use std::collections::HashSet;
use std::io;
use std::path::Path;
use std::process::Command;
use std::thread;
use std::time::{Duration, Instant};

use crate::logging;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Process {
    pid: i32,
    parent: i32,
    group: i32,
    started: u64,
    zombie: bool,
}

pub(super) struct Tree {
    root: Process,
    finished: bool,
}

impl Tree {
    pub(super) fn new(pid: u32) -> io::Result<Self> {
        Ok(Self {
            root: inspect(pid as i32)?
                .ok_or_else(|| io::Error::other(format!("无法取得托管进程身份 pid={pid}")))?,
            finished: false,
        })
    }

    // WNOWAIT 保留根进程 PID，直到归属快照和组清理完成，防止回收后 PGID 被复用。
    pub(super) fn exited(&self) -> io::Result<bool> {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe {
            libc::waitid(
                libc::P_PID,
                self.root.pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        } == -1
        {
            let error = io::Error::last_os_error();
            if self.finished && error.raw_os_error() == Some(libc::ECHILD) {
                return Ok(true);
            }
            return Err(error);
        }
        Ok(unsafe { info.si_pid() } != 0)
    }

    pub(super) fn stop(&mut self, graceful: bool, log: &Path) -> io::Result<()> {
        if self.finished {
            return Ok(());
        }
        let processes = snapshot()?;
        let root = inspect(self.root.pid)?
            .filter(|process| same_identity(process, &self.root))
            .ok_or_else(|| io::Error::other("托管根进程身份已丢失，拒绝认领未知进程组"))?;
        if root.group != self.root.pid {
            return Err(io::Error::other("托管根进程已更换进程组，拒绝清理未知归属"));
        }
        let mut owned = vec![root.clone()];
        for process in processes
            .iter()
            .filter(|process| process.group == self.root.pid && process.pid != self.root.pid)
        {
            if let Some(now) = inspect(process.pid)? {
                if now.group != self.root.pid {
                    return Err(io::Error::other(
                        "采样期间原进程组成员已更换组，拒绝推测归属",
                    ));
                }
                owned.push(now);
            }
        }
        if !root.zombie {
            // 只沿仍存活、身份仍匹配的父链认领；不从失联根进程的旧 PPID 推测归属。
            loop {
                let mut added = false;
                for process in &processes {
                    if owned.iter().any(|known| known.pid == process.pid) {
                        continue;
                    }
                    if let Some(parent) = owned.iter().find(|known| known.pid == process.parent) {
                        let current_parent = inspect(parent.pid)?;
                        if !current_parent
                            .is_some_and(|now| same_identity(&now, parent) && !now.zombie)
                        {
                            return Err(io::Error::other(format!(
                                "归属采样时父进程已失联 pid={} ppid={}，保持未知后代不动",
                                process.pid, parent.pid
                            )));
                        }
                        if let Some(now) = inspect(process.pid)? {
                            if now.parent != parent.pid
                                || now.group != process.group
                                || !inspect(parent.pid)?.is_some_and(|current| {
                                    same_identity(&current, parent) && !current.zombie
                                })
                            {
                                return Err(io::Error::other(format!(
                                    "采样期间后代身份变化 pid={}，拒绝认领",
                                    process.pid
                                )));
                            }
                            owned.push(now);
                            added = true;
                        }
                    }
                }
                if !added {
                    break;
                }
            }
        }
        let groups: HashSet<i32> = owned.iter().map(|process| process.group).collect();
        if groups.iter().any(|group| {
            !owned
                .iter()
                .any(|process| process.pid == *group && process.group == *group)
        }) {
            return Err(io::Error::other(
                "目标进程组缺少已确认归属的组领导，保持未知组不动",
            ));
        }
        let mut ancestor = std::process::id() as i32;
        while let Some(process) = processes.iter().find(|process| process.pid == ancestor) {
            if groups.contains(&process.group) {
                return Err(io::Error::other(
                    "归属快照涉及自身或祖先进程组，拒绝发送信号",
                ));
            }
            ancestor = process.parent;
            if ancestor <= 1 {
                break;
            }
        }
        if groups.iter().any(|group| *group <= 1) {
            return Err(io::Error::other("拒绝清理无效进程组"));
        }
        if graceful && !root.zombie {
            logging::write(
                log,
                "process-term",
                &format!("请求退出 pid={} pgid={}", root.pid, root.group),
            );
            signal(root.group, libc::SIGTERM)?;
            let deadline = Instant::now() + Duration::from_secs(12);
            while owned.iter().any(|process| {
                inspect(process.pid)
                    .ok()
                    .flatten()
                    .is_some_and(|now| same_identity(&now, process) && !now.zombie)
            }) && Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(20));
            }
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut signalled = HashSet::new();
        loop {
            let current = snapshot()?;
            let mut remaining = false;
            for group in &groups {
                let living: Vec<_> = current
                    .iter()
                    .filter(|process| process.group == *group && !process.zombie)
                    .collect();
                if living.is_empty() {
                    continue;
                }
                remaining = true;
                if signalled.contains(group) {
                    continue;
                }
                // 仅对已捕获目标查询内核身份，不读取无关系统进程的高精度信息。
                let mut anchor = None;
                for known in owned.iter().filter(|process| process.group == *group) {
                    if let Some(now) = inspect(known.pid)? {
                        let retained_root = *group == self.root.pid && now.pid == self.root.pid;
                        if same_identity(&now, known)
                            && now.group == *group
                            && (retained_root || !now.zombie)
                        {
                            anchor = Some(now);
                            break;
                        }
                    }
                }
                let Some(anchor) = anchor else {
                    if !snapshot()?
                        .iter()
                        .any(|process| process.group == *group && !process.zombie)
                    {
                        continue;
                    }
                    return Err(io::Error::other(format!(
                        "进程组身份无法确认 pgid={group}，保持不动"
                    )));
                };
                signalled.insert(*group);
                logging::write(
                    log,
                    "process-kill",
                    &format!("强制清理 pid={} pgid={group}", anchor.pid),
                );
                signal(*group, libc::SIGKILL)?;
            }
            if !remaining {
                self.finished = true;
                logging::write(
                    log,
                    "process-tree-exit",
                    &format!("已确认进程组退出 pid={} groups={groups:?}", self.root.pid),
                );
                if graceful && root.zombie {
                    logging::write(
                        log,
                        "process-tree-unknown",
                        &format!("根进程已退出 pid={}，未知独立后代未清理", root.pid),
                    );
                    return Err(io::Error::other(format!(
                        "根进程已退出 pid={}，仅清理原进程组，无法确认失联独立后代归属",
                        root.pid
                    )));
                }
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!(
                        "等待托管进程组退出超时 pid={} groups={groups:?}",
                        self.root.pid
                    ),
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
}

fn same_identity(left: &Process, right: &Process) -> bool {
    left.started != 0 && left.pid == right.pid && left.started == right.started
}

fn signal(group: i32, signal: i32) -> io::Result<()> {
    if unsafe { libc::killpg(group, signal) } == -1 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ESRCH) {
            return Err(error);
        }
    }
    Ok(())
}

fn snapshot() -> io::Result<Vec<Process>> {
    // macOS 和 Linux 均支持该 ps 格式；快照只提供拓扑，不用于确认 PID 身份。
    let output = Command::new("/bin/ps")
        .args(["-axo", "pid=,ppid=,pgid=,stat="])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!(
            "读取进程归属快照失败：{}",
            String::from_utf8_lossy(&output.stderr)
        )));
    }
    let mut processes = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        let number = |index: usize| -> io::Result<i32> {
            fields
                .get(index)
                .and_then(|field| field.parse().ok())
                .ok_or_else(|| io::Error::other("ps 返回无效进程字段"))
        };
        processes.push(Process {
            pid: number(0)?,
            parent: number(1)?,
            group: number(2)?,
            started: 0,
            zombie: fields.get(3).is_some_and(|state| state.starts_with('Z')),
        });
    }
    Ok(processes)
}

