use crate::config::{PackageConfig, ServerConfig};
use crate::environment::{self, Component, EnvironmentState};
use crate::environment_arch::{native_architecture, WindowsArchitecture};
use crate::environment_download::{client, download};
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
    state.check(cancelled, log)?;
    state
        .component_path(Component::Node)
        .ok_or_else(|| "Node.js 安装后仍不可用，请检查安装日志或选择已安装的 node.exe".into())
}

pub(crate) fn prepare(
    state: &EnvironmentState,
    server: &ServerConfig,
    download_source: DownloadSource,
    cancelled: &(dyn Fn() -> bool + Sync),
    log: &Path,
) -> Result<(), String> {
    let needs_pi = environment::requires_pi(server);
    if !environment::requires_node(server) && !needs_pi {
        return Ok(());
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
    let (node, bash) = parallel(
        cancelled,
        |cancelled| {
            if needs_node {
                download_node(state, &client, &work.0, download_source, cancelled, log).map(Some)
            } else {
                Ok(None)
            }
        },
        |cancelled| {
            if needs_bash {
                download_bash(state, &client, &work.0, download_source, cancelled, log).map(Some)
            } else {
                Ok(None)
            }
        },
    )?;
    state.set_phase("installing", "正在安装运行环境", None);
    if let Some(node) = node {
        let installed = install_node(state, &work.0.join(&node.file), cancelled, log)?;
        let actual_version = state.probe(Component::Node, &installed, cancelled, log)?;
        if actual_version != node.version {
            return Err(
                "Node.js 安装后检测到的版本与下载版本不一致，请检查已有 Node.js 安装或手动选择路径"
                    .into(),
            );
        }
    }
    if let Some(installer) = bash {
        install_bash(state, &installer, cancelled, log)?;
    }
    if install_pi && state.component_path(Component::Pi).is_none() {
        state.set_phase("installing", "正在安装 Pi", None);
        prepare_pi(state, &work.0, download_source, cancelled, log)?;
    }
    state.verify_global_commands(needs_pi, cancelled, log)?;
    logging::write(
        log,
        "environment-prepared",
        "常规运行环境已准备，外部命令校验通过，开始验证服务兼容性",
    );
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
    download_source: DownloadSource,
    cancelled: &(dyn Fn() -> bool + Sync),
    log: &Path,
) -> Result<NodeDownload, String> {
    let architecture = architecture_for_host(log)?;
    let node_base = download_source.node_base();
    state.set_component_step(Component::Node, "正在下载 Node.js 版本索引");
    let index = work.join("node-index.json");
    download(
        state,
        client,
        &format!("{node_base}index.json"),
        &index,
        None,
        cancelled,
        log,
    )?;
    let node = node_download(
        &fs::read_to_string(index).map_err(|error| error.to_string())?,
        architecture,
    )?;
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

fn download_bash(
    state: &EnvironmentState,
    client: &reqwest::Client,
    work: &Path,
    download_source: DownloadSource,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<PathBuf, String> {
    let downloads = runtime_downloads(architecture_for_host(log)?);
    state.set_component_step(Component::Bash, "正在下载 Git Bash");
    let archive = work.join("git-installer.exe");
    if download(
        state,
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
    state.check(cancelled, log)?;
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
    download_source: DownloadSource,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<(), String> {
    state.set_component_step(Component::Pi, "正在安装 Pi，查询最新正式版本");
    let node = state
        .component_path(Component::Node)
        .ok_or("Node.js 尚未就绪")?;
    let npm = environment::npm_cli(&node).ok_or("npm 尚未就绪")?;
    let package = PackageConfig {
        name: environment::PI_PACKAGE.into(),
        registry: Some(download_source.npm_registry().into()),
        auto_update_on_start: false,
        periodic_update_check: false,
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
            download_source.npm_registry(),
            &format!("{}@{version}", environment::PI_PACKAGE),
        ],
        Some(work),
        Duration::from_secs(600),
        cancelled,
        log,
    )?;
    let actual_version = state.probe(Component::Pi, &installed, cancelled, log)?;
    if actual_version != version {
        return Err("Pi 实际版本与查询的正式版本不一致，已停止安装".into());
    }
    state.use_installed(Component::Pi, &installed, cancelled, log)?;
    Ok(())
}
