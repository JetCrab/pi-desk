use crate::config::ServerConfig;
use crate::environment_arch::{native_architecture, WindowsArchitecture};
use crate::environment_install;
use crate::environment_source::{self, DownloadSource};
use crate::process::{self, ProcessEnvironment};
use crate::{logging, packages};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

pub(crate) const PI_PACKAGE: &str = "@earendil-works/pi-coding-agent";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Component {
    Node,
    Pi,
    Bash,
}

impl Component {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Node => "node",
            Self::Pi => "pi",
            Self::Bash => "bash",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ComponentSnapshot {
    pub name: Component,
    pub status: String,
    pub version: Option<String>,
    pub path: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct DownloadSnapshot {
    pub received: u64,
    pub total: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct EnvironmentSnapshot {
    pub status: String,
    pub components: Vec<ComponentSnapshot>,
    pub step: String,
    pub download: Option<DownloadSnapshot>,
    pub error: Option<String>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Choices {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    node: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pi: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bash: Option<PathBuf>,
    #[serde(
        default,
        rename = "downloadSource",
        skip_serializing_if = "Option::is_none"
    )]
    download_source: Option<DownloadSource>,
}

struct EnvironmentData {
    snapshot: EnvironmentSnapshot,
    choices: Choices,
    search_path: OsString,
    preparation_steps: Vec<(Component, String)>,
    downloads: BTreeMap<PathBuf, DownloadSnapshot>,
}

impl EnvironmentData {
    fn update_preparation_step(&mut self) {
        self.snapshot.step = match self.preparation_steps.as_slice() {
            [] => "正在验证准备结果".into(),
            [(_, step)] => step.clone(),
            steps => steps
                .iter()
                .map(|(_, step)| step.as_str())
                .collect::<Vec<_>>()
                .join("；"),
        };
    }
}

pub(crate) struct EnvironmentState {
    pub(crate) root: PathBuf,
    choices_path: PathBuf,
    data: Mutex<EnvironmentData>,
    source_recommendation: tokio::sync::OnceCell<DownloadSource>,
}

pub(crate) fn requires_pi(server: &ServerConfig) -> bool {
    server
        .package
        .as_ref()
        .is_some_and(|package| package.name == "@jetcrab/pi-desk")
}

pub(crate) fn requires_node(server: &ServerConfig) -> bool {
    server.package.is_some()
        || server
            .start_command
            .split_whitespace()
            .next()
            .is_some_and(|word| {
                matches!(
                    word.trim_matches('"').to_lowercase().as_str(),
                    "node" | "node.exe" | "npm" | "npm.cmd" | "npx" | "npx.cmd"
                )
            })
}

impl EnvironmentState {
    pub(crate) fn new(root: PathBuf, choices_path: PathBuf) -> Self {
        let choices = fs::read(&choices_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            root,
            choices_path,
            source_recommendation: tokio::sync::OnceCell::new(),
            data: Mutex::new(EnvironmentData {
                choices,
                search_path: std::env::var_os("PATH").unwrap_or_default(),
                preparation_steps: Vec::new(),
                downloads: BTreeMap::new(),
                snapshot: EnvironmentSnapshot {
                    status: "checking".into(),
                    components: [Component::Node, Component::Pi, Component::Bash]
                        .into_iter()
                        .map(|name| ComponentSnapshot {
                            name,
                            status: "missing".into(),
                            version: None,
                            path: None,
                            detail: None,
                        })
                        .collect(),
                    step: "正在检测本机环境".into(),
                    download: None,
                    error: None,
                },
            }),
        }
    }

    pub(crate) async fn download_source(&self, lookup_url: &str, log: &Path) -> DownloadSource {
        if cfg!(target_os = "macos") {
            return DownloadSource::Official;
        }
        if let Some(source) = self.data.lock().unwrap().choices.download_source {
            return source;
        }
        let recommended = *self
            .source_recommendation
            .get_or_init(|| environment_source::recommend(lookup_url, log))
            .await;
        self.data
            .lock()
            .unwrap()
            .choices
            .download_source
            .unwrap_or(recommended)
    }

    pub(crate) fn save_download_source(&self, source: DownloadSource) -> Result<(), String> {
        let mut data = self.data.lock().unwrap();
        let mut choices = data.choices.clone();
        choices.download_source = Some(source);
        self.save_choices(&choices)?;
        data.choices = choices;
        Ok(())
    }

    fn save_choices(&self, choices: &Choices) -> Result<(), String> {
        if let Some(parent) = self.choices_path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let temporary = self.choices_path.with_extension("json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(choices).map_err(|error| error.to_string())?,
        )
        .and_then(|_| fs::rename(&temporary, &self.choices_path))
        .map_err(|error| format!("保存桌面环境选择失败：{error}"))
    }

    pub(crate) fn snapshot(&self) -> EnvironmentSnapshot {
        self.data.lock().unwrap().snapshot.clone()
    }

    pub(crate) fn set_phase(&self, status: &str, step: &str, error: Option<String>) {
        let mut data = self.data.lock().unwrap();
        data.snapshot.status = status.into();
        data.snapshot.step = step.into();
        data.snapshot.error = error;
        data.snapshot.download = None;
        let steps = std::mem::take(&mut data.preparation_steps);
        for (component, _) in steps {
            if let Some(slot) = data
                .snapshot
                .components
                .iter_mut()
                .find(|slot| slot.name == component)
            {
                slot.detail = None;
            }
        }
        data.downloads.clear();
    }

    pub(crate) fn set_component_step(&self, component: Component, step: &str) {
        let mut data = self.data.lock().unwrap();
        if let Some(slot) = data
            .snapshot
            .components
            .iter_mut()
            .find(|slot| slot.name == component)
        {
            slot.status = "missing".into();
            slot.detail = Some(step.into());
        }
        if let Some((_, current)) = data
            .preparation_steps
            .iter_mut()
            .find(|(name, _)| *name == component)
        {
            *current = step.into();
        } else {
            data.preparation_steps.push((component, step.into()));
        }
        data.update_preparation_step();
    }

    pub(crate) fn progress(&self, file: &Path, received: u64, total: Option<u64>) {
        let mut data = self.data.lock().unwrap();
        data.downloads
            .insert(file.to_path_buf(), DownloadSnapshot { received, total });
        let received = data
            .downloads
            .values()
            .map(|download| download.received)
            .sum();
        let total = data
            .downloads
            .values()
            .try_fold(0, |sum, download| download.total.map(|total| sum + total));
        data.snapshot.download = Some(DownloadSnapshot { received, total });
    }

    pub(crate) fn needs_setup(&self, server: &ServerConfig) -> bool {
        let snapshot = self.snapshot();
        if !requires_node(server) && !requires_pi(server) {
            return false;
        }
        if snapshot.status == "checking" {
            return true;
        }
        let ready = |name| {
            snapshot
                .components
                .iter()
                .any(|value| value.name == name && value.status == "ready")
        };
        (requires_node(server) && !ready(Component::Node))
            || (requires_pi(server)
                && (!ready(Component::Pi) || !ready(Component::Bash) || !self.node_supports_pi()))
    }

    fn node_supports_pi(&self) -> bool {
        self.snapshot()
            .components
            .iter()
            .find(|value| value.name == Component::Node)
            .and_then(|value| value.version.as_deref())
            .and_then(|value| semver::Version::parse(value.trim_start_matches('v')).ok())
            .is_some_and(|version| version >= semver::Version::new(22, 19, 0))
    }

    pub(crate) fn component_path(&self, component: Component) -> Option<PathBuf> {
        self.snapshot()
            .components
            .into_iter()
            .find(|value| value.name == component && value.status == "ready")
            .and_then(|value| value.path)
            .map(PathBuf::from)
    }

    pub(crate) fn child_environment(&self) -> ProcessEnvironment {
        let data = self.data.lock().unwrap();
        let mut paths = Vec::new();
        for component in &data.snapshot.components {
            if component.status != "ready" {
                continue;
            }
            if let Some(path) = component.path.as_ref().map(PathBuf::from) {
                match component.name {
                    Component::Node => {
                        if let Some(parent) = path.parent() {
                            paths.push(parent.to_path_buf());
                        }
                    }
                    Component::Pi => {
                        #[cfg(target_os = "macos")]
                        if let Some(modules) = path.parent().and_then(Path::parent) {
                            paths.push(modules.join(".bin"));
                            if let Some(prefix) = modules
                                .parent()
                                .filter(|parent| {
                                    parent.file_name().is_some_and(|name| name == "lib")
                                })
                                .and_then(Path::parent)
                            {
                                paths.push(prefix.join("bin"));
                            }
                        }
                        #[cfg(not(target_os = "macos"))]
                        if let Some(prefix) =
                            path.parent().and_then(Path::parent).and_then(Path::parent)
                        {
                            paths.push(prefix.to_path_buf());
                        }
                    }
                    Component::Bash => {
                        if let Some(parent) = path.parent() {
                            paths.push(parent.to_path_buf());
                            #[cfg(windows)]
                            if let Some(root) = parent.parent() {
                                paths.push(root.join("cmd"));
                            }
                        }
                    }
                }
            }
        }
        paths.extend(std::env::split_paths(&data.search_path));
        let mut environment = vec![
            (
                OsString::from("PATH"),
                std::env::join_paths(paths).unwrap_or_else(|_| data.search_path.clone()),
            ),
            (
                OsString::from("npm_config_cache"),
                self.root.join("cache/npm").into_os_string(),
            ),
            (
                OsString::from("npm_config_maxsockets"),
                OsString::from("10"),
            ),
        ];
        #[cfg(target_os = "macos")]
        environment.push((
            OsString::from("npm_config_prefix"),
            self.root.join("npm").into_os_string(),
        ));
        if let Some(pi) = data
            .snapshot
            .components
            .iter()
            .find(|value| value.name == Component::Pi && value.status == "ready")
            .and_then(|value| value.path.as_ref())
        {
            environment.push((OsString::from("PI_DESK_PI_PACKAGE_DIR"), OsString::from(pi)));
        }
        if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
            environment.push((
                OsString::from("PI_CODING_AGENT_DIR"),
                std::env::var_os("PI_CODING_AGENT_DIR")
                    .unwrap_or_else(|| self.root.join("pi-agent").into_os_string()),
            ));
            environment.push((
                OsString::from("PI_CODING_AGENT_SESSION_DIR"),
                std::env::var_os("PI_CODING_AGENT_SESSION_DIR").unwrap_or_else(|| {
                    std::env::var_os("PI_CODING_AGENT_DIR")
                        .map(PathBuf::from)
                        .unwrap_or_else(|| self.root.join("pi-agent"))
                        .join("sessions")
                        .into_os_string()
                }),
            ));
            environment.push((
                OsString::from("npm_config_userconfig"),
                self.root.join("npmrc").into_os_string(),
            ));
        }
        environment
    }

    #[cfg(target_os = "macos")]
    pub(crate) fn verify_global_commands(
        &self,
        needs_pi: bool,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<(), String> {
        let node = self
            .component_path(Component::Node)
            .ok_or("Node.js 尚未就绪")?;
        self.probe(Component::Node, &node, cancelled, log)?;
        if needs_pi {
            let bash = self
                .component_path(Component::Bash)
                .ok_or("Git 和 Bash 尚未就绪")?;
            self.probe(Component::Bash, &bash, cancelled, log)?;
            let pi = self.component_path(Component::Pi).ok_or("Pi 尚未就绪")?;
            self.probe(Component::Pi, &pi, cancelled, log)?;
        }
        logging::write(
            log,
            "environment-commands",
            "所选运行环境校验通过，未修改系统 PATH",
        );
        Ok(())
    }

    #[cfg(windows)]
    pub(crate) fn verify_global_commands(
        &self,
        needs_pi: bool,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<(), String> {
        let node = self
            .component_path(Component::Node)
            .ok_or("Node.js 尚未就绪")?;
        self.register_command_path(
            Component::Node,
            node.parent().ok_or("Node.js 安装路径无效")?,
            cancelled,
            log,
        )?;
        if needs_pi {
            let pi = self.component_path(Component::Pi).ok_or("Pi 尚未就绪")?;
            let prefix = pi
                .parent()
                .and_then(Path::parent)
                .and_then(Path::parent)
                .ok_or("Pi 全局安装路径无效")?;
            self.register_command_path(Component::Pi, prefix, cancelled, log)?;
            let bash = self
                .component_path(Component::Bash)
                .ok_or("Git Bash 尚未就绪")?;
            if let Some(root) = bash.parent().and_then(Path::parent) {
                let cmd = root.join("cmd");
                if cmd.join("git.exe").is_file() {
                    self.register_command_path(Component::Bash, &cmd, cancelled, log)?;
                }
            }
        }
        let path = refreshed_path(log, cancelled, false);
        self.data.lock().unwrap().search_path = path.clone();
        let commands = if needs_pi {
            vec!["node", "npm", "git", "pi"]
        } else {
            vec!["node", "npm"]
        };
        for command in commands {
            self.check_global_command(command, &path, cancelled, log)?;
        }
        Ok(())
    }

    #[cfg(windows)]
    fn register_command_path(
        &self,
        component: Component,
        path: &Path,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<(), String> {
        ensure_user_path(path, cancelled, log).map_err(|error| {
            if !cancelled() {
                self.invalidate_component(component, &error);
            }
            error
        })
    }

    #[cfg(windows)]
    fn check_global_command(
        &self,
        command: &str,
        path: &OsString,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<(), String> {
        let component = match command {
            "node" | "npm" => Component::Node,
            "git" => Component::Bash,
            _ => Component::Pi,
        };
        let result = (|| {
            let output = process::run_capture_with_environment(
                &format!("{command} --version"),
                Some(&self.root),
                Duration::from_secs(20),
                log,
                cancelled,
                &[(OsString::from("PATH"), path.clone())],
            )?;
            if !output.status.success() {
                return Err(format!(
                    "外部命令 {command} 仍不可用：{}",
                    packages::command_failure(&output)
                ));
            }
            let text = process::decode_output(&output.stdout);
            let version = text.trim();
            if matches!(command, "node" | "pi") {
                let expected = self
                    .snapshot()
                    .components
                    .into_iter()
                    .find(|value| value.name == component)
                    .and_then(|value| value.version);
                if expected.as_deref().is_some_and(|expected| {
                    expected.trim_start_matches('v') != version.trim_start_matches('v')
                }) {
                    return Err(format!("外部 {command} 命令指向另一版本（{version}），请调整已有安装或 PATH 后重新检测"));
                }
            }
            logging::write(
                log,
                "environment-global-command",
                &format!("外部命令校验通过：{command} {version}"),
            );
            Ok(())
        })();
        if let Err(error) = &result {
            if !cancelled() {
                self.invalidate_component(component, error);
            }
        }
        result
    }

    #[cfg(windows)]
    fn invalidate_component(&self, component: Component, error: &str) {
        let mut data = self.data.lock().unwrap();
        if let Some(slot) = data
            .snapshot
            .components
            .iter_mut()
            .find(|slot| slot.name == component)
        {
            slot.status = "invalid".into();
            slot.detail = Some(error.into());
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub(crate) fn verify_global_commands(
        &self,
        _needs_pi: bool,
        _cancelled: &dyn Fn() -> bool,
        _log: &Path,
    ) -> Result<(), String> {
        Err("当前平台不支持自动准备运行环境，请选择本机环境".into())
    }

    pub(crate) fn run_node(
        &self,
        arguments: &[&str],
        cwd: Option<&Path>,
        timeout: Duration,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<String, String> {
        let node = self.component_path(Component::Node).ok_or_else(|| {
            "请先准备 Node.js 和 npm，或选择有效的 Node.js 可执行文件".to_string()
        })?;
        let output = process::run_program(
            &node,
            arguments,
            cwd,
            timeout,
            log,
            cancelled,
            &self.child_environment(),
        )?;
        if !output.status.success() {
            return Err(packages::command_failure(&output));
        }
        Ok(process::decode_output(&output.stdout).trim().to_string())
    }

    pub(crate) fn npm_command(&self) -> Result<String, String> {
        let node = self
            .component_path(Component::Node)
            .ok_or_else(|| "请先准备 Node.js 和 npm".to_string())?;
        let npm = npm_cli(&node).ok_or_else(|| {
            "Node.js 目录缺少 npm，请选择包含 npm 的完整 Node.js 环境".to_string()
        })?;
        let command = format!(
            "{} {}",
            packages::quote(&node.to_string_lossy()),
            packages::quote(&npm.to_string_lossy())
        );
        Ok(command)
    }

    pub(crate) fn check(&self, cancelled: &dyn Fn() -> bool, log: &Path) -> Result<(), String> {
        if cancelled() {
            return Err("操作已取消".into());
        }
        fs::create_dir_all(&self.root).map_err(|error| format!("创建桌面环境目录失败：{error}"))?;
        let injected = discovery_path_override();
        let search = injected
            .clone()
            .unwrap_or_else(|| refreshed_path(log, cancelled, true));
        self.check_in_path(
            search,
            injected.is_none(),
            configured_shell(&self.root),
            cancelled,
            log,
        )
    }

    fn check_in_path(
        &self,
        search: OsString,
        include_system: bool,
        configured_bash: Option<PathBuf>,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<(), String> {
        let paths = std::env::split_paths(&search)
            .filter(|path| !self.is_private_path(path))
            .collect::<Vec<_>>();
        let search = std::env::join_paths(paths).map_err(|error| error.to_string())?;
        self.data.lock().unwrap().search_path = search.clone();
        let mut choices = self.data.lock().unwrap().choices.clone();
        choices.node = choices.node.filter(|path| !self.is_private_path(path));
        choices.pi = choices.pi.filter(|path| !self.is_private_path(path));
        choices.bash = choices.bash.filter(|path| !self.is_private_path(path));
        let node_candidates = candidates(
            if cfg!(windows) { "node.exe" } else { "node" },
            choices.node.clone(),
            &search,
            if !include_system || !cfg!(windows) {
                &[]
            } else if matches!(native_architecture(), Ok(WindowsArchitecture::X64)) {
                &[
                    "C:/Program Files/nodejs/node.exe",
                    "C:/Program Files (x86)/nodejs/node.exe",
                ]
            } else {
                &["C:/Program Files/nodejs/node.exe"]
            },
            include_system,
        );
        #[cfg(target_os = "macos")]
        let node_candidates = {
            let mut paths = node_candidates;
            if include_system && choices.node.is_none() {
                paths.insert(0, self.root.join("node/bin/node"));
            }
            paths
        };
        let node = self.probe_candidates(
            Component::Node,
            choices.node.is_some(),
            node_candidates,
            cancelled,
            log,
        );
        self.replace_component(node);
        let mut pi_candidates = Vec::new();
        #[cfg(target_os = "macos")]
        if include_system && choices.pi.is_none() {
            pi_candidates.push(self.root.join("npm/lib/node_modules").join(PI_PACKAGE));
        }
        if let Some(path) = choices.pi.clone() {
            pi_candidates.push(path);
        } else {
            if include_system {
                if let Some(path) = std::env::var_os("PI_DESK_PI_PACKAGE_DIR") {
                    let path = PathBuf::from(path);
                    if !self.is_private_path(&path) {
                        pi_candidates.push(path);
                    }
                }
            }
            if let Some(node) = self.component_path(Component::Node) {
                if let Some(parent) = node.parent() {
                    pi_candidates.push(parent.join("node_modules").join(PI_PACKAGE));
                    #[cfg(target_os = "macos")]
                    pi_candidates.push(parent.join("../lib/node_modules").join(PI_PACKAGE));
                }
                if let Some(cli) = npm_cli(&node) {
                    if let Ok(output) = self.run_node(
                        &[&cli.to_string_lossy(), "root", "-g"],
                        Some(&self.root),
                        Duration::from_secs(10),
                        cancelled,
                        log,
                    ) {
                        pi_candidates.push(PathBuf::from(output).join(PI_PACKAGE));
                    }
                }
            }
            if include_system {
                if let Some(appdata) = std::env::var_os("APPDATA") {
                    pi_candidates.push(
                        PathBuf::from(appdata)
                            .join("npm/node_modules")
                            .join(PI_PACKAGE),
                    );
                }
            }
            for directory in std::env::split_paths(&search) {
                pi_candidates.push(directory.join("node_modules").join(PI_PACKAGE));
                #[cfg(target_os = "macos")]
                pi_candidates.push(directory.join("../lib/node_modules").join(PI_PACKAGE));
            }
        }
        pi_candidates.retain(|path| !self.is_private_path(path));
        let pi = self.probe_candidates(
            Component::Pi,
            choices.pi.is_some(),
            pi_candidates,
            cancelled,
            log,
        );
        self.replace_component(pi);
        let configured_private = configured_bash
            .as_ref()
            .filter(|path| self.is_private_path(path))
            .cloned();
        let explicit_bash = configured_bash.is_some() || choices.bash.is_some();
        let mut bash_candidates = candidates(
            if cfg!(windows) { "bash.exe" } else { "bash" },
            configured_bash.clone().or(choices.bash.clone()),
            &search,
            if !include_system || !cfg!(windows) {
                &[]
            } else {
                &[
                    "C:/Program Files/Git/bin/bash.exe",
                    "C:/Program Files (x86)/Git/bin/bash.exe",
                    "C:/msys64/usr/bin/bash.exe",
                ]
            },
            include_system,
        );
        if !explicit_bash && cfg!(windows) {
            for directory in std::env::split_paths(&search) {
                if directory.join("git.exe").is_file() {
                    if let Some(root) = directory.parent() {
                        bash_candidates.push(root.join("bin/bash.exe"));
                    }
                }
            }
        }
        if !explicit_bash && include_system && cfg!(windows) {
            for key in ["LOCALAPPDATA", "USERPROFILE"] {
                if let Some(home) = std::env::var_os(key) {
                    bash_candidates.push(PathBuf::from(home).join("Programs/Git/bin/bash.exe"));
                }
            }
        }
        let bash = if let Some(path) = configured_private {
            ComponentSnapshot {
                name: Component::Bash,
                status: "invalid".into(),
                version: None,
                path: Some(path.to_string_lossy().into_owned()),
                detail: Some("Pi 的 shellPath 指向旧桌面私有环境，请修正 Pi 设置后重新检测".into()),
            }
        } else {
            self.probe_candidates(
                Component::Bash,
                explicit_bash,
                bash_candidates,
                cancelled,
                log,
            )
        };
        self.replace_component(bash);
        if cancelled() {
            return Err("操作已取消".into());
        }
        Ok(())
    }

    pub(crate) fn finish_check(&self, servers: &[ServerConfig]) {
        self.set_phase("required", "正在汇总检测结果", None);
        let required = servers.iter().any(|server| self.needs_setup(server));
        self.set_phase(
            if required { "required" } else { "ready" },
            if required {
                "需要准备运行环境"
            } else {
                "运行环境已就绪"
            },
            None,
        );
    }

    pub(crate) fn use_installed(
        &self,
        component: Component,
        path: &Path,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<(), String> {
        let version = self.probe(component, path, cancelled, log)?;
        self.replace_component(ComponentSnapshot {
            name: component,
            status: "ready".into(),
            version: Some(version),
            path: Some(path.to_string_lossy().into_owned()),
            detail: None,
        });
        Ok(())
    }

    pub(crate) fn is_private_path(&self, path: &Path) -> bool {
        #[cfg(target_os = "macos")]
        if path.starts_with(self.root.join("node/bin")) || path.starts_with(self.root.join("npm")) {
            return false;
        }
        if path.starts_with(&self.root) {
            return true;
        }
        let root = fs::canonicalize(&self.root).unwrap_or_else(|_| self.root.clone());
        let path = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        path.starts_with(root)
    }

    pub(crate) fn has_manual_choice(&self, component: Component) -> bool {
        let data = self.data.lock().unwrap();
        let choice = match component {
            Component::Node => data.choices.node.clone(),
            Component::Pi => data.choices.pi.clone(),
            Component::Bash => {
                if configured_shell(&self.root).is_some() {
                    return true;
                }
                data.choices.bash.clone()
            }
        };
        choice.is_some_and(|path| !self.is_private_path(&path))
    }

    pub(crate) fn cleanup_cache(&self, log: &Path) {
        if let Err(error) = fs::remove_dir_all(self.root.join("cache")) {
            if error.kind() != std::io::ErrorKind::NotFound {
                logging::write(log, "environment-cache-cleanup-failed", &error.to_string());
            }
        }
    }

    fn replace_component(&self, component: ComponentSnapshot) {
        let name = component.name;
        let ready = component.status == "ready";
        let mut data = self.data.lock().unwrap();
        if let Some(slot) = data
            .snapshot
            .components
            .iter_mut()
            .find(|value| value.name == component.name)
        {
            *slot = component;
        }
        if ready && !data.preparation_steps.is_empty() {
            data.preparation_steps
                .retain(|(component, _)| *component != name);
            data.update_preparation_step();
        }
    }

    fn probe_candidates(
        &self,
        component: Component,
        manual: bool,
        paths: Vec<PathBuf>,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> ComponentSnapshot {
        let mut result = ComponentSnapshot {
            name: component,
            status: "missing".into(),
            version: None,
            path: None,
            detail: Some(format!("未找到可用的 {}", component.name())),
        };
        for path in paths {
            if cancelled() {
                break;
            }
            if !path.exists() && !manual {
                continue;
            }
            let path = if component == Component::Pi {
                pi_root(&path).unwrap_or(path)
            } else {
                path
            };
            match self.probe(component, &path, cancelled, log) {
                Ok(version) => {
                    let ready = ComponentSnapshot {
                        name: component,
                        status: "ready".into(),
                        version: Some(version.clone()),
                        path: Some(path.to_string_lossy().into_owned()),
                        detail: None,
                    };
                    if component == Component::Node
                        && !manual
                        && semver::Version::parse(version.trim_start_matches('v'))
                            .is_ok_and(|version| version < semver::Version::new(22, 19, 0))
                    {
                        if result.status != "ready" {
                            result = ComponentSnapshot { detail: Some("此 Node.js 可用于通用 npm 服务；Pi Desk 需要 Node.js 22.19 或更高版本，请准备或选择兼容版本".into()), ..ready };
                        }
                        continue;
                    }
                    return ready;
                }
                Err(error) => {
                    logging::write(
                        log,
                        "environment-probe-failed",
                        &format!(
                            "component={} path={} error={error}",
                            component.name(),
                            path.display()
                        ),
                    );
                    if result.status != "ready" {
                        result = ComponentSnapshot {
                            name: component,
                            status: "invalid".into(),
                            version: None,
                            path: Some(path.to_string_lossy().into_owned()),
                            detail: Some(error),
                        };
                    }
                }
            }
            if manual {
                break;
            }
        }
        result
    }

    pub(crate) fn probe(
        &self,
        component: Component,
        path: &Path,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<String, String> {
        if !path.exists() {
            return Err("选择的路径不存在，请重新选择".into());
        }
        if component == Component::Pi {
            let manifest: serde_json::Value = serde_json::from_slice(
                &fs::read(path.join("package.json"))
                    .map_err(|error| format!("Pi 包清单不可读：{error}"))?,
            )
            .map_err(|error| error.to_string())?;
            if manifest["name"] != PI_PACKAGE {
                return Err("请选择 Pi coding-agent 的 package.json 或 CLI 入口".into());
            }
            let version = manifest["version"].as_str().ok_or("Pi 版本无效")?;
            if semver::Version::parse(version).map_err(|error| error.to_string())?
                < semver::Version::new(1, 0, 1)
            {
                return Err("Pi 版本过旧，请更新到 1.0.1 或选择兼容版本".into());
            }
            let entry = manifest["bin"]
                .as_str()
                .or_else(|| manifest["bin"]["pi"].as_str())
                .ok_or("Pi CLI 入口未声明")?;
            let cli = path.join(entry);
            let actual = self.run_node(
                &[&cli.to_string_lossy(), "--version"],
                Some(path),
                Duration::from_secs(20),
                cancelled,
                log,
            )?;
            if actual.is_empty() {
                return Err("Pi CLI 未返回版本，请重新选择完整 Pi 包".into());
            }
            return Ok(version.into());
        }
        let output = process::run_program(
            path,
            &["--version"],
            None,
            Duration::from_secs(10),
            log,
            cancelled,
            &self.child_environment(),
        )?;
        if !output.status.success() {
            return Err(packages::command_failure(&output));
        }
        let text = process::decode_output(&output.stdout).trim().to_string();
        if component == Component::Node {
            semver::Version::parse(text.trim_start_matches('v'))
                .map_err(|_| "Node.js 版本响应无效")?;
            let npm = npm_cli(path).ok_or("此 Node.js 环境缺少 npm，请选择完整 Node.js 环境")?;
            let npm_output = process::run_program(
                path,
                &[&npm.to_string_lossy(), "--version"],
                None,
                Duration::from_secs(10),
                log,
                cancelled,
                &self.child_environment(),
            )?;
            if !npm_output.status.success() {
                return Err(format!(
                    "npm 不可用：{}",
                    packages::command_failure(&npm_output)
                ));
            }
        } else {
            if !text.contains("GNU bash") {
                return Err("所选程序不是可用的 GNU Bash".into());
            }
            #[cfg(target_os = "macos")]
            self.probe_git(path, cancelled, log)?;
        }
        Ok(text.lines().next().unwrap_or("").to_string())
    }

    #[cfg(target_os = "macos")]
    fn probe_git(
        &self,
        bash: &Path,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<(), String> {
        let mut environment = self.child_environment();
        if let Some((_, path)) = environment.iter_mut().find(|(key, _)| key == "PATH") {
            let mut paths = bash
                .parent()
                .map(Path::to_path_buf)
                .into_iter()
                .collect::<Vec<_>>();
            paths.extend(std::env::split_paths(path));
            *path = std::env::join_paths(paths).map_err(|error| error.to_string())?;
        }
        let git = environment
            .iter()
            .find(|(key, _)| key == "PATH")
            .into_iter()
            .flat_map(|(_, path)| std::env::split_paths(path))
            .map(|directory| directory.join("git"))
            .find(|path| path.is_file())
            .ok_or("未找到 Git，请安装 Command Line Tools 后重新检测")?;
        if git == Path::new("/usr/bin/git") {
            let tools = process::run_program(
                Path::new("/usr/bin/xcode-select"),
                &["-p"],
                None,
                Duration::from_secs(10),
                log,
                cancelled,
                &environment,
            )?;
            if !tools.status.success() {
                return Err(
                    "Git 需要 Command Line Tools；点击安装并打开可请求系统安装，安装完成后重新检测"
                        .into(),
                );
            }
        }
        let output = process::run_program(
            &git,
            &["--version"],
            None,
            Duration::from_secs(10),
            log,
            cancelled,
            &environment,
        )?;
        if !output.status.success() {
            return Err(format!(
                "Git 不可用：{}",
                packages::command_failure(&output)
            ));
        }
        Ok(())
    }

    pub(crate) fn select(
        &self,
        component: Component,
        archive: bool,
        cancelled: &(dyn Fn() -> bool + Sync),
        log: &Path,
    ) -> Result<bool, String> {
        if archive && !cfg!(windows) {
            return Err(
                "macOS 请使用自动准备 Node.js，或选择已安装的环境目录；不支持 Windows MSI 安装包"
                    .into(),
            );
        }
        if archive && component != Component::Node {
            return Err("只有 Node.js 支持选择 MSI 安装包".into());
        }
        #[cfg(not(target_os = "macos"))]
        let filter = if archive {
            vec!["msi"]
        } else if component == Component::Pi {
            vec!["json", "js", "mjs", "cjs", "cmd", "exe"]
        } else {
            vec!["exe"]
        };
        #[cfg(not(target_os = "macos"))]
        let title = match (component, archive) {
            (Component::Node, true) => "选择 Node.js MSI 安装包",
            (Component::Node, false) => "选择 node.exe",
            (Component::Pi, _) => "选择 Pi package.json 或 CLI 入口",
            (Component::Bash, _) => "选择 bash.exe",
        };
        #[cfg(target_os = "macos")]
        let selected = crate::environment_dialog::pick_directory("选择运行环境目录", cancelled);
        #[cfg(not(target_os = "macos"))]
        let selected = crate::environment_dialog::pick_file(title, &filter, cancelled);
        let Some(mut path) = selected else {
            return Ok(false);
        };
        if cancelled() {
            return Err("操作已取消".into());
        }
        #[cfg(target_os = "macos")]
        if component != Component::Pi {
            let executable = if component == Component::Node {
                "node"
            } else {
                "bash"
            };
            path = [path.join(executable), path.join("bin").join(executable)]
                .into_iter()
                .find(|path| path.is_file())
                .ok_or_else(|| format!("所选目录中没有 {executable} 或 bin/{executable}"))?;
        }
        if archive {
            self.set_phase("installing", "正在安装 Node.js", None);
            path = environment_install::install_node(self, &path, cancelled, log)?;
            self.verify_global_commands(false, cancelled, log)?;
        } else if component == Component::Pi {
            path = pi_root(&path)
                .ok_or("此路径不属于 Pi coding-agent 包，请选择该包的 package.json")?;
        }
        if self.is_private_path(&path) {
            return Err("请选择常规安装的组件，旧桌面私有环境不会加入全局 PATH".into());
        }
        path = fs::canonicalize(&path).map_err(|error| format!("所选路径无效：{error}"))?;
        self.probe(component, &path, cancelled, log)?;
        let mut data = self.data.lock().unwrap();
        let mut choices = data.choices.clone();
        match component {
            Component::Node => choices.node = Some(path),
            Component::Pi => choices.pi = Some(path),
            Component::Bash => choices.bash = Some(path),
        }
        self.save_choices(&choices)?;
        data.choices = choices;
        Ok(true)
    }

    pub(crate) fn prepare(
        &self,
        server: &ServerConfig,
        download_source: DownloadSource,
        cancelled: &(dyn Fn() -> bool + Sync),
        log: &Path,
    ) -> Result<(), String> {
        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        self.check(cancelled, log)?;
        environment_install::prepare(self, server, download_source, cancelled, log)
    }

    pub(crate) fn verify_service(
        &self,
        server: &ServerConfig,
        directory: &Path,
        cancelled: &dyn Fn() -> bool,
        log: &Path,
    ) -> Result<(), String> {
        if !requires_pi(server) {
            return Ok(());
        }
        let script = pi_runtime_check_script(directory);
        let result = if !script.is_file() {
            Err("此 Pi Desk 服务包缺少 Pi 兼容检查入口，请选择支持桌面环境准备的服务版本".into())
        } else {
            self.run_node(
                &[&script.to_string_lossy(), "--check"],
                Some(directory),
                Duration::from_secs(45),
                cancelled,
                log,
            )
        };
        let checked = result.and_then(|text| {
            let value: serde_json::Value = serde_json::from_str(&text)
                .map_err(|error| format!("Pi 兼容检查响应无效：{error}"))?;
            if value["status"] == "ready" {
                Ok(())
            } else {
                Err(format!(
                    "Pi 未就绪；服务需要 Pi {}，请安装兼容版本后重新检测",
                    value["installVersion"].as_str().unwrap_or("新版")
                ))
            }
        });
        if let Err(error) = &checked {
            let mut data = self.data.lock().unwrap();
            if let Some(pi) = data
                .snapshot
                .components
                .iter_mut()
                .find(|value| value.name == Component::Pi)
            {
                pi.status = "invalid".into();
                pi.detail = Some(error.clone());
            }
            data.snapshot.status = "failed".into();
            data.snapshot.step = "Pi 与服务不兼容，请更新或选择兼容的 Pi 后重试".into();
            data.snapshot.error = Some(error.clone());
        }
        checked
    }
}

fn pi_runtime_check_script(directory: &Path) -> PathBuf {
    let bin = directory.join("node_modules/@jetcrab/pi-desk/bin");
    let current = bin.join("pi-global-runtime.js");
    if current.is_file() {
        return current;
    }
    let legacy = bin.join("l4-pi-global-runtime.js");
    if legacy.is_file() {
        return legacy;
    }
    current
}

pub(crate) fn npm_cli(node: &Path) -> Option<PathBuf> {
    let parent = node.parent()?;
    [
        parent.join("node_modules/npm/bin/npm-cli.js"),
        parent.join("../lib/node_modules/npm/bin/npm-cli.js"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn pi_root(path: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    let resolved = fs::canonicalize(path).ok()?;
    #[cfg(target_os = "macos")]
    let path = resolved.as_path();
    let mut directory = if path.is_dir() { path } else { path.parent()? };
    for _ in 0..6 {
        if fs::read(directory.join("package.json"))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .is_some_and(|value| value["name"] == PI_PACKAGE)
        {
            return Some(directory.to_path_buf());
        }
        let adjacent = directory.join("node_modules").join(PI_PACKAGE);
        if adjacent.join("package.json").is_file() {
            return Some(adjacent);
        }
        directory = directory.parent()?;
    }
    None
}

fn candidates(
    name: &str,
    manual: Option<PathBuf>,
    search: &OsString,
    common: &[&str],
    include_system: bool,
) -> Vec<PathBuf> {
    if let Some(path) = manual {
        return vec![path];
    }
    let mut paths = std::env::split_paths(search)
        .map(|directory| directory.join(name))
        .collect::<Vec<_>>();
    paths.extend(common.iter().map(PathBuf::from));
    if name == "node.exe" && include_system {
        for key in ["NVM_SYMLINK", "NODE_HOME"] {
            if let Some(root) = std::env::var_os(key) {
                paths.push(PathBuf::from(root).join(name));
            }
        }
        let native_x64 = matches!(native_architecture(), Ok(WindowsArchitecture::X64));
        for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if key != "ProgramFiles" && !native_x64 {
                continue;
            }
            if let Some(root) = std::env::var_os(key) {
                paths.push(PathBuf::from(root).join("nodejs").join(name));
            }
        }
    }
    paths.dedup();
    paths
}

fn configured_shell(root: &Path) -> Option<PathBuf> {
    let agent = std::env::var_os("PI_CODING_AGENT_DIR")
        .map(PathBuf::from)
        .or_else(|| {
            if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
                Some(root.join("pi-agent"))
            } else {
                std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .map(|home| PathBuf::from(home).join(".pi/agent"))
            }
        })?;
    let value: serde_json::Value =
        serde_json::from_slice(&fs::read(agent.join("settings.json")).ok()?).ok()?;
    let shell = value["shellPath"].as_str()?;
    if let Some(rest) = shell
        .strip_prefix("~/")
        .or_else(|| shell.strip_prefix("~\\"))
    {
        return std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
            .map(|home| PathBuf::from(home).join(rest));
    }
    Some(PathBuf::from(shell))
}

// 仅供隔离原生验收指定发现路径，空值表示不扫描真实机器；不进入持久配置或 IPC。
fn discovery_path_override() -> Option<OsString> {
    std::env::var_os("PI_DESK_DESKTOP_DATA_DIR")?;
    std::env::var_os("PI_DESK_DESKTOP_DISCOVERY_PATH")
}

#[cfg(windows)]
pub(crate) fn windows_system_directory() -> PathBuf {
    let root = PathBuf::from(
        std::env::var_os("SystemRoot").unwrap_or_else(|| OsString::from("C:\\Windows")),
    );
    root.join("System32")
}

#[cfg(windows)]
fn user_path_script(directory: &Path) -> String {
    let directory = directory.to_string_lossy().replace('\'', "''");
    format!(
        r#"
$ErrorActionPreference = 'Stop'
$dir = '{directory}'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {{
    $path = [string]$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = if ($key.GetValueNames() -contains 'Path') {{ $key.GetValueKind('Path') }} else {{ [Microsoft.Win32.RegistryValueKind]::ExpandString }}
    $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
    $present = @(($machine + ';' + $path) -split ';' | Where-Object {{
        [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') -ieq $dir.TrimEnd('\')
    }})
    if ($present.Count -eq 0) {{
        $next = if ([string]::IsNullOrEmpty($path)) {{ $dir }} else {{ $path.TrimEnd(';') + ';' + $dir }}
        $key.SetValue('Path',$next,$kind)
    }}
}} finally {{
    $key.Dispose()
}}
"#
    )
}

#[cfg(windows)]
fn ensure_user_path(
    directory: &Path,
    cancelled: &dyn Fn() -> bool,
    log: &Path,
) -> Result<(), String> {
    if std::env::var_os("PI_DESK_DESKTOP_DATA_DIR").is_some() {
        return Err("隔离模式禁止修改用户 PATH".into());
    }
    let executable = windows_system_directory().join("WindowsPowerShell/v1.0/powershell.exe");
    let output = process::run_program(
        &executable,
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &user_path_script(directory),
        ],
        None,
        Duration::from_secs(10),
        log,
        cancelled,
        &[],
    )?;
    if !output.status.success() {
        return Err(format!(
            "登记用户 PATH 失败：{}",
            packages::command_failure(&output)
        ));
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE,
        };
        let environment: Vec<u16> = "Environment\0".encode_utf16().collect();
        let mut result = 0;
        if unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                environment.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                2000,
                &mut result,
            )
        } == 0
        {
            logging::write(
                log,
                "environment-path-notify-failed",
                "用户 PATH 已保存，但 Windows 环境变化通知未完成，外部终端可能需要重新登录后生效",
            );
        }
    }
    logging::write(
        log,
        "environment-user-path",
        &format!("已确认用户 PATH 包含：{}", directory.display()),
    );
    Ok(())
}

fn refreshed_path(log: &Path, cancelled: &dyn Fn() -> bool, include_current: bool) -> OsString {
    let current = if include_current {
        std::env::var_os("PATH").unwrap_or_default()
    } else {
        OsString::new()
    };
    #[cfg(windows)]
    {
        let executable = windows_system_directory().join("WindowsPowerShell/v1.0/powershell.exe");
        let result = process::run_program(&executable, &["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); [Environment]::GetEnvironmentVariable('Path','Machine'); [Environment]::GetEnvironmentVariable('Path','User')"], None, Duration::from_secs(10), log, cancelled, &[]);
        match result {
            Ok(output) if output.status.success() => {
                let mut paths = Vec::new();
                for line in process::decode_output(&output.stdout).lines() {
                    paths.extend(std::env::split_paths(&OsString::from(line)));
                }
                paths.extend(std::env::split_paths(&current));
                return std::env::join_paths(paths).unwrap_or(current);
            }
            result => {
                let error = match result {
                    Ok(output) => packages::command_failure(&output),
                    Err(error) => error,
                };
                logging::write(
                    log,
                    "environment-path-refresh-failed",
                    &format!("powershell={} error={error}", executable.display()),
                );
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (log, cancelled);
        let mut paths = vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/bin"),
            PathBuf::from("/bin"),
            PathBuf::from("/usr/sbin"),
            PathBuf::from("/sbin"),
        ];
        paths.extend(std::env::split_paths(&current));
        return std::env::join_paths(paths).unwrap_or(current);
    }
    #[cfg(windows)]
    current
}

#[cfg(test)]
#[path = "environment_tests.rs"]
mod tests;
