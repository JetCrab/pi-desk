use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use futures_util::StreamExt;
use iroh::{
    Endpoint, EndpointAddr, EndpointId, RelayConfig, RelayMap, RelayMode, SecretKey,
    endpoint::{Connection, PortmapperConfig, presets},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore, oneshot};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::{debug, info};

use crate::runtime::{
    TunnelConnectionRow, TunnelEndpointConfig, TunnelMode, TunnelPath, TunnelServiceConfig,
    TunnelSource, TunnelTarget,
};

#[cfg(test)]
mod tests;
mod transfer;
mod wire;

pub(crate) use transfer::ForwarderRuntime;

const ALPN: &[u8] = b"pi-desk-tunnel/1";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: usize = 128;
const MAX_STREAMS: usize = 512;
const MAX_SERVICES: usize = 128;
const MAX_FORWARDERS: usize = 128;

type RuntimeResult<T> = Result<T, String>;

pub(crate) struct EndpointRuntime {
    shared: Arc<Shared>,
    shutdown: AsyncMutex<()>,
}

struct Shared {
    id: String,
    endpoint: Mutex<Option<Endpoint>>,
    relay_url: iroh::RelayUrl,
    cancel: CancellationToken,
    tasks: TaskTracker,
    mutations: AsyncMutex<()>,
    services: Mutex<HashMap<String, Arc<Service>>>,
    outgoing: AsyncMutex<HashMap<EndpointId, Connection>>,
    connection_slots: Arc<Semaphore>,
    stream_slots: Arc<Semaphore>,
    forwarder_slots: Arc<Semaphore>,
    active: Mutex<HashMap<(usize, u64), Active>>,
}

struct Service {
    config: TunnelServiceConfig,
    gateway_id: EndpointId,
    cancel: CancellationToken,
    tasks: TaskTracker,
}

struct Active {
    connection: Connection,
    port: u16,
    source: TunnelSource,
}

struct ActiveGuard {
    shared: Arc<Shared>,
    key: (usize, u64),
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.shared
            .active
            .lock()
            .expect("活动流锁")
            .remove(&self.key);
    }
}

impl Drop for EndpointRuntime {
    fn drop(&mut self) {
        self.shared.cancel.cancel();
    }
}

