use std::collections::{HashMap, HashSet};
use std::net::Ipv6Addr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pi_desk_tunnel_common::protocol::{
    OpenTunnelRequest, OpenTunnelResponse, StatusTunnelResponse, TunnelRelayTransport,
    TunnelStatus, random_hex,
};
use pi_desk_tunnel_common::runtime::{
    TunnelError as RuntimeTunnelError, TunnelRuntimeEvent, TunnelServerHandle,
    TunnelServerServiceConfig,
};
use tokio::sync::{Mutex as AsyncMutex, mpsc};

const TUNNEL_LEASE: Duration = Duration::from_secs(30);
const REQUEST_TOMBSTONE_TTL: Duration = Duration::from_secs(60);
const SWEEP_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone)]
pub struct TunnelRegistryConfig {
    pub public_relay: String,
    pub public_host: String,
    pub server_public_key: String,
}

pub struct TunnelRegistry {
    server: TunnelServerHandle,
    config: TunnelRegistryConfig,
    state: Mutex<TunnelRegistryState>,
    operation_lock: AsyncMutex<()>,
}

struct TunnelRegistryState {
    tunnels: HashMap<String, TunnelEntry>,
    request_ids: HashMap<String, RequestRecord>,
    used_ports: HashSet<u16>,
}

struct RequestRecord {
    public_port: u16,
    tunnel_id: Option<String>,
    closed_at: Option<Instant>,
}

struct TunnelEntry {
    owner_device_id: String,
    response: OpenTunnelResponse,
    status: TunnelStatus,
    error: Option<String>,
    last_seen: Instant,
    closing: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TunnelError {
    InvalidRequest,
    InvalidPort,
    PortConflict,
    RequestConflict,
    NotFound,
    Internal,
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidRequest => formatter.write_str("隧道请求不符合格式要求"),
            Self::InvalidPort => formatter.write_str("公网端口必须是 1 到 65535 的有效端口"),
            Self::PortConflict => formatter.write_str("公网端口已被占用"),
            Self::RequestConflict => formatter.write_str("请求标识与已有请求冲突"),
            Self::NotFound => formatter.write_str("隧道不存在"),
            Self::Internal => formatter.write_str("隧道服务内部错误"),
        }
    }
}

impl std::error::Error for TunnelError {}

impl TunnelRegistry {
    pub fn new(
        server: TunnelServerHandle,
        event_rx: mpsc::Receiver<TunnelRuntimeEvent>,
        config: TunnelRegistryConfig,
    ) -> Arc<Self> {
        let registry = Arc::new(Self {
            server,
            config,
            state: Mutex::new(TunnelRegistryState {
                tunnels: HashMap::new(),
                request_ids: HashMap::new(),
                used_ports: HashSet::new(),
            }),
            operation_lock: AsyncMutex::new(()),
        });
        Self::consume_events(Arc::downgrade(&registry), event_rx);
        Self::sweep_expired(Arc::downgrade(&registry));
        registry
    }

    pub async fn open(
        &self,
        request: OpenTunnelRequest,
    ) -> Result<OpenTunnelResponse, TunnelError> {
        let _operation = self.operation_lock.lock().await;
        let request_id = normalize_request_id(&request.request_id)?;
        let device_id = normalize_device_id(&request.device_id)?;
        validate_public_port(request.public_port)?;

        let replaced_tunnel_id = {
            let state = self.state.lock().map_err(|_| TunnelError::Internal)?;
            if let Some(record) = state.request_ids.get(&request_id) {
                if record.public_port != request.public_port || record.tunnel_id.is_none() {
                    return Err(TunnelError::RequestConflict);
                }
                let entry = state
                    .tunnels
                    .get(record.tunnel_id.as_deref().expect("活动请求必须有隧道 ID"))
                    .ok_or(TunnelError::Internal)?;
                if entry.closing || entry.owner_device_id != device_id {
                    return Err(TunnelError::RequestConflict);
                }
                return Ok(entry.response.clone());
            }
            state
                .tunnels
                .iter()
                .find(|(_, entry)| entry.response.public_port == request.public_port)
                .map(|(tunnel_id, entry)| (tunnel_id.clone(), entry.owner_device_id.clone()))
        };

        if let Some((tunnel_id, owner_device_id)) = replaced_tunnel_id {
            if owner_device_id != device_id {
                return Err(TunnelError::PortConflict);
            }
            let service_id = self
                .set_closing(&tunnel_id, true)?
                .ok_or(TunnelError::Internal)?;
            if let Err(error) = self.server.remove_service(service_id.clone()).await {
                self.set_closing(&service_id, false)?;
                return Err(error.into());
            }
            self.release_tunnel(&service_id)?;
        }

        let response = {
            let mut state = self.state.lock().map_err(|_| TunnelError::Internal)?;
            if state.used_ports.contains(&request.public_port) {
                return Err(TunnelError::PortConflict);
            }
            let tunnel_id = random_hex::<16>().map_err(|_| TunnelError::Internal)?;
            let response = OpenTunnelResponse {
                tunnel_id: tunnel_id.clone(),
                public_port: request.public_port,
                public_addr: format_public_addr(&self.config.public_host, request.public_port),
                relay_addr: self.config.public_relay.clone(),
                service_token: random_hex::<32>().map_err(|_| TunnelError::Internal)?,
                server_public_key: self.config.server_public_key.clone(),
                relay_transport: TunnelRelayTransport::Noise,
            };
            state.used_ports.insert(request.public_port);
            state.request_ids.insert(
                request_id,
                RequestRecord {
                    public_port: request.public_port,
                    tunnel_id: Some(tunnel_id.clone()),
                    closed_at: None,
                },
            );
            state.tunnels.insert(
                tunnel_id,
                TunnelEntry {
                    owner_device_id: device_id,
                    response: response.clone(),
                    status: TunnelStatus::AwaitingClient,
                    error: None,
                    last_seen: Instant::now(),
                    closing: false,
                },
            );
            response
        };

        let service = TunnelServerServiceConfig {
            service_id: response.tunnel_id.clone(),
            bind_addr: format!("0.0.0.0:{}", response.public_port),
            token: response.service_token.clone(),
        };
        if let Err(error) = self.server.add_service(service).await {
            self.remove_failed_open(&response.tunnel_id, response.public_port)?;
            return Err(error.into());
        }

        Ok(response)
    }

