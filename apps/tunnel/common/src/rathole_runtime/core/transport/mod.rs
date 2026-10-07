// Derived from rathole (Apache-2.0), reduced to direct TCP plus Noise.
use super::config::{ClientServiceConfig, ServerServiceConfig, TcpConfig};
use super::helper::{to_socket_addr, try_set_tcp_keepalive};
use anyhow::Result;
use async_trait::async_trait;
use std::fmt::{Debug, Display};
use std::net::SocketAddr;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::{TcpStream, ToSocketAddrs};
use tracing::{error, trace};

#[derive(Clone)]
pub struct AddrMaybeCached {
    pub addr: String,
    pub socket_addr: Option<SocketAddr>,
}

impl AddrMaybeCached {
    pub fn new(address: &str) -> Self {
        Self {
            addr: address.to_owned(),
            socket_addr: None,
        }
    }

    pub async fn resolve(&mut self) -> Result<()> {
        self.socket_addr = Some(to_socket_addr(&self.addr).await?);
        Ok(())
    }
}

impl Display for AddrMaybeCached {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.socket_addr {
            Some(address) => Display::fmt(&address, formatter),
            None => formatter.write_str(&self.addr),
        }
    }
}

#[async_trait]
pub trait Transport: Debug + Send + Sync {
    type Acceptor: Send + Sync;
    type RawStream: Send + Sync;
    type Stream: 'static + AsyncRead + AsyncWrite + Unpin + Send + Sync + Debug;

    fn new(
        config: &TcpConfig,
        noise_private_key: Option<&str>,
        noise_public_key: Option<&str>,
    ) -> Result<Self>
    where
        Self: Sized;
    fn hint(connection: &Self::Stream, options: SocketOpts);
    async fn bind<T: ToSocketAddrs + Send + Sync>(&self, address: T) -> Result<Self::Acceptor>;
    async fn accept(&self, acceptor: &Self::Acceptor) -> Result<(Self::RawStream, SocketAddr)>;
    async fn handshake(&self, connection: Self::RawStream) -> Result<Self::Stream>;
    async fn connect(&self, address: &AddrMaybeCached) -> Result<Self::Stream>;
}

mod tcp;
pub use tcp::TcpTransport;
mod noise;
pub use noise::NoiseTransport;

#[derive(Debug, Clone, Copy)]
pub struct SocketOpts {
    nodelay: bool,
    keepalive: Option<(u64, u64)>,
}

impl SocketOpts {
    fn from_cfg(config: &TcpConfig) -> Self {
        Self {
            nodelay: config.nodelay,
            keepalive: Some((config.keepalive_secs, config.keepalive_interval)),
        }
    }

    pub fn for_control_channel() -> Self {
        Self {
            nodelay: true,
            keepalive: None,
        }
    }

    pub fn from_client_cfg(config: &ClientServiceConfig) -> Self {
        Self {
            nodelay: config.nodelay,
            keepalive: None,
        }
    }

    pub fn from_server_cfg(config: &ServerServiceConfig) -> Self {
        Self {
            nodelay: config.nodelay,
            keepalive: None,
        }
    }

    pub fn apply(&self, connection: &TcpStream) {
        if let Some((seconds, interval)) = self.keepalive {
            if let Err(error) = try_set_tcp_keepalive(
                connection,
                Duration::from_secs(seconds),
                Duration::from_secs(interval),
            ) {
                error!(%error, "设置 TCP keepalive 失败");
            }
        }
        if let Err(error) = connection.set_nodelay(self.nodelay) {
            trace!(%error, "设置 TCP nodelay 失败");
        }
    }
}
