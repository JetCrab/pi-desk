use std::collections::HashMap;
use std::net::{Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use pi_desk_tunnel_common::protocol::{
    LEASE_DURATION, OpenTunnelRequest, OpenTunnelResponse, RENEW_INTERVAL, ResolveTunnelRequest,
    ResolveTunnelResponse, StatusTunnelResponse, TunnelRelayConfig, TunnelStatus, random_hex,
};
use pi_desk_tunnel_common::runtime::{TunnelEndpoint, TunnelForwarder, TunnelTarget};
use tokio::sync::{Mutex, mpsc, oneshot, watch};
use tokio::task::{Id, JoinError, JoinHandle, JoinSet};

const REQUEST_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const PROBE_RETRY: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub struct TunnelRegistryConfig {
    pub relay: TunnelRelayConfig,
    pub public_host: String,
}

pub struct TunnelRegistry {
    commands: mpsc::Sender<Command>,
    task: Mutex<Option<JoinHandle<()>>>,
}

type ReleaseResult = Result<(), TunnelError>;
type ReleaseWatch = watch::Receiver<Option<ReleaseResult>>;

enum OpenResult {
    Opened(OpenTunnelResponse),
    Releasing(ReleaseWatch),
}

enum Command {
    Open(
        OpenTunnelRequest,
        oneshot::Sender<Result<OpenResult, TunnelError>>,
    ),
    Status(
        String,
        oneshot::Sender<Result<StatusTunnelResponse, TunnelError>>,
    ),
    Resolve(
        ResolveTunnelRequest,
        oneshot::Sender<Result<ResolveTunnelResponse, TunnelError>>,
    ),
    Close(String, oneshot::Sender<Option<ReleaseWatch>>),
    Shutdown(oneshot::Sender<()>),
    #[cfg(test)]
    Expire(Instant, oneshot::Sender<()>),
    #[cfg(test)]
    ProbeStarted(String, oneshot::Sender<Option<watch::Receiver<bool>>>),
}

// 注册表由一个任务独占，网络调用和资源回收期间不持锁。
struct RegistryTask {
    endpoint: TunnelEndpoint,
    config: TunnelRegistryConfig,
    tunnels: HashMap<String, TunnelEntry>,
    requests: HashMap<String, RequestRecord>,
    probes: mpsc::UnboundedSender<ProbeResult>,
    // 清理完成前保留目标与公网端口，相关 open/close 在调用方等待同一个通知。
    releasing: HashMap<String, PendingRelease>,
    cleanup: JoinSet<(String, ReleaseResult)>,
}

struct PendingRelease {
    request: OpenTunnelRequest,
    done: watch::Sender<Option<ReleaseResult>>,
    task_id: Id,
}

struct RequestRecord {
    request: OpenTunnelRequest,
    tunnel_id: Option<String>,
    closed_at: Option<Instant>,
}

struct TunnelEntry {
    request: OpenTunnelRequest,
    response: OpenTunnelResponse,
    status: TunnelStatus,
    error: Option<String>,
    last_seen: Instant,
    probe: JoinHandle<()>,
    stop_probe: oneshot::Sender<()>,
    forwarder: Option<TunnelForwarder>,
    #[cfg(test)]
    probe_started: watch::Receiver<bool>,
}

struct ProbeResult {
    tunnel_id: String,
    result: Result<(), String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TunnelError {
    InvalidRequest,
    InvalidPort,
    PortConflict,
    RequestConflict,
    NotFound,
    NotReady,
    Internal,
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRequest => "隧道请求不符合格式要求",
            Self::InvalidPort => "端口必须是 1 到 65535 的有效端口",
            Self::PortConflict => "公网端口已被占用或无法监听",
            Self::RequestConflict => "请求标识与已有请求冲突",
            Self::NotFound => "隧道不存在",
            Self::NotReady => "隧道提供端尚未就绪",
            Self::Internal => "隧道服务内部错误",
        })
    }
}

impl std::error::Error for TunnelError {}

