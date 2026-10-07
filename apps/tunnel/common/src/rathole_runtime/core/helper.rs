// Derived from rathole (Apache-2.0), reduced to TCP listener and relay helpers.
use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use backoff::{Notify, backoff::Backoff};
use socket2::{SockRef, TcpKeepalive};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpStream, ToSocketAddrs, lookup_host};
use tokio::sync::broadcast;

pub fn try_set_tcp_keepalive(
    connection: &TcpStream,
    keepalive_duration: Duration,
    keepalive_interval: Duration,
) -> Result<()> {
    let socket = SockRef::from(connection);
    let keepalive = TcpKeepalive::new()
        .with_time(keepalive_duration)
        .with_interval(keepalive_interval);
    socket.set_tcp_keepalive(&keepalive)?;
    Ok(())
}

pub async fn to_socket_addr<A: ToSocketAddrs>(address: A) -> Result<SocketAddr> {
    lookup_host(address)
        .await?
        .next()
        .ok_or_else(|| anyhow!("无法解析中继地址"))
}

pub async fn retry_notify_with_deadline<I, E, F, Fut, B, N>(
    backoff: B,
    operation: F,
    notify: N,
    deadline: &mut broadcast::Receiver<bool>,
) -> Result<I>
where
    E: std::error::Error + Send + Sync + 'static,
    B: Backoff,
    F: FnMut() -> Fut,
    Fut: Future<Output = std::result::Result<I, backoff::Error<E>>>,
    N: Notify<E>,
{
    tokio::select! {
        result = backoff::future::retry_notify(backoff, operation, notify) => result.map_err(anyhow::Error::new),
        _ = deadline.recv() => Err(anyhow!("shutdown")),
    }
}

pub async fn write_and_flush<T: AsyncWrite + Unpin>(connection: &mut T, data: &[u8]) -> Result<()> {
    connection
        .write_all(data)
        .await
        .context("写入控制命令失败")?;
    connection.flush().await.context("刷新控制命令失败")?;
    Ok(())
}