#[cfg(target_os = "linux")]
fn inspect(pid: i32) -> io::Result<Option<Process>> {
    let stat = match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => stat,
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ESRCH) =>
        {
            return Ok(None)
        }
        Err(error) => return Err(error),
    };
    let fields: Vec<_> = stat
        .rsplit_once(") ")
        .ok_or_else(|| io::Error::other("无效进程 stat"))?
        .1
        .split_whitespace()
        .collect();
    let number = |index: usize| -> io::Result<u64> {
        fields
            .get(index)
            .and_then(|field| field.parse().ok())
            .ok_or_else(|| io::Error::other("无效进程身份字段"))
    };
    Ok(Some(Process {
        pid,
        parent: number(1)? as i32,
        group: number(2)? as i32,
        started: number(19)?,
        zombie: matches!(fields.first(), Some(&"Z") | Some(&"X")),
    }))
}

#[cfg(target_os = "macos")]
fn inspect(pid: i32) -> io::Result<Option<Process>> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    let result = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            // 非零 arg 包含尚未回收的僵尸进程，与 WNOWAIT 保留根 PID 配套。
            1,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    if result <= 0 {
        let error = io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(libc::ESRCH) | Some(libc::ENOENT)) {
            return Ok(None);
        }
        return Err(error);
    }
    if result != size {
        return Err(io::Error::other(format!(
            "进程身份读取不完整 pid={pid} bytes={result} expected={size}"
        )));
    }
    Ok(Some(Process {
        pid,
        parent: info.pbi_ppid as i32,
        group: info.pbi_pgid as i32,
        started: info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec,
        zombie: info.pbi_status == 5,
    }))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn inspect(_pid: i32) -> io::Result<Option<Process>> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "当前 Unix 平台不支持高精度进程身份校验",
    ))
}

