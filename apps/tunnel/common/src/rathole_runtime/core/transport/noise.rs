// Derived from rathole (Apache-2.0), reduced to Pi Desk Noise TCP.
use std::net::SocketAddr;

use anyhow::{Context, Result, anyhow};
use async_trait::async_trait;
use snowstorm::{Builder, NoiseParams, NoiseStream};
use tokio::net::{TcpListener, TcpStream, ToSocketAddrs};

use super::{AddrMaybeCached, SocketOpts, TcpTransport, Transport};
use crate::rathole_runtime::core::config::TcpConfig;

const NOISE_PATTERN: &str = "Noise_NK_25519_ChaChaPoly_BLAKE2s";

pub struct NoiseTransport {
    tcp: TcpTransport,
    params: NoiseParams,
    local_private_key: Vec<u8>,
    remote_public_key: Option<Vec<u8>>,
}

impl std::fmt::Debug for NoiseTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("NoiseTransport")
    }
}

impl NoiseTransport {
    fn builder(&self) -> Builder<'_> {
        let builder = Builder::new(self.params.clone()).local_private_key(&self.local_private_key);
        match &self.remote_public_key {
            Some(public_key) => builder.remote_public_key(public_key),
            None => builder,
        }
    }
}

#[async_trait]
impl Transport for NoiseTransport {
    type Acceptor = TcpListener;
    type RawStream = TcpStream;
    type Stream = NoiseStream<TcpStream>;

    fn new(tcp: &TcpConfig, private_key: Option<&str>, public_key: Option<&str>) -> Result<Self> {
        let params: NoiseParams = NOISE_PATTERN.parse()?;
        let builder = Builder::new(params.clone());
        let local_private_key = match private_key {
            Some(key) => base64::decode(key).context("Noise 私钥不是 base64")?,
            None => builder.generate_keypair()?.private,
        };
        let remote_public_key = public_key
            .map(|key| base64::decode(key).context("Noise 公钥不是 base64"))
            .transpose()?;
        if private_key.is_some() && public_key.is_some() {
            return Err(anyhow!("Noise 连接只能配置一侧静态密钥"));
        }
        Ok(Self {
            tcp: TcpTransport::new(tcp, None, None)?,
            params,
            local_private_key,
            remote_public_key,
        })
    }

    fn hint(connection: &Self::Stream, options: SocketOpts) {
        options.apply(connection.get_inner());
    }

    async fn bind<T: ToSocketAddrs + Send + Sync>(&self, address: T) -> Result<Self::Acceptor> {
        Ok(TcpListener::bind(address).await?)
    }

    async fn accept(&self, acceptor: &Self::Acceptor) -> Result<(Self::RawStream, SocketAddr)> {
        self.tcp.accept(acceptor).await
    }

    async fn handshake(&self, connection: Self::RawStream) -> Result<Self::Stream> {
        NoiseStream::handshake(connection, self.builder().build_responder()?)
            .await
            .context("Noise 服务端握手失败")
    }

    async fn connect(&self, address: &AddrMaybeCached) -> Result<Self::Stream> {
        let connection = self.tcp.connect(address).await?;
        NoiseStream::handshake(connection, self.builder().build_initiator()?)
            .await
            .context("Noise 客户端握手失败")
    }
}