impl EndpointRuntime {
    pub(crate) async fn start(config: TunnelEndpointConfig) -> RuntimeResult<Arc<Self>> {
        let parsed = url::Url::parse(&config.relay.url).map_err(|_| "中继URL无效")?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("中继URL必须是无认证和查询参数的HTTP(S)地址".to_owned());
        }
        if config.relay.auth_token.is_empty() {
            return Err("中继接入令牌不能为空".to_owned());
        }
        if config.relay.quic_port == 0 {
            return Err("中继QUIC地址发现端口必须大于0".to_owned());
        }
        let relay_url: iroh::RelayUrl = parsed.into();
        let mut relay_config = RelayConfig::from(relay_url.clone());
        let mut quic_config = relay_config.quic.take().unwrap_or_default();
        quic_config.port = config.relay.quic_port;
        relay_config.quic = Some(quic_config);
        let relay_map =
            RelayMap::from_iter([relay_config]).with_auth_token(config.relay.auth_token);
        let mut builder = Endpoint::builder(presets::Minimal)
            .relay_mode(RelayMode::Custom(relay_map))
            .alpns(vec![ALPN.to_vec()]);
        if let Some(secret_key) = config.secret_key {
            builder = builder.secret_key(SecretKey::from_bytes(&secret_key));
        }
        if config.mode == TunnelMode::RelayOnly {
            builder = builder
                .clear_ip_transports()
                .portmapper_config(PortmapperConfig::Disabled);
        }
        #[cfg(test)]
        {
            // 本地网络测试不向开发机所在路由器申请端口映射。
            builder = builder.portmapper_config(PortmapperConfig::Disabled);
        }
        let endpoint = builder.bind().await.map_err(|_| "无法绑定iroh端点")?;
        let shared = Arc::new(Shared {
            id: endpoint.id().to_string(),
            endpoint: Mutex::new(Some(endpoint)),
            relay_url,
            cancel: CancellationToken::new(),
            tasks: TaskTracker::new(),
            mutations: AsyncMutex::new(()),
            services: Mutex::new(HashMap::new()),
            outgoing: AsyncMutex::new(HashMap::new()),
            connection_slots: Arc::new(Semaphore::new(MAX_CONNECTIONS)),
            stream_slots: Arc::new(Semaphore::new(MAX_STREAMS)),
            forwarder_slots: Arc::new(Semaphore::new(MAX_FORWARDERS)),
            active: Mutex::new(HashMap::new()),
        });
        let accept_shared = shared.clone();
        shared
            .tasks
            .spawn(async move { transfer::accept_connections(accept_shared).await });
        info!(endpoint_id = %shared.id, mode = ?config.mode, "隧道端点已启动");
        Ok(Arc::new(Self {
            shared,
            shutdown: AsyncMutex::new(()),
        }))
    }

    pub(crate) fn id(&self) -> String {
        self.shared.id.clone()
    }

    pub(crate) async fn register_service(&self, config: TunnelServiceConfig) -> RuntimeResult<()> {
        if config.tunnel_id.is_empty() || config.service_token.is_empty() {
            return Err("隧道登记ID和令牌不能为空".to_owned());
        }
        if !config.local_addr.ip().is_loopback() || config.local_addr.port() == 0 {
            return Err("本地转发目标必须是有效的回环TCP端口".to_owned());
        }
        let gateway_id = parse_id(&config.gateway_id)?;
        let _mutation = self.shared.mutations.lock().await;
        self.shared.running()?;
        let old = {
            let mut services = self.shared.services.lock().expect("端口登记锁");
            if !services.contains_key(&config.tunnel_id) && services.len() >= MAX_SERVICES {
                return Err("隧道登记端口数量已达上限".to_owned());
            }
            services.remove(&config.tunnel_id)
        };
        if let Some(service) = old {
            stop_service(service).await;
        }
        info!(tunnel_id = %config.tunnel_id, port = config.local_addr.port(), "隧道端口已登记");
        self.shared.services.lock().expect("端口登记锁").insert(
            config.tunnel_id.clone(),
            Arc::new(Service {
                config,
                gateway_id,
                cancel: self.shared.cancel.child_token(),
                tasks: TaskTracker::new(),
            }),
        );
        Ok(())
    }

    pub(crate) async fn remove_service(&self, tunnel_id: &str) -> RuntimeResult<()> {
        let _mutation = self.shared.mutations.lock().await;
        let service = self
            .shared
            .services
            .lock()
            .expect("端口登记锁")
            .remove(tunnel_id);
        if let Some(service) = service {
            stop_service(service).await;
            info!(tunnel_id, "隧道端口授权与全部业务流已撤销");
        }
        Ok(())
    }

    pub(crate) async fn probe(&self, target: &TunnelTarget) -> RuntimeResult<()> {
        validate_target(target)?;
        let _mutation = self.shared.mutations.lock().await;
        self.shared.running()?;
        let slot = self
            .shared
            .stream_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "隧道流数量已达上限")?;
        let shared = self.shared.clone();
        let target = target.clone();
        let (sender, receiver) = oneshot::channel();
        self.shared.tasks.spawn(async move {
            let _slot = slot;
            let result = tokio::select! {
                biased;
                _ = shared.cancel.cancelled() => Err("隧道端点已关闭".to_owned()),
                result = tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
                    let connection = shared.connect(&target).await?;
                    let (_send, mut recv) = transfer::request(&connection, &target, wire::Operation::Probe).await?;
                    let mut end = [0; 1];
                    match recv.read(&mut end).await {
                        Ok(None) => Ok(()),
                        _ => Err("隧道探测响应未正常结束".to_owned()),
                    }
                }) => result.map_err(|_| "隧道探测超时".to_owned()).and_then(|result| result),
            };
            let _ = sender.send(result);
        });
        drop(_mutation);
        receiver
            .await
            .map_err(|_| "隧道探测任务已停止".to_owned())?
    }

    pub(crate) async fn forward(
        &self,
        bind_addr: SocketAddr,
        target: TunnelTarget,
    ) -> RuntimeResult<ForwarderRuntime> {
        validate_target(&target)?;
        let _mutation = self.shared.mutations.lock().await;
        self.shared.running()?;
        transfer::start_forwarder(self.shared.clone(), bind_addr, target).await
    }

    pub(crate) async fn forward_listener(
        &self,
        listener: std::net::TcpListener,
        target: TunnelTarget,
    ) -> RuntimeResult<ForwarderRuntime> {
        validate_target(&target)?;
        let _mutation = self.shared.mutations.lock().await;
        self.shared.running()?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("无法设置TCP监听为非阻塞模式：{error}"))?;
        let listener = tokio::net::TcpListener::from_std(listener)
            .map_err(|error| format!("无法接管TCP监听：{error}"))?;
        transfer::start_forwarder_listener(self.shared.clone(), listener, target)
    }

    pub(crate) fn connections(&self) -> Vec<TunnelConnectionRow> {
        let active = self.shared.active.lock().expect("活动流锁");
        let mut rows: Vec<TunnelConnectionRow> = Vec::new();
        for record in active.values() {
            let peer_id = record.connection.remote_id().to_string();
            let path = selected_path(&record.connection);
            if let Some(row) = rows.iter_mut().find(|row| {
                row.peer_id == peer_id
                    && row.local_port == record.port
                    && row.source == record.source
                    && row.path == path
            }) {
                row.active_tcp += 1;
            } else {
                rows.push(TunnelConnectionRow {
                    peer_id,
                    local_port: record.port,
                    source: record.source,
                    path,
                    active_tcp: 1,
                });
            }
        }
        rows.sort_by(|a, b| (&a.peer_id, a.local_port).cmp(&(&b.peer_id, b.local_port)));
        rows
    }

    pub(crate) async fn shutdown(&self) -> RuntimeResult<()> {
        let _shutdown = self.shutdown.lock().await;
        {
            let _mutation = self.shared.mutations.lock().await;
            self.shared.cancel.cancel();
        }
        self.shared.tasks.close();
        let endpoint = self.shared.endpoint.lock().expect("端点锁").take();
        if let Some(endpoint) = endpoint {
            endpoint.close().await;
        }
        self.shared.tasks.wait().await;
        self.shared.outgoing.lock().await.clear();
        self.shared.services.lock().expect("端口登记锁").clear();
        debug_assert!(self.shared.active.lock().expect("活动流锁").is_empty());
        info!(endpoint_id = %self.shared.id, "隧道端点及全部任务已关闭");
        Ok(())
    }
}