#[cfg(test)]
mod tests {
    use super::super::{run_capture, spawn_foreground, stop_child, ManagedProcess};
    use super::*;
    use std::fs;
    use std::net::{TcpListener, TcpStream};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture {
        directory: PathBuf,
        root: Option<ManagedProcess>,
        detached: Vec<Process>,
    }

    impl Fixture {
        fn new(name: &str) -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../../temp/tests/desktop-process")
                .join(format!("{name}-{}-{suffix}", std::process::id()));
            fs::create_dir_all(&directory).unwrap();
            Self {
                directory,
                root: None,
                detached: Vec::new(),
            }
        }

        fn write(&self, name: &str, source: &str) {
            fs::write(self.directory.join(name), source).unwrap();
        }

        fn start(&mut self, source: &str) {
            self.write("root.js", source);
            self.root = Some(
                spawn_foreground(
                    "exec node root.js",
                    Some(&self.directory),
                    &self.directory.join("process.log"),
                )
                .unwrap(),
            );
        }

        fn track_detached(&mut self) {
            if self.root.as_ref().is_some_and(|root| root.tree.finished) {
                return;
            }
            if let Ok(pid) = fs::read_to_string(self.directory.join("leaf-pid.txt")) {
                let Ok(pid) = pid.trim().parse::<i32>() else {
                    return;
                };
                if !self.detached.iter().any(|known| known.pid == pid) {
                    if let Ok(Some(process)) = inspect(pid) {
                        let root_group = self.root.as_ref().map(|root| root.id() as i32);
                        if process.group == process.pid || root_group == Some(process.group) {
                            self.detached.push(process);
                        }
                    }
                }
            }
        }

