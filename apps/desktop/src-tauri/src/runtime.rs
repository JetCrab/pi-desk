use crate::config::{self, DesktopConfig, ServerConfig, TargetConfig, UpdatePolicy};
use crate::environment::{Component, EnvironmentSnapshot, EnvironmentState};
use crate::environment_source::DownloadSource;
use crate::packages::{self, should_select_version};
use crate::process::{self, ManagedProcess};
use crate::tunnel::{self, TunnelWorkerConfig, TunnelWorkerEvent, TunnelWorkerHandle};
use crate::{logging, service_port, windows};
use pi_desk_tunnel_common::config::{
    ensure_device_id, require_ready, TunnelConfig, DESKTOP_DEVICE_KEY,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

const START_TIMEOUT: Duration = Duration::from_secs(120);
const PORT_RELEASE_TIMEOUT: Duration = Duration::from_secs(5);
const PACKAGE_UPDATE_INTERVAL: Duration = Duration::from_secs(60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageUpdateSnapshot {
    pub status: String,
    pub version: Option<String>,
    pub error: Option<String>,
}

impl Default for PackageUpdateSnapshot {
    fn default() -> Self {
        Self {
            status: "idle".into(),
            version: None,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSnapshot {
    pub status: String,
    pub detail: String,
    pub version: Option<String>,
    pub auto_start: bool,
    pub needs_setup: bool,
    pub update: Option<PackageUpdateSnapshot>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSnapshot {
    pub status: String,
    pub detail: String,
    pub public_addr: Option<String>,
    pub public_port: u16,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSnapshot {
    pub url: String,
    pub server: Option<ServerSnapshot>,
    pub tunnel: Option<TunnelSnapshot>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlState {
    pub hide_on_startup: Option<bool>,
    pub hide_on_open: bool,
    pub show_on_close: bool,
    pub targets: Vec<TargetSnapshot>,
    pub environment: EnvironmentSnapshot,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetSettings {
    pub target: Option<TargetConfig>,
    pub default_server: ServerConfig,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConnectionInput {
    pub control_server_url: String,
    pub control_key: String,
}

#[derive(Clone, Debug, Default)]
enum ServerPhase {
    #[default]
    Stopped,
    Starting(String),
    Running,
    Failed(String),
}

#[derive(Clone, Debug, Default)]
enum TunnelPhase {
    #[default]
    Stopped,
    Opening,
    Connecting(String),
    Listening(String),
    Recovering(String),
    Stopping,
    Failed(String),
}

struct ManagedChild {
    child: ManagedProcess,
    version: Option<String>,
    directory: Option<PathBuf>,
    server: ServerConfig,
}

#[derive(Default)]
struct TargetRuntime {
    child: Option<ManagedChild>,
    server_phase: ServerPhase,
    update: PackageUpdateSnapshot,
    operation: Option<Arc<AtomicBool>>,
    stop_requested: bool,
    open_after_start: bool,
    tunnel_worker: Option<TunnelWorkerHandle>,
    tunnel_phase: TunnelPhase,
    last_check: Option<Instant>,
    notified_version: Option<String>,
}

fn default_auto_start() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct TargetRuntimeInfo {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_version: Option<String>,
    #[serde(default = "default_auto_start")]
    auto_start: bool,
}

impl Default for TargetRuntimeInfo {
    fn default() -> Self {
        Self {
            last_version: None,
            auto_start: true,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeInfo {
    #[serde(default)]
    targets: BTreeMap<String, TargetRuntimeInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    hide_on_startup: Option<bool>,
    #[serde(default = "default_auto_start")]
    hide_on_open: bool,
    #[serde(default = "default_auto_start")]
    show_on_close: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_opened_url: Option<String>,
}

impl Default for RuntimeInfo {
    fn default() -> Self {
        Self {
            targets: BTreeMap::new(),
            hide_on_startup: None,
            hide_on_open: true,
            show_on_close: true,
            last_opened_url: None,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRuntimeInfo {
    #[serde(default)]
    last_version: Option<String>,
    #[serde(default = "default_auto_start")]
    auto_start: bool,
}

pub struct ShellState {
    config: Mutex<DesktopConfig>,
    config_write: Mutex<()>,
    runtime_info: Mutex<RuntimeInfo>,
    pub(crate) config_path: PathBuf,
    pub(crate) runtime_path: PathBuf,
    pub(crate) log_path: PathBuf,
    pub(crate) windows: windows::WindowRegistry,
    pub(crate) environment: EnvironmentState,
    environment_operation: Mutex<Option<Arc<AtomicBool>>>,
    environment_worker: Mutex<Option<JoinHandle<()>>>,
    target_runtimes: Mutex<HashMap<String, TargetRuntime>>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    monitor: Mutex<Option<(mpsc::Sender<()>, JoinHandle<()>)>>,
    closing: AtomicBool,
}

impl ShellState {
    pub fn new(
        config: DesktopConfig,
        runtime_info: RuntimeInfo,
        config_path: PathBuf,
        runtime_path: PathBuf,
        log_path: PathBuf,
    ) -> Self {
        let data_directory = log_path
            .parent()
            .and_then(Path::parent)
            .unwrap_or(Path::new("."))
            .join("browser-data-v2");
        #[cfg(target_os = "macos")]
        let environment_root = config_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("environment");
        #[cfg(not(target_os = "macos"))]
        let environment_root = log_path
            .parent()
            .and_then(Path::parent)
            .unwrap_or(Path::new("."))
            .join("environment");
        let choices_path = config_path.with_file_name("environment.json");
        Self {
            environment: EnvironmentState::new(environment_root, choices_path),
            environment_operation: Mutex::new(None),
            environment_worker: Mutex::new(None),
            config: Mutex::new(config),
            config_write: Mutex::new(()),
            runtime_info: Mutex::new(runtime_info),
            config_path,
            runtime_path,
            log_path,
            windows: windows::WindowRegistry::new(data_directory),
            target_runtimes: Mutex::new(HashMap::new()),
            workers: Mutex::new(Vec::new()),
            monitor: Mutex::new(None),
            closing: AtomicBool::new(false),
        }
    }

    pub fn config(&self) -> Result<DesktopConfig, String> {
        self.config
            .lock()
            .map(|value| value.clone())
            .map_err(|_| "桌面配置不可用".into())
    }
}

fn write_shell_log(state: &ShellState, stage: &str, detail: &str) {
    logging::write(&state.log_path, stage, detail);
}

pub fn load_runtime_info(path: &Path, config: &DesktopConfig) -> RuntimeInfo {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| parse_runtime_info(&content, config))
        .unwrap_or_default()
}

fn parse_runtime_info(content: &str, config: &DesktopConfig) -> Option<RuntimeInfo> {
    let value: serde_json::Value = serde_json::from_str(content).ok()?;
    if value.get("targets").is_some() {
        let mut info: RuntimeInfo = serde_json::from_value(value).ok()?;
        info.targets.retain(|url, _| config.target(url).is_some());
        if info
            .last_opened_url
            .as_ref()
            .is_some_and(|url| config.target(url).is_none())
        {
            info.last_opened_url = None;
        }
        return Some(info);
    }
    let legacy: LegacyRuntimeInfo = serde_json::from_value(value).ok()?;
    let mut info = RuntimeInfo::default();
    if let Some(target) = config.targets.iter().find(|target| target.server.is_some()) {
        info.targets.insert(
            target.url.clone(),
            TargetRuntimeInfo {
                last_version: legacy.last_version,
                auto_start: legacy.auto_start,
            },
        );
    }
    Some(info)
}

fn mutate_runtime_info(
    state: &ShellState,
    change: impl FnOnce(&mut RuntimeInfo),
) -> Result<(), String> {
    let mut info = state
        .runtime_info
        .lock()
        .map_err(|_| "运行记录不可用".to_string())?;
    let mut next = info.clone();
    change(&mut next);
    if let Some(parent) = state.runtime_path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("创建运行记录目录失败：{error}"))?;
    }
    let content = serde_json::to_vec(&next).map_err(|error| error.to_string())?;
    let temporary = state.runtime_path.with_extension("json.tmp");
    fs::write(&temporary, content)
        .and_then(|()| fs::rename(&temporary, &state.runtime_path))
        .map_err(|error| format!("保存运行记录失败：{error}"))?;
    *info = next;
    Ok(())
}

fn cached_version(state: &ShellState, url: &str) -> Result<Option<String>, String> {
    state
        .runtime_info
        .lock()
        .map(|info| {
            info.targets
                .get(url)
                .and_then(|target| target.last_version.clone())
        })
        .map_err(|_| "运行记录不可用".into())
}

fn set_cached_version(state: &ShellState, url: &str, version: String) -> Result<(), String> {
    mutate_runtime_info(state, |info| {
        info.targets
            .entry(url.to_string())
            .or_default()
            .last_version = Some(version)
    })
}

fn auto_start(state: &ShellState, url: &str) -> Result<bool, String> {
    state
        .runtime_info
        .lock()
        .map(|info| {
            info.targets
                .get(url)
                .map(|target| target.auto_start)
                .unwrap_or(true)
        })
        .map_err(|_| "运行记录不可用".into())
}

fn set_auto_start(state: &ShellState, url: &str, enabled: bool) -> Result<(), String> {
    mutate_runtime_info(state, |info| {
        info.targets.entry(url.to_string()).or_default().auto_start = enabled
    })
}

fn configured_target(state: &ShellState, url: &str) -> Result<TargetConfig, String> {
    state
        .config()?
        .target(url)
        .cloned()
        .ok_or_else(|| "网址配置不存在".into())
}

fn configured_server(state: &ShellState, url: &str) -> Result<ServerConfig, String> {
    configured_target(state, url)?
        .server
        .ok_or_else(|| "该网址未配置本机服务".into())
}

pub fn target_settings(state: &ShellState, url: Option<&str>) -> Result<TargetSettings, String> {
    Ok(TargetSettings {
        target: url
            .map(|value| {
                config::normalize_target_url(value).and_then(|url| configured_target(state, &url))
            })
            .transpose()?,
        default_server: config::default_server_config(),
    })
}

pub fn tunnel_connection(state: &ShellState) -> Result<TunnelConnectionInput, String> {
    let config = state.config()?;
    Ok(TunnelConnectionInput {
        control_server_url: config.tunnel.control_server_url,
        control_key: config.tunnel.control_key,
    })
}

fn ensure_desktop_tunnel_ready_config(config: &mut DesktopConfig) -> Result<TunnelConfig, String> {
    let mut tunnel = TunnelConfig {
        control_server_url: config.tunnel.control_server_url.clone(),
        control_key: config.tunnel.control_key.clone(),
        ..TunnelConfig::default()
    };
    if !config.tunnel.device_id.is_empty() {
        tunnel
            .device_ids
            .insert(DESKTOP_DEVICE_KEY.into(), config.tunnel.device_id.clone());
    }
    ensure_device_id(&mut tunnel, DESKTOP_DEVICE_KEY)?;
    require_ready(&tunnel, DESKTOP_DEVICE_KEY)?;
    config.tunnel.device_id = tunnel
        .device_ids
        .get(DESKTOP_DEVICE_KEY)
        .cloned()
        .unwrap_or_default();
    Ok(tunnel)
}

fn save_config(state: &ShellState, config: DesktopConfig) -> Result<(), String> {
    config::save(&state.config_path, &config)?;
    *state
        .config
        .lock()
        .map_err(|_| "桌面配置不可用".to_string())? = config;
    Ok(())
}

fn require_idle(state: &ShellState, url: &str) -> Result<(), String> {
    if state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?
        .get(url)
        .is_some_and(|target| target.operation.is_some())
    {
        return Err("该服务有操作正在进行，请等待完成或取消后再试".into());
    }
    Ok(())
}

pub fn apply_target(
    app: &AppHandle,
    original_url: Option<&str>,
    value: serde_json::Value,
) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let _write = state
        .config_write
        .lock()
        .map_err(|_| "配置写入不可用".to_string())?;
    let next = config::normalize_target(
        serde_json::from_value(value).map_err(|error| format!("网址配置格式无效：{error}"))?,
    )?;
    let mut config = state.config()?;
    let previous = if let Some(url) = original_url {
        let url = config::normalize_target_url(url)?;
        require_idle(&state, &url)?;
        let index = config
            .targets
            .iter()
            .position(|target| target.url == url)
            .ok_or_else(|| "原网址配置不存在".to_string())?;
        Some(std::mem::replace(&mut config.targets[index], next.clone()))
    } else {
        config.targets.push(next.clone());
        None
    };
    let mut config = config::normalize(config)?;
    if config
        .targets
        .iter()
        .any(|target| target.tunnel.as_ref().is_some_and(|tunnel| tunnel.enabled))
    {
        ensure_desktop_tunnel_ready_config(&mut config)?;
    }
    save_config(&state, config)?;
    if let Some(previous) = previous {
        if previous.url != next.url {
            remove_target_runtime(app, &previous.url)?;
        } else {
            if previous.server.is_some() && next.server.is_none() {
                stop_active_child(&state, &next.url)?;
                set_phase(&state, &next.url, ServerPhase::Stopped);
                mutate_runtime_info(&state, |info| {
                    info.targets.remove(&next.url);
                })?;
            } else if previous
                .server
                .as_ref()
                .and_then(|server| server.package.as_ref())
                .map(|package| &package.name)
                != next
                    .server
                    .as_ref()
                    .and_then(|server| server.package.as_ref())
                    .map(|package| &package.name)
            {
                mutate_runtime_info(&state, |info| {
                    if let Some(target) = info.targets.get_mut(&next.url) {
                        target.last_version = None;
                    }
                })?;
                if let Some(runtime) = state
                    .target_runtimes
                    .lock()
                    .map_err(|_| "运行状态不可用".to_string())?
                    .get_mut(&next.url)
                {
                    runtime.update = PackageUpdateSnapshot::default();
                    runtime.notified_version = None;
                }
            } else if previous
                .server
                .as_ref()
                .and_then(|server| server.package.as_ref())
                .map(|package| package.channel)
                != next
                    .server
                    .as_ref()
                    .and_then(|server| server.package.as_ref())
                    .map(|package| package.channel)
            {
                if let Some(runtime) = state
                    .target_runtimes
                    .lock()
                    .map_err(|_| "运行状态不可用".to_string())?
                    .get_mut(&next.url)
                {
                    runtime.update = PackageUpdateSnapshot::default();
                    runtime.notified_version = None;
                }
            }
            if previous.tunnel.as_ref().map(|tunnel| tunnel.public_port)
                != next.tunnel.as_ref().map(|tunnel| tunnel.public_port)
            {
                stop_tunnel_runtime(&state, &next.url);
            }
        }
    }
    write_shell_log(&state, "target-saved", &format!("url={}", next.url));
    Ok(())
}

pub fn delete_target(app: &AppHandle, url: &str) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let _write = state
        .config_write
        .lock()
        .map_err(|_| "配置写入不可用".to_string())?;
    let url = config::normalize_target_url(url)?;
    require_idle(&state, &url)?;
    let mut config = state.config()?;
    let index = config
        .targets
        .iter()
        .position(|target| target.url == url)
        .ok_or_else(|| "网址配置不存在".to_string())?;
    config.targets.remove(index);
    save_config(&state, config)?;
    remove_target_runtime(app, &url)?;
    write_shell_log(&state, "target-deleted", &format!("url={url}"));
    Ok(())
}

fn remove_target_runtime(app: &AppHandle, url: &str) -> Result<(), String> {
    let state = app.state::<ShellState>();
    stop_active_child(&state, url)?;
    stop_tunnel_runtime(&state, url);
    state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?
        .remove(url);
    windows::remove(app, url);
    mutate_runtime_info(&state, |info| {
        info.targets.remove(url);
        if info.last_opened_url.as_deref() == Some(url) {
            info.last_opened_url = None;
        }
    })
}

pub fn apply_tunnel_connection(state: &ShellState, value: serde_json::Value) -> Result<(), String> {
    let _write = state
        .config_write
        .lock()
        .map_err(|_| "配置写入不可用".to_string())?;
    let input: TunnelConnectionInput =
        serde_json::from_value(value).map_err(|error| format!("隧道配置格式无效：{error}"))?;
    let mut config = state.config()?;
    config.tunnel.control_server_url = input.control_server_url;
    config.tunnel.control_key = input.control_key;
    if config
        .targets
        .iter()
        .any(|target| target.tunnel.as_ref().is_some_and(|tunnel| tunnel.enabled))
    {
        ensure_desktop_tunnel_ready_config(&mut config)?;
    }
    save_config(state, config)
}

pub fn open_control_window(app: &AppHandle) -> Result<(), String> {
    windows::open_control(app)
}

pub fn set_startup_preference(
    state: &ShellState,
    hide_on_startup: Option<bool>,
    hide_on_open: Option<bool>,
    show_on_close: Option<bool>,
) -> Result<(), String> {
    mutate_runtime_info(state, |info| {
        if let Some(value) = hide_on_startup {
            info.hide_on_startup = Some(value);
        }
        if let Some(value) = hide_on_open {
            info.hide_on_open = value;
        }
        if let Some(value) = show_on_close {
            info.show_on_close = value;
        }
    })
}

pub fn hides_on_startup(state: &ShellState) -> Result<bool, String> {
    state
        .runtime_info
        .lock()
        .map(|info| info.hide_on_startup == Some(true))
        .map_err(|_| "启动设置不可用".into())
}

// 托盘始终打开配置页；启动快捷方式才按偏好恢复工作窗口。
pub fn activate_desktop(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ShellState>();
    if !hides_on_startup(&state)? {
        return open_control_window(app);
    }
    if state.environment.snapshot().status == "checking" {
        return Ok(());
    }
    let config = state.config()?;
    let url = {
        let info = state.runtime_info.lock().map_err(|_| "运行记录不可用")?;
        info.last_opened_url
            .as_deref()
            .and_then(|url| config.target(url))
            .or_else(|| config.targets.first())
            .map(|target| target.url.clone())
    };
    let Some(url) = url else {
        return open_control_window(app);
    };
    if let Err(error) = open_target(app, &url) {
        write_shell_log(
            &state,
            "desktop-open-failed",
            &format!("url={url} error={error}"),
        );
        return open_control_window(app);
    }
    Ok(())
}

fn open_workspace_window(app: &AppHandle, url: &str) -> Result<(), String> {
    windows::open_browser(app, url)?;
    let state = app.state::<ShellState>();
    mutate_runtime_info(&state, |info| info.last_opened_url = Some(url.to_string()))?;
    let hide = state
        .runtime_info
        .lock()
        .map_err(|_| "窗口设置不可用")?
        .hide_on_open;
    if hide {
        if let Some(window) = app.get_webview_window("control") {
            window
                .hide()
                .map_err(|error| format!("隐藏配置页失败：{error}"))?;
        }
    }
    Ok(())
}

pub fn workspace_window_closed(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let show = state
        .runtime_info
        .lock()
        .map_err(|_| "窗口设置不可用")?
        .show_on_close;
    if show && !state.closing.load(Ordering::Acquire) {
        open_control_window(app)?;
    }
    Ok(())
}

pub fn open_target(app: &AppHandle, url: &str) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let url = config::normalize_target_url(url)?;
    let target = configured_target(&state, &url)?;
    if target.server.is_some() && !has_child(&state, &url) {
        set_auto_start(&state, &url, true)?;
        begin_operation_with_open(app, &url, Operation::Start, true)
    } else {
        open_workspace_window(app, &url)
    }
}

enum EnvironmentOperation {
    Check {
        auto_start: bool,
        open_on_ready: bool,
    },
    Prepare(String, DownloadSource),
    Select(Component, bool),
}

pub(crate) fn check_environment(app: &AppHandle, auto_start: bool) -> Result<(), String> {
    let open_on_ready = auto_start && hides_on_startup(&app.state::<ShellState>())?;
    begin_environment_operation(
        app,
        EnvironmentOperation::Check {
            auto_start,
            open_on_ready,
        },
    )
}

pub(crate) fn prepare_environment(
    app: &AppHandle,
    url: &str,
    download_source: DownloadSource,
) -> Result<(), String> {
    begin_environment_operation(
        app,
        EnvironmentOperation::Prepare(config::normalize_target_url(url)?, download_source),
    )
}

pub(crate) fn select_environment(
    app: &AppHandle,
    component: Component,
    archive: bool,
) -> Result<(), String> {
    if archive && component != Component::Node {
        return Err("只有 Node.js 支持选择 MSI 安装包".into());
    }
    begin_environment_operation(app, EnvironmentOperation::Select(component, archive))
}

pub(crate) fn cancel_environment(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let worker = {
        let _guard = state.config_write.lock().map_err(|_| "配置写入不可用")?;
        if let Some(cancel) = state
            .environment_operation
            .lock()
            .map_err(|_| "环境操作不可用")?
            .as_ref()
        {
            cancel.store(true, Ordering::Release);
        }
        state
            .environment_worker
            .lock()
            .map_err(|_| "环境后台操作不可用")?
            .take()
    };
    if let Some(worker) = worker {
        worker.join().map_err(|_| "环境操作异常终止")?;
    }
    Ok(())
}

pub(crate) fn open_install_help(component: Component) -> Result<(), String> {
    let url = match component {
        Component::Node => "https://nodejs.org/en/download",
        Component::Pi => "https://github.com/earendil-works/pi/blob/main/docs/quickstart.md",
        Component::Bash if cfg!(target_os = "macos") => "https://git-scm.com/download/mac",
        Component::Bash => "https://git-scm.com/download/win",
    };
    webbrowser::open(url).map_err(|error| format!("打开官方安装页面失败：{error}"))
}

fn save_preparation_source(
    state: &ShellState,
    url: &str,
    source: DownloadSource,
) -> Result<(), String> {
    configured_server(state, url)?;
    let mut config = state.config()?;
    if let Some(package) = config
        .targets
        .iter_mut()
        .find(|target| target.url == url)
        .and_then(|target| target.server.as_mut())
        .and_then(|server| server.package.as_mut())
        .filter(|package| package.name == "@jetcrab/pi-desk")
    {
        // 安装选项只替换内置公共源，保留用户为服务配置的自定义仓库。
        if package.registry.as_deref().is_none_or(|registry| {
            matches!(
                registry.trim_end_matches('/'),
                "https://registry.npmjs.org"
                    | "https://registry.npmmirror.com"
                    | "https://mirrors.cloud.tencent.com/npm"
            )
        }) {
            package.registry = Some(source.npm_registry().into());
            save_config(state, config)?;
            write_shell_log(state, "environment-package-source", source.npm_registry());
        }
    }
    state.environment.save_download_source(source)
}

fn begin_environment_operation(
    app: &AppHandle,
    operation: EnvironmentOperation,
) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let _guard = state.config_write.lock().map_err(|_| "配置写入不可用")?;
    if state.closing.load(Ordering::Acquire) {
        return Err("桌面程序正在退出".into());
    }
    if state
        .environment_worker
        .lock()
        .map_err(|_| "环境后台操作不可用")?
        .as_ref()
        .is_some_and(|worker| !worker.is_finished())
    {
        return Err("环境操作正在收尾，请稍后再试".into());
    }
    let mut active = state
        .environment_operation
        .lock()
        .map_err(|_| "环境操作不可用")?;
    if active.is_some() {
        return Err("已有环境操作正在进行，请等待完成或取消".into());
    }
    let mut runtimes = state.target_runtimes.lock().map_err(|_| "运行状态不可用")?;
    if runtimes.values().any(|runtime| runtime.operation.is_some()) {
        return Err("服务操作正在进行，请等待完成或取消后再准备环境".into());
    }
    if !matches!(&operation, EnvironmentOperation::Check { .. })
        && runtimes.values().any(|runtime| runtime.child.is_some())
    {
        return Err("请先停止本机服务，再安装或更换运行环境；已运行的服务不会被自动中断".into());
    }
    if let EnvironmentOperation::Prepare(url, download_source) = &operation {
        save_preparation_source(&state, url, *download_source)?;
    }
    let previous = state.environment.snapshot();
    let cancel = Arc::new(AtomicBool::new(false));
    *active = Some(cancel.clone());
    if let EnvironmentOperation::Prepare(url, _) = &operation {
        let runtime = runtimes.entry(url.clone()).or_default();
        runtime.operation = Some(cancel.clone());
        runtime.stop_requested = false;
    }
    drop(runtimes);
    drop(active);
    state.environment.set_phase(
        if matches!(operation, EnvironmentOperation::Prepare(..)) {
            "installing"
        } else {
            "checking"
        },
        "正在检测运行环境",
        None,
    );
    let worker_app = app.clone();
    let worker_cancel = cancel.clone();
    let handle = thread::Builder::new()
        .name("desktop-environment-operation".into())
        .spawn(move || {
            run_environment_operation(&worker_app, operation, &worker_cancel, previous);
        });
    match handle {
        Ok(handle) => {
            if let Some(previous) = state
                .environment_worker
                .lock()
                .map_err(|_| "环境后台操作不可用")?
                .replace(handle)
            {
                let _ = previous.join();
            }
            Ok(())
        }
        Err(error) => {
            *state.environment_operation.lock().unwrap() = None;
            for runtime in state.target_runtimes.lock().unwrap().values_mut() {
                if runtime
                    .operation
                    .as_ref()
                    .is_some_and(|active| Arc::ptr_eq(active, &cancel))
                {
                    runtime.operation = None;
                }
            }
            state
                .environment
                .set_phase("failed", "无法创建环境后台操作", Some(error.to_string()));
            Err(format!("创建环境后台操作失败：{error}"))
        }
    }
}

fn checked_environment(state: &ShellState, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
    fs::create_dir_all(&state.environment.root)
        .map_err(|error| format!("创建桌面环境目录失败：{error}"))?;
    state.environment.check(cancelled, &state.log_path)?;
    let servers = state
        .config()?
        .targets
        .into_iter()
        .filter_map(|target| target.server)
        .collect::<Vec<_>>();
    state.environment.finish_check(&servers);
    for target in state.config()?.targets {
        let Some(server) = target.server else {
            continue;
        };
        if state.environment.needs_setup(&server) {
            continue;
        }
        let candidate = state
            .target_runtimes
            .lock()
            .map_err(|_| "运行状态不可用")?
            .get(&target.url)
            .and_then(|runtime| runtime.update.version.clone());
        if let (Some(package), Some(version)) = (
            &server.package,
            candidate.or(cached_version(state, &target.url)?),
        ) {
            if let Some(directory) = packages::installed_directory(
                &package_directory(state, &target.url)?,
                package,
                &version,
            ) {
                state.environment.verify_service(
                    &server,
                    &directory,
                    cancelled,
                    &state.log_path,
                )?;
            }
        }
    }
    Ok(())
}

fn run_environment_operation(
    app: &AppHandle,
    operation: EnvironmentOperation,
    cancel: &AtomicBool,
    previous: EnvironmentSnapshot,
) {
    let state = app.state::<ShellState>();
    let cancelled = || cancel.load(Ordering::Acquire) || state.closing.load(Ordering::Acquire);
    let prepare_url = match &operation {
        EnvironmentOperation::Prepare(url, _) => Some(url.clone()),
        _ => None,
    };
    let mut auto_start = false;
    let mut open_on_ready = false;
    let mut selection_cancelled = false;
    let mut started_service = false;
    let result = (|| -> Result<(), String> {
        match operation {
            EnvironmentOperation::Check {
                auto_start: enabled,
                open_on_ready: open,
            } => {
                auto_start = enabled;
                open_on_ready = open;
                checked_environment(&state, &cancelled)?;
            }
            EnvironmentOperation::Select(component, archive) => {
                if state
                    .environment
                    .select(component, archive, &cancelled, &state.log_path)?
                {
                    checked_environment(&state, &cancelled)?;
                } else {
                    selection_cancelled = true;
                }
            }
            EnvironmentOperation::Prepare(url, download_source) => {
                let server = configured_server(&state, &url)?;
                let prepared = Mutex::new(None);
                state.environment.prepare(
                    &server,
                    download_source,
                    &cancelled,
                    &state.log_path,
                    |stopped| {
                        *prepared.lock().unwrap() =
                            prepare_service_package(&state, &url, &server, stopped)?;
                        Ok(())
                    },
                )?;
                if state.environment.needs_setup(&server) {
                    return Err("环境仍未就绪，请检查缺失组件或重新选择兼容路径".into());
                }
                state
                    .environment
                    .set_phase("installing", "正在安装并验证服务", None);
                if !has_child(&state, &url) {
                    started_service = true;
                    set_phase(&state, &url, ServerPhase::Starting("正在准备服务".into()));
                    let result = execute_operation_with_prepared(
                        &state,
                        &url,
                        &server,
                        Operation::Start,
                        &cancelled,
                        prepared.into_inner().unwrap(),
                    );
                    record_operation_failure(
                        &state,
                        &url,
                        &server,
                        Operation::Start,
                        &result,
                        &cancelled,
                    );
                    result?;
                }
                if cancelled() {
                    return Err("操作已取消".into());
                }
                set_auto_start(&state, &url, true)?;
                let servers = state
                    .config()?
                    .targets
                    .into_iter()
                    .filter_map(|target| target.server)
                    .collect::<Vec<_>>();
                state.environment.finish_check(&servers);
                open_workspace_window(app, &url)?;
            }
        }
        Ok(())
    })();
    if selection_cancelled {
        state
            .environment
            .set_phase(&previous.status, &previous.step, previous.error);
    } else if let Err(error) = &result {
        write_shell_log(&state, "environment-operation-failed", error);
        if cancelled() {
            let servers = state
                .config()
                .map(|config| {
                    config
                        .targets
                        .into_iter()
                        .filter_map(|target| target.server)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            state.environment.finish_check(&servers);
        } else {
            state.environment.set_phase(
                "failed",
                "准备未完成，请按原因处理后重试",
                Some(error.clone()),
            );
        }
    }
    if let Some(url) = prepare_url {
        if cancelled() && started_service {
            if let Err(error) = stop_active_child(&state, &url) {
                write_shell_log(&state, "environment-service-cleanup-failed", &error);
            } else {
                set_phase(&state, &url, ServerPhase::Stopped);
            }
        }
        if let Ok(mut runtimes) = state.target_runtimes.lock() {
            let runtime = runtimes.entry(url).or_default();
            runtime.operation = None;
            runtime.stop_requested = false;
            if cancelled() {
                runtime.update = PackageUpdateSnapshot::default();
            }
        }
    }
    *state.environment_operation.lock().unwrap() = None;
    if auto_start && !cancelled() {
        if let Err(error) = start_servers_if_enabled(app) {
            write_shell_log(&state, "environment-auto-start-failed", &error);
        }
        if open_on_ready {
            if let Err(error) = activate_desktop(app) {
                write_shell_log(&state, "desktop-activate-failed", &error);
            }
        }
    }
}

#[derive(Clone, Copy, Debug)]
enum Operation {
    Start,
    Restart,
    Check,
    Update,
    AutoUpdate,
}

pub fn start_servers_if_enabled(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ShellState>();
    for target in state
        .config()?
        .targets
        .into_iter()
        .filter(|target| target.server.is_some())
    {
        if auto_start(&state, &target.url)?
            && !target
                .server
                .as_ref()
                .is_some_and(|server| state.environment.needs_setup(server))
        {
            if let Err(error) = start_server(app, &target.url, false) {
                write_shell_log(
                    &state,
                    "server-auto-start-error",
                    &format!("url={} error={error}", target.url),
                );
            }
        }
    }
    Ok(())
}

pub fn start_server(app: &AppHandle, url: &str, enable_auto_start: bool) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let url = config::normalize_target_url(url)?;
    configured_server(&state, &url)?;
    if enable_auto_start {
        set_auto_start(&state, &url, true)?;
    }
    if has_child(&state, &url) {
        return Ok(());
    }
    begin_operation(app, &url, Operation::Start)
}

pub fn restart_server(app: &AppHandle, url: &str) -> Result<(), String> {
    begin_operation(app, &config::normalize_target_url(url)?, Operation::Restart)
}

pub fn check_package_update(app: &AppHandle, url: &str) -> Result<(), String> {
    begin_operation(app, &config::normalize_target_url(url)?, Operation::Check)
}

pub fn update_package(app: &AppHandle, url: &str) -> Result<(), String> {
    begin_operation(app, &config::normalize_target_url(url)?, Operation::Update)
}

pub fn cancel_package_update(app: &AppHandle, url: &str) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let url = config::normalize_target_url(url)?;
    let mut runtimes = state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?;
    let runtime = runtimes
        .get_mut(&url)
        .ok_or_else(|| "当前没有可取消的操作".to_string())?;
    if runtime.update.status == "switching" {
        return Err("正在切换服务，请等待完成".into());
    }
    if let Some(cancel) = &runtime.operation {
        cancel.store(true, Ordering::Release);
    }
    write_shell_log(&state, "operation-cancel-request", &format!("url={url}"));
    Ok(())
}

pub fn stop_server(app: &AppHandle, url: &str) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let _write = state
        .config_write
        .lock()
        .map_err(|_| "配置写入不可用".to_string())?;
    let url = config::normalize_target_url(url)?;
    configured_server(&state, &url)?;
    set_auto_start(&state, &url, false)?;
    {
        let mut runtimes = state
            .target_runtimes
            .lock()
            .map_err(|_| "运行状态不可用".to_string())?;
        let runtime = runtimes.entry(url.clone()).or_default();
        if let Some(cancel) = &runtime.operation {
            runtime.stop_requested = true;
            cancel.store(true, Ordering::Release);
            return Ok(());
        }
    }
    stop_active_child(&state, &url)?;
    set_phase(&state, &url, ServerPhase::Stopped);
    Ok(())
}

fn begin_operation(app: &AppHandle, url: &str, operation: Operation) -> Result<(), String> {
    begin_operation_with_open(app, url, operation, false)
}

fn begin_operation_with_open(
    app: &AppHandle,
    url: &str,
    operation: Operation,
    open_after_start: bool,
) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let _config_guard = state
        .config_write
        .lock()
        .map_err(|_| "配置写入不可用".to_string())?;
    if state.closing.load(Ordering::Acquire) {
        return Err("桌面程序正在退出".into());
    }
    let server = configured_server(&state, url)?;
    if state
        .environment_operation
        .lock()
        .map_err(|_| "环境操作不可用")?
        .is_some()
    {
        return Err("环境操作正在进行，请等待完成或取消后再试".into());
    }
    if state.environment.needs_setup(&server) {
        return Err("请先在运行环境引导中准备所需组件，或重新检测已安装的环境".into());
    }
    if matches!(
        operation,
        Operation::Check | Operation::Update | Operation::AutoUpdate
    ) && server.package.is_none()
    {
        return Err("该服务未启用包管理".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut runtimes = state
            .target_runtimes
            .lock()
            .map_err(|_| "运行状态不可用".to_string())?;
        let runtime = runtimes.entry(url.to_string()).or_default();
        if runtime.operation.is_some() {
            if open_after_start && matches!(runtime.server_phase, ServerPhase::Starting(_)) {
                runtime.open_after_start = true;
                return Ok(());
            }
            if open_after_start && runtime.child.is_none() && runtime.update.status == "checking" {
                runtime.open_after_start = true;
                runtime
                    .operation
                    .as_ref()
                    .unwrap()
                    .store(true, Ordering::Release);
                return Ok(());
            }
            return Err("该服务有操作正在进行".into());
        }
        runtime.operation = Some(cancel.clone());
        runtime.stop_requested = false;
        runtime.open_after_start = open_after_start;
        if matches!(
            operation,
            Operation::Check | Operation::Update | Operation::AutoUpdate
        ) {
            runtime.last_check = Some(Instant::now());
            if !matches!(operation, Operation::AutoUpdate) {
                runtime.update = PackageUpdateSnapshot {
                    status: "checking".into(),
                    ..Default::default()
                };
            }
        } else if runtime.child.is_none() {
            runtime.server_phase = ServerPhase::Starting("正在准备启动".into());
        }
    }
    write_shell_log(
        &state,
        "operation-start",
        &format!("url={url} operation={operation:?}"),
    );
    let worker_app = app.clone();
    let worker_url = url.to_string();
    let handle = thread::Builder::new()
        .name("desktop-service-operation".into())
        .spawn(move || {
            run_operation(&worker_app, &worker_url, &server, operation, &cancel);
        });
    match handle {
        Ok(handle) => state
            .workers
            .lock()
            .map_err(|_| "后台操作不可用".to_string())?
            .push(handle),
        Err(error) => {
            if let Ok(mut runtimes) = state.target_runtimes.lock() {
                let runtime = runtimes.entry(url.to_string()).or_default();
                runtime.operation = None;
                runtime.update = PackageUpdateSnapshot {
                    status: "failed".into(),
                    error: Some(error.to_string()),
                    version: None,
                };
                if runtime.child.is_none()
                    && matches!(operation, Operation::Start | Operation::Restart)
                {
                    runtime.server_phase =
                        ServerPhase::Failed(format!("创建后台操作失败：{error}"));
                }
            }
            write_shell_log(
                &state,
                "operation-spawn-failed",
                &format!("url={url} operation={operation:?} error={error}"),
            );
            return Err(format!("创建后台操作失败：{error}"));
        }
    }
    Ok(())
}

fn run_operation(
    app: &AppHandle,
    url: &str,
    server: &ServerConfig,
    operation: Operation,
    cancel: &AtomicBool,
) {
    let state = app.state::<ShellState>();
    let started = Instant::now();
    let cancelled = || cancel.load(Ordering::Acquire) || state.closing.load(Ordering::Acquire);
    let startup_check = matches!(operation, Operation::Start)
        && server
            .package
            .as_ref()
            .is_some_and(|package| package.startup_update == UpdatePolicy::Check)
        && cached_version(&state, url).ok().flatten().is_some();
    let result = execute_operation(&state, url, server, operation, &cancelled);
    record_operation_failure(&state, url, server, operation, &result, &cancelled);
    let stop_requested = {
        let mut runtimes = state.target_runtimes.lock().unwrap();
        let runtime = runtimes.entry(url.to_string()).or_default();
        if runtime.stop_requested || state.closing.load(Ordering::Acquire) {
            true
        } else {
            runtime.operation = None;
            false
        }
    };
    if stop_requested {
        match stop_active_child(&state, url) {
            Ok(()) => set_phase(&state, url, ServerPhase::Stopped),
            Err(error) => write_shell_log(
                &state,
                "server-stop-failed",
                &format!("url={url} error={error}"),
            ),
        }
        if let Ok(mut runtimes) = state.target_runtimes.lock() {
            let runtime = runtimes.entry(url.to_string()).or_default();
            runtime.operation = None;
            runtime.stop_requested = false;
        }
    }
    let (open, resume_start) = state
        .target_runtimes
        .lock()
        .map(|mut runtimes| {
            let runtime = runtimes.entry(url.to_string()).or_default();
            let open = runtime.open_after_start
                && runtime.child.is_some()
                && result.is_ok()
                && !cancelled();
            let resume_start = runtime.open_after_start
                && matches!(operation, Operation::Check)
                && !stop_requested
                && !state.closing.load(Ordering::Acquire);
            runtime.open_after_start = false;
            (open, resume_start)
        })
        .unwrap_or((false, false));
    if resume_start {
        if let Err(error) = begin_operation_with_open(app, url, Operation::Start, true) {
            write_shell_log(&state, "resume-start-failed", &error);
            let _ = open_control_window(app);
        }
    }
    if open {
        if let Err(error) = open_workspace_window(app, url) {
            write_shell_log(&state, "browser-open-failed", &error);
            let _ = open_control_window(app);
        }
    }
    if !cancelled() {
        if result.is_err() && matches!(operation, Operation::Start | Operation::Restart) {
            let _ = open_control_window(app);
        }
        if result.is_ok() && matches!(operation, Operation::Check) {
            let show_update = {
                let mut runtimes = state.target_runtimes.lock().unwrap();
                let runtime = runtimes.entry(url.to_string()).or_default();
                let available = if runtime.update.status == "available" {
                    runtime.update.version.clone()
                } else {
                    None
                };
                let changed = available.is_some() && available != runtime.notified_version;
                runtime.notified_version = available;
                changed
            };
            if show_update {
                if let Err(error) = open_control_window(app) {
                    write_shell_log(&state, "update-window-failed", &error);
                }
            }
        }
        if result.is_ok() && startup_check && has_child(&state, url) {
            if let Err(error) = begin_operation(app, url, Operation::Check) {
                write_shell_log(
                    &state,
                    "startup-check-skipped",
                    &format!("url={url} error={error}"),
                );
            }
        }
    }
    write_shell_log(
        &state,
        "operation-end",
        &format!(
            "url={url} operation={operation:?} success={} elapsed_ms={}",
            result.is_ok(),
            started.elapsed().as_millis()
        ),
    );
}

fn record_operation_failure(
    state: &ShellState,
    url: &str,
    server: &ServerConfig,
    operation: Operation,
    result: &Result<(), String>,
    cancelled: &dyn Fn() -> bool,
) {
    let Err(error) = result else {
        return;
    };
    write_shell_log(
        state,
        "operation-failed",
        &format!("url={url} operation={operation:?} error={error}"),
    );
    let mut runtimes = state.target_runtimes.lock().unwrap();
    let runtime = runtimes.entry(url.to_string()).or_default();
    if cancelled() {
        runtime.update = PackageUpdateSnapshot::default();
        runtime.server_phase = if runtime.child.is_some() {
            ServerPhase::Running
        } else {
            ServerPhase::Stopped
        };
    } else {
        if server.package.is_some() {
            runtime.update.status = "failed".into();
            runtime.update.error = Some(error.clone());
        }
        if runtime.child.is_none() && matches!(operation, Operation::Start | Operation::Restart) {
            runtime.server_phase = ServerPhase::Failed(error.clone());
        }
    }
}

struct PackageSelection {
    version: String,
    cached_directory: Option<PathBuf>,
}

struct PreparedPackage {
    selection: PackageSelection,
    directory: PathBuf,
}

fn select_package(
    state: &ShellState,
    url: &str,
    package: &config::PackageConfig,
    operation: Operation,
    cached: Option<&str>,
    cancelled: &dyn Fn() -> bool,
) -> Result<PackageSelection, String> {
    let base = package_directory(state, url)?;
    let cached_directory =
        cached.and_then(|version| packages::installed_directory(&base, package, version));
    let mut version = cached_directory.as_ref().and(cached).map(str::to_string);
    if matches!(
        operation,
        Operation::Check | Operation::Update | Operation::AutoUpdate
    ) || cached_directory.is_none()
        || (matches!(operation, Operation::Start) && package.startup_update == UpdatePolicy::Update)
    {
        set_update(state, url, "checking", None, None);
        match packages::query_version_with_environment(
            package,
            &state.log_path,
            cancelled,
            &state
                .environment
                .npm_command()
                .unwrap_or_else(|_| "npm".into()),
            &state.environment.child_environment(),
        ) {
            Ok(latest) => {
                if cached_directory.is_none()
                    || should_select_version(package, Some(&latest), cached)
                {
                    version = Some(latest);
                }
            }
            Err(error)
                if matches!(operation, Operation::Start)
                    && cached_directory.is_some()
                    && !cancelled() =>
            {
                write_shell_log(
                    state,
                    "version-check-fallback",
                    &format!("url={url} error={error}"),
                );
            }
            Err(error) => return Err(error),
        }
    }
    Ok(PackageSelection {
        version: version.ok_or_else(|| "没有可安装的版本".to_string())?,
        cached_directory,
    })
}

fn install_selected_package(
    state: &ShellState,
    url: &str,
    package: &config::PackageConfig,
    selection: &PackageSelection,
    cached: Option<&str>,
    cancelled: &dyn Fn() -> bool,
) -> Result<PathBuf, String> {
    let started = Instant::now();
    if cancelled() {
        return Err("操作已取消".into());
    }
    if let Some(directory) = selection
        .cached_directory
        .as_ref()
        .filter(|_| Some(selection.version.as_str()) == cached)
    {
        write_shell_log(
            state,
            "package-reused",
            &format!(
                "复用已安装服务 npm 包 package={} version={} elapsed_ms={}",
                package.name,
                selection.version,
                started.elapsed().as_millis()
            ),
        );
        return Ok(directory.clone());
    }
    set_update(
        state,
        url,
        "installing",
        Some(selection.version.clone()),
        None,
    );
    packages::install_with_environment(
        &package_directory(state, url)?,
        package,
        &selection.version,
        &state.log_path,
        cancelled,
        &state
            .environment
            .npm_command()
            .unwrap_or_else(|_| "npm".into()),
        &state.environment.child_environment(),
    )
}

fn prepare_service_package(
    state: &ShellState,
    url: &str,
    server: &ServerConfig,
    cancelled: &dyn Fn() -> bool,
) -> Result<Option<PreparedPackage>, String> {
    let Some(package) = &server.package else {
        return Ok(None);
    };
    set_update(state, url, "checking", None, None);
    let result: Result<Option<PreparedPackage>, String> = (|| {
        let cached = cached_version(state, url)?;
        let selection = select_package(
            state,
            url,
            package,
            Operation::Start,
            cached.as_deref(),
            cancelled,
        )?;
        let directory = install_selected_package(
            state,
            url,
            package,
            &selection,
            cached.as_deref(),
            cancelled,
        )?;
        set_update(
            state,
            url,
            "installed",
            Some(selection.version.clone()),
            None,
        );
        Ok(Some(PreparedPackage {
            selection,
            directory,
        }))
    })();
    if let Err(error) = &result {
        let version = state
            .target_runtimes
            .lock()
            .unwrap()
            .get(url)
            .and_then(|runtime| runtime.update.version.clone());
        set_update(state, url, "failed", version, Some(error.clone()));
    }
    result
}

fn execute_operation(
    state: &ShellState,
    url: &str,
    server: &ServerConfig,
    operation: Operation,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), String> {
    execute_operation_with_prepared(state, url, server, operation, cancelled, None)
}

fn execute_operation_with_prepared(
    state: &ShellState,
    url: &str,
    server: &ServerConfig,
    operation: Operation,
    cancelled: &dyn Fn() -> bool,
    prepared: Option<PreparedPackage>,
) -> Result<(), String> {
    let previous = state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?
        .get(url)
        .and_then(|runtime| runtime.child.as_ref())
        .map(|child| {
            (
                child.version.clone(),
                child.directory.clone(),
                child.server.clone(),
            )
        });
    let was_running = previous.is_some();
    if was_running && matches!(operation, Operation::Start) {
        return Ok(());
    }
    let (old_version, old_directory, old_server) = previous.unwrap_or((None, None, server.clone()));
    let failed_update = if matches!(operation, Operation::AutoUpdate) {
        state
            .target_runtimes
            .lock()
            .map_err(|_| "运行状态不可用".to_string())?
            .get(url)
            .map(|runtime| runtime.update.clone())
            .filter(|update| update.status == "failed")
    } else {
        None
    };
    let cached = if old_server.package.as_ref().map(|package| &package.name)
        == server.package.as_ref().map(|package| &package.name)
    {
        old_version.clone().or(cached_version(state, url)?)
    } else {
        cached_version(state, url)?
    };
    let base = package_directory(state, url)?;
    let mut version = cached.clone();
    let mut directory = None;
    if let Some(package) = &server.package {
        let (selection, prepared_directory) = match prepared {
            Some(prepared) => (prepared.selection, Some(prepared.directory)),
            None => (
                select_package(state, url, package, operation, cached.as_deref(), cancelled)?,
                None,
            ),
        };
        version = Some(selection.version.clone());
        let cached_directory = &selection.cached_directory;
        let selected = selection.version.as_str();
        if matches!(operation, Operation::Check) {
            if cached_directory.is_none()
                || should_select_version(package, version.as_deref(), cached.as_deref())
            {
                set_update(state, url, "available", version, None);
            } else {
                set_update(state, url, "idle", None, None);
            }
            return Ok(());
        }
        if matches!(operation, Operation::AutoUpdate) {
            if !should_select_version(package, version.as_deref(), cached.as_deref()) {
                set_update(state, url, "idle", None, None);
                return Ok(());
            }
            if let Some(failed) = failed_update.filter(|failed| failed.version == version) {
                set_update(state, url, "failed", failed.version, failed.error);
                return Ok(());
            }
        }
        if cancelled() {
            return Err("操作已取消".into());
        }
        let installation = match prepared_directory {
            Some(directory) => Ok(directory),
            None => install_selected_package(
                state,
                url,
                package,
                &selection,
                cached.as_deref(),
                cancelled,
            ),
        };
        directory = Some(match installation {
            Ok(directory) => directory,
            Err(error) => {
                if !was_running && matches!(operation, Operation::Start) && !cancelled() {
                    if let Some((previous, previous_directory)) = cached
                        .as_ref()
                        .filter(|previous| previous.as_str() != selected)
                        .and_then(|previous| {
                            packages::installed_directory(&base, package, previous)
                                .map(|directory| (previous, directory))
                        })
                    {
                        write_shell_log(
                            state,
                            "server-install-rollback",
                            &format!("url={url} version={previous} error={error}"),
                        );
                        set_phase(state, url, ServerPhase::Starting("正在恢复原服务".into()));
                        return match launch_service(
                            state,
                            url,
                            server,
                            Some(previous.clone()),
                            Some(previous_directory),
                            cancelled,
                        ) {
                            Ok(()) => Err(format!("新版本安装失败，已恢复原服务：{error}")),
                            Err(rollback) => Err(format!(
                                "新版本安装失败：{error}；恢复原服务也失败：{rollback}"
                            )),
                        };
                    }
                }
                return Err(error.to_string());
            }
        });
    }
    if let Some(directory) = &directory {
        state
            .environment
            .verify_service(server, directory, cancelled, &state.log_path)?;
    }
    if cancelled() {
        return Err("操作已取消".into());
    }
    if matches!(operation, Operation::Update | Operation::AutoUpdate) && !was_running {
        if let Some(version) = &version {
            set_cached_version(state, url, version.clone())?;
        }
    } else {
        if matches!(operation, Operation::Update | Operation::AutoUpdate)
            && was_running
            && version == old_version
            && directory == old_directory
        {
            set_update(state, url, "idle", None, None);
            return Ok(());
        }
        if was_running {
            set_update(state, url, "switching", version.clone(), None);
        }
        stop_active_child(state, url)?;
        set_phase(state, url, ServerPhase::Starting("正在等待服务响应".into()));
        let start = launch_service(
            state,
            url,
            server,
            version.clone(),
            directory.clone(),
            cancelled,
        );
        if let Err(error) = start {
            if matches!(error, LaunchFailure::Cleanup(_)) {
                set_phase(state, url, ServerPhase::Failed(error.to_string()));
                return Err(error.to_string());
            }
            let fallback = if was_running {
                Some((old_version, old_directory, old_server))
            } else {
                server.package.as_ref().and_then(|package| {
                    cached
                        .as_ref()
                        .filter(|previous| Some(*previous) != version.as_ref())
                        .and_then(|previous| {
                            packages::installed_directory(&base, package, previous)
                                .map(|directory| (previous.clone(), directory))
                        })
                        .or_else(|| {
                            version.as_deref().and_then(|version| {
                                packages::previous_installed_directory(&base, package, version)
                            })
                        })
                        .map(|(version, directory)| {
                            (Some(version), Some(directory), server.clone())
                        })
                })
            }
            .filter(|_| !cancelled());
            if version != cached
                || fallback
                    .as_ref()
                    .is_some_and(|(_, previous, _)| previous != &directory)
            {
                if let Some(candidate) = &directory {
                    if let Err(cleanup) = fs::remove_dir_all(candidate) {
                        write_shell_log(
                            state,
                            "package-cleanup-failed",
                            &format!("directory={} error={cleanup}", candidate.display()),
                        );
                    }
                }
            }
            if let Some((fallback_version, fallback_directory, fallback_server)) = fallback {
                write_shell_log(
                    state,
                    "server-rollback-start",
                    &format!("url={url} version={fallback_version:?}"),
                );
                match launch_service(
                    state,
                    url,
                    &fallback_server,
                    fallback_version.clone(),
                    fallback_directory,
                    cancelled,
                ) {
                    Ok(()) => {
                        if fallback_server
                            .package
                            .as_ref()
                            .map(|package| &package.name)
                            == server.package.as_ref().map(|package| &package.name)
                        {
                            if let Some(version) = fallback_version {
                                set_cached_version(state, url, version)?;
                            }
                        }
                        let channel_changed = fallback_server
                            .package
                            .as_ref()
                            .map(|package| package.channel)
                            != server.package.as_ref().map(|package| package.channel);
                        return Err(if channel_changed {
                            format!(
                                "新服务启动失败，已恢复原服务；仍在使用原通道，本次通道切换未完成：{error}"
                            )
                        } else {
                            format!("新服务启动失败，已恢复原服务：{error}")
                        });
                    }
                    Err(rollback) => {
                        let detail = format!("服务启动失败：{error}；恢复原服务也失败：{rollback}");
                        set_phase(state, url, ServerPhase::Failed(detail.clone()));
                        return Err(detail);
                    }
                }
            }
            set_phase(state, url, ServerPhase::Failed(error.to_string()));
            return Err(error.to_string());
        }
        if let Some(version) = &version {
            set_cached_version(state, url, version.clone())?;
        }
    }
    set_update(state, url, "idle", None, None);
    if let (Some(package), Some(version)) = (&server.package, &version) {
        let mut keep = vec![version.as_str()];
        if let Some(previous) = &cached {
            keep.push(previous.as_str());
        }
        packages::cleanup(&base, package, &keep, &state.log_path);
    }
    Ok(())
}

fn package_directory(state: &ShellState, url: &str) -> Result<PathBuf, String> {
    let root = state
        .log_path
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "日志目录无效".to_string())?;
    Ok(root
        .join("packages")
        .join(config::target_port(url)?.to_string()))
}

#[derive(Debug)]
enum LaunchFailure {
    Other(String),
    Cleanup(String),
}

impl From<String> for LaunchFailure {
    fn from(detail: String) -> Self {
        Self::Other(detail)
    }
}

impl std::fmt::Display for LaunchFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Other(detail) | Self::Cleanup(detail) => formatter.write_str(detail),
        }
    }
}

fn launch_service(
    state: &ShellState,
    url: &str,
    server: &ServerConfig,
    version: Option<String>,
    directory: Option<PathBuf>,
    cancelled: &dyn Fn() -> bool,
) -> Result<(), LaunchFailure> {
    if cancelled() {
        return Err("操作已取消".to_string().into());
    }
    let port = config::target_port(url)?;
    service_port::wait_until_free(port, PORT_RELEASE_TIMEOUT, &state.log_path)?;
    if cancelled() {
        return Err("操作已取消".to_string().into());
    }
    let package = server
        .package
        .as_ref()
        .map(|package| format!("{}@{}", package.name, version.as_deref().unwrap_or("")))
        .unwrap_or_default();
    let command = server
        .start_command
        .replace("{port}", &port.to_string())
        .replace("{package}", &package);
    write_shell_log(
        state,
        "server-spawn",
        &format!("url={url} version={version:?} command={command}"),
    );
    let log = state.log_path.with_file_name("server.log");
    let mut environment = state.environment.child_environment();
    let executable =
        std::env::current_exe().map_err(|error| format!("获取桌面程序路径失败：{error}"))?;
    environment.push((
        "PI_DESK_DESKTOP_EXECUTABLE".into(),
        executable.into_os_string(),
    ));
    environment.push((
        "PI_DESK_DESKTOP_CONFIG".into(),
        state.config_path.as_os_str().to_owned(),
    ));
    let mut child =
        process::spawn_with_environment(&command, directory.as_deref(), &log, &environment)?;
    let started = Instant::now();
    let mut next_health_log = Duration::ZERO;
    let health_url = format!("http://127.0.0.1:{port}{}", server.ready_path);
    let ready = loop {
        if cancelled() {
            break Err(LaunchFailure::Other("操作已取消".into()));
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                let detail = child.failure_detail();
                break Err(format!(
                    "服务进程提前退出：{status}。{}",
                    if detail.is_empty() {
                        "请检查启动命令、服务依赖与端口设置后重试".to_string()
                    } else {
                        detail
                    }
                )
                .into());
            }
            Err(error) => break Err(format!("读取服务进程状态失败：{error}").into()),
            Ok(None) => {}
        }
        let health_error = match check_health(port, &server.ready_path) {
            Ok(()) => break Ok(()),
            Err(error) => error,
        };
        let elapsed = started.elapsed();
        if elapsed >= START_TIMEOUT {
            break Err(LaunchFailure::Other(format!(
                "服务在 {} 秒内未通过健康检查（{health_url}）；最后一次检查：{health_error}",
                START_TIMEOUT.as_secs()
            )));
        }
        if elapsed >= next_health_log {
            write_shell_log(
                state,
                "server-health-wait",
                &format!(
                    "url={url} pid={} elapsed_ms={} health_url={health_url} error={health_error}",
                    child.id(),
                    elapsed.as_millis()
                ),
            );
            next_health_log = elapsed + Duration::from_secs(5);
        }
        thread::sleep(Duration::from_millis(250));
    };
    if let Err(error) = ready {
        write_shell_log(
            state,
            "server-start-failed",
            &format!(
                "url={url} pid={} elapsed_ms={} error={error}",
                child.id(),
                started.elapsed().as_millis()
            ),
        );
        stop_service_child(state, url, &mut child).map_err(|cleanup| {
            LaunchFailure::Cleanup(format!("{error}；清理服务失败：{cleanup}"))
        })?;
        return Err(error);
    }
    if cancelled() {
        stop_service_child(state, url, &mut child).map_err(LaunchFailure::Cleanup)?;
        return Err("操作已取消".to_string().into());
    }
    let mut runtimes = state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?;
    let runtime = runtimes.entry(url.to_string()).or_default();
    runtime.child = Some(ManagedChild {
        child,
        version: version.clone(),
        directory,
        server: server.clone(),
    });
    runtime.server_phase = ServerPhase::Running;
    drop(runtimes);
    write_shell_log(
        state,
        "server-ready",
        &format!("url={url} elapsed_ms={}", started.elapsed().as_millis()),
    );
    Ok(())
}

fn stop_service_child(
    state: &ShellState,
    url: &str,
    child: &mut ManagedProcess,
) -> Result<(), String> {
    let started = Instant::now();
    let result = process::stop_child(child).and_then(|_| {
        service_port::wait_until_free(
            config::target_port(url)?,
            PORT_RELEASE_TIMEOUT,
            &state.log_path,
        )
    });
    write_shell_log(
        state,
        "server-stop-complete",
        &format!(
            "url={url} pid={} elapsed_ms={} result={result:?}",
            child.id(),
            started.elapsed().as_millis()
        ),
    );
    result
}

fn stop_active_child(state: &ShellState, url: &str) -> Result<(), String> {
    let child = state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?
        .get_mut(url)
        .and_then(|runtime| runtime.child.take());
    if let Some(mut child) = child {
        write_shell_log(
            state,
            "server-stop",
            &format!("url={url} pid={}", child.child.id()),
        );
        if let Err(error) = stop_service_child(state, url, &mut child.child) {
            set_phase(state, url, ServerPhase::Failed(error.clone()));
            return Err(error);
        }
    }
    Ok(())
}

fn has_child(state: &ShellState, url: &str) -> bool {
    state
        .target_runtimes
        .lock()
        .map(|runtimes| {
            runtimes
                .get(url)
                .is_some_and(|runtime| runtime.child.is_some())
        })
        .unwrap_or(false)
}

fn set_phase(state: &ShellState, url: &str, phase: ServerPhase) {
    if let Ok(mut runtimes) = state.target_runtimes.lock() {
        runtimes.entry(url.to_string()).or_default().server_phase = phase;
    }
}

fn set_update(
    state: &ShellState,
    url: &str,
    status: &str,
    version: Option<String>,
    error: Option<String>,
) {
    if let Ok(mut runtimes) = state.target_runtimes.lock() {
        runtimes.entry(url.to_string()).or_default().update = PackageUpdateSnapshot {
            status: status.into(),
            version,
            error,
        };
    }
    write_shell_log(state, "update-state", &format!("url={url} status={status}"));
}

fn check_health(port: u16, path: &str) -> Result<(), String> {
    use std::io::{Read, Write};
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_millis(500),
    )
    .map_err(|error| format!("连接健康检查失败：{error}"))?;
    let timeout = Some(Duration::from_millis(500));
    stream
        .set_read_timeout(timeout)
        .and_then(|_| stream.set_write_timeout(timeout))
        .map_err(|error| format!("设置健康检查超时失败：{error}"))?;
    stream
        .write_all(
            format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .map_err(|error| format!("发送健康检查请求失败：{error}"))?;
    let mut response = [0; 12];
    stream
        .read_exact(&mut response)
        .map_err(|error| format!("读取健康检查响应失败（单次超时 500 毫秒）：{error}"))?;
    let status = String::from_utf8_lossy(&response)
        .split_whitespace()
        .nth(1)
        .and_then(|value| value.parse::<u16>().ok());
    if !status.is_some_and(|status| (200..400).contains(&status)) {
        return Err(format!(
            "健康检查返回非成功状态：{}",
            String::from_utf8_lossy(&response)
        ));
    }
    Ok(())
}

pub fn control_state(state: &ShellState) -> Result<ControlState, String> {
    let config = state.config()?;
    let runtimes = state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?;
    let info = state
        .runtime_info
        .lock()
        .map_err(|_| "运行记录不可用".to_string())?;
    let targets = config
        .targets
        .iter()
        .map(|target| {
            let fallback = TargetRuntime::default();
            let runtime = runtimes.get(&target.url).unwrap_or(&fallback);
            let saved = info.targets.get(&target.url);
            let server = target.server.as_ref().map(|server| {
                let (status, detail) = match &runtime.server_phase {
                    ServerPhase::Stopped => ("stopped", "服务未运行".to_string()),
                    ServerPhase::Starting(detail) => ("starting", detail.clone()),
                    ServerPhase::Running => ("running", "服务已就绪".to_string()),
                    ServerPhase::Failed(error) => ("failed", error.clone()),
                };
                ServerSnapshot {
                    status: status.into(),
                    detail,
                    version: runtime
                        .child
                        .as_ref()
                        .and_then(|child| child.version.clone())
                        .or_else(|| saved.and_then(|saved| saved.last_version.clone())),
                    auto_start: saved.map(|saved| saved.auto_start).unwrap_or(true),
                    needs_setup: state.environment.needs_setup(server),
                    update: server.package.as_ref().map(|_| runtime.update.clone()),
                }
            });
            TargetSnapshot {
                url: target.url.clone(),
                server,
                tunnel: target
                    .tunnel
                    .as_ref()
                    .map(|tunnel| tunnel_snapshot(&runtime.tunnel_phase, tunnel.public_port)),
            }
        })
        .collect();
    Ok(ControlState {
        hide_on_startup: info.hide_on_startup,
        hide_on_open: info.hide_on_open,
        show_on_close: info.show_on_close,
        targets,
        environment: state.environment.snapshot(),
    })
}

// 状态监控属于桌面运行态，不依赖控制页面是否打开。
pub fn start_update_monitor(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let mut monitor = state
        .monitor
        .lock()
        .map_err(|_| "状态监控不可用".to_string())?;
    if monitor.is_some() {
        return Ok(());
    }
    let (stop, receive) = mpsc::channel();
    let worker_app = app.clone();
    let handle = thread::Builder::new()
        .name("desktop-state-monitor".into())
        .spawn(move || {
            let mut previous = String::new();
            while matches!(
                receive.recv_timeout(Duration::from_millis(500)),
                Err(mpsc::RecvTimeoutError::Timeout)
            ) {
                let state = worker_app.state::<ShellState>();
                if state.closing.load(Ordering::Acquire) {
                    break;
                }
                monitor_processes(&state);
                reap_workers(&state);
                if let Ok(config) = state.config() {
                    for target in config.targets {
                        let policy = target
                            .server
                            .as_ref()
                            .and_then(|server| server.package.as_ref())
                            .map(|package| package.periodic_update)
                            .unwrap_or(UpdatePolicy::None);
                        if policy != UpdatePolicy::None {
                            let due = state
                                .target_runtimes
                                .lock()
                                .map(|runtimes| {
                                    runtimes.get(&target.url).is_some_and(|runtime| {
                                        runtime.child.is_some()
                                            && runtime.operation.is_none()
                                            && runtime
                                                .last_check
                                                .map(|last| {
                                                    last.elapsed() >= PACKAGE_UPDATE_INTERVAL
                                                })
                                                .unwrap_or(true)
                                    })
                                })
                                .unwrap_or(false);
                            if due {
                                let _ = begin_operation(
                                    &worker_app,
                                    &target.url,
                                    if policy == UpdatePolicy::Check {
                                        Operation::Check
                                    } else {
                                        Operation::AutoUpdate
                                    },
                                );
                            }
                        }
                    }
                }
                if let Ok(snapshot) = control_state(&state).and_then(|snapshot| {
                    serde_json::to_string(&snapshot).map_err(|error| error.to_string())
                }) {
                    if snapshot != previous {
                        previous = snapshot;
                        let _ = worker_app.emit_to("control", "desktop-state-changed", ());
                    }
                }
            }
        })
        .map_err(|error| format!("创建状态监控失败：{error}"))?;
    *monitor = Some((stop, handle));
    Ok(())
}

fn reap_workers(state: &ShellState) {
    if let Ok(mut worker) = state.environment_worker.lock() {
        if worker.as_ref().is_some_and(JoinHandle::is_finished) {
            if worker.take().unwrap().join().is_err() {
                write_shell_log(state, "environment-panicked", "环境后台操作异常终止");
            }
        }
    }
    let mut completed = Vec::new();
    if let Ok(mut workers) = state.workers.lock() {
        let mut index = 0;
        while index < workers.len() {
            if workers[index].is_finished() {
                completed.push(workers.swap_remove(index));
            } else {
                index += 1;
            }
        }
    }
    for worker in completed {
        if worker.join().is_err() {
            write_shell_log(state, "operation-panicked", "后台操作异常终止");
        }
    }
}

fn monitor_processes(state: &ShellState) {
    let Ok(mut runtimes) = state.target_runtimes.lock() else {
        return;
    };
    for (url, runtime) in runtimes.iter_mut() {
        if let Some(child) = &mut runtime.child {
            if let Ok(Some(status)) = child.child.try_wait() {
                write_shell_log(
                    state,
                    "server-exited",
                    &format!("url={url} status={status}"),
                );
                runtime.child.take();
                if runtime.operation.is_none() {
                    runtime.server_phase = ServerPhase::Failed(format!("服务进程已退出：{status}"));
                }
            }
        }
        let mut stopped = false;
        if let Some(worker) = &runtime.tunnel_worker {
            loop {
                match worker.try_recv() {
                    Ok(TunnelWorkerEvent::Opening) => runtime.tunnel_phase = TunnelPhase::Opening,
                    Ok(TunnelWorkerEvent::Connecting { public_addr }) => {
                        runtime.tunnel_phase = TunnelPhase::Connecting(public_addr)
                    }
                    Ok(TunnelWorkerEvent::Listening { public_addr }) => {
                        runtime.tunnel_phase = TunnelPhase::Listening(public_addr)
                    }
                    Ok(TunnelWorkerEvent::Recovering(error)) => {
                        runtime.tunnel_phase = TunnelPhase::Recovering(error)
                    }
                    Ok(TunnelWorkerEvent::Failed(error)) => {
                        write_shell_log(
                            state,
                            "tunnel-failed",
                            &format!("url={url} error={error}"),
                        );
                        runtime.tunnel_phase = TunnelPhase::Failed(error);
                    }
                    Ok(TunnelWorkerEvent::Stopped) => {
                        stopped = true;
                        break;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        stopped = true;
                        break;
                    }
                }
            }
        }
        if stopped {
            runtime.tunnel_worker.take();
            if !matches!(runtime.tunnel_phase, TunnelPhase::Failed(_)) {
                runtime.tunnel_phase = TunnelPhase::Stopped;
            }
        }
    }
}

pub fn start_tunnels_if_enabled(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<ShellState>();
    for target in state.config()?.targets {
        if target.tunnel.as_ref().is_some_and(|tunnel| tunnel.enabled) {
            if let Err(error) = start_tunnel(app, &target.url, false) {
                write_shell_log(
                    &state,
                    "tunnel-auto-start-error",
                    &format!("url={} error={error}", target.url),
                );
            }
        }
    }
    Ok(())
}

pub fn start_tunnel(app: &AppHandle, url: &str, persist_enabled: bool) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let _write = state
        .config_write
        .lock()
        .map_err(|_| "配置写入不可用".to_string())?;
    if state.closing.load(Ordering::Acquire) {
        return Err("桌面程序正在退出".into());
    }
    let url = config::normalize_target_url(url)?;
    if state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?
        .get(&url)
        .is_some_and(|runtime| runtime.tunnel_worker.is_some())
    {
        return Ok(());
    }
    let mut config = state.config()?;
    let target = config
        .targets
        .iter_mut()
        .find(|target| target.url == url)
        .ok_or_else(|| "网址不存在".to_string())?;
    let target_tunnel = target
        .tunnel
        .as_mut()
        .ok_or_else(|| "未配置公网端口".to_string())?;
    if persist_enabled {
        target_tunnel.enabled = true;
    }
    if !target_tunnel.enabled {
        return Err("公网端口未启用".into());
    }
    let public_port = target_tunnel.public_port;
    let tunnel = ensure_desktop_tunnel_ready_config(&mut config)?;
    let (control_key, device_id) = require_ready(&tunnel, DESKTOP_DEVICE_KEY)?;
    save_config(&state, config)?;
    let worker = tunnel::start_tunnel_worker(TunnelWorkerConfig {
        control_server_url: tunnel.control_server_url.clone(),
        control_key,
        device_id,
        local_addr: format!("127.0.0.1:{}", config::target_port(&url)?),
        public_port,
    })?;
    let mut runtimes = state
        .target_runtimes
        .lock()
        .map_err(|_| "运行状态不可用".to_string())?;
    let runtime = runtimes.entry(url.clone()).or_default();
    runtime.tunnel_worker = Some(worker);
    runtime.tunnel_phase = TunnelPhase::Opening;
    write_shell_log(
        &state,
        "tunnel-start",
        &format!("url={url} public_port={public_port}"),
    );
    Ok(())
}

pub fn stop_tunnel(app: &AppHandle, url: &str) -> Result<(), String> {
    let state = app.state::<ShellState>();
    let _write = state
        .config_write
        .lock()
        .map_err(|_| "配置写入不可用".to_string())?;
    let url = config::normalize_target_url(url)?;
    let mut config = state.config()?;
    let tunnel = config
        .targets
        .iter_mut()
        .find(|target| target.url == url)
        .and_then(|target| target.tunnel.as_mut())
        .ok_or_else(|| "未配置公网端口".to_string())?;
    tunnel.enabled = false;
    save_config(&state, config)?;
    stop_tunnel_runtime(&state, &url);
    Ok(())
}

fn stop_tunnel_runtime(state: &ShellState, url: &str) {
    if let Ok(mut runtimes) = state.target_runtimes.lock() {
        if let Some(runtime) = runtimes.get_mut(url) {
            if let Some(worker) = &runtime.tunnel_worker {
                worker.stop();
                runtime.tunnel_phase = TunnelPhase::Stopping;
            }
        }
    }
}

fn tunnel_snapshot(phase: &TunnelPhase, public_port: u16) -> TunnelSnapshot {
    let (status, detail, public_addr) = match phase {
        TunnelPhase::Stopped => ("stopped", "公网端口未连接".into(), None),
        TunnelPhase::Opening => ("opening", "正在申请公网端口".into(), None),
        TunnelPhase::Connecting(addr) => ("connecting", "正在连接".into(), Some(addr.clone())),
        TunnelPhase::Listening(addr) => ("listening", "公网端口已连接".into(), Some(addr.clone())),
        TunnelPhase::Recovering(error) => ("recovering", error.clone(), None),
        TunnelPhase::Stopping => ("stopping", "正在停止".into(), None),
        TunnelPhase::Failed(error) => ("failed", error.clone(), None),
    };
    TunnelSnapshot {
        status: status.into(),
        detail,
        public_addr,
        public_port,
    }
}

pub fn shutdown(app: &AppHandle) {
    let state = app.state::<ShellState>();
    if state.closing.swap(true, Ordering::AcqRel) {
        return;
    }
    // 等待已经接纳的操作完成 worker 注册，避免退出漏掉刚创建的后台线程。
    if let Ok(guard) = state.config_write.lock() {
        drop(guard);
    }
    write_shell_log(&state, "desktop-exit-start", "正在结束桌面托管操作和进程");
    if let Ok(operation) = state.environment_operation.lock() {
        if let Some(cancel) = operation.as_ref() {
            cancel.store(true, Ordering::Release);
        }
    }
    if let Ok(runtimes) = state.target_runtimes.lock() {
        for runtime in runtimes.values() {
            if let Some(cancel) = &runtime.operation {
                cancel.store(true, Ordering::Release);
            }
            if let Some(tunnel) = &runtime.tunnel_worker {
                tunnel.stop();
            }
        }
    }
    if let Some((stop, monitor)) = state
        .monitor
        .lock()
        .ok()
        .and_then(|mut monitor| monitor.take())
    {
        let _ = stop.send(());
        let _ = monitor.join();
    }
    if let Some(worker) = state
        .environment_worker
        .lock()
        .ok()
        .and_then(|mut worker| worker.take())
    {
        let _ = worker.join();
    }
    let workers = state
        .workers
        .lock()
        .map(|mut workers| std::mem::take(&mut *workers))
        .unwrap_or_default();
    for worker in workers {
        let _ = worker.join();
    }
    let urls = state
        .target_runtimes
        .lock()
        .map(|runtimes| runtimes.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    for url in urls {
        if let Err(error) = stop_active_child(&state, &url) {
            write_shell_log(
                &state,
                "server-stop-failed",
                &format!("url={url} error={error}"),
            );
        }
    }
    state.environment.cleanup_cache(&state.log_path);
    write_shell_log(&state, "desktop-exit", "桌面托管操作和服务进程已结束");
}

#[cfg(test)]
mod tests {
    use super::{
        apply_tunnel_connection, auto_start, check_health, parse_runtime_info, RuntimeInfo,
        ShellState, PACKAGE_UPDATE_INTERVAL,
    };
    use crate::config::{
        default_server_config, DesktopConfig, TargetConfig, TunnelConnectionConfig,
    };
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::PathBuf;
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn test_directory(name: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-react/react-lifecycle-tests")
            .join(format!("{name}-{}-{suffix}", std::process::id()));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn preparation_source_is_saved_for_pi_desk_without_overwriting_custom_registries() {
        use super::save_preparation_source;
        use crate::environment_source::DownloadSource;

        let directory = test_directory("preparation-package-source");
        let config_path = directory.join("config.json");
        let url = "http://127.0.0.1:30333";
        for (name, registry, expected) in [
            (
                "@jetcrab/pi-desk",
                None,
                "https://mirrors.cloud.tencent.com/npm",
            ),
            (
                "@jetcrab/pi-desk",
                Some("https://registry.npmjs.org/"),
                "https://mirrors.cloud.tencent.com/npm",
            ),
            (
                "@jetcrab/pi-desk",
                Some("https://registry.npmmirror.com"),
                "https://mirrors.cloud.tencent.com/npm",
            ),
            (
                "@jetcrab/pi-desk",
                Some("https://mirrors.cloud.tencent.com/npm/"),
                "https://mirrors.cloud.tencent.com/npm",
            ),
            (
                "@jetcrab/pi-desk",
                Some("https://registry.example.com"),
                "https://registry.example.com",
            ),
            (
                "example-service",
                Some("https://registry.npmjs.org"),
                "https://registry.npmjs.org",
            ),
        ] {
            let mut config = DesktopConfig::default();
            let package = config.targets[0]
                .server
                .as_mut()
                .unwrap()
                .package
                .as_mut()
                .unwrap();
            package.name = name.into();
            package.registry = registry.map(String::from);
            let untouched = TargetConfig {
                url: "http://127.0.0.1:30334".into(),
                server: Some(default_server_config()),
                tunnel: None,
            };
            config.targets.push(untouched);
            crate::config::save(&config_path, &config).unwrap();
            let state = ShellState::new(
                config,
                RuntimeInfo::default(),
                config_path.clone(),
                directory.join("runtime.json"),
                directory.join("logs/desktop.log"),
            );
            save_preparation_source(&state, url, DownloadSource::Domestic).unwrap();
            for saved in [
                state.config().unwrap(),
                serde_json::from_slice::<DesktopConfig>(&fs::read(&config_path).unwrap()).unwrap(),
            ] {
                assert_eq!(
                    saved.targets[0]
                        .server
                        .as_ref()
                        .unwrap()
                        .package
                        .as_ref()
                        .unwrap()
                        .registry
                        .as_deref(),
                    Some(expected)
                );
                assert_eq!(
                    saved.targets[1]
                        .server
                        .as_ref()
                        .unwrap()
                        .package
                        .as_ref()
                        .unwrap()
                        .registry
                        .as_deref(),
                    Some("https://registry.npmjs.org")
                );
            }
            save_preparation_source(&state, url, DownloadSource::Official).unwrap();
            let expected = if expected == "https://mirrors.cloud.tencent.com/npm" {
                "https://registry.npmjs.org"
            } else {
                expected
            };
            assert_eq!(
                state.config().unwrap().targets[0]
                    .server
                    .as_ref()
                    .unwrap()
                    .package
                    .as_ref()
                    .unwrap()
                    .registry
                    .as_deref(),
                Some(expected)
            );
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn migrates_legacy_runtime_to_the_first_server_target() {
        let config = DesktopConfig {
            targets: vec![
                TargetConfig {
                    url: "https://example.com/".into(),
                    server: None,
                    tunnel: None,
                },
                TargetConfig {
                    url: "http://127.0.0.1:30333/".into(),
                    server: Some(default_server_config()),
                    tunnel: None,
                },
            ],
            tunnel: TunnelConnectionConfig::default(),
        };
        let info = parse_runtime_info(r#"{"lastVersion":"0.1.66","autoStart":false}"#, &config)
            .expect("旧运行记录应迁移");
        let target = info
            .targets
            .get("http://127.0.0.1:30333/")
            .expect("旧记录应绑定本机服务网址");

        assert_eq!(target.last_version.as_deref(), Some("0.1.66"));
        assert!(!target.auto_start);
    }

    #[test]
    fn desktop_window_preferences_roundtrip_and_preserve_legacy_defaults() {
        let directory = test_directory("window-preferences");
        let config = crate::config::DesktopConfig::default();
        let legacy =
            parse_runtime_info(r#"{"lastVersion":"1.2.3","autoStart":false}"#, &config).unwrap();
        assert_eq!(legacy.hide_on_startup, None);
        assert!(legacy.hide_on_open && legacy.show_on_close);
        let state = ShellState::new(
            config.clone(),
            legacy,
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("desktop.log"),
        );
        super::set_startup_preference(&state, Some(true), Some(false), None).unwrap();
        super::set_startup_preference(&state, None, None, Some(false)).unwrap();
        let saved = super::load_runtime_info(&state.runtime_path, &config);
        assert_eq!(saved.hide_on_startup, Some(true));
        assert!(!saved.hide_on_open && !saved.show_on_close);
        assert!(!saved.targets.values().next().unwrap().auto_start);
        let stale = parse_runtime_info(
            r#"{"targets":{},"hideOnStartup":false,"lastOpenedUrl":"https://removed.example/"}"#,
            &config,
        )
        .unwrap();
        assert_eq!(stale.hide_on_startup, Some(false));
        assert_eq!(stale.last_opened_url, None);
        assert!(stale.hide_on_open && stale.show_on_close);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn missing_target_runtime_keeps_auto_start_enabled() {
        let directory = test_directory("runtime-defaults");
        let state = ShellState::new(
            DesktopConfig::default(),
            RuntimeInfo::default(),
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );

        assert!(auto_start(&state, "http://127.0.0.1:30333/").unwrap());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn uses_the_sixty_second_periodic_update_interval() {
        assert_eq!(PACKAGE_UPDATE_INTERVAL, Duration::from_secs(60));
    }

    #[test]
    fn saves_tunnel_connection_in_desktop_config_without_sidecar() {
        let directory = test_directory("runtime-tunnel-config");
        let config_path = directory.join("config.json");
        let state = ShellState::new(
            DesktopConfig::default(),
            RuntimeInfo::default(),
            config_path.clone(),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );

        apply_tunnel_connection(
            &state,
            serde_json::json!({
                "controlServerUrl": "http://tunnel.example:7001",
                "controlKey": "cd".repeat(32)
            }),
        )
        .unwrap();
        let saved: DesktopConfig =
            serde_json::from_str(&fs::read_to_string(&config_path).unwrap()).unwrap();
        assert_eq!(
            saved.tunnel.control_server_url,
            "http://tunnel.example:7001"
        );
        assert_eq!(saved.tunnel.control_key, "cd".repeat(32));
        assert!(!directory.join("tunnel.yaml").exists());

        fs::remove_dir_all(directory).unwrap();
    }

    fn run_health_server(
        chunks: Vec<&'static [u8]>,
        delay: Duration,
    ) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 256];
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let length = stream.read(&mut buffer).unwrap();
                assert!(length > 0, "健康检查应发送完整 HTTP 请求");
                request.extend_from_slice(&buffer[..length]);
            }
            assert!(request.starts_with(b"GET /health HTTP/1.1\r\n"));
            for chunk in chunks {
                thread::sleep(delay);
                stream.write_all(chunk).unwrap();
            }
        });
        (port, handle)
    }

    #[test]
    fn health_check_accepts_success_redirects_and_segmented_responses() {
        let cases = [
            (vec![&b"HTTP/1.1 200 OK\r\n"[..]], Duration::ZERO, true),
            (
                vec![&b"HTTP/1.0 204 No Content\r\n"[..]],
                Duration::ZERO,
                true,
            ),
            (vec![&b"HTTP/1.1 302 Found\r\n"[..]], Duration::ZERO, true),
            (
                vec![&b"HTTP/1.1 404 Not Found\r\n"[..]],
                Duration::ZERO,
                false,
            ),
            (vec![&b"HTTP/1.1 500\r\n"[..]], Duration::ZERO, false),
            (
                vec![&b"HTTP/1.1 "[..], &b"200"[..]],
                Duration::from_millis(20),
                true,
            ),
        ];
        for (chunks, delay, expected) in cases {
            let chunk_count = chunks.len();
            let (port, handle) = run_health_server(chunks, delay);
            assert_eq!(
                check_health(port, "/health").is_ok(),
                expected,
                "response_chunks={chunk_count} delay={delay:?}"
            );
            handle.join().unwrap();
            assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
        }
    }

    #[test]
    fn health_check_reports_connection_and_http_failures() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let error = check_health(port, "/health").unwrap_err();
        assert!(error.contains("连接健康检查失败"), "{error}");

        let (port, handle) = run_health_server(
            vec![&b"HTTP/1.1 503 Service Unavailable\r\n"[..]],
            Duration::ZERO,
        );
        let result = check_health(port, "/health");
        handle.join().unwrap();
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
        assert_eq!(result.unwrap_err(), "健康检查返回非成功状态：HTTP/1.1 503");
    }

    #[test]
    fn health_check_times_out_when_server_does_not_respond() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            thread::sleep(Duration::from_millis(700));
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\n");
        });

        let error = check_health(port, "/health").unwrap_err();
        assert!(error.contains("读取健康检查响应失败"), "{error}");
        assert!(error.contains("500 毫秒"), "{error}");

        handle.join().unwrap();
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
    }
}

#[cfg(test)]
#[path = "recovery_tests.rs"]
mod recovery_tests;

#[cfg(test)]
mod operation_tests {
    use super::{
        control_state, execute_operation, package_directory, record_operation_failure,
        stop_active_child, Operation, RuntimeInfo, ShellState, TargetRuntimeInfo,
    };
    use crate::config::{
        DesktopConfig, PackageConfig, ReleaseChannel, ServerConfig, TargetConfig,
        TunnelConnectionConfig, UpdatePolicy,
    };
    use std::fs;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    const PACKAGE_NAME: &str = "runtime-update-fixture";

    fn test_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../temp/tests/desktop-react/react-lifecycle-tests")
            .join(format!(
                "runtime-update-rollback-{}-{suffix}",
                std::process::id()
            ));
        fs::create_dir_all(&directory).unwrap();
        directory
    }

    struct VersionRegistry {
        address: String,
        stopping: Arc<AtomicBool>,
        worker: Option<JoinHandle<()>>,
    }

    impl VersionRegistry {
        fn new() -> Self {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            listener.set_nonblocking(true).unwrap();
            let address = format!("http://{}", listener.local_addr().unwrap());
            let metadata = serde_json::to_vec(&serde_json::json!({
                "name": PACKAGE_NAME,
                "dist-tags": { "latest": "2.0.0" },
                "versions": {
                    "1.2.3": { "name": PACKAGE_NAME, "version": "1.2.3" },
                    "2.0.0": { "name": PACKAGE_NAME, "version": "2.0.0" }
                }
            }))
            .unwrap();
            let stopping = Arc::new(AtomicBool::new(false));
            let worker_stopping = stopping.clone();
            let worker = thread::spawn(move || {
                while !worker_stopping.load(Ordering::Acquire) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            stream.set_nonblocking(false).unwrap();
                            respond(stream, &metadata);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(10));
                        }
                        Err(_) => break,
                    }
                }
            });
            Self {
                address,
                stopping,
                worker: Some(worker),
            }
        }
    }

    impl Drop for VersionRegistry {
        fn drop(&mut self) {
            self.stopping.store(true, Ordering::Release);
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn respond(mut stream: TcpStream, body: &[u8]) {
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        while !request.windows(4).any(|part| part == b"\r\n\r\n") {
            let Ok(length) = stream.read(&mut buffer) else {
                return;
            };
            if length == 0 {
                return;
            }
            request.extend_from_slice(&buffer[..length]);
        }
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body);
    }

    fn write_runtime_package(directory: &Path, version: &str, entry: &str) {
        let package = directory.join("node_modules").join(PACKAGE_NAME);
        fs::create_dir_all(&package).unwrap();
        fs::write(
            package.join("package.json"),
            serde_json::json!({ "name": PACKAGE_NAME, "version": version }).to_string(),
        )
        .unwrap();
        let launcher = format!(
            r#"
const {{ spawn }} = require('node:child_process');
const child = spawn(process.execPath, ['-e', {}, '--', ...process.argv.slice(2)], {{ stdio: 'inherit' }});
child.on('error', error => {{
  console.error(error);
  process.exitCode = 1;
}});
child.on('exit', code => {{
  process.exitCode = code ?? 1;
}});
"#,
            serde_json::to_string(entry).unwrap()
        );
        fs::write(package.join("service.cjs"), launcher).unwrap();
    }

    fn available_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    }

    #[test]
    fn prepared_package_waits_in_memory_and_starts_without_another_query() {
        let directory = test_directory();
        let _npm_environment = crate::test_support::NpmEnvironment::new(&directory);
        let registry = VersionRegistry::new();
        let port = available_port();
        let url = format!("http://127.0.0.1:{port}/");
        let package = PackageConfig {
            name: PACKAGE_NAME.into(),
            registry: Some(registry.address.clone()),
            startup_update: UpdatePolicy::Check,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Stable,
        };
        let mut server = ServerConfig {
            start_command: format!("node node_modules\\{PACKAGE_NAME}\\service.cjs -p {{port}}"),
            ready_path: "/health".into(),
            package: Some(package.clone()),
        };
        let state = ShellState::new(
            DesktopConfig {
                targets: vec![TargetConfig {
                    url: url.clone(),
                    server: Some(server.clone()),
                    tunnel: None,
                }],
                tunnel: TunnelConnectionConfig::default(),
            },
            RuntimeInfo::default(),
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );
        let candidate = crate::packages::version_directory(
            &package_directory(&state, &url).unwrap(),
            &package,
            "2.0.0",
        );
        write_runtime_package(&candidate, "2.0.0", "const http=require('node:http');http.createServer((req,res)=>res.writeHead(200).end('ready')).listen(Number(process.argv[process.argv.indexOf('-p')+1]),'127.0.0.1');");
        let before = fs::read(directory.join("runtime.json")).ok();
        let prepared = super::prepare_service_package(&state, &url, &server, &|| false).unwrap();
        assert!(
            super::cached_version(&state, &url).unwrap().is_none(),
            "安装候选不能提前成为成功版本"
        );
        assert_eq!(fs::read(directory.join("runtime.json")).ok(), before);
        let snapshot = control_state(&state).unwrap();
        let update = snapshot.targets[0]
            .server
            .as_ref()
            .unwrap()
            .update
            .as_ref()
            .unwrap();
        assert_eq!(update.status, "installed");
        assert_eq!(update.version.as_deref(), Some("2.0.0"));
        drop(registry);
        server.package.as_mut().unwrap().registry = Some("http://127.0.0.1:1".into());
        let result = super::execute_operation_with_prepared(
            &state,
            &url,
            &server,
            Operation::Start,
            &|| false,
            prepared,
        );
        let current = control_state(&state).unwrap();
        stop_active_child(&state, &url).unwrap();
        assert!(
            result.is_ok(),
            "复用候选启动不应再次访问已离线的npm源：{result:?}"
        );
        assert_eq!(
            current.targets[0].server.as_ref().unwrap().status,
            "running"
        );
        assert_eq!(
            super::cached_version(&state, &url).unwrap().as_deref(),
            Some("2.0.0")
        );
        let log = fs::read_to_string(directory.join("logs/desktop.log")).unwrap();
        assert_eq!(log.matches("[package-query-start]").count(), 1);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_update_restores_old_service_and_reports_failed_update() {
        assert_failed_update_restores_old_service(true, false);
    }

    #[test]
    fn failed_cold_start_update_restores_cached_service() {
        assert_failed_update_restores_old_service(false, false);
    }

    #[test]
    fn failed_cold_start_install_restores_cached_service() {
        assert_failed_update_restores_old_service(false, true);
    }

    fn assert_failed_update_restores_old_service(was_running: bool, install_fails: bool) {
        let directory = test_directory();
        let _npm_environment = crate::test_support::NpmEnvironment::new(&directory);
        let registry = VersionRegistry::new();
        let port = available_port();
        let url = format!("http://127.0.0.1:{port}/");
        let package = PackageConfig {
            name: PACKAGE_NAME.into(),
            registry: Some(registry.address.clone()),
            startup_update: UpdatePolicy::None,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Stable,
        };
        let server = ServerConfig {
            start_command: format!("node node_modules\\{PACKAGE_NAME}\\service.cjs -p {{port}}"),
            ready_path: "/health".into(),
            package: Some(package.clone()),
        };
        let mut runtime_info = RuntimeInfo::default();
        runtime_info.targets.insert(
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
            runtime_info,
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );
        let base = package_directory(&state, &url).unwrap();
        let old_directory = crate::packages::version_directory(&base, &package, "1.2.3");
        let candidate_directory = crate::packages::version_directory(&base, &package, "2.0.0");
        write_runtime_package(
            &old_directory,
            "1.2.3",
            "const http=require('node:http');const port=Number(process.argv[process.argv.indexOf('-p')+1]);http.createServer((req,res)=>res.writeHead(200).end('old')).listen(port,'127.0.0.1');",
        );
        let not_cancelled = || false;

        if was_running {
            execute_operation(&state, &url, &server, Operation::Start, &not_cancelled).unwrap();
        }
        let candidate = r#"
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', `
  const http = require('node:http');
  const port = Number(process.argv.at(-1));
  http.createServer((req, res) => res.writeHead(503).end('not ready'))
    .listen(port, '127.0.0.1', () => process.send('listening'));
`, process.argv.at(-1)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.on('message', () => process.exit(9));
"#;
        if !install_fails {
            write_runtime_package(&candidate_directory, "2.0.0", candidate);
        }
        let mut server = server;
        server.package.as_mut().unwrap().startup_update = if was_running {
            UpdatePolicy::None
        } else {
            UpdatePolicy::Update
        };
        let operation = if was_running {
            Operation::Update
        } else {
            Operation::Start
        };
        let result = execute_operation(&state, &url, &server, operation, &not_cancelled);
        assert!(result.as_ref().unwrap_err().contains("已恢复原服务"));
        record_operation_failure(&state, &url, &server, operation, &result, &not_cancelled);
        let snapshot = control_state(&state).unwrap();
        let restored = snapshot.targets[0].server.as_ref().unwrap();
        assert_eq!(restored.status, "running");
        assert_eq!(restored.version.as_deref(), Some("1.2.3"));
        let update = restored.update.as_ref().unwrap();
        assert_eq!(update.status, "failed");
        assert!(update.error.as_deref().unwrap().contains("已恢复原服务"));
        assert!(old_directory.exists());
        assert!(!candidate_directory.exists());
        if was_running {
            let running_pid = state
                .target_runtimes
                .lock()
                .unwrap()
                .get(&url)
                .unwrap()
                .child
                .as_ref()
                .unwrap()
                .child
                .id();
            execute_operation(&state, &url, &server, Operation::AutoUpdate, &not_cancelled)
                .unwrap();
            let snapshot = control_state(&state).unwrap();
            let update = snapshot.targets[0]
                .server
                .as_ref()
                .unwrap()
                .update
                .as_ref()
                .unwrap();
            assert_eq!(update.status, "failed");
            assert_eq!(update.version.as_deref(), Some("2.0.0"));
            assert_eq!(
                state
                    .target_runtimes
                    .lock()
                    .unwrap()
                    .get(&url)
                    .unwrap()
                    .child
                    .as_ref()
                    .unwrap()
                    .child
                    .id(),
                running_pid
            );
        }

        stop_active_child(&state, &url).unwrap();
        drop(registry);
        let released = TcpListener::bind(("127.0.0.1", port)).unwrap();
        drop(released);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn periodic_update_switches_to_newer_version_only_once() {
        let directory = test_directory();
        let _npm_environment = crate::test_support::NpmEnvironment::new(&directory);
        let registry = VersionRegistry::new();
        let port = available_port();
        let url = format!("http://127.0.0.1:{port}/");
        let package = PackageConfig {
            name: PACKAGE_NAME.into(),
            registry: Some(registry.address.clone()),
            startup_update: UpdatePolicy::None,
            periodic_update: UpdatePolicy::Update,
            channel: ReleaseChannel::Stable,
        };
        let server = ServerConfig {
            start_command: format!("node node_modules\\{PACKAGE_NAME}\\service.cjs -p {{port}}"),
            ready_path: "/health".into(),
            package: Some(package.clone()),
        };
        let mut runtime_info = RuntimeInfo::default();
        runtime_info.targets.insert(
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
            runtime_info,
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );
        let base = package_directory(&state, &url).unwrap();
        let old_directory = crate::packages::version_directory(&base, &package, "1.2.3");
        let new_directory = crate::packages::version_directory(&base, &package, "2.0.0");
        let entry = "const http=require('node:http');const port=Number(process.argv[process.argv.indexOf('-p')+1]);http.createServer((req,res)=>res.writeHead(200).end('ready')).listen(port,'127.0.0.1');";
        write_runtime_package(&old_directory, "1.2.3", entry);
        let not_cancelled = || false;

        execute_operation(&state, &url, &server, Operation::Start, &not_cancelled).unwrap();
        write_runtime_package(&new_directory, "2.0.0", entry);
        execute_operation(&state, &url, &server, Operation::AutoUpdate, &not_cancelled).unwrap();
        let snapshot = control_state(&state).unwrap();
        let running = snapshot.targets[0].server.as_ref().unwrap();
        assert_eq!(running.status, "running");
        assert_eq!(running.version.as_deref(), Some("2.0.0"));
        let running_pid = state
            .target_runtimes
            .lock()
            .unwrap()
            .get(&url)
            .unwrap()
            .child
            .as_ref()
            .unwrap()
            .child
            .id();
        execute_operation(&state, &url, &server, Operation::AutoUpdate, &not_cancelled).unwrap();
        assert_eq!(
            state
                .target_runtimes
                .lock()
                .unwrap()
                .get(&url)
                .unwrap()
                .child
                .as_ref()
                .unwrap()
                .child
                .id(),
            running_pid
        );

        stop_active_child(&state, &url).unwrap();
        drop(registry);
        let released = TcpListener::bind(("127.0.0.1", port)).unwrap();
        drop(released);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn slow_start_passes_health_check_after_thirty_seconds() {
        let directory = test_directory();
        let port = available_port();
        let url = format!("http://127.0.0.1:{port}/");
        let script = directory.join("slow-start.js");
        fs::write(
            &script,
            r#"
const http = require('node:http');
const readyAt = Date.now() + 31_000;
http.createServer((req, res) => {
  res.writeHead(Date.now() >= readyAt ? 200 : 503).end();
}).listen(Number(process.argv.at(-1)), '127.0.0.1');
"#,
        )
        .unwrap();
        let server = ServerConfig {
            start_command: format!("node \"{}\" {{port}}", script.display()),
            ready_path: "/health".into(),
            package: None,
        };
        let state = ShellState::new(
            DesktopConfig {
                targets: vec![],
                tunnel: TunnelConnectionConfig::default(),
            },
            RuntimeInfo::default(),
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );
        let started = std::time::Instant::now();
        let result = super::launch_service(
            &state,
            &url,
            &server,
            None,
            Some(directory.clone()),
            &|| false,
        );
        let elapsed = started.elapsed();
        let stopped = stop_active_child(&state, &url);
        assert!(result.is_ok(), "慢启动不应在 30 秒时被停止：{result:?}");
        stopped.unwrap();
        assert!(elapsed >= Duration::from_secs(31));
        let listener =
            TcpListener::bind(("127.0.0.1", port)).expect("慢启动服务停止后必须释放端口");
        drop(listener);
        let log = fs::read_to_string(&state.log_path).unwrap();
        assert!(log.contains("[server-ready]"));
        assert!(log.contains("健康检查返回非成功状态：HTTP/1.1 503"));
        let wait_count = log.matches("[server-health-wait]").count();
        assert!(
            (2..20).contains(&wait_count),
            "等待日志应限频：{wait_count}"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancelled_start_releases_nested_listener_before_returning() {
        let directory = test_directory();
        let port = available_port();
        let url = format!("http://127.0.0.1:{port}/");
        let ready = directory.join("listening.txt");
        let leaf = format!(
            r#"
const fs = require('node:fs');
const http = require('node:http');
http.createServer((req, res) => res.writeHead(503).end('not ready'))
  .listen(Number(process.argv.at(-1)), '127.0.0.1', () => fs.writeFileSync({}, 'ready'));
"#,
            serde_json::to_string(&ready.to_string_lossy()).unwrap()
        );
        let script = directory.join("launcher.js");
        fs::write(&script, format!(
            "require('node:child_process').spawn(process.execPath, ['-e', {}, process.argv.at(-1)], {{stdio: 'inherit'}});",
            serde_json::to_string(&leaf).unwrap()
        )).unwrap();
        let server = ServerConfig {
            start_command: format!("node \"{}\" {{port}}", script.display()),
            ready_path: "/health".into(),
            package: None,
        };
        let state = ShellState::new(
            DesktopConfig {
                targets: vec![],
                tunnel: TunnelConnectionConfig::default(),
            },
            RuntimeInfo::default(),
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );
        let error = super::launch_service(
            &state,
            &url,
            &server,
            None,
            Some(directory.clone()),
            &|| ready.exists(),
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("操作已取消"), "{error}");
        assert!(ready.exists());
        let listener =
            TcpListener::bind(("127.0.0.1", port)).expect("取消已返回，但子服务端口仍未释放");
        drop(listener);
        assert!(fs::read_to_string(&state.log_path)
            .unwrap()
            .contains("[server-stop-complete]"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn occupied_port_does_not_launch_service_or_stop_external_listener() {
        let directory = test_directory();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/");
        let server = ServerConfig {
            start_command: "node -e \"process.exit(9)\"".into(),
            ready_path: "/health".into(),
            package: None,
        };
        let state = ShellState::new(
            DesktopConfig {
                targets: vec![],
                tunnel: TunnelConnectionConfig::default(),
            },
            RuntimeInfo::default(),
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );
        let error = super::launch_service(
            &state,
            &url,
            &server,
            None,
            Some(directory.clone()),
            &|| false,
        )
        .unwrap_err()
        .to_string();
        assert!(error.contains("未停止占用进程"), "{error}");
        assert!(!fs::read_to_string(&state.log_path)
            .unwrap()
            .contains("[server-spawn]"));
        drop(TcpStream::connect(("127.0.0.1", port)).unwrap());
        drop(listener);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn cancellation_while_waiting_for_port_prevents_spawn() {
        let directory = test_directory();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let url = format!("http://127.0.0.1:{port}/");
        let log_path = directory.join("logs/desktop.log");
        let server = ServerConfig {
            start_command: "node -e \"process.exit(9)\"".into(),
            ready_path: "/health".into(),
            package: None,
        };
        let state = ShellState::new(
            DesktopConfig {
                targets: vec![],
                tunnel: TunnelConnectionConfig::default(),
            },
            RuntimeInfo::default(),
            directory.join("config.json"),
            directory.join("runtime.json"),
            log_path.clone(),
        );
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        let worker = thread::spawn(move || {
            super::launch_service(&state, &url, &server, None, None, &|| {
                worker_cancelled.load(Ordering::Acquire)
            })
        });
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        let mut observed_wait = false;
        while std::time::Instant::now() < deadline {
            if fs::read_to_string(&log_path)
                .unwrap_or_default()
                .contains("[service-port-wait]")
            {
                observed_wait = true;
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        cancelled.store(true, Ordering::Release);
        drop(listener);
        let result = worker.join().unwrap();
        assert!(observed_wait, "取消应发生在等待端口期间");
        assert!(result.unwrap_err().to_string().contains("操作已取消"));
        assert!(!fs::read_to_string(&log_path)
            .unwrap()
            .contains("[server-spawn]"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn startup_policies_and_running_checks_preserve_service_until_update_requested() {
        for policy in [
            UpdatePolicy::None,
            UpdatePolicy::Check,
            UpdatePolicy::Update,
        ] {
            let directory = test_directory();
            let _npm_environment = crate::test_support::NpmEnvironment::new(&directory);
            let registry = VersionRegistry::new();
            let port = available_port();
            let url = format!("http://127.0.0.1:{port}/");
            let package = PackageConfig {
                name: PACKAGE_NAME.into(),
                registry: Some(registry.address.clone()),
                startup_update: policy,
                periodic_update: UpdatePolicy::Check,
                channel: ReleaseChannel::Stable,
            };
            let server = ServerConfig {
                start_command: format!("node node_modules/{PACKAGE_NAME}/service.cjs {{port}}"),
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
                directory.join("config.json"),
                directory.join("runtime.json"),
                directory.join("logs/desktop.log"),
            );
            struct StopOnDrop<'a>(&'a ShellState, &'a str);
            impl Drop for StopOnDrop<'_> {
                fn drop(&mut self) {
                    let _ = stop_active_child(self.0, self.1);
                }
            }
            let cleanup = StopOnDrop(&state, &url);
            let base = package_directory(&state, &url).unwrap();
            for version in ["1.2.3", "2.0.0"] {
                let path = crate::packages::version_directory(&base, &package, version);
                write_runtime_package(&path, version, "require('node:http').createServer((req,res)=>res.writeHead(200).end('ready')).listen(Number(process.argv.at(-1)),'127.0.0.1')");
            }
            execute_operation(&state, &url, &server, Operation::Start, &|| false).unwrap();
            let expected = if policy == UpdatePolicy::Update {
                "2.0.0"
            } else {
                "1.2.3"
            };
            let snapshot = control_state(&state).unwrap();
            let running = snapshot.targets[0].server.as_ref().unwrap();
            assert_eq!(running.version.as_deref(), Some(expected), "{policy:?}");
            assert_eq!(
                super::cached_version(&state, &url).unwrap().as_deref(),
                Some(expected)
            );
            assert_eq!(running.update.as_ref().unwrap().status, "idle");
            let log = fs::read_to_string(&state.log_path).unwrap();
            if policy != UpdatePolicy::Update {
                assert!(!log.contains("status=installing"));
            }
            if policy != UpdatePolicy::Update {
                assert!(
                    !log.contains("status=checking"),
                    "启动检查不能在服务就绪前查询网络"
                );
            }
            let pid = state
                .target_runtimes
                .lock()
                .unwrap()
                .get(&url)
                .unwrap()
                .child
                .as_ref()
                .unwrap()
                .child
                .id();
            execute_operation(&state, &url, &server, Operation::Check, &|| false).unwrap();
            assert_eq!(
                state
                    .target_runtimes
                    .lock()
                    .unwrap()
                    .get(&url)
                    .unwrap()
                    .child
                    .as_ref()
                    .unwrap()
                    .child
                    .id(),
                pid
            );
            assert_eq!(
                super::cached_version(&state, &url).unwrap().as_deref(),
                Some(expected)
            );
            drop(cleanup);
            drop(registry);
            drop(TcpListener::bind(("127.0.0.1", port)).unwrap());
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn manual_update_check_queries_version_without_installing() {
        let directory = test_directory();
        let _npm_environment = crate::test_support::NpmEnvironment::new(&directory);
        let registry = VersionRegistry::new();
        let port = available_port();
        let url = format!("http://127.0.0.1:{port}/");
        let package = PackageConfig {
            name: PACKAGE_NAME.into(),
            registry: Some(registry.address.clone()),
            startup_update: UpdatePolicy::None,
            periodic_update: UpdatePolicy::None,
            channel: ReleaseChannel::Stable,
        };
        let server = ServerConfig {
            start_command: format!("node node_modules\\{PACKAGE_NAME}\\service.cjs -p {{port}}"),
            ready_path: "/health".into(),
            package: Some(package),
        };
        let mut runtime_info = RuntimeInfo::default();
        runtime_info.targets.insert(
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
            runtime_info,
            directory.join("config.json"),
            directory.join("runtime.json"),
            directory.join("logs/desktop.log"),
        );
        let base = package_directory(&state, &url).unwrap();
        let not_cancelled = || false;

        execute_operation(&state, &url, &server, Operation::Check, &not_cancelled).unwrap();

        let snapshot = control_state(&state).unwrap();
        let update = snapshot.targets[0]
            .server
            .as_ref()
            .unwrap()
            .update
            .as_ref()
            .unwrap();
        assert_eq!(update.status, "available");
        assert_eq!(update.version.as_deref(), Some("2.0.0"));
        assert!(!base.exists());

        drop(registry);
        fs::remove_dir_all(directory).unwrap();
    }
}
