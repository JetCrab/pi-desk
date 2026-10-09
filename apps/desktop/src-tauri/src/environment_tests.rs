use super::*;
use crate::config::{default_server_config, PackageConfig, ReleaseChannel, UpdatePolicy};
use std::time::{SystemTime, UNIX_EPOCH};

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(name: &str) -> Self {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-environment")
            .join(format!("{name}-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }

    fn state(&self) -> EnvironmentState {
        EnvironmentState::new(self.0.join("environment"), self.0.join("environment.json"))
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn mark_ready(state: &EnvironmentState, name: Component, version: &str, path: PathBuf) {
    state.replace_component(ComponentSnapshot {
        name,
        status: "ready".into(),
        version: Some(version.into()),
        path: Some(path.to_string_lossy().into_owned()),
        detail: None,
        download: None,
    });
}

fn generic_server() -> ServerConfig {
    ServerConfig {
        start_command: "node server.js".into(),
        ready_path: "/health".into(),
        package: Some(PackageConfig {
            name: "example-service".into(),
            registry: None,
            startup_update: UpdatePolicy::None,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Stable,
        }),
    }
}

#[test]
fn npm_cli_accepts_linux_distribution_layout() {
    let directory = TestDirectory::new("linux-npm-layout");
    let node = directory.0.join("usr/bin/node");
    let cli = directory.0.join("usr/share/nodejs/npm/bin/npm-cli.js");
    fs::create_dir_all(node.parent().unwrap()).unwrap();
    fs::create_dir_all(cli.parent().unwrap()).unwrap();
    fs::write(&node, "").unwrap();
    fs::write(&cli, "").unwrap();
    let found = npm_cli(&node).expect("应识别发行版提供的 npm-cli.js");
    assert_eq!(
        fs::canonicalize(found).unwrap(),
        fs::canonicalize(cli).unwrap()
    );
}

#[cfg(unix)]
#[test]
fn pi_root_resolves_unix_bin_symlinks() {
    let directory = TestDirectory::new("unix-pi-symlink");
    let prefix = directory.0.join("prefix");
    let package = prefix.join("lib/node_modules").join(PI_PACKAGE);
    fs::create_dir_all(package.join("dist")).unwrap();
    fs::create_dir_all(prefix.join("bin")).unwrap();
    fs::write(
        package.join("package.json"),
        format!("{{\"name\":\"{PI_PACKAGE}\"}}"),
    )
    .unwrap();
    fs::write(package.join("dist/cli.js"), "").unwrap();
    let link = prefix.join("bin/pi");
    std::os::unix::fs::symlink(package.join("dist/cli.js"), &link).unwrap();
    assert_eq!(pi_root(&link).unwrap(), fs::canonicalize(package).unwrap());
}

#[test]
fn pi_check_entry_prefers_current_name_and_supports_legacy_packages() {
    let directory = TestDirectory::new("pi-check-entry");
    let bin = directory.0.join("node_modules/@jetcrab/pi-desk/bin");
    fs::create_dir_all(&bin).unwrap();
    let current = bin.join("pi-global-runtime.js");
    let legacy = bin.join("l4-pi-global-runtime.js");
    assert_eq!(pi_runtime_check_script(&directory.0), current);
    fs::write(&legacy, "").unwrap();
    assert_eq!(pi_runtime_check_script(&directory.0), legacy);
    fs::write(&current, "").unwrap();
    assert_eq!(pi_runtime_check_script(&directory.0), current);
}

#[test]
fn missing_environment_blocks_only_services_that_require_it() {
    let directory = TestDirectory::new("service-requirements");
    let state = directory.state();
    let pi = default_server_config();
    let generic = generic_server();
    let independent = ServerConfig {
        start_command: "native-service.exe".into(),
        ready_path: "/health".into(),
        package: None,
    };
    assert!(state.needs_setup(&pi));
    assert!(state.needs_setup(&generic));
    assert!(!state.needs_setup(&independent));

    mark_ready(
        &state,
        Component::Node,
        "v22.22.2",
        directory.0.join("node/node.exe"),
    );
    state.finish_check(&[pi.clone(), generic.clone(), independent]);
    assert!(
        !state.needs_setup(&generic),
        "通用 npm 服务不应被 Pi/Bash 缺失拦截"
    );
    assert!(state.needs_setup(&pi));
    assert_eq!(state.snapshot().status, "required");

    mark_ready(
        &state,
        Component::Pi,
        "1.0.1",
        directory.0.join("pi/node_modules").join(PI_PACKAGE),
    );
    mark_ready(
        &state,
        Component::Bash,
        "GNU bash 5",
        directory.0.join("git/bin/bash.exe"),
    );
    state.finish_check(&[pi.clone(), generic]);
    assert!(!state.needs_setup(&pi));
    assert_eq!(state.snapshot().status, "ready");
}

#[test]
fn pi_rejects_old_node_without_blocking_generic_services() {
    let directory = TestDirectory::new("node-compatibility");
    let state = directory.state();
    mark_ready(
        &state,
        Component::Node,
        "v22.18.0",
        directory.0.join("node/node.exe"),
    );
    mark_ready(
        &state,
        Component::Pi,
        "1.0.1",
        directory.0.join("pi/node_modules").join(PI_PACKAGE),
    );
    mark_ready(
        &state,
        Component::Bash,
        "GNU bash 5",
        directory.0.join("git/bin/bash.exe"),
    );
    let pi = default_server_config();
    state.finish_check(&[pi.clone()]);
    assert!(state.needs_setup(&pi));
    assert!(!state.needs_setup(&generic_server()));
    mark_ready(
        &state,
        Component::Node,
        "v22.19.0",
        directory.0.join("node/node.exe"),
    );
    state.finish_check(&[pi.clone()]);
    assert!(!state.needs_setup(&pi));
    state.set_phase("checking", "正在检查", None);
    assert!(state.needs_setup(&pi), "重检未完成不得使用陈旧 ready 状态");
}

#[test]
fn chosen_runtime_is_injected_only_into_child_environment() {
    let directory = TestDirectory::new("child-environment");
    let state = directory.state();
    let original = std::env::var_os("PATH");
    let node = directory.0.join("node/node.exe");
    let pi = directory.0.join("pi/node_modules").join(PI_PACKAGE);
    let bash = directory.0.join("git/bin/bash.exe");
    mark_ready(&state, Component::Node, "v22.22.2", node.clone());
    mark_ready(&state, Component::Pi, "1.0.1", pi.clone());
    mark_ready(&state, Component::Bash, "GNU bash 5", bash.clone());
    let env = state.child_environment();
    let path = env.iter().find(|(name, _)| name == "PATH").unwrap();
    let parts = std::env::split_paths(&path.1).collect::<Vec<_>>();
    assert_eq!(parts.first().unwrap(), node.parent().unwrap());
    #[cfg(windows)]
    assert!(parts.contains(&directory.0.join("pi")));
    assert!(parts.contains(&directory.0.join("git/bin")));
    #[cfg(windows)]
    assert!(parts.contains(&directory.0.join("git/cmd")));
    assert!(env
        .iter()
        .any(|(name, value)| name == "PI_DESK_PI_PACKAGE_DIR" && value == pi.as_os_str()));
    assert!(env
        .iter()
        .any(|(name, value)| name == "npm_config_maxsockets" && value == "10"));
    assert_eq!(
        std::env::var_os("PATH"),
        original,
        "不得更改宿主或系统 PATH"
    );
}

#[cfg(unix)]
#[test]
fn unix_runtime_uses_application_prefix_without_changing_host_path() {
    let directory = TestDirectory::new("unix-prefix");
    let state = directory.state();
    let original = std::env::var_os("PATH");
    let prefix = state.root.join("npm");
    let pi = prefix.join("lib/node_modules").join(PI_PACKAGE);
    mark_ready(
        &state,
        Component::Node,
        "v22.22.2",
        state.root.join("node/bin/node"),
    );
    mark_ready(&state, Component::Pi, "1.0.1", pi.clone());
    let environment = state.child_environment();
    let path = environment.iter().find(|(name, _)| name == "PATH").unwrap();
    let paths = std::env::split_paths(&path.1).collect::<Vec<_>>();
    assert!(paths.contains(&prefix.join("bin")));
    assert!(environment
        .iter()
        .any(|(name, value)| name == "npm_config_prefix" && value == prefix.as_os_str()));
    assert!(!state.is_private_path(&pi));
    assert_eq!(std::env::var_os("PATH"), original);
}

#[test]
fn preparation_steps_preserve_parallel_progress_and_clear_stale_status_on_exit() {
    let directory = TestDirectory::new("parallel-status");
    let state = directory.state();
    state.set_phase("installing", "正在准备", None);
    state.set_component_step(Component::Node, "正在下载 Node.js");
    state.set_component_step(Component::Bash, "正在下载 Git Bash");
    state.progress(
        Component::Node,
        &directory.0.join("node.zip"),
        10,
        Some(100),
    );
    state.progress(Component::Bash, &directory.0.join("git.exe"), 20, None);
    let snapshot = state.snapshot();
    let node = snapshot
        .components
        .iter()
        .find(|item| item.name == Component::Node)
        .unwrap();
    let bash = snapshot
        .components
        .iter()
        .find(|item| item.name == Component::Bash)
        .unwrap();
    assert_eq!(node.download.as_ref().unwrap().received, 10);
    assert_eq!(node.download.as_ref().unwrap().total, Some(100));
    assert_eq!(bash.download.as_ref().unwrap().received, 20);
    assert_eq!(
        bash.download.as_ref().unwrap().total,
        None,
        "未知大小不能显示虚假百分比"
    );
    state.set_component_step(Component::Bash, "正在解压并校验 Git Bash");
    let snapshot = state.snapshot();
    assert!(
        snapshot
            .components
            .iter()
            .find(|item| item.name == Component::Bash)
            .unwrap()
            .download
            .is_none(),
        "安装阶段不能保留下载进度"
    );
    assert_eq!(
        snapshot
            .components
            .iter()
            .find(|item| item.name == Component::Node)
            .unwrap()
            .download
            .as_ref()
            .unwrap()
            .received,
        10
    );
    assert!(snapshot
        .components
        .iter()
        .find(|component| component.name == Component::Bash)
        .unwrap()
        .detail
        .as_ref()
        .unwrap()
        .contains("解压"));
    mark_ready(
        &state,
        Component::Bash,
        "GNU bash 5",
        directory.0.join("git/bin/bash.exe"),
    );
    assert_eq!(state.snapshot().step, "正在下载 Node.js");
    state.set_phase("failed", "准备未完成", Some("网络错误".into()));
    assert!(state
        .snapshot()
        .components
        .iter()
        .all(|item| item.download.is_none()));
    assert!(state
        .snapshot()
        .components
        .iter()
        .all(|component| component.detail.is_none()));
    state.set_phase("installing", "正在重试", None);
    state.progress(Component::Node, &directory.0.join("retry.zip"), 1, Some(2));
    assert_eq!(
        state
            .snapshot()
            .components
            .iter()
            .find(|item| item.name == Component::Node)
            .unwrap()
            .download
            .as_ref()
            .unwrap()
            .received,
        1,
        "重试不能保留旧下载字节"
    );
}

#[test]
fn checking_one_installer_preserves_other_components_and_download_progress() {
    let directory = TestDirectory::new("parallel-component-check");
    for checking in [Component::Node, Component::Bash] {
        let state = directory.state();
        state.set_phase("installing", "正在准备", None);
        state.set_component_step(Component::Node, "正在安装 Node.js");
        state.set_component_step(Component::Bash, "正在下载 Git Bash");
        state.set_component_step(Component::Pi, "正在安装 Pi");
        state.progress(Component::Bash, &directory.0.join("git.exe"), 10, Some(100));
        let before = state.snapshot();
        state
            .check_in_path(
                &[checking],
                OsString::new(),
                false,
                None,
                &|| false,
                &directory.0.join("desktop.log"),
            )
            .unwrap();
        let after = state.snapshot();
        for component in before
            .components
            .iter()
            .filter(|item| item.name != checking)
        {
            let actual = after
                .components
                .iter()
                .find(|item| item.name == component.name)
                .unwrap();
            assert_eq!(actual.status, component.status);
            assert_eq!(actual.detail, component.detail);
        }
        assert_eq!(after.status, "installing");
        if checking != Component::Bash {
            assert_eq!(
                after
                    .components
                    .iter()
                    .find(|item| item.name == Component::Bash)
                    .unwrap()
                    .download
                    .as_ref()
                    .unwrap()
                    .received,
                10
            );
        }
        assert_eq!(after.step, before.step);
    }
}

#[test]
fn explicit_selection_never_silently_falls_back_to_another_installation() {
    let directory = TestDirectory::new("explicit-choice");
    let selected = directory.0.join("selected/node.exe");
    assert_eq!(
        candidates(
            "node.exe",
            Some(selected.clone()),
            &OsString::from("C:/elsewhere"),
            &["C:/Program Files/nodejs/node.exe"],
            false,
        ),
        vec![selected]
    );
}

#[cfg(windows)]
#[test]
fn missing_command_error_preserves_windows_localized_output() {
    let directory = TestDirectory::new("windows-command-output");
    let output = process::run_capture(
        "pi_desk_environment_missing_command",
        None,
        Duration::from_secs(10),
        &directory.0.join("desktop.log"),
        &|| false,
    )
    .unwrap();
    assert!(!output.status.success());
    let text = process::decode_output(&output.stderr);
    assert!(!text.trim().is_empty());
    assert!(
        !text.contains('\u{fffd}'),
        "Windows 命令输出不应含乱码替换字符：{text}"
    );
}

#[test]
fn runtime_downloads_follow_native_windows_architecture() {
    use crate::environment_arch::{from_processor_architecture, WindowsArchitecture};
    assert_eq!(
        from_processor_architecture(0).unwrap(),
        WindowsArchitecture::X86
    );
    assert_eq!(
        from_processor_architecture(9).unwrap(),
        WindowsArchitecture::X64
    );
    assert!(
        from_processor_architecture(12).is_err(),
        "不得把 ARM64 当作32位系统"
    );
    assert!(from_processor_architecture(u16::MAX).is_err());

    let x86 = environment_install::runtime_downloads(WindowsArchitecture::X86);
    assert!(x86
        .git_url
        .ends_with("/v2.48.1.windows.1/Git-2.48.1-32-bit.exe"));
    let x64 = environment_install::runtime_downloads(WindowsArchitecture::X64);
    assert!(x64
        .git_url
        .ends_with("/v2.51.0.windows.1/Git-2.51.0-64-bit.exe"));
    assert_eq!(x64.git_size, 64_701_312);
    assert_eq!(
        x64.git_sha256,
        "843037416371600a7f289be8fe2b2224afe1c1bb0736bbab7b3ff393e6a7aaf2"
    );
    assert_eq!(x86.git_size, 62_864_568);
    assert_eq!(
        x86.git_sha256,
        "fdf9be6795afd911b4ed87417f2d5ac547798b5b47441b9f71984cddef943c3a"
    );
    assert_ne!(x86.git_sha256, x64.git_sha256);
}

#[test]
fn node_download_selects_latest_stable_lts_available_for_each_architecture() {
    use crate::environment_arch::WindowsArchitecture;
    let index = r#"[
        {"version":"v24.1.0","lts":"Krypton","files":["win-x64-msi"]},
        {"version":"v26.1.0","lts":false,"files":["win-x64-msi","win-x86-msi"]},
        {"version":"v24.9.0","lts":"Krypton","files":["win-x64-msi"]},
        {"version":"v22.23.3","lts":"Jod","files":["win-x64-msi","win-x86-msi"]},
        {"version":"v24.10.0","lts":"Krypton","files":["win-x64-msi"]},
        {"version":"v24.11.0","lts":"Krypton","files":["win-x64-zip"]},
        {"version":"v28.0.0-rc.1","lts":"Future","files":["win-x64-msi","win-x86-msi"]}
    ]"#;
    let x64 = environment_install::node_download(index, WindowsArchitecture::X64).unwrap();
    assert_eq!(x64.version, "v24.10.0");
    assert_eq!(x64.file, "node-v24.10.0-x64.msi");
    let x86 = environment_install::node_download(index, WindowsArchitecture::X86).unwrap();
    assert_eq!(x86.version, "v22.23.3");
    assert_eq!(x86.file, "node-v22.23.3-x86.msi");
    let incompatible = r#"[
        {"version":"v20.19.0","lts":"Iron","files":["win-x86-msi"]},
        {"version":"v24.10.0","lts":"Krypton","files":["win-x64-msi"]}
    ]"#;
    assert!(environment_install::node_download(incompatible, WindowsArchitecture::X86).is_err());
}

#[cfg(windows)]
#[test]
fn native_architecture_matches_operating_system_independent_of_shell_bitness() {
    use crate::environment_arch::{native_architecture, WindowsArchitecture};
    let directory = TestDirectory::new("native-architecture");
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, IsWow64Process};
    let mut wow64 = 0;
    assert_ne!(
        unsafe { IsWow64Process(GetCurrentProcess(), &mut wow64) },
        0
    );
    let expected = if cfg!(target_pointer_width = "64") || wow64 != 0 {
        WindowsArchitecture::X64
    } else {
        WindowsArchitecture::X86
    };
    assert_eq!(native_architecture().unwrap(), expected);
    let refreshed = refreshed_path(&directory.0.join("path-refresh.log"), &|| false, true);
    let paths = std::env::split_paths(&refreshed).collect::<Vec<_>>();
    for path in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        assert!(paths.contains(&path), "重读环境不得丢失原有 PATH");
    }
    let log = fs::read_to_string(directory.0.join("path-refresh.log")).unwrap();
    assert!(
        !log.contains("environment-path-refresh-failed"),
        "原生环境读取失败：{log}"
    );
}