        fn ready(&mut self) -> u16 {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                self.track_detached();
                if let Ok(bytes) = fs::read(self.directory.join("ready.json")) {
                    if let Ok(state) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        self.track_detached();
                        return state["port"].as_u64().unwrap() as u16;
                    }
                }
                assert!(Instant::now() < deadline, "测试监听服务未就绪");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            // 即使功能断言失败，也按事先捕获的内核身份释放测试自己的进程组。
            if self.root.is_some() {
                self.track_detached();
            }
            for known in &self.detached {
                if inspect(known.pid)
                    .ok()
                    .flatten()
                    .is_some_and(|now| same_identity(&now, known) && now.group == known.group)
                {
                    let _ = signal(known.group, libc::SIGKILL);
                }
            }
            self.root.take();
            let deadline = Instant::now() + Duration::from_secs(2);
            while self.detached.iter().any(|known| {
                inspect(known.pid)
                    .ok()
                    .flatten()
                    .is_some_and(|now| same_identity(&now, known) && !now.zombie)
            }) && Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(10));
            }
            let released = self.detached.iter().all(|known| {
                !inspect(known.pid)
                    .ok()
                    .flatten()
                    .is_some_and(|now| same_identity(&now, known) && !now.zombie)
            });
            if !released {
                eprintln!("测试进程未释放：{}", self.directory.display());
            }
            if !thread::panicking() {
                assert!(released, "测试进程未释放");
                fs::remove_dir_all(&self.directory).unwrap();
            }
        }
    }

    const LISTENER: &str = r#"