impl TunnelRegistry {
    pub fn new(endpoint: TunnelEndpoint, config: TunnelRegistryConfig) -> Arc<Self> {
        let (commands, receiver) = mpsc::channel(128);
        let (probes, results) = mpsc::unbounded_channel();
        let task = tokio::spawn(
            RegistryTask {
                endpoint,
                config,
                tunnels: HashMap::new(),
                requests: HashMap::new(),
                probes,
                releasing: HashMap::new(),
                cleanup: JoinSet::new(),
            }
            .run(receiver, results),
        );
        Arc::new(Self {
            commands,
            task: Mutex::new(Some(task)),
        })
    }

    pub async fn open(
        &self,
        request: OpenTunnelRequest,
    ) -> Result<OpenTunnelResponse, TunnelError> {
        loop {
            let (reply, result) = oneshot::channel();
            self.commands
                .send(Command::Open(request.clone(), reply))
                .await
                .map_err(|_| TunnelError::Internal)?;
            match result.await.map_err(|_| TunnelError::Internal)?? {
                OpenResult::Opened(response) => return Ok(response),
                OpenResult::Releasing(done) => wait_release(done).await?,
            }
        }
    }

    pub async fn status(&self, tunnel_id: &str) -> Result<StatusTunnelResponse, TunnelError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Status(tunnel_id.to_owned(), reply))
            .await
            .map_err(|_| TunnelError::Internal)?;
        result.await.map_err(|_| TunnelError::Internal)?
    }

    pub async fn resolve(
        &self,
        request: ResolveTunnelRequest,
    ) -> Result<ResolveTunnelResponse, TunnelError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Resolve(request, reply))
            .await
            .map_err(|_| TunnelError::Internal)?;
        result.await.map_err(|_| TunnelError::Internal)?
    }

    pub async fn close(&self, tunnel_id: &str) -> Result<(), TunnelError> {
        let (reply, result) = oneshot::channel();
        self.commands
            .send(Command::Close(tunnel_id.to_owned(), reply))
            .await
            .map_err(|_| TunnelError::Internal)?;
        match result.await.map_err(|_| TunnelError::Internal)? {
            Some(done) => wait_release(done).await,
            None => Ok(()),
        }
    }

    pub async fn shutdown(&self) {
        let task = self.task.lock().await.take();
        if let Some(task) = task {
            let (reply, result) = oneshot::channel();
            if self.commands.send(Command::Shutdown(reply)).await.is_ok() {
                let _ = result.await;
            }
            if let Err(error) = task.await {
                eprintln!("隧道网关任务退出异常 error={error}");
            }
        }
    }
}

impl RegistryTask {
    async fn run(
        mut self,
        mut commands: mpsc::Receiver<Command>,
        mut results: mpsc::UnboundedReceiver<ProbeResult>,
    ) {
        let mut sweep = tokio::time::interval(RENEW_INTERVAL);
        let shutdown_reply = loop {
            tokio::select! {
                command = commands.recv() => match command {
                    Some(Command::Open(request, reply)) => { let _ = reply.send(self.open(request).await); }
                    Some(Command::Status(id, reply)) => { let _ = reply.send(self.status(&id)); }
                    Some(Command::Resolve(request, reply)) => { let _ = reply.send(self.resolve(request)); }
                    Some(Command::Close(id, reply)) => { let _ = reply.send(self.release(&id)); }
                    Some(Command::Shutdown(reply)) => break Some(reply),
                    None => break None,
                    #[cfg(test)]
                    Some(Command::Expire(now, reply)) => { self.expire(now); let _ = reply.send(()); }
                    #[cfg(test)]
                    Some(Command::ProbeStarted(id, reply)) => { let _ = reply.send(self.tunnels.get(&id).map(|entry| entry.probe_started.clone())); }
                },
                Some(result) = results.recv() => self.apply_probe(result),
                _ = sweep.tick() => self.expire(Instant::now()),
                Some(result) = self.cleanup.join_next(), if !self.cleanup.is_empty() => self.finish_release(result),
            }
        };
        commands.close();
        let ids = self.tunnels.keys().cloned().collect::<Vec<_>>();
        for id in ids {
            self.release(&id);
        }
        let endpoint = self.endpoint.clone();
        let cleanup = async {
            while let Some(result) = self.cleanup.join_next().await {
                self.finish_release(result);
            }
        };
        // 进程退出同时取消端点网络工作，避免逐项等待离线提供端的握手超时。
        let (_, endpoint_result) = tokio::join!(cleanup, endpoint.shutdown());
        if let Err(error) = endpoint_result {
            eprintln!("隧道网关端点关闭失败 error={error}");
        }
        if let Some(reply) = shutdown_reply {
            let _ = reply.send(());
        }
    }