#[test]
fn old_private_runtime_is_not_reused_or_deleted_by_detection() {
    let directory = TestDirectory::new("legacy-private-runtime");
    let state = directory.state();
    let node = state.root.join("node/node.exe");
    let pi = state.root.join("pi/node_modules").join(PI_PACKAGE);
    let bash = state.root.join("git/bin/bash.exe");
    for path in [&node, &pi.join("package.json"), &bash] {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, b"legacy").unwrap();
    }
    state.data.lock().unwrap().choices = Choices {
        node: Some(fs::canonicalize(&node).unwrap()),
        pi: Some(fs::canonicalize(&pi).unwrap()),
        bash: Some(fs::canonicalize(&bash).unwrap()),
        download_source: None,
    };
    let search = std::env::join_paths([node.parent().unwrap(), bash.parent().unwrap()]).unwrap();
    state
        .check_in_path(
            &[Component::Node, Component::Pi, Component::Bash],
            search,
            false,
            None,
            &|| false,
            &directory.0.join("desktop.log"),
        )
        .unwrap();
    assert!(state
        .snapshot()
        .components
        .iter()
        .all(|component| component.status == "missing"));
    for component in [Component::Node, Component::Pi] {
        assert!(!state.has_manual_choice(component));
    }
    assert_eq!(fs::read(node).unwrap(), b"legacy");
    assert_eq!(fs::read(bash).unwrap(), b"legacy");
    assert_eq!(fs::read(pi.join("package.json")).unwrap(), b"legacy");
    assert!(
        !directory.0.join("desktop.log").exists(),
        "排除私有环境时不得启动旧程序"
    );
}

