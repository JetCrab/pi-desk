use super::{pause_services, restore_services};
use crate::config::{DesktopConfig, ServerConfig, TargetConfig, TunnelConnectionConfig};
use crate::runtime::{
    has_child, launch_service, stop_active_child, RuntimeInfo, ShellState, TargetRuntimeInfo,
};
use std::cell::Cell;
use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct Fixture {
    state: ShellState,
    directory: PathBuf,
    urls: Vec<String>,
    ports: Vec<u16>,
}

impl Fixture {
    fn new() -> Self {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-pi-update")
            .join(format!(
                "service-recovery-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir_all(&directory).unwrap();
        let node = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let node = String::from_utf8(node.stdout).unwrap().trim().to_string();
        let script = directory.join("service.cjs");
        fs::write(&script, "require('node:http').createServer((q,s)=>s.end('ready')).listen(Number(process.argv[2]),'127.0.0.1')").unwrap();
        let listeners = (0..3)
            .map(|_| TcpListener::bind(("127.0.0.1", 0)).unwrap())
            .collect::<Vec<_>>();
        let ports = listeners
            .iter()
            .map(|listener| listener.local_addr().unwrap().port())
            .collect::<Vec<_>>();
        let urls = ports
            .iter()
            .map(|port| format!("http://127.0.0.1:{port}/"))
            .collect::<Vec<_>>();
        let server = ServerConfig {
            start_command: format!(
                "{} {} {{port}}",
                crate::packages::quote(&node),
                crate::packages::quote(&script.to_string_lossy())
            ),
            ready_path: "/health".into(),
            package: None,
        };
        let config = DesktopConfig {
            targets: urls
                .iter()
                .map(|url| TargetConfig {
                    url: url.clone(),
                    server: Some(server.clone()),
                    tunnel: None,
                })
                .collect(),
            tunnel: TunnelConnectionConfig::default(),
        };
        let mut info = RuntimeInfo::default();
        for (index, url) in urls.iter().enumerate() {
            info.targets.insert(
                url.clone(),
                TargetRuntimeInfo {
                    last_version: Some("1.2.3".into()),
                    auto_start: index != 0,
                },
            );
        }
        crate::config::save(&directory.join("config.json"), &config).unwrap();
        fs::write(
            directory.join("runtime.json"),
            serde_json::to_vec(&info).unwrap(),
        )
        .unwrap();
        let state = ShellState::new(
            config,
            info,
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );
        state.environment.set_phase("ready", "运行环境已就绪", None);
        drop(listeners);
        let fixture = Self {
            state,
            directory,
            urls,
            ports,
        };
        for url in &fixture.urls[..2] {
            launch_service(
                &fixture.state,
                url,
                &server,
                Some("1.2.3".into()),
                Some(fixture.directory.clone()),
                &|| false,
            )
            .unwrap();
        }
        fixture
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        for (url, port) in self.urls.iter().zip(&self.ports) {
            stop_active_child(&self.state, url).unwrap();
            assert!(
                TcpListener::bind(("127.0.0.1", *port)).is_ok(),
                "测试端口未释放：{port}"
            );
        }
        if !std::thread::panicking() {
            fs::remove_dir_all(&self.directory).unwrap();
        }
    }
}

#[test]
fn pi_update_restores_only_running_services_with_original_config_and_preferences() {
    let fixture = Fixture::new();
    let state = &fixture.state;
    let before = fs::read(fixture.directory.join("runtime.json")).unwrap();
    let old_pids = fixture.urls[..2]
        .iter()
        .map(|url| {
            state.target_runtimes.lock().unwrap()[url]
                .child
                .as_ref()
                .unwrap()
                .child
                .id()
        })
        .collect::<Vec<_>>();
    // 已保存的下一次配置不能替换本次维护恢复所用的实际运行命令。
    for target in &mut state.config.lock().unwrap().targets {
        target.server.as_mut().unwrap().start_command = "invalid-next-start-command".into();
    }
    let mut paused = Vec::new();
    pause_services(state, &mut paused, &|| false).unwrap();
    assert_eq!(paused.len(), 2);
    for port in &fixture.ports {
        assert!(TcpListener::bind(("127.0.0.1", *port)).is_ok());
    }
    assert!(restore_services(state, paused, &|| false).is_empty());
    for (url, old_pid) in fixture.urls[..2].iter().zip(old_pids) {
        let runtimes = state.target_runtimes.lock().unwrap();
        let child = runtimes[url].child.as_ref().unwrap();
        assert_ne!(child.child.id(), old_pid);
        assert_eq!(child.version.as_deref(), Some("1.2.3"));
        assert_eq!(child.directory.as_ref(), Some(&fixture.directory));
    }
    assert!(
        !has_child(state, &fixture.urls[2]),
        "原本停止的服务不得启动"
    );
    assert_eq!(
        fs::read(fixture.directory.join("runtime.json")).unwrap(),
        before,
        "维护不得改写自动启动及版本记录"
    );
}

#[test]
fn pi_update_cancelled_during_pause_can_restore_the_already_stopped_subset() {
    let fixture = Fixture::new();
    let calls = Cell::new(0);
    let mut paused = Vec::new();
    let result = pause_services(&fixture.state, &mut paused, &|| {
        calls.set(calls.get() + 1);
        calls.get() > 1
    });
    assert!(result.unwrap_err().contains("取消"));
    assert_eq!(paused.len(), 1);
    assert_eq!(
        fixture
            .urls
            .iter()
            .filter(|url| has_child(&fixture.state, url))
            .count(),
        1
    );
    assert!(restore_services(&fixture.state, paused, &|| false).is_empty());
    assert_eq!(
        fixture
            .urls
            .iter()
            .filter(|url| has_child(&fixture.state, url))
            .count(),
        2
    );
}

#[test]
fn pi_update_exit_does_not_restart_paused_services() {
    let fixture = Fixture::new();
    let mut paused = Vec::new();
    pause_services(&fixture.state, &mut paused, &|| false).unwrap();
    let failures = restore_services(&fixture.state, paused, &|| true);
    assert!(failures[0].contains("正在退出"));
    assert!(fixture
        .urls
        .iter()
        .all(|url| !has_child(&fixture.state, url)));
}

#[test]
fn pi_update_one_restore_failure_does_not_prevent_other_services_restoring() {
    let fixture = Fixture::new();
    let mut paused = Vec::new();
    pause_services(&fixture.state, &mut paused, &|| false).unwrap();
    paused[0].server.start_command = "command-that-does-not-exist-for-pi-update-fixture".into();
    let failed_url = paused[0].url.clone();
    let restored_url = paused[1].url.clone();
    let errors = restore_services(&fixture.state, paused, &|| false);
    assert_eq!(errors.len(), 1);
    assert!(errors[0].contains(&failed_url));
    assert!(!has_child(&fixture.state, &failed_url));
    assert!(has_child(&fixture.state, &restored_url));
    assert!(!has_child(&fixture.state, &fixture.urls[2]));
}
