#![cfg(windows)]

use super::{
    control_state, execute_operation, load_runtime_info, package_directory,
    record_operation_failure, stop_active_child, Operation, RuntimeInfo, ShellState,
    TargetRuntimeInfo,
};
use crate::config::{
    DesktopConfig, PackageConfig, ServerConfig, TargetConfig, TunnelConnectionConfig,
};
use crate::packages::{
    self,
    tests::{pack_fixture, LocalRegistry, PACKAGE_NAME},
};
use crate::test_support::NpmEnvironment;
use std::fs;
use std::net::TcpListener;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const HEALTHY_ENTRY: &str = "#!/usr/bin/env node\nconst http=require('node:http');const port=Number(process.argv[process.argv.indexOf('-p')+1]);http.createServer((req,res)=>res.writeHead(204).end()).listen(port,'127.0.0.1');\n";

struct Fixture {
    root: PathBuf,
    state: ShellState,
    server: ServerConfig,
    url: String,
    port: u16,
    installed: PathBuf,
    registry: Option<LocalRegistry>,
    _environment: NpmEnvironment,
}

impl Fixture {
    fn new(name: &str, entry: &str) -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/run/desktop-generic-service")
            .join(format!("{name}-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let environment = NpmEnvironment::new(&root);
        let log = root.join("logs/desktop.log");
        let tarball = pack_fixture(&root, "1.2.3", Some(entry), None, &log);
        let registry = LocalRegistry::new(vec![tarball]);
        let port = TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let url = format!("http://127.0.0.1:{port}/");
        let package = PackageConfig {
            name: PACKAGE_NAME.into(),
            registry: Some(registry.address.clone()),
            auto_update_on_start: false,
            periodic_update_check: false,
        };
        let server = ServerConfig {
            start_command: "node_modules\\.bin\\fixture-service.cmd -p {port}".into(),
            ready_path: "/health".into(),
            package: Some(package.clone()),
        };
        let mut info = RuntimeInfo::default();
        info.targets.insert(
            url.clone(),
            TargetRuntimeInfo {
                last_version: Some("1.2.3".into()),
                auto_start: false,
            },
        );
        let state = ShellState::new(
            DesktopConfig {
                targets: vec![TargetConfig {
                    url: url.clone(),
                    server: Some(server.clone()),
                    tunnel: None,
                }],
                tunnel: TunnelConnectionConfig::default(),
            },
            info,
            root.join("config.json"),
            root.join("runtime.json"),
            log,
        );
        let installed = packages::install(
            &package_directory(&state, &url).unwrap(),
            &package,
            "1.2.3",
            &state.log_path,
            &|| false,
        )
        .unwrap();
        Self {
            root,
            state,
            server,
            url,
            port,
            installed,
            registry: Some(registry),
            _environment: environment,
        }
    }

    fn entry(&self) -> PathBuf {
        self.installed
            .join("node_modules")
            .join(PACKAGE_NAME)
            .join("service.cjs")
    }

    fn log(&self) -> String {
        fs::read_to_string(&self.state.log_path).unwrap()
    }

    fn start(&self) -> Result<(), String> {
        execute_operation(
            &self.state,
            &self.url,
            &self.server,
            Operation::Start,
            &|| false,
        )
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = stop_active_child(&self.state, &self.url);
        self.registry.take();
        if !std::thread::panicking() {
            assert!(
                TcpListener::bind(("127.0.0.1", self.port)).is_ok(),
                "服务端口必须释放"
            );
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
}

#[test]
fn generic_npm_binary_starts_without_pi_desk_files() {
    let fixture = Fixture::new("npm-binary", HEALTHY_ENTRY);
    fixture.start().unwrap();

    let snapshot = control_state(&fixture.state).unwrap();
    let server = snapshot.targets[0].server.as_ref().unwrap();
    assert_eq!(server.status, "running");
    assert_eq!(server.version.as_deref(), Some("1.2.3"));
    let package = fixture.installed.join("node_modules").join(PACKAGE_NAME);
    assert!(!package.join("l1-server.ts").exists());
    assert!(!package.join("temp/next/BUILD_ID").exists());
    assert!(!fixture
        .installed
        .join("node_modules/.bin/pi-desk.cmd")
        .exists());
}

#[test]
fn startup_failure_reports_exit_code_without_reinstall_or_retry() {
    for exit_code in [9, 78] {
        let entry = format!(
            "#!/usr/bin/env node\nconsole.error('fixture-release-failure');process.exit({exit_code});\n"
        );
        let fixture = Fixture::new("failed-start", &entry);
        let before = fixture.log();
        let result = fixture.start();
        let error = result.as_ref().unwrap_err();
        assert!(error.contains("服务进程提前退出"), "{error}");
        assert!(error.contains(&exit_code.to_string()), "{error}");
        record_operation_failure(
            &fixture.state,
            &fixture.url,
            &fixture.server,
            Operation::Start,
            &result,
            &|| false,
        );

        let snapshot = control_state(&fixture.state).unwrap();
        assert_eq!(
            snapshot.targets[0].server.as_ref().unwrap().status,
            "failed"
        );
        let log = fixture.log();
        assert_eq!(log.matches("[server-spawn]").count(), 1);
        assert_eq!(
            log.matches("command=npm install ").count(),
            before.matches("command=npm install ").count()
        );
        assert_eq!(fs::read_to_string(fixture.entry()).unwrap(), entry);
    }
}

#[test]
fn stopped_service_update_only_installs_without_starting() {
    let fixture = Fixture::new("install-only", HEALTHY_ENTRY);
    execute_operation(
        &fixture.state,
        &fixture.url,
        &fixture.server,
        Operation::Update,
        &|| false,
    )
    .unwrap();
    assert_eq!(
        control_state(&fixture.state).unwrap().targets[0]
            .server
            .as_ref()
            .unwrap()
            .status,
        "stopped"
    );
    assert!(!fixture.log().contains("[server-spawn]"));
}

#[test]
fn stopped_update_then_failed_start_restores_previous_install_after_reload() {
    let mut fixture = Fixture::new("install-start-rollback", HEALTHY_ENTRY);
    let tarball = pack_fixture(
        &fixture.root,
        "2.0.0",
        Some("#!/usr/bin/env node\nprocess.exit(9);\n"),
        None,
        &fixture.state.log_path,
    );
    let registry = LocalRegistry::new(vec![tarball]);
    fixture.server.package.as_mut().unwrap().registry = Some(registry.address.clone());
    fixture.registry = Some(registry);
    let config = DesktopConfig {
        targets: vec![TargetConfig {
            url: fixture.url.clone(),
            server: Some(fixture.server.clone()),
            tunnel: None,
        }],
        tunnel: TunnelConnectionConfig::default(),
    };
    execute_operation(
        &fixture.state,
        &fixture.url,
        &fixture.server,
        Operation::Update,
        &|| false,
    )
    .unwrap();
    let runtime_path = fixture.root.join("runtime.json");
    let info = load_runtime_info(&runtime_path, &config);
    assert_eq!(
        info.targets[&fixture.url].last_version.as_deref(),
        Some("2.0.0")
    );
    fixture.state = ShellState::new(
        config,
        info,
        fixture.root.join("config.json"),
        runtime_path,
        fixture.root.join("logs/desktop.log"),
    );
    let before = fixture.log();
    let error = fixture.start().unwrap_err();
    assert!(error.contains("已恢复原服务"), "{error}");
    let snapshot = control_state(&fixture.state).unwrap();
    let server = snapshot.targets[0].server.as_ref().unwrap();
    assert_eq!(server.status, "running");
    assert_eq!(server.version.as_deref(), Some("1.2.3"));
    let base = package_directory(&fixture.state, &fixture.url).unwrap();
    assert!(
        !packages::version_directory(&base, fixture.server.package.as_ref().unwrap(), "2.0.0")
            .exists()
    );
    assert_eq!(
        fixture.log().matches("command=npm install ").count(),
        before.matches("command=npm install ").count()
    );
}

#[test]
fn changed_start_command_failure_restores_original_command() {
    let fixture = Fixture::new("changed-command-rollback", HEALTHY_ENTRY);
    fixture.start().unwrap();
    let mut changed = fixture.server.clone();
    changed.start_command = "node -e \"process.exit(9)\"".into();
    let error = execute_operation(
        &fixture.state,
        &fixture.url,
        &changed,
        Operation::Restart,
        &|| false,
    )
    .unwrap_err();
    assert!(error.contains("已恢复原服务"), "{error}");
    assert_eq!(
        control_state(&fixture.state).unwrap().targets[0]
            .server
            .as_ref()
            .unwrap()
            .status,
        "running"
    );
    assert_eq!(fixture.log().matches("[server-spawn]").count(), 3);
}

#[test]
fn occupied_port_and_cancellation_do_not_reinstall_or_stop_another_service() {
    let fixture = Fixture::new("occupied-or-cancelled", HEALTHY_ENTRY);
    let before = fixture.log();
    let listener = TcpListener::bind(("127.0.0.1", fixture.port)).unwrap();
    let error = fixture.start().unwrap_err();
    assert!(error.contains(&format!("端口 {} 暂不可用", fixture.port)));
    assert!(error.contains("未停止占用进程"));
    assert_eq!(listener.local_addr().unwrap().port(), fixture.port);
    drop(listener);
    let result = execute_operation(
        &fixture.state,
        &fixture.url,
        &fixture.server,
        Operation::Start,
        &|| true,
    );
    assert!(result.unwrap_err().contains("已取消"));
    let log = fixture.log();
    assert!(!log.contains("[server-spawn]"));
    assert_eq!(
        log.matches("command=npm install ").count(),
        before.matches("command=npm install ").count()
    );
    assert_eq!(fs::read_to_string(fixture.entry()).unwrap(), HEALTHY_ENTRY);
}
