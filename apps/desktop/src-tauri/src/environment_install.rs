use crate::config::{PackageConfig, ReleaseChannel, ServerConfig, UpdatePolicy};
use crate::environment::{self, Component, EnvironmentState};
use crate::environment_arch::{native_architecture, WindowsArchitecture};
use crate::environment_download::{client, download};
#[cfg(windows)]
use crate::environment_installer;
use crate::environment_source::DownloadSource;
use crate::{logging, packages};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

pub(crate) struct NodeDownload {
    pub version: String,
    pub file: String,
}

pub(crate) fn node_download(
    index: &str,
    architecture: WindowsArchitecture,
) -> Result<NodeDownload, String> {
    #[derive(serde::Deserialize)]
    struct Release {
        version: String,
        files: Vec<String>,
        lts: serde_json::Value,
    }
    let releases: Vec<Release> = serde_json::from_str(index)
        .map_err(|error| format!("Node.js 官方版本索引无效：{error}"))?;
    let architecture = match architecture {
        WindowsArchitecture::X86 => "x86",
        WindowsArchitecture::X64 => "x64",
    };
    let artifact = format!("win-{architecture}-msi");
    let version = releases
        .into_iter()
        .filter(|release| {
            release.lts.as_str().is_some_and(|name| !name.is_empty())
                && release.files.contains(&artifact)
        })
        .filter_map(|release| semver::Version::parse(release.version.trim_start_matches('v')).ok())
        .filter(|version| version.pre.is_empty() && version >= &semver::Version::new(22, 19, 0))
        .max()
        .ok_or_else(|| {
            format!("官方未提供兼容的 Windows {architecture} Node.js LTS 安装包，请手动安装")
        })?;
    Ok(NodeDownload {
        file: format!("node-v{version}-{architecture}.msi"),
        version: format!("v{version}"),
    })
}

#[cfg(any(target_os = "macos", target_os = "linux", test))]
pub(crate) fn unix_node_download(os: &str, arch: &str) -> Result<NodeDownload, String> {
    let platform = match (os, arch) {
        ("linux", "x86_64") => "linux-x64",
        ("macos", "x86_64") => "darwin-x64",
        ("macos", "aarch64") => "darwin-arm64",
        _ => {
            return Err(format!(
                "不支持自动准备 {os} {arch} Node.js，请选择本机环境"
            ));
        }
    };
    Ok(NodeDownload {
        version: "v22.22.2".into(),
        file: format!("node-v22.22.2-{platform}.tar.gz"),
    })
}

pub(crate) struct RuntimeDownloads {
    pub git_url: &'static str,
    pub git_sha256: &'static str,
    pub git_size: u64,
}

pub(crate) fn runtime_downloads(architecture: WindowsArchitecture) -> RuntimeDownloads {
    match architecture {
        WindowsArchitecture::X86 => RuntimeDownloads {
            // 2.48.1 是官方最后包含 Bash 的 32 位完整安装包；后续 MinGit 不能替代。
            git_url: "https://github.com/git-for-windows/git/releases/download/v2.48.1.windows.1/Git-2.48.1-32-bit.exe",
            git_sha256: "fdf9be6795afd911b4ed87417f2d5ac547798b5b47441b9f71984cddef943c3a",
            git_size: 62_864_568,
        },
        WindowsArchitecture::X64 => RuntimeDownloads {
            git_url: "https://github.com/git-for-windows/git/releases/download/v2.51.0.windows.1/Git-2.51.0-64-bit.exe",
            git_sha256: "843037416371600a7f289be8fe2b2224afe1c1bb0736bbab7b3ff393e6a7aaf2",
            git_size: 64_701_312,
        },
    }
}

#[cfg(windows)]
fn architecture_for_host(log: &Path) -> Result<WindowsArchitecture, String> {
    let architecture = native_architecture().map_err(|error| {
        logging::write(
            log,
            "environment-architecture-failed",
            &format!("shell={} error={error}", std::env::consts::ARCH),
        );
        error
    })?;
    logging::write(
        log,
        "environment-download-architecture",
        &format!("shell={} native={architecture:?}", std::env::consts::ARCH),
    );
    Ok(architecture)
}

