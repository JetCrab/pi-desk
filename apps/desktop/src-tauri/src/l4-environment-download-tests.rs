use super::{client, download as download_component};
use crate::environment::{Component, EnvironmentState};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn download(
    state: &EnvironmentState,
    client: &reqwest::Client,
    url: &str,
    destination: &std::path::Path,
    expected_size: Option<u64>,
    cancelled: &dyn Fn() -> bool,
    log: &std::path::Path,
) -> Result<String, String> {
    download_component(
        state,
        Component::Node,
        client,
        url,
        destination,
        expected_size,
        cancelled,
        log,
    )
}

fn node_progress(state: &EnvironmentState) -> Option<crate::environment::DownloadSnapshot> {
    state
        .snapshot()
        .components
        .into_iter()
        .find(|slot| slot.name == Component::Node)
        .unwrap()
        .download
}

struct Directory(PathBuf);

impl Directory {
    fn new(name: &str) -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-download")
            .join(format!("{name}-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn state(&self) -> EnvironmentState {
        EnvironmentState::new(self.0.join("environment"), self.0.join("environment.json"))
    }
}

impl Drop for Directory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[derive(Clone, Copy)]
enum Mode {
    Range,
    SingleUnknownSize,
    ParallelResume,
    ProbeDisconnect,
    ReadTimeout,
    ActiveCancellation,
    SingleRetry,
    InvalidRange,
    InvalidSegment,
    Forbidden,
    Unavailable,
}

struct Shared {
    mode: Mode,
    body: Vec<u8>,
    requests: Mutex<Vec<Option<(usize, usize)>>>,
    interrupted: AtomicBool,
    active: AtomicUsize,
    max_active: AtomicUsize,
    initial_requests: Mutex<usize>,
    ready: Condvar,
}

struct Server {
    address: SocketAddr,
    shared: Arc<Shared>,
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl Server {
    fn new(mode: Mode, size: usize) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let shared = Arc::new(Shared {
            mode,
            body: (0..size)
                .map(|index| ((index * 17 + index / 251) % 256) as u8)
                .collect(),
            requests: Mutex::new(Vec::new()),
            interrupted: AtomicBool::new(false),
            active: AtomicUsize::new(0),
            max_active: AtomicUsize::new(0),
            initial_requests: Mutex::new(0),
            ready: Condvar::new(),
        });
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = stopping.clone();
        let worker_shared = shared.clone();
        let worker = thread::spawn(move || {
            let mut connections = Vec::new();
            for stream in listener.incoming() {
                if worker_stopping.load(Ordering::Acquire) {
                    break;
                }
                let shared = worker_shared.clone();
                let stream = stream.unwrap();
                connections.push(thread::spawn(move || serve(stream, &shared)));
            }
            for connection in connections {
                connection.join().unwrap();
            }
        });
        Self {
            address,
            shared,
            stopping,
            worker: Some(worker),
        }
    }

