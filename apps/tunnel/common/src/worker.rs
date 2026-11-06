use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use crate::config::{TunnelConfig, normalize_tunnel_config, require_ready};
use crate::protocol::{LEASE_DURATION, RENEW_INTERVAL};
use crate::runtime::{
    TunnelConnectionRow, TunnelEndpoint, TunnelEndpointConfig, TunnelForwarder, TunnelMode,
    TunnelPath, TunnelServiceConfig, TunnelTarget, generate_secret_key, provider_id,
    start_endpoint,
};

#[path = "worker/control_io.rs"]
mod control_io;
use control_io::{ControlIo, Timed};

#[cfg(test)]
#[path = "worker/tests.rs"]
mod tests;

const COMMAND_CAPACITY: usize = 64;
const RECOVERY_INTERVAL: Duration = Duration::from_secs(1);
const POLL_INTERVAL: Duration = Duration::from_millis(250);
const MAX_STATUS_FAILURES: u8 = 3;

type SharedSnapshot = Arc<Mutex<TunnelWorkerSnapshot>>;
type SharedEndpoint = Arc<tokio::sync::Mutex<Option<TunnelEndpoint>>>;

#[derive(Clone)]
pub struct TunnelWorkerConfig {
    pub control_server_url: String,
    pub control_key: [u8; 32],
    pub provider_secret_key: Option<[u8; 32]>,
    pub mode: TunnelMode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TunnelPublicationConfig {
    pub local_addr: SocketAddr,
    pub public_port: Option<u16>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TunnelForwardConfig {
    pub provider_id: String,
    pub remote_port: u16,
    pub local_port: u16,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelPhase {
    Stopped,
    Opening,
    Connecting,
    Listening,
    Recovering,
    Stopping,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelPublicationSnapshot {
    pub local_port: u16,
    pub public_port: Option<u16>,
    pub phase: TunnelPhase,
    pub detail: String,
    pub public_addr: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelForwardSnapshot {
    pub provider_id: String,
    pub remote_port: u16,
    pub local_port: u16,
    pub phase: TunnelPhase,
    pub detail: String,
    pub path: TunnelPath,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelWorkerSnapshot {
    pub provider_id: Option<String>,
    pub mode: TunnelMode,
    pub publications: Vec<TunnelPublicationSnapshot>,
    pub forwards: Vec<TunnelForwardSnapshot>,
    pub connections: Vec<TunnelConnectionRow>,
}

enum Command {
    Publish(TunnelPublicationConfig),
    Unpublish(u16),
    Forward(TunnelForwardConfig),
    StopForward(u16),
    SetMode(TunnelMode),
}

pub struct TunnelWorkerHandle {
    commands: mpsc::Sender<Command>,
    stop: watch::Sender<bool>,
    snapshot: SharedSnapshot,
    thread: Option<JoinHandle<Result<(), String>>>,
}

impl TunnelWorkerHandle {
    pub fn publish(&self, config: TunnelPublicationConfig) -> Result<(), String> {
        if config.local_addr.port() == 0 || config.public_port == Some(0) {
            return Err("隧道端口必须是 1 到 65535 的有效端口".to_owned());
        }
        if !config.local_addr.ip().is_loopback() {
            return Err("隧道发布目标必须使用本机回环地址".to_owned());
        }
        self.submit(Command::Publish(config))
    }

    pub fn unpublish(&self, local_port: u16) -> Result<(), String> {
        self.submit(Command::Unpublish(local_port))
    }

    pub fn forward(&self, config: TunnelForwardConfig) -> Result<(), String> {
        if config.local_port == 0 || config.remote_port == 0 {
            return Err("隧道端口必须是 1 到 65535 的有效端口".to_owned());
        }
        // Endpoint 身份为32字节公钥的十六进制表示，不持久化临时注册信息。
        crate::protocol::parse_key_hex(&config.provider_id)
            .map_err(|_| "提供端标识必须是64位十六进制公钥".to_owned())?;
        self.submit(Command::Forward(config))
    }

    pub fn stop_forward(&self, local_port: u16) -> Result<(), String> {
        self.submit(Command::StopForward(local_port))
    }

    pub fn set_mode(&self, mode: TunnelMode) -> Result<(), String> {
        self.submit(Command::SetMode(mode))
    }

    pub fn snapshot(&self) -> TunnelWorkerSnapshot {
        self.snapshot.lock().unwrap().clone()
    }

    pub fn stop(&self) {
        self.stop.send_replace(true);
    }

    pub fn shutdown(mut self) -> Result<(), String> {
        self.stop();
        self.thread
            .take()
            .expect("隧道线程只能等待一次")
            .join()
            .map_err(|_| "隧道后台线程意外退出".to_owned())?
    }

    pub fn is_finished(&self) -> bool {
        self.thread.as_ref().is_none_or(JoinHandle::is_finished)
    }

    fn submit(&self, command: Command) -> Result<(), String> {
        if *self.stop.borrow() || self.is_finished() {
            return Err("隧道后台已停止".to_owned());
        }
        self.commands
            .try_send(command)
            .map_err(|error| match error {
                mpsc::error::TrySendError::Full(_) => "隧道命令队列已满，请稍后重试".to_owned(),
                mpsc::error::TrySendError::Closed(_) => "隧道后台已停止".to_owned(),
            })
    }
}

impl Drop for TunnelWorkerHandle {
    fn drop(&mut self) {
        self.stop();
        // 丢弃 owner 同样不能遗留 Endpoint、阻塞请求或本地监听。
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

pub fn start_tunnel_worker(mut config: TunnelWorkerConfig) -> Result<TunnelWorkerHandle, String> {
    let normalized = normalize_tunnel_config(TunnelConfig {
        control_server_url: config.control_server_url.clone(),
        control_key: hex::encode(config.control_key),
    })?;
    require_ready(&normalized)?;
    config.control_server_url = normalized.control_server_url;
    let key = match config.provider_secret_key {
        Some(key) => key,
        None => crate::protocol::parse_key_hex(&generate_secret_key()?)
            .map_err(|error| error.to_string())?,
    };
    let identity = provider_id(&hex::encode(key))?;
    config.provider_secret_key = Some(key);
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(control_io::HTTP_CONCURRENCY)
        .build()
        .map_err(|error| format!("无法启动隧道后台运行时：{error}"))?;
    let snapshot = Arc::new(Mutex::new(TunnelWorkerSnapshot {
        provider_id: None,
        mode: config.mode,
        publications: Vec::new(),
        forwards: Vec::new(),
        connections: Vec::new(),
    }));
    let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (stop, stop_receiver) = watch::channel(false);
    let state = snapshot.clone();
    let thread = std::thread::Builder::new()
        .name("pi-desk-tunnel".to_owned())
        .spawn(move || {
            runtime.block_on(run_worker(config, identity, receiver, stop_receiver, state))
        })
        .map_err(|error| format!("无法创建隧道后台线程：{error}"))?;
    Ok(TunnelWorkerHandle {
        commands,
        stop,
        snapshot,
        thread: Some(thread),
    })
}

#[derive(Clone)]
struct Cancellation {
    item: watch::Receiver<bool>,
    worker: watch::Receiver<bool>,
}

impl Cancellation {
    fn is_cancelled(&self) -> bool {
        *self.item.borrow() || *self.worker.borrow()
    }

    async fn cancelled(&mut self) {
        if self.is_cancelled() {
            return;
        }
        tokio::select! {
            _ = self.item.changed() => {},
            _ = self.worker.changed() => {},
        }
    }
}

struct Item<C> {
    config: C,
    stop: watch::Sender<bool>,
    task: tokio::task::JoinHandle<Result<(), String>>,
}

impl<C> Item<C> {
    async fn shutdown(self) -> Result<(), String> {
        self.stop.send_replace(true);
        self.task.await.map_err(|_| "隧道任务意外退出".to_owned())?
    }
}

struct Worker {
    config: TunnelWorkerConfig,
    identity: String,
    control: ControlIo,
    provider: SharedEndpoint,
    visitor: SharedEndpoint,
    snapshot: SharedSnapshot,
    stop: watch::Receiver<bool>,
    publications: BTreeMap<u16, Item<TunnelPublicationConfig>>,
    forwards: BTreeMap<u16, Item<TunnelForwardConfig>>,
    cleanup_error: Option<String>,
}

async fn run_worker(
    config: TunnelWorkerConfig,
    identity: String,
    mut commands: mpsc::Receiver<Command>,
    mut stop: watch::Receiver<bool>,
    snapshot: SharedSnapshot,
) -> Result<(), String> {
    let mut worker = Worker {
        control: ControlIo::new(&config),
        config,
        identity,
        provider: Arc::new(tokio::sync::Mutex::new(None)),
        visitor: Arc::new(tokio::sync::Mutex::new(None)),
        snapshot,
        stop: stop.clone(),
        publications: BTreeMap::new(),
        forwards: BTreeMap::new(),
        cleanup_error: None,
    };
    let mut poll = tokio::time::interval(POLL_INTERVAL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if *stop.borrow() {
            break;
        }
        tokio::select! {
            biased;
            _ = stop.changed() => break,
            command = commands.recv() => match command {
                Some(command) => worker.command(command).await,
                None => break,
            },
            _ = poll.tick() => worker.poll().await,
        }
    }
    worker.shutdown().await
}

impl Worker {
    fn record_cleanup(&mut self, result: Result<(), String>) {
        if let Err(error) = result {
            tracing::warn!("隧道资源回收未确认：{error}");
            // 只保留首个错误，重复失败不会形成无界历史。
            if self.cleanup_error.is_none() {
                self.cleanup_error = Some(error);
            }
        }
    }

    async fn command(&mut self, command: Command) {
        match command {
            Command::Publish(config) => {
                let port = config.local_addr.port();
                if self.remove_publication(port).await.is_ok() {
                    self.spawn_publication(config);
                }
            }
            Command::Unpublish(port) => {
                let _ = self.remove_publication(port).await;
            }
            Command::Forward(config) => {
                if self.remove_forward(config.local_port).await.is_ok() {
                    self.spawn_forward(config);
                }
            }
            Command::StopForward(port) => {
                let _ = self.remove_forward(port).await;
            }
            Command::SetMode(mode) if mode != self.config.mode => {
                self.change_mode(mode).await;
            }
            Command::SetMode(_) => {}
        }
    }

    fn cancellation(&self) -> (watch::Sender<bool>, Cancellation) {
        let (stop, item) = watch::channel(false);
        (
            stop,
            Cancellation {
                item,
                worker: self.stop.clone(),
            },
        )
    }

    fn spawn_publication(&mut self, config: TunnelPublicationConfig) {
        let port = config.local_addr.port();
        {
            let mut state = self.snapshot.lock().unwrap();
            state.provider_id = Some(self.identity.clone());
            state.publications.push(TunnelPublicationSnapshot {
                local_port: port,
                public_port: config.public_port,
                phase: TunnelPhase::Opening,
                detail: "正在登记端口".to_owned(),
                public_addr: None,
            });
            state.publications.sort_by_key(|row| row.local_port);
        }
        let (stop, cancel) = self.cancellation();
        let publication = Publication {
            config: config.clone(),
            identity: self.identity.clone(),
            secret: self.config.provider_secret_key.unwrap(),
            control: self.control.clone(),
            endpoint: self.provider.clone(),
            snapshot: self.snapshot.clone(),
            cancel,
            cleanup_error: None,
        };
        let task = tokio::spawn(publication.run());
        self.publications.insert(port, Item { config, stop, task });
    }

    fn spawn_forward(&mut self, config: TunnelForwardConfig) {
        let port = config.local_port;
        self.snapshot
            .lock()
            .unwrap()
            .forwards
            .push(TunnelForwardSnapshot {
                provider_id: config.provider_id.clone(),
                remote_port: config.remote_port,
                local_port: port,
                phase: TunnelPhase::Connecting,
                detail: "正在解析提供端端口".to_owned(),
                path: TunnelPath::Unknown,
            });
        self.snapshot
            .lock()
            .unwrap()
            .forwards
            .sort_by_key(|row| row.local_port);
        let (stop, cancel) = self.cancellation();
        let forward = Forward {
            config: config.clone(),
            mode: self.config.mode,
            control: self.control.clone(),
            endpoint: self.visitor.clone(),
            snapshot: self.snapshot.clone(),
            cancel,
        };
        let task = tokio::spawn(forward.run());
        self.forwards.insert(port, Item { config, stop, task });
    }

    fn publication_cleanup_failed(&mut self, port: u16, error: &str) {
        self.record_cleanup(Err(error.to_owned()));
        if let Some(row) = self
            .snapshot
            .lock()
            .unwrap()
            .publications
            .iter_mut()
            .find(|row| row.local_port == port)
        {
            row.phase = TunnelPhase::Failed;
            row.detail = format!(
                "旧发布清理失败，尚未确认完成：{error}。当前后台保留该项，不能重新开启或移除；需重建隧道后台后重试。"
            );
            row.public_addr = None;
        }
    }

    fn forward_cleanup_failed(&mut self, port: u16, error: &str) {
        self.record_cleanup(Err(error.to_owned()));
        if let Some(row) = self
            .snapshot
            .lock()
            .unwrap()
            .forwards
            .iter_mut()
            .find(|row| row.local_port == port)
        {
            row.phase = TunnelPhase::Failed;
            row.detail = format!(
                "旧映射清理失败，尚未确认完成：{error}。当前后台保留该项，不能重新开启或移除；需重建隧道后台后重试。"
            );
            row.path = TunnelPath::Unknown;
        }
    }

    async fn remove_publication(&mut self, port: u16) -> Result<(), String> {
        if let Some(item) = self.publications.remove(&port) {
            if let Some(row) = self
                .snapshot
                .lock()
                .unwrap()
                .publications
                .iter_mut()
                .find(|row| row.local_port == port)
            {
                row.phase = TunnelPhase::Stopping;
                row.detail = "正在停止端口".to_owned();
                row.public_addr = None;
            }
            if let Err(error) = item.shutdown().await {
                self.publication_cleanup_failed(port, &error);
                return Err(error);
            }
        } else if let Some(row) = self
            .snapshot
            .lock()
            .unwrap()
            .publications
            .iter()
            .find(|row| row.local_port == port)
        {
            // Item 已经 join，残留行表示上次清理未确认，不能把缺少任务视为成功。
            return Err(row.detail.clone());
        }
        let mut state = self.snapshot.lock().unwrap();
        state.publications.retain(|row| row.local_port != port);
        state.connections.retain(|row| row.local_port != port);
        Ok(())
    }

    async fn remove_forward(&mut self, port: u16) -> Result<(), String> {
        if let Some(item) = self.forwards.remove(&port) {
            if let Some(row) = self
                .snapshot
                .lock()
                .unwrap()
                .forwards
                .iter_mut()
                .find(|row| row.local_port == port)
            {
                row.phase = TunnelPhase::Stopping;
                row.detail = "正在停止映射".to_owned();
            }
            if let Err(error) = item.shutdown().await {
                self.forward_cleanup_failed(port, &error);
                return Err(error);
            }
        } else if let Some(row) = self
            .snapshot
            .lock()
            .unwrap()
            .forwards
            .iter()
            .find(|row| row.local_port == port)
        {
            return Err(row.detail.clone());
        }
        self.snapshot
            .lock()
            .unwrap()
            .forwards
            .retain(|row| row.local_port != port);
        Ok(())
    }

    async fn change_mode(&mut self, mode: TunnelMode) {
        // 先同时通知所有映射，再逐项 join，最后关闭旧 Endpoint，之后才能重绑。
        let items = std::mem::take(&mut self.forwards);
        for row in &mut self.snapshot.lock().unwrap().forwards {
            if items.contains_key(&row.local_port) {
                row.phase = TunnelPhase::Stopping;
                row.detail = "正在重建访问模式".to_owned();
                row.path = TunnelPath::Unknown;
            }
        }
        for item in items.values() {
            item.stop.send_replace(true);
        }
        let mut configs = Vec::new();
        for item in items.into_values() {
            let config = item.config.clone();
            match item.shutdown().await {
                Ok(()) => configs.push(config),
                Err(error) => self.forward_cleanup_failed(config.local_port, &error),
            }
        }
        let endpoint = self.visitor.lock().await.take();
        if let Some(endpoint) = endpoint
            && let Err(error) = endpoint.shutdown().await
        {
            self.record_cleanup(Err(error.clone()));
            for config in &configs {
                self.forward_cleanup_failed(config.local_port, &error);
            }
            configs.clear();
        }
        self.config.mode = mode;
        {
            let mut state = self.snapshot.lock().unwrap();
            state.mode = mode;
            state
                .forwards
                .retain(|row| row.phase == TunnelPhase::Failed);
        }
        if !*self.stop.borrow() {
            for config in configs {
                self.spawn_forward(config);
            }
        }
        tracing::info!("隧道访问模式切换已处理，提供端保持运行");
    }

    async fn poll(&self) {
        let connections = match self.provider.try_lock() {
            Ok(endpoint) => endpoint
                .as_ref()
                .map(TunnelEndpoint::connections)
                .unwrap_or_default(),
            Err(_) => return,
        };
        let mut state = self.snapshot.lock().unwrap();
        if state.connections != connections {
            state.connections = connections;
        }
    }

    async fn shutdown(mut self) -> Result<(), String> {
        for item in self.publications.values() {
            item.stop.send_replace(true);
        }
        for item in self.forwards.values() {
            item.stop.send_replace(true);
        }
        for (port, item) in std::mem::take(&mut self.publications) {
            if let Err(error) = item.shutdown().await {
                self.publication_cleanup_failed(port, &error);
            }
        }
        for (port, item) in std::mem::take(&mut self.forwards) {
            if let Err(error) = item.shutdown().await {
                self.forward_cleanup_failed(port, &error);
            }
        }
        for shared in [self.provider.clone(), self.visitor.clone()] {
            if let Some(endpoint) = shared.lock().await.take() {
                self.record_cleanup(endpoint.shutdown().await);
            }
        }
        {
            let mut state = self.snapshot.lock().unwrap();
            state.connections.clear();
            for row in &mut state.publications {
                if row.phase != TunnelPhase::Failed {
                    row.phase = TunnelPhase::Stopped;
                    row.detail = "已停止".to_owned();
                }
                row.public_addr = None;
            }
            for row in &mut state.forwards {
                if row.phase != TunnelPhase::Failed {
                    row.phase = TunnelPhase::Stopped;
                    row.detail = "已停止".to_owned();
                }
                row.path = TunnelPath::Unknown;
            }
        }
        self.cleanup_error.map_or(Ok(()), Err)
    }
}

async fn endpoint(
    shared: &SharedEndpoint,
    config: TunnelEndpointConfig,
) -> Result<TunnelEndpoint, String> {
    let mut current = shared.lock().await;
    if current.is_none() {
        *current = Some(start_endpoint(config).await?);
    }
    Ok(current.as_ref().unwrap().clone())
}

#[derive(Clone, Copy)]
struct Lease {
    deadline: Instant,
}

impl Lease {
    fn new(started: Instant) -> Self {
        Self {
            deadline: started + LEASE_DURATION,
        }
    }

    fn renew(&mut self, started: Instant, now: Instant) -> bool {
        if now >= self.deadline || now >= started + LEASE_DURATION {
            return false;
        }
        self.deadline = started + LEASE_DURATION;
        true
    }
}

struct Publication {
    config: TunnelPublicationConfig,
    identity: String,
    secret: [u8; 32],
    control: ControlIo,
    endpoint: SharedEndpoint,
    snapshot: SharedSnapshot,
    cancel: Cancellation,
    cleanup_error: Option<String>,
}

impl Publication {
    fn update(&self, phase: TunnelPhase, detail: &str, public_addr: Option<String>) {
        let mut state = self.snapshot.lock().unwrap();
        if let Some(row) = state
            .publications
            .iter_mut()
            .find(|row| row.local_port == self.config.local_addr.port())
        {
            row.phase = phase;
            row.detail = detail.to_owned();
            row.public_addr = public_addr;
        }
    }

    async fn run(mut self) -> Result<(), String> {
        let result = self.run_inner().await;
        if let Err(error) = &result {
            self.update(TunnelPhase::Failed, error, None);
            tracing::warn!(
                port = self.config.local_addr.port(),
                "隧道发布任务停止：{error}"
            );
        }
        result.and(self.cleanup_error.take().map_or(Ok(()), Err))
    }

    fn record_close(&mut self, result: Result<(), String>) {
        if let Err(error) = result {
            tracing::warn!(
                port = self.config.local_addr.port(),
                "隧道旧注册已撤销本地授权，控制清理未确认：{error}"
            );
            if self.cleanup_error.is_none() {
                self.cleanup_error = Some(error);
            }
        }
    }

    async fn run_inner(&mut self) -> Result<(), String> {
        let public_addr = self
            .control
            .public_addr(self.config.public_port)
            .map_err(|error| error.to_string())?;
        loop {
            if self.cancel.is_cancelled() {
                return Ok(());
            }
            self.update(TunnelPhase::Opening, "正在登记端口", None);
            let request_id = crate::protocol::random_hex::<16>()
                .map_err(|error| format!("无法生成隧道请求标识：{error}"))?;
            let control = self.control.clone();
            let opening = control.open(
                request_id,
                self.identity.clone(),
                self.config.clone(),
                self.cancel.clone(),
            );
            tokio::pin!(opening);
            let opened = tokio::select! {
                result = &mut opening => result,
                _ = self.cancel.cancelled() => {
                    // spawn_blocking 无法取消；必须收回迟到 open 的注册后才能退出。
                    if let Ok(response) = opening.await {
                        let closed = self.control.close(response.value.tunnel_id).await;
                        self.record_close(closed);
                    }
                    return Ok(());
                }
            };
            let opened = match opened {
                Ok(opened) => opened,
                Err(error) => {
                    let retry = control_io::retryable(&error);
                    self.update(
                        if retry {
                            TunnelPhase::Recovering
                        } else {
                            TunnelPhase::Failed
                        },
                        &error.to_string(),
                        None,
                    );
                    tracing::warn!(
                        port = self.config.local_addr.port(),
                        "隧道端口登记失败：{error}"
                    );
                    if !retry || self.wait_retry().await {
                        return Ok(());
                    }
                    continue;
                }
            };
            let tunnel_id = opened.value.tunnel_id.clone();
            let mut lease = Lease::new(opened.started);
            if self.cancel.is_cancelled() || Instant::now() >= lease.deadline {
                let closed = self.control.close(tunnel_id).await;
                self.record_close(closed);
                if self.cancel.is_cancelled() {
                    return Ok(());
                }
                continue;
            }
            self.update(
                TunnelPhase::Connecting,
                "正在连接提供端",
                public_addr.clone(),
            );
            let provider = endpoint(
                &self.endpoint,
                TunnelEndpointConfig {
                    secret_key: Some(self.secret),
                    relay: opened.value.relay.clone(),
                    mode: TunnelMode::Auto,
                },
            )
            .await;
            let provider = match provider {
                Ok(provider) => provider,
                Err(error) => {
                    let closed = self.control.close(tunnel_id).await;
                    self.record_close(closed);
                    self.update(TunnelPhase::Recovering, &error, None);
                    if self.wait_retry().await {
                        return Ok(());
                    }
                    continue;
                }
            };
            let registered = if self.cancel.is_cancelled() || Instant::now() >= lease.deadline {
                false
            } else {
                let registering = provider.register_service(TunnelServiceConfig {
                    tunnel_id: tunnel_id.clone(),
                    service_token: opened.value.service_token,
                    local_addr: self.config.local_addr,
                    gateway_id: opened.value.gateway_id,
                });
                let result = tokio::select! {
                    biased;
                    _ = self.cancel.cancelled() => None,
                    _ = tokio::time::sleep_until(lease.deadline) => None,
                    result = registering => Some(result),
                };
                match result {
                    Some(Ok(())) => true,
                    Some(Err(error)) => {
                        self.update(TunnelPhase::Recovering, &error, None);
                        false
                    }
                    None => false,
                }
            };
            let result = if registered {
                self.maintain(&provider, &tunnel_id, &mut lease, public_addr.clone())
                    .await
            } else {
                Ok(())
            };
            // 本地授权先撤销并 join 该项流，然后才清理控制登记。
            let revoked = provider.remove_service(&tunnel_id).await;
            let closed = self.control.close(tunnel_id).await;
            self.record_close(closed);
            revoked?;
            result?;
            if self.cancel.is_cancelled() {
                self.update(TunnelPhase::Stopped, "已停止", None);
                return Ok(());
            }
            if self.wait_retry().await {
                return Ok(());
            }
        }
    }

    async fn maintain(
        &mut self,
        provider: &TunnelEndpoint,
        tunnel_id: &str,
        lease: &mut Lease,
        public_addr: Option<String>,
    ) -> Result<(), String> {
        let mut next_status = Instant::now();
        let mut failures = 0_u8;
        let mut ready = false;
        loop {
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => {
                    self.update(TunnelPhase::Stopping, "正在停止端口", None);
                    return Ok(());
                }
                _ = tokio::time::sleep_until(lease.deadline) => {
                    self.update(TunnelPhase::Recovering, "端口租约已到期，正在撤销授权", None);
                    return Ok(());
                }
                _ = tokio::time::sleep_until(next_status) => {},
            }
            let control = self.control.clone();
            let status = control.status(tunnel_id.to_owned(), self.cancel.clone());
            tokio::pin!(status);
            let response = tokio::select! {
                biased;
                _ = self.cancel.cancelled() => {
                    self.update(TunnelPhase::Stopping, "正在停止端口", None);
                    let revoked = provider.remove_service(tunnel_id).await;
                    let _ = status.await;
                    revoked?;
                    return Ok(());
                }
                _ = tokio::time::sleep_until(lease.deadline) => {
                    self.update(TunnelPhase::Recovering, "端口租约已到期，正在撤销授权", None);
                    let revoked = provider.remove_service(tunnel_id).await;
                    let _ = status.await;
                    revoked?;
                    return Ok(());
                }
                response = &mut status => response,
            };
            match response {
                Ok(Timed { started, value }) => {
                    if !lease.renew(started, Instant::now()) {
                        self.update(TunnelPhase::Recovering, "端口租约响应已过期", None);
                        return Ok(());
                    }
                    failures = 0;
                    match value.status {
                        crate::protocol::TunnelStatus::Ready => {
                            ready = true;
                            self.update(TunnelPhase::Listening, "端口已就绪", public_addr.clone());
                        }
                        crate::protocol::TunnelStatus::AwaitingProvider if !ready => {}
                        _ => {
                            self.update(
                                TunnelPhase::Recovering,
                                "服务端注册已失效，正在撤销授权",
                                None,
                            );
                            return Ok(());
                        }
                    }
                    next_status = started + RENEW_INTERVAL;
                }
                Err(error) => {
                    failures = failures.saturating_add(1);
                    if control_io::registration_invalid(&error) || failures >= MAX_STATUS_FAILURES {
                        self.update(
                            TunnelPhase::Recovering,
                            "无法维持端口注册，正在撤销授权",
                            None,
                        );
                        tracing::warn!(
                            port = self.config.local_addr.port(),
                            "隧道端口续租失败，撤销该端口：{error}"
                        );
                        return Ok(());
                    }
                    next_status = Instant::now() + RENEW_INTERVAL;
                }
            }
        }
    }

    async fn wait_retry(&mut self) -> bool {
        tokio::select! {
            _ = self.cancel.cancelled() => true,
            _ = tokio::time::sleep(RECOVERY_INTERVAL) => false,
        }
    }
}

struct Forward {
    config: TunnelForwardConfig,
    mode: TunnelMode,
    control: ControlIo,
    endpoint: SharedEndpoint,
    snapshot: SharedSnapshot,
    cancel: Cancellation,
}

impl Forward {
    fn update(&self, phase: TunnelPhase, detail: &str, forwarder: Option<&TunnelForwarder>) {
        let mut state = self.snapshot.lock().unwrap();
        if let Some(row) = state
            .forwards
            .iter_mut()
            .find(|row| row.local_port == self.config.local_port)
        {
            row.phase = phase;
            row.detail = detail.to_owned();
            row.path = forwarder
                .map(TunnelForwarder::path)
                .unwrap_or(TunnelPath::Unknown);
        }
    }

    async fn run(mut self) -> Result<(), String> {
        let mut forwarder = None;
        let result = self.maintain(&mut forwarder).await;
        let closed = match forwarder {
            Some(forwarder) => forwarder.shutdown().await,
            None => Ok(()),
        };
        let result = result.and(closed);
        if let Err(error) = &result {
            self.update(TunnelPhase::Failed, error, None);
            tracing::warn!(port = self.config.local_port, "隧道映射任务停止：{error}");
        } else if self.cancel.is_cancelled() {
            self.update(TunnelPhase::Stopped, "已停止", None);
        } else if let Some(row) = self
            .snapshot
            .lock()
            .unwrap()
            .forwards
            .iter_mut()
            .find(|row| row.local_port == self.config.local_port)
        {
            row.path = TunnelPath::Unknown;
        }
        result
    }

    async fn maintain(&mut self, forwarder: &mut Option<TunnelForwarder>) -> Result<(), String> {
        let mut next_resolve = Instant::now();
        loop {
            if self.cancel.is_cancelled() {
                return Ok(());
            }
            tokio::select! {
                biased;
                _ = self.cancel.cancelled() => return Ok(()),
                _ = tokio::time::sleep_until(next_resolve) => {},
                _ = tokio::time::sleep(POLL_INTERVAL), if forwarder.is_some() => {
                    let mut state = self.snapshot.lock().unwrap();
                    if let Some(row) = state.forwards.iter_mut().find(|row| row.local_port == self.config.local_port) {
                        row.path = forwarder.as_ref().unwrap().path();
                    }
                    continue;
                }
            }
            let control = self.control.clone();
            let resolving = control.resolve(
                self.config.provider_id.clone(),
                self.config.remote_port,
                self.cancel.clone(),
            );
            tokio::pin!(resolving);
            let resolved = tokio::select! {
                result = &mut resolving => result,
                _ = self.cancel.cancelled() => {
                    let closed = match forwarder.take() {
                        Some(listener) => listener.shutdown().await,
                        None => Ok(()),
                    };
                    let _ = resolving.await;
                    closed?;
                    return Ok(());
                }
            };
            let resolved = match resolved {
                Ok(resolved) => resolved.value,
                Err(error) => {
                    let retry = control_io::resolve_retryable(&error);
                    self.update(
                        if retry {
                            TunnelPhase::Recovering
                        } else {
                            TunnelPhase::Failed
                        },
                        &error.to_string(),
                        forwarder.as_ref(),
                    );
                    if !retry {
                        return Ok(());
                    }
                    next_resolve = Instant::now() + RECOVERY_INTERVAL;
                    continue;
                }
            };
            let visitor = match endpoint(
                &self.endpoint,
                TunnelEndpointConfig {
                    secret_key: None,
                    relay: resolved.relay,
                    mode: self.mode,
                },
            )
            .await
            {
                Ok(visitor) => visitor,
                Err(error) => {
                    self.update(TunnelPhase::Recovering, &error, forwarder.as_ref());
                    next_resolve = Instant::now() + RECOVERY_INTERVAL;
                    continue;
                }
            };
            if self.cancel.is_cancelled() {
                return Ok(());
            }
            let target = TunnelTarget {
                provider_id: self.config.provider_id.clone(),
                tunnel_id: resolved.tunnel_id,
                service_token: resolved.service_token,
            };
            if let Some(forwarder) = forwarder.as_ref() {
                forwarder.set_target(target.clone());
            }
            let probe = {
                let probing = visitor.probe(&target);
                tokio::pin!(probing);
                tokio::select! {
                    _ = self.cancel.cancelled() => {
                        let closed = match forwarder.take() {
                            Some(listener) => listener.shutdown().await,
                            None => Ok(()),
                        };
                        let _ = probing.await;
                        closed?;
                        return Ok(());
                    }
                    result = &mut probing => result,
                }
            };
            if let Err(error) = probe {
                self.update(TunnelPhase::Recovering, &error, forwarder.as_ref());
                next_resolve = Instant::now() + RECOVERY_INTERVAL;
                continue;
            }
            if forwarder.is_none() {
                let bind_addr = SocketAddr::from((Ipv4Addr::LOCALHOST, self.config.local_port));
                match visitor.forward(bind_addr, target).await {
                    Ok(listener) => *forwarder = Some(listener),
                    Err(error) => {
                        self.update(TunnelPhase::Failed, &error, None);
                        return Ok(());
                    }
                }
            }
            if self.cancel.is_cancelled() {
                return Ok(());
            }
            self.update(TunnelPhase::Listening, "本地映射已就绪", forwarder.as_ref());
            next_resolve = Instant::now() + RENEW_INTERVAL;
        }
    }
}