    async fn open(&mut self, mut request: OpenTunnelRequest) -> Result<OpenResult, TunnelError> {
        request.request_id = normalize_request_id(&request.request_id)?;
        validate_provider_id(&request.provider_id)?;
        validate_port(request.port)?;
        if let Some(port) = request.public_port {
            validate_port(port)?;
        }
        self.expire(Instant::now());
        if let Some(record) = self.requests.get(&request.request_id) {
            if record.request != request {
                return Err(TunnelError::RequestConflict);
            }
            return record
                .tunnel_id
                .as_ref()
                .and_then(|id| self.tunnels.get(id))
                .map(|entry| OpenResult::Opened(entry.response.clone()))
                .ok_or(TunnelError::RequestConflict);
        }
        if let Some(port) = request.public_port
            && self.tunnels.values().any(|entry| {
                entry.request.public_port == Some(port)
                    && (entry.request.provider_id != request.provider_id
                        || entry.request.port != request.port)
            })
        {
            return Err(TunnelError::PortConflict);
        }
        if let Some(pending) = self.releasing.values().find(|pending| {
            (pending.request.provider_id == request.provider_id
                && pending.request.port == request.port)
                || request.public_port.is_some()
                    && pending.request.public_port == request.public_port
        }) {
            return Ok(OpenResult::Releasing(pending.done.subscribe()));
        }
        let previous = self
            .tunnels
            .iter()
            .find(|(_, entry)| {
                entry.request.provider_id == request.provider_id
                    && entry.request.port == request.port
            })
            .map(|(id, _)| id.clone());
        if let Some(id) = previous {
            return Ok(OpenResult::Releasing(
                self.release(&id).ok_or(TunnelError::Internal)?,
            ));
        }
        let tunnel_id = random_hex::<16>().map_err(|_| TunnelError::Internal)?;
        let response = OpenTunnelResponse {
            tunnel_id: tunnel_id.clone(),
            service_token: random_hex::<32>().map_err(|_| TunnelError::Internal)?,
            relay: self.config.relay.clone(),
            gateway_id: self.endpoint.id(),
            public_addr: request
                .public_port
                .map(|port| format_public_addr(&self.config.public_host, port)),
        };
        let target = TunnelTarget {
            provider_id: request.provider_id.clone(),
            tunnel_id: tunnel_id.clone(),
            service_token: response.service_token.clone(),
        };
        let forwarder = if let Some(port) = request.public_port {
            match self
                .endpoint
                .forward(SocketAddr::from(([0, 0, 0, 0], port)), target.clone())
                .await
            {
                Ok(forwarder) => Some(forwarder),
                Err(error) => {
                    eprintln!("隧道公网监听失败 port={port} error={error}");
                    return Err(TunnelError::PortConflict);
                }
            }
        } else {
            None
        };
        let endpoint = self.endpoint.clone();
        let probes = self.probes.clone();
        let (stop_probe, mut stopped) = oneshot::channel();
        #[cfg(test)]
        let (started, probe_started) = watch::channel(false);
        let probe = tokio::spawn(async move {
            let deadline = Instant::now() + LEASE_DURATION;
            let mut first_failure = true;
            loop {
                if !matches!(stopped.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
                    return;
                }
                #[cfg(test)]
                let _ = started.send(true);
                // 单次探测由 common 限制超时；关闭时不丢弃其 future，等待内部任务收敛。
                match endpoint.probe(&target).await {
                    Ok(()) => {
                        let _ = probes.send(ProbeResult {
                            tunnel_id,
                            result: Ok(()),
                        });
                        return;
                    }
                    Err(error) if first_failure => {
                        eprintln!(
                            "隧道提供端尚未通过探测 tunnel={} error={error}",
                            target.tunnel_id
                        );
                        first_failure = false;
                    }
                    Err(_) => {}
                }
                if Instant::now() >= deadline {
                    let _ = probes.send(ProbeResult {
                        tunnel_id,
                        result: Err("提供端认证探测超时".to_owned()),
                    });
                    return;
                }
                tokio::select! {
                    _ = &mut stopped => return,
                    _ = tokio::time::sleep(PROBE_RETRY) => {},
                }
            }
        });
        self.requests.insert(
            request.request_id.clone(),
            RequestRecord {
                request: request.clone(),
                tunnel_id: Some(response.tunnel_id.clone()),
                closed_at: None,
            },
        );
        self.tunnels.insert(
            response.tunnel_id.clone(),
            TunnelEntry {
                request,
                response: response.clone(),
                status: TunnelStatus::AwaitingProvider,
                error: None,
                last_seen: Instant::now(),
                probe,
                stop_probe,
                forwarder,
                #[cfg(test)]
                probe_started,
            },
        );
        eprintln!(
            "隧道已注册 tunnel={} public={}",
            response.tunnel_id,
            response.public_addr.as_deref().unwrap_or("仅客户端")
        );
        Ok(OpenResult::Opened(response))
    }