    fn url(&self) -> String {
        format!("http://{}/fixture", self.address)
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        let _ = TcpStream::connect(self.address);
        self.worker.take().unwrap().join().unwrap();
        assert_eq!(self.shared.active.load(Ordering::Acquire), 0);
        assert!(
            TcpListener::bind(self.address).is_ok(),
            "测试下载端口必须释放"
        );
    }
}

fn serve(mut stream: TcpStream, shared: &Shared) {
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    let mut request = Vec::new();
    let mut buffer = [0; 1024];
    while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
        let Ok(length) = stream.read(&mut buffer) else {
            return;
        };
        if length == 0 {
            return;
        }
        request.extend_from_slice(&buffer[..length]);
    }
    let request = String::from_utf8(request).unwrap();
    let range = request.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if !key.eq_ignore_ascii_case("range") {
            return None;
        }
        let (start, end) = value.trim().strip_prefix("bytes=")?.split_once('-')?;
        Some((
            start.parse::<usize>().unwrap(),
            end.parse::<usize>().unwrap(),
        ))
    });
    shared.requests.lock().unwrap().push(range);
    if matches!(shared.mode, Mode::ProbeDisconnect) && shared.requests.lock().unwrap().len() == 1 {
        return;
    }
    match shared.mode {
        Mode::Forbidden => {
            let _ = stream.write_all(
                b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        Mode::Unavailable => {
            let _ = stream.write_all(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }
        Mode::InvalidRange => {
            let _ = stream.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Range: bytes 1-1/100\r\nContent-Length: 1\r\nConnection: close\r\n\r\nx");
            return;
        }
        _ => {}
    }
    if matches!(shared.mode, Mode::SingleUnknownSize) {
        let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
        let _ = stream.write_all(&shared.body);
        return;
    }
    if matches!(shared.mode, Mode::SingleRetry) {
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            shared.body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let length = if !shared.interrupted.swap(true, Ordering::AcqRel) {
            shared.body.len() / 2
        } else {
            shared.body.len()
        };
        let _ = stream.write_all(&shared.body[..length]);
        return;
    }
    let (start, end) = range.expect("分段下载必须发出 Range 请求");
    assert!(start <= end && end < shared.body.len());
    if matches!(shared.mode, Mode::InvalidSegment) && end > start {
        let header = format!(
            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{end}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            start + 1, shared.body.len(), end - start + 1
        );
        let _ = stream.write_all(header.as_bytes());
        return;
    }
    let active = shared.active.fetch_add(1, Ordering::AcqRel) + 1;
    shared.max_active.fetch_max(active, Ordering::AcqRel);
    if matches!(shared.mode, Mode::ParallelResume)
        && end > start
        && (0..10).any(|index| start == shared.body.len() / 10 * index)
    {
        let mut initial = shared.initial_requests.lock().unwrap();
        *initial += 1;
        shared.ready.notify_all();
        let _ = shared
            .ready
            .wait_timeout_while(initial, Duration::from_secs(2), |count| *count < 10)
            .unwrap();
    }
    let header = format!(
        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {start}-{end}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        shared.body.len(), end - start + 1
    );
    let _ = stream.write_all(header.as_bytes());
    let stalled = matches!(shared.mode, Mode::ReadTimeout)
        && start == 0
        && end > 0
        && !shared.interrupted.swap(true, Ordering::AcqRel);
    let length = if (matches!(shared.mode, Mode::ActiveCancellation) && end > start)
        || stalled
        || (matches!(shared.mode, Mode::ParallelResume)
            && start == 0
            && end > 0
            && !shared.interrupted.swap(true, Ordering::AcqRel))
    {
        64 * 1024
    } else {
        end - start + 1
    };
    let _ = stream.write_all(&shared.body[start..start + length]);
    if (matches!(shared.mode, Mode::ActiveCancellation) && end > start) || stalled {
        let mut byte = [0];
        match stream.read(&mut byte) {
            Ok(0) => {}
            // Windows 主动取消也可能返回 WSAECONNABORTED，而不是连接重置。
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ) => {}
            result => panic!("取消或超时必须关闭活动请求：{result:?}"),
        }
    }
    shared.active.fetch_sub(1, Ordering::AcqRel);
}

#[test]
fn ten_connections_resume_interrupted_segment_and_preserve_file_hash() {
    let directory = Directory::new("parallel-resume");
    let server = Server::new(Mode::ParallelResume, 2 * 1024 * 1024);
    let state = directory.state();
    let destination = directory.0.join("fixture.bin");
    let hash = download(
        &state,
        &client().unwrap(),
        &server.url(),
        &destination,
        None,
        &|| false,
        &directory.0.join("desktop.log"),
    )
    .unwrap();
    assert_eq!(fs::read(&destination).unwrap(), server.shared.body);
    assert_eq!(hash, format!("{:x}", Sha256::digest(&server.shared.body)));
    assert_eq!(server.shared.max_active.load(Ordering::Acquire), 10);
    let requests = server.shared.requests.lock().unwrap();
    assert!(requests.iter().any(|range| matches!(range, Some((start, end)) if *start == 64 * 1024 && *end == server.shared.body.len() / 10 - 1)), "中断分段必须从已写入偏移续传：{requests:?}");
    let progress = node_progress(&state).unwrap();
    assert_eq!(progress.received, server.shared.body.len() as u64);
    assert_eq!(progress.total, Some(server.shared.body.len() as u64));
}

#[test]
fn concurrent_files_report_combined_downloaded_bytes() {
    let directory = Directory::new("concurrent-files");
    let first = Server::new(Mode::ParallelResume, 2 * 1024 * 1024);
    let second = Server::new(Mode::ParallelResume, 3 * 1024 * 1024);
    let state = directory.state();
    let client = client().unwrap();
    let first_file = directory.0.join("node.bin");
    let second_file = directory.0.join("git.bin");
    let log = directory.0.join("desktop.log");
    thread::scope(|scope| {
        let first_task = scope.spawn(|| {
            download(
                &state,
                &client,
                &first.url(),
                &first_file,
                None,
                &|| false,
                &log,
            )
        });
        download(
            &state,
            &client,
            &second.url(),
            &second_file,
            None,
            &|| false,
            &log,
        )
        .unwrap();
        first_task.join().unwrap().unwrap();
    });
    assert_eq!(fs::read(first_file).unwrap(), first.shared.body);
    assert_eq!(fs::read(second_file).unwrap(), second.shared.body);
    let progress = node_progress(&state).unwrap();
    assert_eq!(progress.received, 5 * 1024 * 1024);
    assert_eq!(progress.total, Some(5 * 1024 * 1024));
}

#[test]
fn disconnect_before_response_headers_is_retried() {
    let directory = Directory::new("probe-disconnect");
    let server = Server::new(Mode::ProbeDisconnect, 128 * 1024);
    let destination = directory.0.join("fixture.bin");
    download(
        &directory.state(),
        &client().unwrap(),
        &server.url(),
        &destination,
        None,
        &|| false,
        &directory.0.join("desktop.log"),
    )
    .unwrap();
    assert_eq!(fs::read(destination).unwrap(), server.shared.body);
    assert!(server.shared.requests.lock().unwrap().len() >= 3);
}

#[test]
fn read_timeout_resumes_after_the_last_written_byte() {
    let directory = Directory::new("read-timeout");
    let server = Server::new(Mode::ReadTimeout, 128 * 1024);
    let destination = directory.0.join("fixture.bin");
    let client = reqwest::Client::builder()
        .read_timeout(Duration::from_millis(200))
        .build()
        .unwrap();
    download(
        &directory.state(),
        &client,
        &server.url(),
        &destination,
        None,
        &|| false,
        &directory.0.join("desktop.log"),
    )
    .unwrap();
    assert_eq!(fs::read(destination).unwrap(), server.shared.body);
    assert!(server
        .shared
        .requests
        .lock()
        .unwrap()
        .contains(&Some((64 * 1024, 128 * 1024 - 1))));
}

#[test]
fn completed_unknown_size_file_does_not_block_later_download_percentage() {
    let directory = Directory::new("unknown-size-progress");
    let metadata = Server::new(Mode::SingleUnknownSize, 128 * 1024);
    let archive = Server::new(Mode::Range, 2 * 1024 * 1024);
    let state = directory.state();
    let client = client().unwrap();
    for (server, name) in [(&metadata, "index.json"), (&archive, "archive.bin")] {
        let destination = directory.0.join(name);
        let hash = download(
            &state,
            &client,
            &server.url(),
            &destination,
            None,
            &|| false,
            &directory.0.join("desktop.log"),
        )
        .unwrap();
        assert_eq!(hash, format!("{:x}", Sha256::digest(&server.shared.body)));
        assert_eq!(fs::read(destination).unwrap(), server.shared.body);
        let progress = node_progress(&state).unwrap();
        assert_eq!(progress.total, Some(progress.received));
    }
    let progress = node_progress(&state).unwrap();
    assert_eq!(progress.received, (128 + 2 * 1024) * 1024);
    assert_eq!(progress.total, Some((128 + 2 * 1024) * 1024));
}

#[test]
fn server_without_range_support_retries_whole_file() {
    let directory = Directory::new("single-retry");
    let server = Server::new(Mode::SingleRetry, 128 * 1024);
    let state = directory.state();
    let destination = directory.0.join("fixture.bin");
    download(
        &state,
        &client().unwrap(),
        &server.url(),
        &destination,
        Some(server.shared.body.len() as u64),
        &|| false,
        &directory.0.join("desktop.log"),
    )
    .unwrap();
    assert_eq!(fs::read(&destination).unwrap(), server.shared.body);
    assert!(server.shared.requests.lock().unwrap().len() >= 2);
    assert_eq!(
        node_progress(&state).unwrap().received,
        server.shared.body.len() as u64
    );
}

#[test]
fn mismatched_ranges_are_rejected_without_installable_file() {
    let directory = Directory::new("invalid-range");
    let server = Server::new(Mode::InvalidRange, 100);
    let destination = directory.0.join("fixture.bin");
    assert!(download(
        &directory.state(),
        &client().unwrap(),
        &server.url(),
        &destination,
        None,
        &|| false,
        &directory.0.join("desktop.log")
    )
    .is_err());
    assert!(!destination.exists());
    assert_eq!(server.shared.requests.lock().unwrap().len(), 1);
}

#[test]
fn known_release_size_mismatch_is_rejected_before_writing() {
    let directory = Directory::new("invalid-size");
    let server = Server::new(Mode::ParallelResume, 2 * 1024 * 1024);
    let destination = directory.0.join("fixture.bin");
    assert!(download(
        &directory.state(),
        &client().unwrap(),
        &server.url(),
        &destination,
        Some(server.shared.body.len() as u64 + 1),
        &|| false,
        &directory.0.join("desktop.log")
    )
    .is_err());
    assert!(!destination.exists());
    assert_eq!(server.shared.requests.lock().unwrap().len(), 1);
}

#[test]
fn invalid_segment_response_removes_partial_download() {
    let directory = Directory::new("invalid-segment");
    let server = Server::new(Mode::InvalidSegment, 128 * 1024);
    let destination = directory.0.join("fixture.bin");
    let error = download(
        &directory.state(),
        &client().unwrap(),
        &server.url(),
        &destination,
        None,
        &|| false,
        &directory.0.join("desktop.log"),
    )
    .unwrap_err();
    assert!(error.contains("范围"), "{error}");
    assert_eq!(server.shared.requests.lock().unwrap().len(), 2);
    assert!(!destination.exists());
}

#[test]
fn cancellation_closes_active_requests_and_removes_partial_file() {
    let directory = Directory::new("cancel-active");
    let server = Server::new(Mode::ActiveCancellation, 2 * 1024 * 1024);
    let destination = directory.0.join("fixture.bin");
    let state = directory.state();
    let started = Instant::now();
    let error = download(
        &state,
        &client().unwrap(),
        &server.url(),
        &destination,
        None,
        &|| node_progress(&state).is_some_and(|progress| progress.received > 0),
        &directory.0.join("desktop.log"),
    )
    .unwrap_err();
    assert!(error.contains("取消"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(!destination.exists());
    assert!(node_progress(&state).is_none());
}

#[test]
fn permission_errors_are_not_retried() {
    let directory = Directory::new("forbidden");
    let server = Server::new(Mode::Forbidden, 0);
    let destination = directory.0.join("fixture.bin");
    let error = download(
        &directory.state(),
        &client().unwrap(),
        &server.url(),
        &destination,
        None,
        &|| false,
        &directory.0.join("desktop.log"),
    )
    .unwrap_err();
    assert!(error.contains("403"), "{error}");
    assert_eq!(server.shared.requests.lock().unwrap().len(), 1);
    assert!(!destination.exists());
}

#[test]
fn cancellation_stops_transient_failure_retries_promptly() {
    let directory = Directory::new("cancel-retry");
    let server = Server::new(Mode::Unavailable, 0);
    let destination = directory.0.join("fixture.bin");
    let started = Instant::now();
    let error = download(
        &directory.state(),
        &client().unwrap(),
        &server.url(),
        &destination,
        None,
        &|| !server.shared.requests.lock().unwrap().is_empty(),
        &directory.0.join("desktop.log"),
    )
    .unwrap_err();
    assert!(error.contains("取消"), "{error}");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(!destination.exists());
    assert_eq!(server.shared.requests.lock().unwrap().len(), 1);
}

#[test]
fn unavailable_server_eventually_fails_instead_of_retrying_forever() {
    let directory = Directory::new("bounded-retries");
    let server = Server::new(Mode::Unavailable, 0);
    let destination = directory.0.join("fixture.bin");
    let error = download(
        &directory.state(),
        &client().unwrap(),
        &server.url(),
        &destination,
        None,
        &|| false,
        &directory.0.join("desktop.log"),
    )
    .unwrap_err();
    assert!(error.contains("503"), "{error}");
    assert_eq!(server.shared.requests.lock().unwrap().len(), 6);
    assert!(!destination.exists());
}