struct Staging(PathBuf);
impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn staging(state: &EnvironmentState) -> Result<Staging, String> {
    let temporary = state.root.join("staging");
    // 环境操作全局互斥，遗留 staging 只可能来自上一次被强制结束的安装。
    if temporary.exists() {
        fs::remove_dir_all(&temporary).map_err(|error| format!("清理未完成环境失败：{error}"))?;
    }
    fs::create_dir_all(&temporary).map_err(|error| error.to_string())?;
    Ok(Staging(temporary))
}

#[cfg(windows)]
pub(crate) fn install_node(
    state: &EnvironmentState,
    installer: &Path,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<PathBuf, String> {
    state.set_component_step(Component::Node, "正在安装 Node.js，请允许 Windows 授权");
    let install_log = state.root.join("node-install.log");
    let system = environment::windows_system_directory();
    let code = environment_installer::run(
        &system.join("msiexec.exe"),
        &[
            "/i",
            &installer.to_string_lossy(),
            "/passive",
            "/norestart",
            "/L*V",
            &install_log.to_string_lossy(),
        ],
        true,
        log,
        cancelled,
        &|| state.set_component_step(Component::Node, "正在等待 Node.js 安装结束"),
    )?;
    match code {
        0 => {}
        3010 => logging::write(
            log,
            "environment-node-reboot",
            "Node.js 安装成功，Windows 建议重启电脑",
        ),
        1602 => return Err("Node.js 安装已取消".into()),
        _ => {
            return Err(format!(
                "Node.js 安装失败（退出码 {code}），安装日志：{}",
                install_log.display()
            ))
        }
    }
    state.check_components(&[Component::Node], cancelled, log)?;
    state
        .component_path(Component::Node)
        .ok_or_else(|| "Node.js 安装后仍不可用，请检查安装日志或选择已安装的 node.exe".into())
}

#[cfg(not(windows))]
pub(crate) fn install_node(
    _state: &EnvironmentState,
    _installer: &Path,
    _cancelled: &dyn Fn() -> bool,
    _log: &Path,
) -> Result<PathBuf, String> {
    Err("当前平台不支持 MSI；请自动准备 Node.js 或选择已安装的运行环境".into())
}

#[cfg(windows)]
pub(crate) fn prepare(
    state: &EnvironmentState,
    server: &ServerConfig,
    download_source: DownloadSource,
    cancelled: &(dyn Fn() -> bool + Sync),
    log: &Path,
    service: impl FnOnce(&(dyn Fn() -> bool + Sync)) -> Result<(), String> + Send,
) -> Result<(), String> {
    let needs_pi = environment::requires_pi(server);
    if !environment::requires_node(server) && !needs_pi {
        return service(cancelled);
    }
    if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
        return Err("隔离模式禁止安装或修改全局运行环境".into());
    }
    let work = staging(state)?;
    let client = client()?;
    let old_node = state.component_path(Component::Node);
    let node_old_for_pi = state
        .snapshot()
        .components
        .iter()
        .find(|value| value.name == Component::Node)
        .and_then(|value| value.version.as_deref())
        .and_then(|version| semver::Version::parse(version.trim_start_matches('v')).ok())
        .is_some_and(|version| version < semver::Version::new(22, 19, 0));
    for component in [Component::Node, Component::Pi, Component::Bash] {
        let needed = component == Component::Node || needs_pi;
        if needed
            && state.has_manual_choice(component)
            && (state.component_path(component).is_none()
                || (component == Component::Node && needs_pi && node_old_for_pi))
        {
            return Err(format!(
                "明确选择的 {} 不可用或版本不兼容，请安装兼容版本或重新选择路径后检测",
                component.name()
            ));
        }
    }
    let needs_node = old_node.is_none() || (needs_pi && node_old_for_pi);
    let needs_bash = needs_pi && state.component_path(Component::Bash).is_none();
    let install_pi = needs_pi && state.component_path(Component::Pi).is_none();
    logging::write(
        log,
        "environment-prepare",
        &format!("常规安装：source={download_source:?} Node.js={needs_node} Git Bash={needs_bash} Pi={install_pi}"),
    );
    state.set_phase("installing", "正在下载安装包", None);
    if needs_node {
        state.set_component_step(Component::Node, "正在下载 Node.js 安装包");
    }
    if needs_bash {
        state.set_component_step(Component::Bash, "正在下载 Git Bash 安装包");
    }
    prepare_components(
        cancelled,
        |cancelled| {
            if needs_node {
                let node =
                    download_node(state, &client, &work.0, &download_source, cancelled, log)?;
                let installed = install_node(state, &work.0.join(&node.file), cancelled, log)?;
                let actual_version = state.probe(Component::Node, &installed, cancelled, log)?;
                if actual_version != node.version {
                    return Err(
                        "Node.js 安装后检测到的版本与下载版本不一致，请检查已有 Node.js 安装或手动选择路径"
                            .into(),
                    );
                }
            }
            Ok(())
        },
        |cancelled| {
            if needs_bash {
                let installer =
                    download_bash(state, &client, &work.0, &download_source, cancelled, log)?;
                install_bash(state, &installer, cancelled, log)?;
            }
            Ok(())
        },
        |cancelled| {
            if install_pi {
                prepare_pi(state, &work.0, &download_source, cancelled, log)?;
            }
            Ok(())
        },
        service,
    )?;
    state.verify_global_commands(needs_pi, cancelled, log)?;
    logging::write(
        log,
        "environment-prepared",
        "常规运行环境已准备，外部命令校验通过，开始验证服务兼容性",
    );
    Ok(())
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(crate) fn prepare(
    _state: &EnvironmentState,
    _server: &ServerConfig,
    _download_source: DownloadSource,
    _cancelled: &(dyn Fn() -> bool + Sync),
    _log: &Path,
    _service: impl FnOnce(&(dyn Fn() -> bool + Sync)) -> Result<(), String> + Send,
) -> Result<(), String> {
    Err("当前平台不支持自动准备运行环境，请选择本机环境".into())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn prepare(
    state: &EnvironmentState,
    server: &ServerConfig,
    download_source: DownloadSource,
    cancelled: &(dyn Fn() -> bool + Sync),
    log: &Path,
    service: impl FnOnce(&(dyn Fn() -> bool + Sync)) -> Result<(), String> + Send,
) -> Result<(), String> {
    let needs_pi = environment::requires_pi(server);
    if !environment::requires_node(server) && !needs_pi {
        return service(cancelled);
    }
    if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
        return Err("隔离模式禁止下载或安装真实运行环境".into());
    }
    let node_old = state
        .snapshot()
        .components
        .iter()
        .find(|item| item.name == Component::Node)
        .and_then(|item| item.version.as_deref())
        .and_then(|version| semver::Version::parse(version.trim_start_matches('v')).ok())
        .is_some_and(|version| version < semver::Version::new(22, 19, 0));
    for component in [Component::Node, Component::Bash, Component::Pi] {
        if (component == Component::Node || needs_pi)
            && state.has_manual_choice(component)
            && (state.component_path(component).is_none()
                || (component == Component::Node && needs_pi && node_old))
        {
            return Err(format!(
                "明确选择的 {} 不可用或版本不兼容，请修正选择后重新检测",
                component.name()
            ));
        }
    }
    #[cfg(target_os = "linux")]
    if needs_pi && state.component_path(Component::Bash).is_none() {
        return Err("未找到可用的 Git 和 Bash，请通过发行版软件包管理器安装 git 和 bash，然后重新检测或选择已安装的位置".into());
    }
    #[cfg(target_os = "macos")]
    if needs_pi && state.component_path(Component::Bash).is_none() {
        state.set_component_step(Component::Bash, "正在请求安装 Command Line Tools");
        let output = crate::process::run_program(
            Path::new("/usr/bin/xcode-select"),
            &["--install"],
            None,
            Duration::from_secs(15),
            log,
            cancelled,
            &state.child_environment(),
        )?;
        logging::write(
            log,
            "environment-command-line-tools",
            &format!(
                "exit={} stdout={} stderr={}",
                output.status,
                crate::process::decode_output(&output.stdout).trim(),
                crate::process::decode_output(&output.stderr).trim(),
            ),
        );
        return Err(if output.status.success() {
            "已请求系统安装 Command Line Tools；请在系统对话框中完成安装，然后点击重新检测或重试安装".into()
        } else {
            format!(
                "无法自动确认 Git 和 Bash；请安装 Command Line Tools 或选择已有环境后重新检测：{}",
                packages::command_failure(&output)
            )
        });
    }
    let work = staging(state)?;
    state.set_phase("installing", "正在准备应用运行环境", None);
    prepare_components(
        cancelled,
        |cancelled| {
            if state.component_path(Component::Node).is_none() || (needs_pi && node_old) {
                let node =
                    download_node(state, &client()?, &work.0, &download_source, cancelled, log)?;
                let extracted = work.0.join("node");
                fs::create_dir_all(&extracted).map_err(|error| error.to_string())?;
                state.set_component_step(Component::Node, "正在解压并校验 Node.js");
                let output = crate::process::run_program(
                    Path::new("/usr/bin/tar"),
                    &[
                        "-xzf",
                        &work.0.join(&node.file).to_string_lossy(),
                        "--strip-components=1",
                        "-C",
                        &extracted.to_string_lossy(),
                    ],
                    None,
                    Duration::from_secs(60),
                    log,
                    cancelled,
                    &state.child_environment(),
                )?;
                if !output.status.success() {
                    return Err(format!(
                        "解压 Node.js 失败：{}",
                        packages::command_failure(&output)
                    ));
                }
                let executable = extracted.join("bin/node");
                if state.probe(Component::Node, &executable, cancelled, log)? != node.version {
                    return Err("Node.js 实际版本与官方归档版本不一致，已停止安装".into());
                }
                if cancelled() {
                    return Err("操作已取消".into());
                }
                let installed = state.root.join("node");
                if installed.exists() {
                    fs::remove_dir_all(&installed)
                        .map_err(|error| format!("替换应用 Node.js 失败：{error}"))?;
                }
                fs::rename(extracted, &installed)
                    .map_err(|error| format!("安装应用 Node.js 失败：{error}"))?;
                state.use_installed(
                    Component::Node,
                    &installed.join("bin/node"),
                    cancelled,
                    log,
                )?;
            }
            Ok(())
        },
        |_| Ok(()),
        |cancelled| {
            if needs_pi && state.component_path(Component::Pi).is_none() {
                prepare_pi(state, &work.0, &download_source, cancelled, log)?;
            }
            Ok(())
        },
        service,
    )?;
    state.verify_global_commands(needs_pi, cancelled, log)?;
    logging::write(
        log,
        "environment-prepared",
        "应用运行环境已就绪，未修改系统 PATH 或安装系统软件包",
    );
    Ok(())
}

#[cfg(any(windows, target_os = "macos", target_os = "linux", test))]
fn prepare_components(
    cancelled: &(dyn Fn() -> bool + Sync),
    node: impl FnOnce(&(dyn Fn() -> bool + Sync)) -> Result<(), String> + Send,
    bash: impl FnOnce(&(dyn Fn() -> bool + Sync)) -> Result<(), String> + Send,
    pi: impl FnOnce(&(dyn Fn() -> bool + Sync)) -> Result<(), String> + Send,
    service: impl FnOnce(&(dyn Fn() -> bool + Sync)) -> Result<(), String> + Send,
) -> Result<(), String> {
    parallel(
        cancelled,
        |stopped| {
            node(stopped)?;
            if stopped() {
                return Err("操作已取消".into());
            }
            parallel(stopped, pi, service)?;
            Ok(())
        },
        bash,
    )?;
    Ok(())
}

fn parallel<A: Send, B: Send>(
    cancelled: &(dyn Fn() -> bool + Sync),
    first: impl FnOnce(&(dyn Fn() -> bool + Sync)) -> Result<A, String> + Send,
    second: impl FnOnce(&(dyn Fn() -> bool + Sync)) -> Result<B, String> + Send,
) -> Result<(A, B), String> {
    let failure = Mutex::new(None);
    let stopped = || cancelled() || failure.lock().unwrap().is_some();
    thread::scope(|scope| {
        let first = scope.spawn(|| {
            let result = first(&stopped);
            if let Err(error) = &result {
                failure.lock().unwrap().get_or_insert(error.clone());
            }
            result
        });
        let second = second(&stopped);
        if let Err(error) = &second {
            failure.lock().unwrap().get_or_insert(error.clone());
        }
        // 等待全部任务退出后才释放 staging，并保留最先发生的错误而非取消提示。
        let first = first
            .join()
            .map_err(|_| "并行准备任务异常退出".to_string())?;
        if let Some(error) = failure.lock().unwrap().clone() {
            return Err(error);
        }
        Ok((first?, second?))
    })
}

fn download_node(
    state: &EnvironmentState,
    client: &reqwest::Client,
    work: &Path,
    download_source: &DownloadSource,
    cancelled: &(dyn Fn() -> bool + Sync),
    log: &Path,
) -> Result<NodeDownload, String> {
    let node_base = download_source.node_base();
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let node = {
        #[cfg(windows)]
        let architecture = architecture_for_host(log)?;
        #[cfg(not(windows))]
        let architecture = native_architecture()?;
        state.set_component_step(Component::Node, "正在下载 Node.js 版本索引");
        let index = work.join("node-index.json");
        download(
            state,
            Component::Node,
            client,
            &format!("{node_base}index.json"),
            &index,
            None,
            cancelled,
            log,
        )?;
        node_download(
            &fs::read_to_string(index).map_err(|error| error.to_string())?,
            architecture,
        )?
    };
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    let node = unix_node_download(std::env::consts::OS, std::env::consts::ARCH)?;
    logging::write(
        log,
        "environment-node-version",
        &format!("version={} file={}", node.version, node.file),
    );
    state.set_component_step(
        Component::Node,
        &format!("正在下载 Node.js {}", node.version),
    );
    let base = format!("{node_base}{}/", node.version);
    let sums = work.join("SHASUMS256.txt");
    let archive = work.join(&node.file);
    let (actual, _) = parallel(
        cancelled,
        |cancelled| {
            download(
                state,
                Component::Node,
                client,
                &format!("{base}{}", node.file),
                &archive,
                None,
                cancelled,
                log,
            )
        },
        |cancelled| {
            download(
                state,
                Component::Node,
                client,
                &format!("{base}SHASUMS256.txt"),
                &sums,
                None,
                cancelled,
                log,
            )
        },
    )?;
    let expected = fs::read_to_string(&sums)
        .map_err(|error| error.to_string())?
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            (parts.next()? == node.file
                && hash.len() == 64
                && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| hash.to_ascii_lowercase())
        })
        .ok_or("官方 SHA256 清单缺少所选 Node.js 文件")?;
    if actual != expected {
        return Err("Node.js SHA256 校验失败，请重新下载".into());
    }
    Ok(node)
}