    fn status(&mut self, id: &str) -> Result<StatusTunnelResponse, TunnelError> {
        let entry = self.tunnels.get_mut(id).ok_or(TunnelError::NotFound)?;
        // 清扫间隔内到达的迟到续租也不能复活已过期注册。
        if entry.last_seen.elapsed() >= LEASE_DURATION {
            return Err(TunnelError::NotFound);
        }
        entry.last_seen = Instant::now();
        Ok(StatusTunnelResponse {
            tunnel_id: id.to_owned(),
            status: entry.status,
            error: entry.error.clone(),
        })
    }

    fn resolve(&self, request: ResolveTunnelRequest) -> Result<ResolveTunnelResponse, TunnelError> {
        validate_provider_id(&request.provider_id)?;
        validate_port(request.port)?;
        let entry = self
            .tunnels
            .values()
            .find(|entry| {
                entry.request.provider_id == request.provider_id
                    && entry.request.port == request.port
                    && entry.last_seen.elapsed() < LEASE_DURATION
            })
            .ok_or(TunnelError::NotFound)?;
        if entry.status != TunnelStatus::Ready {
            return Err(TunnelError::NotReady);
        }
        Ok(ResolveTunnelResponse {
            tunnel_id: entry.response.tunnel_id.clone(),
            service_token: entry.response.service_token.clone(),
            relay: self.config.relay.clone(),
        })
    }

    fn apply_probe(&mut self, result: ProbeResult) {
        if let Some(entry) = self.tunnels.get_mut(&result.tunnel_id) {
            match result.result {
                Ok(()) => {
                    entry.status = TunnelStatus::Ready;
                    eprintln!("隧道提供端已就绪 tunnel={}", result.tunnel_id);
                }
                Err(error) => {
                    entry.status = TunnelStatus::Failed;
                    eprintln!(
                        "隧道提供端探测失败 tunnel={} error={error}",
                        result.tunnel_id
                    );
                    entry.error = Some(error);
                }
            }
        }
    }

    fn release(&mut self, id: &str) -> Option<ReleaseWatch> {
        if let Some(pending) = self.releasing.get(id) {
            return Some(pending.done.subscribe());
        }
        let entry = self.tunnels.remove(id)?;
        if let Some(record) = self.requests.get_mut(&entry.request.request_id) {
            record.tunnel_id = None;
            record.closed_at = Some(Instant::now());
        }
        let _ = entry.stop_probe.send(());
        let (done, result) = watch::channel(None);
        let request = entry.request;
        let tunnel_id = id.to_owned();
        let id = tunnel_id.clone();
        let task_id = self
            .cleanup
            .spawn(async move {
                let forwarder_result = match entry.forwarder {
                    Some(forwarder) => forwarder.shutdown().await,
                    None => Ok(()),
                };
                let probe_result = entry.probe.await;
                let result = match (forwarder_result, probe_result) {
                    (Err(error), _) => {
                        eprintln!("隧道公网转发关闭失败 tunnel={id} error={error}");
                        Err(TunnelError::Internal)
                    }
                    (_, Err(error)) => {
                        eprintln!("隧道探测任务关闭失败 tunnel={id} error={error}");
                        Err(TunnelError::Internal)
                    }
                    (Ok(()), Ok(())) => Ok(()),
                };
                (id, result)
            })
            .id();
        self.releasing.insert(
            tunnel_id,
            PendingRelease {
                request,
                done,
                task_id,
            },
        );
        Some(result)
    }

