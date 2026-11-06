use std::net::SocketAddr;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::iroh_runtime::{EndpointRuntime, ForwarderRuntime};
use crate::protocol::TunnelRelayConfig;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TunnelMode {
    #[default]
    Auto,
    RelayOnly,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelPath {
    #[default]
    Unknown,
    Direct,
    Relay,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TunnelSource {
    Public,
    Client,
}

#[derive(Clone)]
pub struct TunnelEndpointConfig {
    pub secret_key: Option<[u8; 32]>,
    pub relay: TunnelRelayConfig,
    pub mode: TunnelMode,
}

#[derive(Clone)]
pub struct TunnelServiceConfig {
    pub tunnel_id: String,
    pub service_token: String,
    pub local_addr: SocketAddr,
    pub gateway_id: String,
}

#[derive(Clone)]
pub struct TunnelTarget {
    pub provider_id: String,
    pub tunnel_id: String,
    pub service_token: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelConnectionRow {
    pub peer_id: String,
    pub local_port: u16,
    pub source: TunnelSource,
    pub path: TunnelPath,
    pub active_tcp: u32,
}

#[derive(Clone)]
pub struct TunnelEndpoint {
    pub(crate) runtime: Arc<EndpointRuntime>,
}

pub struct TunnelForwarder {
    pub(crate) runtime: ForwarderRuntime,
}

pub async fn start_endpoint(config: TunnelEndpointConfig) -> Result<TunnelEndpoint, String> {
    Ok(TunnelEndpoint {
        runtime: EndpointRuntime::start(config).await?,
    })
}

pub fn generate_secret_key() -> Result<String, String> {
    let mut key = [0_u8; 32];
    getrandom::fill(&mut key).map_err(|_| "无法生成隧道私钥".to_owned())?;
    Ok(hex::encode(key))
}

pub fn provider_id(secret_key: &str) -> Result<String, String> {
    if secret_key.len() != 64 {
        return Err("隧道私钥必须是64位十六进制值".to_owned());
    }
    let mut key = [0_u8; 32];
    hex::decode_to_slice(secret_key, &mut key)
        .map_err(|_| "隧道私钥必须是64位十六进制值".to_owned())?;
    Ok(iroh::SecretKey::from_bytes(&key).public().to_string())
}

impl TunnelEndpoint {
    pub fn id(&self) -> String {
        self.runtime.id()
    }

    pub async fn register_service(&self, config: TunnelServiceConfig) -> Result<(), String> {
        self.runtime.register_service(config).await
    }

    pub async fn remove_service(&self, tunnel_id: &str) -> Result<(), String> {
        self.runtime.remove_service(tunnel_id).await
    }

    pub async fn probe(&self, target: &TunnelTarget) -> Result<(), String> {
        self.runtime.probe(target).await
    }

    pub async fn forward(
        &self,
        bind_addr: SocketAddr,
        target: TunnelTarget,
    ) -> Result<TunnelForwarder, String> {
        Ok(TunnelForwarder {
            runtime: self.runtime.forward(bind_addr, target).await?,
        })
    }

    pub fn connections(&self) -> Vec<TunnelConnectionRow> {
        self.runtime.connections()
    }

    /// 关闭同一实例的全部克隆；调用返回后其他克隆不能重新启用它。
    pub async fn shutdown(self) -> Result<(), String> {
        self.runtime.shutdown().await
    }
}

impl TunnelForwarder {
    pub fn local_addr(&self) -> SocketAddr {
        self.runtime.local_addr()
    }

    pub fn set_target(&self, target: TunnelTarget) {
        self.runtime.set_target(target);
    }

    pub fn path(&self) -> TunnelPath {
        self.runtime.path()
    }

    pub async fn shutdown(self) -> Result<(), String> {
        self.runtime.shutdown().await
    }
}
