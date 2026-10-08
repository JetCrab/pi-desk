use super::{recommend, DownloadSource, IP_LOOKUP_TIMEOUT};
use crate::environment::EnvironmentState;
use std::fs;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct Directory(PathBuf);

impl Directory {
    fn new(name: &str) -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-source")
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

struct CountryServer {
    address: SocketAddr,
    requests: Arc<AtomicUsize>,
    stopping: Arc<AtomicBool>,
    requested: mpsc::Receiver<()>,
    release: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
}

impl CountryServer {
    fn new(status: u16, body: &'static str, held: bool) -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_requests = requests.clone();
        let worker_stopping = stopping.clone();
        let (notify, requested) = mpsc::channel();
        let (release, gate) = mpsc::channel();
        let worker = thread::spawn(move || {
            for stream in listener.incoming() {
                if worker_stopping.load(Ordering::Acquire) {
                    break;
                }
                let mut stream = stream.unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let length = stream.read(&mut buffer).unwrap();
                    assert!(length > 0);
                    request.extend_from_slice(&buffer[..length]);
                }
                worker_requests.fetch_add(1, Ordering::AcqRel);
                notify.send(()).unwrap();
                if held {
                    gate.recv_timeout(Duration::from_secs(5)).unwrap();
                }
                let response = format!("HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
                let _ = stream.write_all(response.as_bytes());
            }
        });
        Self {
            address,
            requests,
            stopping,
            requested,
            release,
            worker: Some(worker),
        }
    }

    fn url(&self) -> String {
        format!("http://{}/country", self.address)
    }
}

impl Drop for CountryServer {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
        let _ = self.release.send(());
        let _ = TcpStream::connect(self.address);
        self.worker.take().unwrap().join().unwrap();
        assert!(
            TcpListener::bind(self.address).is_ok(),
            "IP 测试端口必须释放"
        );
    }
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn saved_domestic_choice_uses_tencent_npm_without_changing_binary_mirrors() {
    let directory = Directory::new("domestic-source-compatibility");
    fs::write(
        directory.0.join("environment.json"),
        r#"{"node":"C:/selected/node.exe","downloadSource":"npmmirror"}"#,
    )
    .unwrap();
    let state = directory.state();
    let source = runtime().block_on(state.download_source(
        "http://127.0.0.1:1/must-not-query",
        &directory.0.join("desktop.log"),
    ));
    assert_eq!(source, DownloadSource::Domestic);
    assert_eq!(
        source.npm_registry(),
        "https://mirrors.cloud.tencent.com/npm"
    );
    assert_eq!(source.node_base(), "https://npmmirror.com/mirrors/node/");
    assert_eq!(
        source.git_url("https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe"),
        "https://registry.npmmirror.com/-/binary/git-for-windows/v2.51.0.windows.1/Git-2.51.0-64-bit.exe"
    );
    assert_eq!(serde_json::to_string(&source).unwrap(), "\"npmmirror\"");
    assert_eq!(
        DownloadSource::Official.npm_registry(),
        "https://registry.npmjs.org"
    );
    assert!(
        !directory.0.join("desktop.log").exists(),
        "已有选择不能重新查询 IP"
    );
}

#[test]
fn china_recommends_mirror_and_other_countries_recommend_official() {
    let directory = Directory::new("country-recommendation");
    let runtime = runtime();
    for (body, expected) in [
        (
            r#"{"success":true,"country_code":"CN"}"#,
            DownloadSource::Domestic,
        ),
        (
            r#"{"success":true,"country_code":"US"}"#,
            DownloadSource::Official,
        ),
    ] {
        let server = CountryServer::new(200, body, false);
        assert_eq!(
            runtime.block_on(recommend(&server.url(), &directory.0.join("desktop.log"))),
            expected
        );
    }
}

#[test]
fn failed_or_invalid_country_lookup_defaults_to_official() {
    let directory = Directory::new("country-failure");
    let runtime = runtime();
    for (status, body) in [
        (503, "unavailable"),
        (200, r#"{"success":false}"#),
        (200, r#"{"success":true,"country_code":null}"#),
        (200, "invalid-json"),
    ] {
        let server = CountryServer::new(status, body, false);
        assert_eq!(
            runtime.block_on(recommend(&server.url(), &directory.0.join("desktop.log"))),
            DownloadSource::Official
        );
    }
}

#[test]
fn country_lookup_timeout_is_bounded_and_defaults_to_official() {
    let directory = Directory::new("country-timeout");
    let server = CountryServer::new(200, r#"{"success":true,"country_code":"CN"}"#, true);
    let started = Instant::now();
    assert_eq!(
        runtime().block_on(recommend(&server.url(), &directory.0.join("desktop.log"))),
        DownloadSource::Official
    );
    assert!(
        started.elapsed() < IP_LOOKUP_TIMEOUT + Duration::from_secs(1),
        "IP 查询不能阻塞安装超过查询上限"
    );
    assert_eq!(server.requests.load(Ordering::Acquire), 1);
}

#[test]
fn recommendation_is_cached_but_only_accepted_source_is_persisted() {
    let directory = Directory::new("source-cache");
    let choices = directory.0.join("environment.json");
    fs::write(&choices, r#"{"node":"C:/selected/node.exe"}"#).unwrap();
    let server = CountryServer::new(200, r#"{"success":true,"country_code":"CN"}"#, false);
    let state = directory.state();
    let runtime = runtime();
    for _ in 0..2 {
        assert_eq!(
            runtime
                .block_on(state.download_source(&server.url(), &directory.0.join("desktop.log"))),
            DownloadSource::Domestic
        );
    }
    assert_eq!(server.requests.load(Ordering::Acquire), 1);
    let before: serde_json::Value = serde_json::from_slice(&fs::read(&choices).unwrap()).unwrap();
    assert!(
        before.get("downloadSource").is_none(),
        "IP 推荐不能被当成用户选择保存"
    );
    state
        .save_download_source(DownloadSource::Official)
        .unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&fs::read(&choices).unwrap()).unwrap();
    assert_eq!(
        saved,
        serde_json::json!({ "node": "C:/selected/node.exe", "downloadSource": "official" })
    );
    let reloaded = directory.state();
    assert_eq!(
        runtime.block_on(reloaded.download_source(&server.url(), &directory.0.join("desktop.log"))),
        DownloadSource::Official
    );
    assert_eq!(
        server.requests.load(Ordering::Acquire),
        1,
        "已保存的选择不应再次进行 IP 查询"
    );
}

#[test]
fn accepted_source_wins_over_a_late_country_response() {
    let directory = Directory::new("source-late-response");
    let server = CountryServer::new(200, r#"{"success":true,"country_code":"CN"}"#, true);
    let state = Arc::new(directory.state());
    let querying_state = state.clone();
    let url = server.url();
    let log = directory.0.join("desktop.log");
    let runtime = runtime();
    let query = runtime.spawn(async move { querying_state.download_source(&url, &log).await });
    server
        .requested
        .recv_timeout(Duration::from_secs(2))
        .unwrap();
    state
        .save_download_source(DownloadSource::Official)
        .unwrap();
    server.release.send(()).unwrap();
    assert_eq!(runtime.block_on(query).unwrap(), DownloadSource::Official);
}