    fn finish_release(&mut self, result: Result<(String, ReleaseResult), JoinError>) {
        let (id, result) = match result {
            Ok(result) => result,
            Err(error) => {
                eprintln!("隧道资源回收任务异常 error={error}");
                let Some(id) = self
                    .releasing
                    .iter()
                    .find(|(_, pending)| pending.task_id == error.id())
                    .map(|(id, _)| id.clone())
                else {
                    return;
                };
                (id, Err(TunnelError::Internal))
            }
        };
        if let Some(pending) = self.releasing.remove(&id) {
            let _ = pending.done.send(Some(result));
            eprintln!("隧道已释放 tunnel={id}");
        }
    }

    fn expire(&mut self, now: Instant) {
        let ids = self
            .tunnels
            .iter()
            .filter(|(_, entry)| now.saturating_duration_since(entry.last_seen) >= LEASE_DURATION)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in ids {
            self.release(&id);
        }
        self.prune_tombstones(now);
    }

    fn prune_tombstones(&mut self, now: Instant) {
        self.requests.retain(|_, record| {
            record
                .closed_at
                .is_none_or(|closed| now.saturating_duration_since(closed) < REQUEST_TOMBSTONE_TTL)
        });
    }
}

async fn wait_release(mut done: ReleaseWatch) -> ReleaseResult {
    let result = *done
        .wait_for(Option::is_some)
        .await
        .map_err(|_| TunnelError::Internal)?;
    result.ok_or(TunnelError::Internal)?
}

fn validate_port(port: u16) -> Result<(), TunnelError> {
    if port == 0 {
        Err(TunnelError::InvalidPort)
    } else {
        Ok(())
    }
}

fn validate_provider_id(id: &str) -> Result<(), TunnelError> {
    if id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(TunnelError::InvalidRequest)
    }
}

fn normalize_request_id(id: &str) -> Result<String, TunnelError> {
    let id = id.trim();
    if id.is_empty() || id.len() > 128 {
        Err(TunnelError::InvalidRequest)
    } else {
        Ok(id.to_owned())
    }
}