#[cfg(windows)]
#[test]
fn external_command_failure_keeps_setup_required() {
    let directory = TestDirectory::new("external-command-failure");
    for (command, path, reason) in [
        ("pi", OsString::new(), "仍不可用"),
        ("node", std::env::var_os("PATH").unwrap(), "另一版本"),
    ] {
        let state = directory.state();
        fs::create_dir_all(&state.root).unwrap();
        mark_ready(
            &state,
            Component::Node,
            "v99.0.0",
            directory.0.join("node/node.exe"),
        );
        mark_ready(
            &state,
            Component::Pi,
            "1.0.1",
            directory.0.join("pi/node_modules").join(PI_PACKAGE),
        );
        mark_ready(
            &state,
            Component::Bash,
            "GNU bash 5",
            directory.0.join("git/bin/bash.exe"),
        );
        let server = default_server_config();
        state.finish_check(&[server.clone()]);
        assert!(!state.needs_setup(&server));
        let error = state
            .check_global_command(command, &path, &|| false, &directory.0.join("desktop.log"))
            .unwrap_err();
        assert!(error.contains(reason), "{error}");
        assert!(state.needs_setup(&server));
        assert!(state
            .snapshot()
            .components
            .iter()
            .any(|component| component.status == "invalid"
                && component.detail.as_deref() == Some(error.as_str())));
    }
}

#[test]
fn explicit_pi_shell_path_pointing_to_private_runtime_is_reported_instead_of_ignored() {
    let directory = TestDirectory::new("private-pi-shell");
    let state = directory.state();
    let path = state.root.join("git/bin/bash.exe");
    state
        .check_in_path(
            &[Component::Node, Component::Pi, Component::Bash],
            OsString::new(),
            false,
            Some(path.clone()),
            &|| false,
            &directory.0.join("desktop.log"),
        )
        .unwrap();
    let bash = state
        .snapshot()
        .components
        .into_iter()
        .find(|component| component.name == Component::Bash)
        .unwrap();
    assert_eq!(bash.status, "invalid");
    assert_eq!(bash.path, Some(path.to_string_lossy().into_owned()));
    assert!(bash.detail.unwrap().contains("shellPath"));
    assert!(!directory.0.join("desktop.log").exists());
}
