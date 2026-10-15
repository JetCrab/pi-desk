use crate::config::{PackageConfig, ReleaseChannel, UpdatePolicy};
use crate::environment::{Component, EnvironmentState, PI_PACKAGE};
use crate::environment_source::DownloadSource;
use crate::process::{self, ProcessEnvironment};
use crate::{logging, packages};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(test)]
#[path = "l4-environment-pi-tests.rs"]
mod tests;

pub(crate) struct PiInstallation {
    pub directory: PathBuf,
    pub version: String,
}

struct NpmEnvironment {
    command: String,
    environment: ProcessEnvironment,
}

impl NpmEnvironment {
    fn new(state: &EnvironmentState) -> Result<Self, String> {
        state.npm_command()?;
        let environment = state.child_environment();
        let names: &[&str] = if cfg!(windows) {
            &["npm.exe", "npm.bat", "npm.cmd"]
        } else {
            &["npm"]
        };
        let executable = environment
            .iter()
            .find(|(key, _)| key == "PATH")
            .into_iter()
            .flat_map(|(_, path)| std::env::split_paths(path))
            .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
            .find(|path| path.is_file())
            .ok_or("当前 Node.js 环境未找到 npm")?;
        Ok(Self {
            command: packages::quote(&executable.to_string_lossy()),
            environment,
        })
    }