fn format_public_addr(host: &str, port: u16) -> String {
    if host.parse::<Ipv6Addr>().is_ok() {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(test)]
#[path = "gateway_tests.rs"]
mod gateway_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use pi_desk_tunnel_common::runtime::{
        TunnelEndpointConfig, TunnelMode, provider_id, start_endpoint,
    };
    use tokio::net::TcpListener;

    async fn registry() -> Arc<TunnelRegistry> {
        let relay = TunnelRelayConfig {
            url: "http://127.0.0.1:9".to_owned(),
            auth_token: "test-relay-token".to_owned(),
            quic_port: 7842,
        };
        let endpoint = start_endpoint(TunnelEndpointConfig {
            secret_key: None,
            relay: relay.clone(),
            mode: TunnelMode::RelayOnly,
        })
        .await
        .unwrap();
        TunnelRegistry::new(
            endpoint,
            TunnelRegistryConfig {
                relay,
                public_host: "2001:db8::1".to_owned(),
            },
        )
    }

    fn request(id: &str, port: Option<u16>) -> OpenTunnelRequest {
        OpenTunnelRequest {
            request_id: id.to_owned(),
            provider_id: provider_id(&"01".repeat(32)).unwrap(),
            port: 3000,
            public_port: port,
        }
    }

    async fn free_port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    async fn expire_at(registry: &TunnelRegistry, now: Instant) {
        let (reply, result) = oneshot::channel();
        registry
            .commands
            .send(Command::Expire(now, reply))
            .await
            .unwrap();
        result.await.unwrap();
    }

    #[tokio::test]
    async fn request_identity_conflicts_and_replacement_release_listeners() {
        let registry = registry().await;
        let port = free_port().await;
        let original = request("original", Some(port));
        let opened = registry.open(original.clone()).await.unwrap();
        assert_eq!(opened.public_addr, Some(format!("[2001:db8::1]:{port}")));
        assert_eq!(registry.open(original.clone()).await.unwrap(), opened);
        assert!(TcpListener::bind(("0.0.0.0", port)).await.is_err());
        let mut conflict = original.clone();
        conflict.port += 1;
        assert_eq!(
            registry.open(conflict).await,
            Err(TunnelError::RequestConflict)
        );
        let mut other_provider = request("other-provider", Some(port));
        other_provider.provider_id = provider_id(&"02".repeat(32)).unwrap();
        assert_eq!(
            registry.open(other_provider).await,
            Err(TunnelError::PortConflict)
        );
        let mut other_service = request("other-service", Some(port));
        other_service.port += 1;
        assert_eq!(
            registry.open(other_service).await,
            Err(TunnelError::PortConflict)
        );
        let replacement = registry
            .open(request("replacement", Some(port)))
            .await
            .unwrap();
        assert_ne!(replacement.tunnel_id, opened.tunnel_id);
        assert_ne!(replacement.service_token, opened.service_token);
        assert_eq!(replacement.gateway_id, opened.gateway_id);
        assert!(matches!(
            registry.status(&opened.tunnel_id).await,
            Err(TunnelError::NotFound)
        ));
        assert_eq!(
            registry.open(original).await,
            Err(TunnelError::RequestConflict)
        );
        registry.close(&replacement.tunnel_id).await.unwrap();
        registry.close(&replacement.tunnel_id).await.unwrap();
        let rebound = TcpListener::bind(("0.0.0.0", port)).await.unwrap();
        drop(rebound);
        registry.shutdown().await;
    }

    #[tokio::test]
    async fn p2p_only_stays_unready_and_lease_expiry_keeps_request_tombstone() {
        let registry = registry().await;
        let original = request("p2p-only", None);
        let opened = registry.open(original.clone()).await.unwrap();
        assert_eq!(opened.public_addr, None);
        assert_eq!(
            registry.status(&opened.tunnel_id).await.unwrap().status,
            TunnelStatus::AwaitingProvider
        );
        let target = ResolveTunnelRequest {
            provider_id: original.provider_id.clone(),
            port: original.port,
        };
        assert_eq!(
            registry.resolve(target.clone()).await,
            Err(TunnelError::NotReady)
        );
        expire_at(&registry, Instant::now() + LEASE_DURATION).await;
        assert_eq!(registry.resolve(target).await, Err(TunnelError::NotFound));
        assert!(matches!(
            registry.status(&opened.tunnel_id).await,
            Err(TunnelError::NotFound)
        ));
        assert_eq!(
            registry.open(original.clone()).await,
            Err(TunnelError::RequestConflict)
        );
        expire_at(&registry, Instant::now() + REQUEST_TOMBSTONE_TTL).await;
        assert_ne!(
            registry.open(original).await.unwrap().tunnel_id,
            opened.tunnel_id
        );
        registry.shutdown().await;
    }

    #[tokio::test]
    async fn bind_failure_and_shutdown_do_not_leave_owned_ports() {
        let registry = registry().await;
        let occupied = TcpListener::bind("0.0.0.0:0").await.unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert_eq!(
            registry.open(request("occupied", Some(port))).await,
            Err(TunnelError::PortConflict)
        );
        drop(occupied);
        registry
            .open(request("occupied", Some(port)))
            .await
            .unwrap();
        registry.shutdown().await;
        let rebound = TcpListener::bind(("0.0.0.0", port)).await.unwrap();
        drop(rebound);
        assert!(matches!(
            registry.status("stopped").await,
            Err(TunnelError::Internal)
        ));
    }
}