const fs = require('node:fs');
const server = require('node:net').createServer(socket => socket.end());
process.on('SIGTERM', () => {
  fs.writeFileSync('terminated.txt', 'SIGTERM');
  server.close(() => process.exit(0));
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync('ready.json', JSON.stringify({ port: server.address().port })));
"#;

    const LEAF: &str = r#"
const fs = require('node:fs');
process.on('SIGTERM', () => {});
const server = require('node:net').createServer(socket => socket.end());
server.listen(0, '127.0.0.1', () => fs.writeFileSync('ready.json', JSON.stringify({ port: server.address().port })));
"#;

    const PARENT: &str = r#"
const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['leaf.js'], { detached: true, stdio: 'inherit' });
fs.writeFileSync('leaf-pid.txt', String(child.pid));
process.on('SIGTERM', () => { fs.writeFileSync('terminated.txt', 'SIGTERM'); process.exit(0); });
setInterval(() => {}, 1000);
"#;

    #[test]
    fn natural_completion_does_not_wait_for_term_grace_or_report_cleanup_failure() {
        let fixture = Fixture::new("unix-natural-exit");
        fixture.write("root.js", "process.stdout.write('finished');");
        let started = Instant::now();
        let output = run_capture(
            "exec node root.js",
            Some(&fixture.directory),
            Duration::from_secs(5),
            &fixture.directory.join("process.log"),
            &|| false,
        )
        .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"finished");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn slow_normal_shutdown_gets_more_than_one_second_before_sigkill() {
        let mut fixture = Fixture::new("unix-slow-graceful-stop");
        fixture.start(&LISTENER.replace(
            "server.close(() => process.exit(0))",
            "server.close(() => setTimeout(() => process.exit(0), 1250))",
        ));
        let port = fixture.ready();
        stop_child(fixture.root.as_mut().unwrap()).unwrap();
        TcpListener::bind(("127.0.0.1", port)).expect("慢关闭完成后端口应可重新绑定");
        let log = fs::read_to_string(fixture.directory.join("process.log")).unwrap();
        assert!(log.contains("process-term"));
        assert!(!log.contains("process-kill"));
    }

    #[test]
    fn stop_requests_sigterm_before_forcing_a_normal_node_listener() {
        let mut fixture = Fixture::new("unix-graceful-stop");
        fixture.start(LISTENER);
        let port = fixture.ready();
        stop_child(fixture.root.as_mut().unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(fixture.directory.join("terminated.txt")).unwrap(),
            "SIGTERM"
        );
        TcpListener::bind(("127.0.0.1", port)).expect("正常停止后端口应可重新绑定");
        let log = fs::read_to_string(fixture.directory.join("process.log")).unwrap();
        assert!(log.contains("process-term"));
        assert!(!log.contains("process-kill"));
    }

    #[test]
    fn stop_kills_owned_detached_group_but_preserves_an_unrelated_listener() {
        let mut unrelated = Fixture::new("unix-unrelated-listener");
        unrelated.start(LISTENER);
        let unrelated_port = unrelated.ready();
        let mut fixture = Fixture::new("unix-detached-stop");
        fixture.write("leaf.js", LEAF);
        fixture.start(PARENT);
        let port = fixture.ready();
        assert_eq!(fixture.detached.len(), 1);
        stop_child(fixture.root.as_mut().unwrap()).unwrap();
        assert!(fs::read_to_string(fixture.directory.join("terminated.txt")).is_ok());
        assert!(inspect(fixture.detached[0].pid)
            .unwrap()
            .is_none_or(|now| now.zombie));
        TcpListener::bind(("127.0.0.1", port)).expect("独立后代停止后端口应可重新绑定");
        TcpStream::connect(("127.0.0.1", unrelated_port)).expect("无关监听应继续工作");
        assert!(!unrelated.root.as_mut().unwrap().tree.exited().unwrap());
        assert!(fs::read_to_string(fixture.directory.join("process.log"))
            .unwrap()
            .contains("process-kill"));
    }

    #[test]
    fn startup_cancellation_releases_the_detached_listener_and_output_pipes() {
        let mut fixture = Fixture::new("unix-startup-cancel");
        fixture.write("leaf.js", LEAF);
        fixture.write("root.js", PARENT);
        let fixture = std::cell::RefCell::new(fixture);
        let directory = fixture.borrow().directory.clone();
        let result = run_capture(
            "exec node root.js",
            Some(&directory),
            Duration::from_secs(15),
            &directory.join("process.log"),
            &|| {
                fixture.borrow_mut().track_detached();
                directory.join("ready.json").exists()
            },
        );
        let fixture = fixture.into_inner();
        assert!(result.unwrap_err().contains("已取消"));
        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.directory.join("ready.json")).unwrap())
                .unwrap();
        TcpListener::bind(("127.0.0.1", state["port"].as_u64().unwrap() as u16))
            .expect("启动取消后端口应可重新绑定");
        assert!(fixture
            .detached
            .iter()
            .all(|known| inspect(known.pid).unwrap().is_none_or(|now| now.zombie)));
    }

    #[test]
    fn retained_zombie_root_anchors_a_same_group_child_born_after_snapshot() {
        let mut fixture = Fixture::new("unix-late-same-group-child");
        fixture.write(
            "late.js",
            &format!("{LEAF}\nserver.on('listening', () => process.send('ready'));"),
        );
        fixture.start(r#"
const fs = require('node:fs');
const server = require('node:net').createServer(socket => socket.end());
process.on('SIGTERM', () => {
  const child = require('node:child_process').spawn(process.execPath, ['late.js'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  fs.writeFileSync('leaf-pid.txt', String(child.pid));
  child.on('message', () => process.exit(0));
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync('ready.json', JSON.stringify({ port: server.address().port })));
"#);
        let original_port = fixture.ready();
        stop_child(fixture.root.as_mut().unwrap()).unwrap();
        let state: serde_json::Value =
            serde_json::from_slice(&fs::read(fixture.directory.join("ready.json")).unwrap())
                .unwrap();
        TcpListener::bind(("127.0.0.1", original_port)).expect("根监听端口应释放");
        TcpListener::bind(("127.0.0.1", state["port"].as_u64().unwrap() as u16))
            .expect("快照之后出生的同组子监听应释放");
    }

    #[test]
    fn exited_root_does_not_claim_an_orphan_and_readers_can_be_cancelled() {
        let mut fixture = Fixture::new("unix-orphan-boundary");
        fixture.write("leaf.js", LEAF);
        fixture.start(&format!("{PARENT}\nsetInterval(() => {{ if (fs.existsSync('exit-root.txt')) process.exit(0); }}, 10);"));
        let port = fixture.ready();
        fs::write(fixture.directory.join("exit-root.txt"), "exit").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !fixture.root.as_ref().unwrap().tree.exited().unwrap() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(10));
        }
        let error = stop_child(fixture.root.as_mut().unwrap()).unwrap_err();
        assert!(error.contains("根进程已退出"));
        TcpStream::connect(("127.0.0.1", port)).expect("未知归属独立组应保持不动");
        let started = Instant::now();
        let error = fixture.root.as_mut().unwrap().finish_readers().unwrap_err();
        assert!(error.to_string().contains("输出管道"));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "失联后代持有管道时不应永久等待输出线程"
        );
    }
}
