// Derived from rathole (Apache-2.0), reduced to direct TCP for Pi Desk.
use super::super::config::TcpConfig;
use super::{AddrMaybeCached, SocketOpts, Transport};
use anyhow::Result;
use async_trait::async_trait;
use std::net::SocketAddr;
use tokio::net::{TcpListener, TcpStream, ToSocketAddrs};

#[derive(Debug)]
pub struct TcpTransport {
    socket_opts: SocketOpts,
}

#[async_trait]
impl Transport for TcpTransport {
    type Acceptor = TcpListener;
    type Stream = TcpStream;
    type RawStream = TcpStream;

    fn new(
        config: &TcpConfig,
        _noise_private_key: Option<&str>,
        _noise_public_key: Option<&str>,
    ) -> Result<Self> {
        Ok(Self {
            socket_opts: SocketOpts::from_cfg(config),
        })
    }

    fn hint(conn: &Self::Stream, options: SocketOpts) {
        options.apply(conn);
    }

    async fn bind<T: ToSocketAddrs + Send + Sync>(&self, address: T) -> Result<Self::Acceptor> {
        Ok(TcpListener::bind(address).await?)
    }

    async fn accept(&self, acceptor: &Self::Acceptor) -> Result<(Self::RawStream, SocketAddr)> {
        let (stream, address) = acceptor.accept().await?;
        self.socket_opts.apply(&stream);
        Ok((stream, address))
    }

    async fn handshake(&self, stream: Self::RawStream) -> Result<Self::Stream> {
        Ok(stream)
    }

    async fn connect(&self, address: &AddrMaybeCached) -> Result<Self::Stream> {
        let stream = match address.socket_addr {
            Some(address) => TcpStream::connect(address).await?,
            None => TcpStream::connect(&address.addr).await?,
        };
        self.socket_opts.apply(&stream);
        Ok(stream)
    }
}