#[cfg(windows)]
fn download_bash(
    state: &EnvironmentState,
    client: &reqwest::Client,
    work: &Path,
    download_source: &DownloadSource,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<PathBuf, String> {
    let downloads = runtime_downloads(architecture_for_host(log)?);
    state.set_component_step(Component::Bash, "正在下载 Git Bash");
    let archive = work.join("git-installer.exe");
    if download(
        state,
        Component::Bash,
        client,
        &download_source.git_url(downloads.git_url),
        &archive,
        Some(downloads.git_size),
        cancelled,
        log,
    )? != downloads.git_sha256
    {
        return Err("Git Bash SHA256 校验失败，请重新下载".into());
    }
    Ok(archive)
}

#[cfg(windows)]
fn install_bash(
    state: &EnvironmentState,
    installer: &Path,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<(), String> {
    state.set_component_step(Component::Bash, "正在安装 Git，请允许 Windows 授权");
    let install_log = state.root.join("git-install.log");
    let code = environment_installer::run(
        installer,
        &[
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/NORESTART",
            "/SP-",
            "/o:PathOption=Cmd",
            &format!("/LOG={}", install_log.display()),
        ],
        true,
        log,
        cancelled,
        &|| state.set_component_step(Component::Bash, "正在等待 Git 安装结束"),
    )?;
    if code != 0 {
        return Err(format!(
            "Git 安装失败（退出码 {code}），安装日志：{}",
            install_log.display()
        ));
    }
    state.check_components(&[Component::Bash], cancelled, log)?;
    if state.component_path(Component::Bash).is_none() {
        return Err("Git 安装后仍未找到可用的 Git Bash，请检查安装日志或选择 bash.exe".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "environment_install_tests.rs"]
mod tests;

fn prepare_pi(
    state: &EnvironmentState,
    work: &Path,
    download_source: &DownloadSource,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<(), String> {
    let started = std::time::Instant::now();
    state.set_component_step(Component::Pi, "正在查询 Pi 最新正式版本");
    let node = state
        .component_path(Component::Node)
        .ok_or("Node.js 尚未就绪")?;
    let npm = environment::npm_cli(&node).ok_or("npm 尚未就绪")?;
    let package = PackageConfig {
        name: environment::PI_PACKAGE.into(),
        registry: Some(download_source.npm_registry().into()),
        startup_update: UpdatePolicy::None,
        periodic_update: UpdatePolicy::None,
        channel: ReleaseChannel::Stable,
    };
    let version = packages::query_version_with_environment(
        &package,
        log,
        cancelled,
        &state.npm_command()?,
        &state.child_environment(),
    )?;
    let root = state.run_node(
        &[&npm.to_string_lossy(), "root", "-g"],
        Some(work),
        Duration::from_secs(10),
        cancelled,
        log,
    )?;
    let installed = PathBuf::from(root).join(environment::PI_PACKAGE);
    if state.is_private_path(&installed) {
        return Err("npm 全局目录指向旧桌面私有环境，请调整 npm prefix 后重试".into());
    }
    state.set_component_step(Component::Pi, &format!("正在安装 Pi {version}"));
    logging::write(
        log,
        "environment-pi-install",
        &format!(
            "version={version} registry={}",
            download_source.npm_registry()
        ),
    );
    let installing = std::time::Instant::now();
    let installation = packages::with_registry_fallback(
        &package,
        log,
        cancelled,
        &state.npm_command()?,
        &state.child_environment(),
        |source| {
            state.run_node(
                &[
                    &npm.to_string_lossy(),
                    "install",
                    "-g",
                    "--ignore-scripts",
                    "--no-audit",
                    "--no-fund",
                    "--progress=false",
                    "--registry",
                    source,
                    "--replace-registry-host=never",
                    &format!("--@earendil-works:registry={source}"),
                    &format!("{}@{version}", environment::PI_PACKAGE),
                ],
                Some(work),
                Duration::from_secs(600),
                cancelled,
                log,
            )
        },
    );
    logging::write(
        log,
        "environment-pi-install-end",
        &format!(
            "Pi npm 安装 success={} elapsed_ms={}",
            installation.is_ok(),
            installing.elapsed().as_millis()
        ),
    );
    installation?;
    let actual_version = state.probe(Component::Pi, &installed, cancelled, log)?;
    if actual_version != version {
        return Err("Pi 实际版本与查询的正式版本不一致，已停止安装".into());
    }
    state.use_installed(Component::Pi, &installed, cancelled, log)?;
    logging::write(
        log,
        "environment-pi-prepared",
        &format!(
            "Pi 准备完成 version={version} elapsed_ms={}",
            started.elapsed().as_millis()
        ),
    );
    Ok(())
}