    pub async fn status(&self, tunnel_id: &str) -> Result<StatusTunnelResponse, TunnelError> {
        let mut state = self.state.lock().map_err(|_| TunnelError::Internal)?;
        let entry = state
            .tunnels
            .get_mut(tunnel_id)
            .ok_or(TunnelError::NotFound)?;
        if entry.closing {
            return Err(TunnelError::NotFound);
        }
        entry.last_seen = Instant::now();
        Ok(StatusTunnelResponse {
            tunnel_id: entry.response.tunnel_id.clone(),
            status: entry.status,
            error: entry.error.clone(),
        })
    }

    pub async fn close(&self, tunnel_id: &str) -> Result<(), TunnelError> {
        let _operation = self.operation_lock.lock().await;
        let Some(service_id) = self.set_closing(tunnel_id, true)? else {
            return Ok(());
        };
        match self.server.remove_service(service_id.clone()).await {
            Ok(()) => self.release_tunnel(&service_id),
            Err(error) => {
                self.set_closing(&service_id, false)?;
                Err(error.into())
            }
        }
    }

    fn remove_failed_open(&self, tunnel_id: &str, public_port: u16) -> Result<(), TunnelError> {
        let mut state = self.state.lock().map_err(|_| TunnelError::Internal)?;
        state.tunnels.remove(tunnel_id);
        state.used_ports.remove(&public_port);
        state
            .request_ids
            .retain(|_, record| record.tunnel_id.as_deref() != Some(tunnel_id));
        Ok(())
    }

    fn set_closing(&self, tunnel_id: &str, closing: bool) -> Result<Option<String>, TunnelError> {
        let mut state = self.state.lock().map_err(|_| TunnelError::Internal)?;
        let Some(entry) = state.tunnels.get_mut(tunnel_id) else {
            return Ok(None);
        };
        if entry.closing == closing {
            return Ok(None);
        }
        entry.closing = closing;
        Ok(Some(entry.response.tunnel_id.clone()))
    }

    fn release_tunnel(&self, tunnel_id: &str) -> Result<(), TunnelError> {
        let mut state = self.state.lock().map_err(|_| TunnelError::Internal)?;
        let entry = state
            .tunnels
            .remove(tunnel_id)
            .ok_or(TunnelError::Internal)?;
        state.used_ports.remove(&entry.response.public_port);
        for record in state.request_ids.values_mut() {
            if record.tunnel_id.as_deref() == Some(tunnel_id) {
                record.tunnel_id = None;
                record.closed_at = Some(Instant::now());
                break;
            }
        }
        Ok(())
    }

    async fn expire_stale_at(&self, now: Instant) -> Result<(), TunnelError> {
        let stale_tunnel_ids = {
            let state = self.state.lock().map_err(|_| TunnelError::Internal)?;
            state
                .tunnels
                .iter()
                .filter(|(_, entry)| {
                    !entry.closing && now.saturating_duration_since(entry.last_seen) >= TUNNEL_LEASE
                })
                .map(|(tunnel_id, _)| tunnel_id.clone())
                .collect::<Vec<_>>()
        };

        for tunnel_id in stale_tunnel_ids {
            let _operation = self.operation_lock.lock().await;
            let should_remove = {
                let mut state = self.state.lock().map_err(|_| TunnelError::Internal)?;
                match state.tunnels.get_mut(&tunnel_id) {
                    Some(entry)
                        if !entry.closing
                            && now.saturating_duration_since(entry.last_seen) >= TUNNEL_LEASE =>
                    {
                        entry.closing = true;
                        true
                    }
                    Some(_) | None => false,
                }
            };
            if should_remove {
                if self.server.remove_service(tunnel_id.clone()).await.is_ok() {
                    self.release_tunnel(&tunnel_id)?;
                } else {
                    self.set_closing(&tunnel_id, false)?;
                }
            }
        }
        self.prune_request_tombstones(now)?;
        Ok(())
    }