    fn run(
        &self,
        arguments: &[&str],
        work: &Path,
        timeout: Duration,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<String, String> {
        let command = format!(
            "{} {}",
            self.command,
            arguments
                .iter()
                .map(|argument| packages::quote(argument))
                .collect::<Vec<_>>()
                .join(" ")
        );
        let output = process::run_capture_with_environment(
            &command,
            Some(work),
            timeout,
            log,
            cancelled,
            &self.environment,
        )?;
        if !output.status.success() {
            return Err(packages::command_failure(&output));
        }
        Ok(process::decode_output(&output.stdout).trim().to_string())
    }

    fn global_directory(
        &self,
        state: &EnvironmentState,
        work: &Path,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<PathBuf, String> {
        fs::create_dir_all(work).map_err(|error| format!("创建 Pi 操作目录失败：{error}"))?;
        let root = self.run(
            &["root", "-g"],
            work,
            Duration::from_secs(10),
            cancelled,
            log,
        )?;
        if root.is_empty() || !Path::new(&root).is_absolute() {
            return Err("npm 返回的全局安装目录无效".into());
        }
        let directory = PathBuf::from(root).join(PI_PACKAGE);
        if state.is_private_path(&directory) {
            return Err("npm 全局目录指向旧桌面私有环境，请调整 npm prefix 后重试".into());
        }
        Ok(directory)
    }
}

fn package(download_source: &DownloadSource) -> PackageConfig {
    PackageConfig {
        name: PI_PACKAGE.into(),
        registry: Some(download_source.npm_registry().into()),
        startup_update: UpdatePolicy::None,
        periodic_update: UpdatePolicy::None,
        channel: ReleaseChannel::Stable,
    }
}

fn selected_directory(state: &EnvironmentState) -> Option<PathBuf> {
    state
        .snapshot()
        .components
        .into_iter()
        .find(|component| component.name == Component::Pi)
        .and_then(|component| component.path)
        .map(PathBuf::from)
}

fn installation(directory: &Path) -> Result<PiInstallation, String> {
    let metadata =
        fs::symlink_metadata(directory).map_err(|error| format!("Pi 安装目录不可读：{error}"))?;
    let linked = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let linked = {
        use std::os::windows::fs::MetadataExt;
        linked || metadata.file_attributes() & 0x400 != 0
    };
    if linked {
        return Err("Pi 包目录是 npm link 或符号链接，请在原安装来源更新".into());
    }
    if directory.join(".git").exists() {
        return Err("当前 Pi 是源码安装，请在源码目录更新".into());
    }
    let manifest: serde_json::Value = serde_json::from_slice(
        &fs::read(directory.join("package.json"))
            .map_err(|error| format!("Pi 包清单不可读：{error}"))?,
    )
    .map_err(|error| format!("Pi 包清单无效：{error}"))?;
    if manifest["name"] != PI_PACKAGE {
        return Err("当前目录不是 Pi coding-agent 安装包".into());
    }
    let version = manifest["version"].as_str().ok_or("Pi 版本无效")?;
    semver::Version::parse(version).map_err(|_| "Pi 版本号无效")?;
    Ok(PiInstallation {
        directory: directory.to_path_buf(),
        version: version.into(),
    })
}

fn matching_installation(selected: &Path, global: &Path) -> Result<PiInstallation, String> {
    let current = installation(selected)?;
    let physical =
        fs::canonicalize(selected).map_err(|error| format!("当前 Pi 安装路径无效：{error}"))?;
    let global_physical = fs::canonicalize(global).map_err(|error| {
        format!("当前 Pi 不属于可用的 npm 全局安装，请在原安装来源更新：{error}")
    })?;
    if physical != global_physical {
        return Err(
            "当前 Pi 不属于所选 Node.js 的 npm 全局安装，请在原安装来源更新或重新选择 Pi".into(),
        );
    }
    // 检查未解析的全局包目录，不能把 npm link 的源码目标当作普通全局安装。
    installation(global)?;
    Ok(current)
}

pub(crate) fn update_target(
    state: &EnvironmentState,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<PiInstallation, String> {
    if cancelled() {
        return Err("操作已取消".into());
    }
    let selected = selected_directory(state).ok_or("未找到当前 Pi 安装路径，请先检测或选择 Pi")?;
    let npm = NpmEnvironment::new(state)?;
    let global = npm.global_directory(state, &state.root, cancelled, log)?;
    matching_installation(&selected, &global).inspect_err(|error| {
        logging::write(log, "environment-pi-update-target-failed", error);
    })
}

pub(crate) fn query_version(
    state: &EnvironmentState,
    download_source: &DownloadSource,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<String, String> {
    fs::create_dir_all(&state.root).map_err(|error| format!("创建桌面环境目录失败：{error}"))?;
    let npm = NpmEnvironment::new(state)?;
    packages::query_version_with_environment(
        &package(download_source),
        log,
        cancelled,
        &npm.command,
        &npm.environment,
    )
}

pub(crate) fn install_version(
    state: &EnvironmentState,
    work: &Path,
    download_source: &DownloadSource,
    version: &str,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<(), String> {
    if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
        return Err("隔离模式禁止安装或修改全局运行环境".into());
    }
    let parsed = semver::Version::parse(version).map_err(|_| "Pi 目标版本号无效")?;
    if !parsed.pre.is_empty() {
        return Err("Pi 安装只接受正式版本".into());
    }
    if cancelled() {
        return Err("操作已取消".into());
    }
    // 固定 npm 命令和环境，后续组件进度变化不能改变 PATH 或 npm prefix。
    let npm = NpmEnvironment::new(state)?;
    let global = npm.global_directory(state, work, cancelled, log)?;
    let installed = if let Some(selected) = selected_directory(state) {
        matching_installation(&selected, &global)?.directory
    } else {
        match fs::symlink_metadata(&global) {
            Ok(_) => {
                installation(&global)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Pi 安装目录不可读：{error}")),
        }
        global
    };
    state.set_component_step(Component::Pi, &format!("正在安装 Pi {version}"));
    logging::write(
        log,
        "environment-pi-install",
        &format!(
            "version={version} registry={} directory={}",
            download_source.npm_registry(),
            installed.display()
        ),
    );
    let started = std::time::Instant::now();
    let result = packages::with_registry_fallback(
        &package(download_source),
        log,
        cancelled,
        &npm.command,
        &npm.environment,
        |source| {
            npm.run(
                &[
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
                    &format!("{PI_PACKAGE}@{version}"),
                ],
                work,
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
            result.is_ok(),
            started.elapsed().as_millis()
        ),
    );
    result?;
    if installation(&installed)?.version != version {
        return Err("Pi 实际版本与目标正式版本不一致，已停止安装".into());
    }
    state.use_installed(Component::Pi, &installed, cancelled, log)
}