async fn stop_service(service: Arc<Service>) {
    service.cancel.cancel();
    service.tasks.close();
    service.tasks.wait().await;
}

fn parse_id(value: &str) -> RuntimeResult<EndpointId> {
    value.parse().map_err(|_| "隧道端点公钥无效".to_owned())
}

fn validate_target(target: &TunnelTarget) -> RuntimeResult<()> {
    parse_id(&target.provider_id)?;
    if target.tunnel_id.is_empty() || target.service_token.is_empty() {
        return Err("隧道目标登记ID和令牌不能为空".to_owned());
    }
    Ok(())
}

fn selected_path(connection: &Connection) -> TunnelPath {
    if connection.close_reason().is_some() {
        return TunnelPath::Unknown;
    }
    connection
        .paths()
        .iter()
        .find(|path| path.is_selected())
        .map_or(TunnelPath::Unknown, |path| {
            if path.is_ip() {
                TunnelPath::Direct
            } else if path.is_relay() {
                TunnelPath::Relay
            } else {
                TunnelPath::Unknown
            }
        })
}

impl Shared {
    fn running(&self) -> RuntimeResult<()> {
        if self.cancel.is_cancelled() {
            Err("隧道端点已关闭".to_owned())
        } else {
            Ok(())
        }
    }

    fn endpoint(&self) -> RuntimeResult<Endpoint> {
        self.running()?;
        self.endpoint
            .lock()
            .expect("端点锁")
            .clone()
            .ok_or_else(|| "隧道端点已关闭".to_owned())
    }

    async fn connect(self: &Arc<Self>, target: &TunnelTarget) -> RuntimeResult<Connection> {
        let id = parse_id(&target.provider_id)?;
        {
            let mut outgoing = self.outgoing.lock().await;
            self.running()?;
            outgoing.retain(|_, connection| connection.close_reason().is_none());
            if let Some(connection) = outgoing.get(&id) {
                return Ok(connection.clone());
            }
        }
        let permit = self
            .connection_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "隧道连接数量已达上限")?;
        let endpoint = self.endpoint()?;
        let address = EndpointAddr::new(id).with_relay_url(self.relay_url.clone());
        let connection = tokio::time::timeout(HANDSHAKE_TIMEOUT, endpoint.connect(address, ALPN))
            .await
            .map_err(|_| "iroh连接握手超时")?
            .map_err(|_| "无法建立iroh连接")?;
        let mut outgoing = self.outgoing.lock().await;
        if let Err(error) = self.running() {
            connection.close(0u32.into(), b"endpoint stopped during dial");
            return Err(error);
        }
        if let Some(cached) = outgoing
            .get(&id)
            .filter(|cached| cached.close_reason().is_none())
        {
            if cached.stable_id() != connection.stable_id() {
                connection.close(0u32.into(), b"concurrent dial already cached");
            }
            return Ok(cached.clone());
        }
        outgoing.insert(id, connection.clone());
        let shared = self.clone();
        let observed = connection.clone();
        self.tasks
            .spawn(async move { transfer::connection_loop(shared, observed, permit).await });
        Ok(connection)
    }

    async fn observe_connection(self: &Arc<Self>, connection: &Connection) {
        let mut paths = connection.paths_stream();
        while let Some(snapshot) = paths.next().await {
            let path = snapshot.iter().find(|path| path.is_selected()).map_or(
                TunnelPath::Unknown,
                |path| {
                    if path.is_ip() {
                        TunnelPath::Direct
                    } else if path.is_relay() {
                        TunnelPath::Relay
                    } else {
                        TunnelPath::Unknown
                    }
                },
            );
            debug!(peer_id = %connection.remote_id(), ?path, "隧道实际路径更新");
        }
    }

    fn count(
        self: &Arc<Self>,
        connection: &Connection,
        stream_id: u64,
        service: &Service,
    ) -> ActiveGuard {
        let key = (connection.stable_id(), stream_id);
        self.active.lock().expect("活动流锁").insert(
            key,
            Active {
                connection: connection.clone(),
                port: service.config.local_addr.port(),
                source: if connection.remote_id() == service.gateway_id {
                    TunnelSource::Public
                } else {
                    TunnelSource::Client
                },
            },
        );
        ActiveGuard {
            shared: self.clone(),
            key,
        }
    }
}