    fn prune_request_tombstones(&self, now: Instant) -> Result<(), TunnelError> {
        let mut state = self.state.lock().map_err(|_| TunnelError::Internal)?;
        state.request_ids.retain(|_, record| {
            record.closed_at.is_none_or(|closed_at| {
                now.saturating_duration_since(closed_at) < REQUEST_TOMBSTONE_TTL
            })
        });
        Ok(())
    }

    fn consume_events(
        registry: std::sync::Weak<Self>,
        mut event_rx: mpsc::Receiver<TunnelRuntimeEvent>,
    ) {
        tokio::spawn(async move {
            while let Some(event) = event_rx.recv().await {
                let Some(registry) = registry.upgrade() else {
                    break;
                };
                registry.apply_event(event);
            }
        });
    }

    fn sweep_expired(registry: std::sync::Weak<Self>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(SWEEP_INTERVAL);
            loop {
                interval.tick().await;
                let Some(registry) = registry.upgrade() else {
                    break;
                };
                if registry.expire_stale_at(Instant::now()).await.is_err() {
                    eprintln!("隧道过期清理失败，将在下一轮重试");
                }
            }
        });
    }

    fn apply_event(&self, event: TunnelRuntimeEvent) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        match event {
            TunnelRuntimeEvent::ServerServiceListening {
                service_id,
                bind_addr,
            } => {
                if let Some(entry) = state.tunnels.get_mut(&service_id) {
                    entry.status = TunnelStatus::Listening;
                    entry.error = None;
                    eprintln!("隧道公网监听已就绪 service={service_id} bind={bind_addr}");
                }
            }
            TunnelRuntimeEvent::ServerServiceFailed { service_id, error } => {
                if let Some(entry) = state.tunnels.get_mut(&service_id) {
                    entry.status = TunnelStatus::Failed;
                    entry.error = Some("公网端口监听失败".to_string());
                    eprintln!("隧道公网监听失败 service={service_id} error={error}");
                }
            }
            TunnelRuntimeEvent::Stopped => {
                for entry in state.tunnels.values_mut() {
                    entry.status = TunnelStatus::Failed;
                    entry.error = Some("隧道中继服务已停止".to_string());
                }
            }
            TunnelRuntimeEvent::ClientControlConnected { .. }
            | TunnelRuntimeEvent::ClientControlDisconnected { .. } => {}
        }
    }
}

fn validate_public_port(port: u16) -> Result<(), TunnelError> {
    if port == 0 {
        Err(TunnelError::InvalidPort)
    } else {
        Ok(())
    }
}

fn normalize_device_id(device_id: &str) -> Result<String, TunnelError> {
    if device_id.len() == 32
        && device_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(device_id.to_owned())
    } else {
        Err(TunnelError::InvalidRequest)
    }
}

fn normalize_request_id(request_id: &str) -> Result<String, TunnelError> {
    let request_id = request_id.trim();
    if request_id.is_empty() || request_id.len() > 128 {
        Err(TunnelError::InvalidRequest)
    } else {
        Ok(request_id.to_owned())
    }
}

fn format_public_addr(host: &str, public_port: u16) -> String {
    if host.parse::<Ipv6Addr>().is_ok() {
        format!("[{host}]:{public_port}")
    } else {
        format!("{host}:{public_port}")
    }
}

impl From<RuntimeTunnelError> for TunnelError {
    fn from(_: RuntimeTunnelError) -> Self {
        Self::Internal
    }
}

#[cfg(test)]
mod tests {
    use super::{TunnelError, format_public_addr, normalize_device_id, validate_public_port};

    #[test]
    fn accepts_every_nonzero_protocol_port() {
        assert!(validate_public_port(1).is_ok());
        assert!(validate_public_port(u16::MAX).is_ok());
        assert_eq!(validate_public_port(0), Err(TunnelError::InvalidPort));
    }

    #[test]
    fn preserves_device_identity_and_ipv6_addresses() {
        assert!(normalize_device_id("aabbccddeeff00112233445566778899").is_ok());
        assert!(normalize_device_id("debug-aabbccddeeff00112233445566778899").is_err());
        assert_eq!(
            format_public_addr("2001:db8::1", 65535),
            "[2001:db8::1]:65535"
        );
    }
}
