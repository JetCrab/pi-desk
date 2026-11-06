use std::{
    net::SocketAddr,
    sync::{Arc, Mutex},
};

use iroh::endpoint::{Connection, RecvStream, SendStream};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::OwnedSemaphorePermit,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
use tracing::{debug, warn};

use super::{
    ALPN, HANDSHAKE_TIMEOUT, RuntimeResult, Service, Shared, selected_path, validate_target,
    wire::{self, Header, Operation, Reply},
};
use crate::runtime::{TunnelPath, TunnelTarget};

pub(crate) struct ForwarderRuntime {
    local_addr: SocketAddr,
    mapping: Arc<Mapping>,
}

struct Mapping {
    target: Mutex<TunnelTarget>,
    connection: Mutex<Option<Connection>>,
    cancel: CancellationToken,
    tasks: TaskTracker,
}

impl Drop for ForwarderRuntime {
    fn drop(&mut self) {
        self.mapping.cancel.cancel();
    }
}

impl ForwarderRuntime {
    pub(crate) fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    pub(crate) fn set_target(&self, target: TunnelTarget) {
        let mut current = self.mapping.target.lock().expect("映射目标锁");
        if current.provider_id != target.provider_id {
            self.mapping.connection.lock().expect("映射连接锁").take();
        }
        *current = target;
    }

    pub(crate) fn path(&self) -> TunnelPath {
        if self.mapping.cancel.is_cancelled() {
            return TunnelPath::Unknown;
        }
        self.mapping
            .connection
            .lock()
            .expect("映射连接锁")
            .as_ref()
            .map_or(TunnelPath::Unknown, selected_path)
    }

    pub(crate) async fn shutdown(self) -> RuntimeResult<()> {
        self.mapping.cancel.cancel();
        self.mapping.tasks.close();
        self.mapping.tasks.wait().await;
        self.mapping.connection.lock().expect("映射连接锁").take();
        Ok(())
    }
}

pub(super) async fn start_forwarder(
    shared: Arc<Shared>,
    bind_addr: SocketAddr,
    target: TunnelTarget,
) -> RuntimeResult<ForwarderRuntime> {
    let slot = shared
        .forwarder_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| "本地映射数量已达上限")?;
    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|error| format!("无法监听TCP端口：{error}"))?;
    let local_addr = listener.local_addr().map_err(|_| "无法读取TCP监听地址")?;
    let mapping = Arc::new(Mapping {
        target: Mutex::new(target),
        connection: Mutex::new(None),
        cancel: shared.cancel.child_token(),
        tasks: TaskTracker::new(),
    });
    let listener_mapping = mapping.clone();
    let listener_shared = shared.clone();
    let tracked = mapping.tasks.token();
    shared.tasks.spawn(async move {
        let _slot = slot;
        let _tracked = tracked;
        accept_tcp(listener_shared, listener_mapping, listener).await;
    });
    Ok(ForwarderRuntime {
        local_addr,
        mapping,
    })
}

async fn accept_tcp(shared: Arc<Shared>, mapping: Arc<Mapping>, listener: TcpListener) {
    loop {
        let accepted = tokio::select! {
            biased;
            _ = mapping.cancel.cancelled() => break,
            accepted = listener.accept() => accepted,
        };
        let (tcp, _) = match accepted {
            Ok(accepted) => accepted,
            Err(error) => {
                warn!(%error, "隧道TCP监听失败");
                break;
            }
        };
        let Ok(slot) = shared.stream_slots.clone().try_acquire_owned() else {
            warn!("隧道业务流数量已达上限，拒绝新TCP连接");
            continue;
        };
        // 在accept时捕获登记，不把已经接纳的字节重放给替换后的目标。
        let target = mapping.target.lock().expect("映射目标锁").clone();
        let flow_shared = shared.clone();
        let flow_mapping = mapping.clone();
        let tracked = mapping.tasks.token();
        shared.tasks.spawn(async move {
            let _slot = slot;
            let _tracked = tracked;
            let result = tokio::select! {
                biased;
                _ = flow_mapping.cancel.cancelled() => Ok(()),
                result = forward_tcp(&flow_shared, &flow_mapping, tcp, target) => result,
            };
            if let Err(error) = result {
                debug!(%error, "隧道出站TCP流结束");
            }
        });
    }
    mapping.cancel.cancel();
    mapping.connection.lock().expect("映射连接锁").take();
}

async fn forward_tcp(
    shared: &Arc<Shared>,
    mapping: &Mapping,
    mut tcp: TcpStream,
    target: TunnelTarget,
) -> RuntimeResult<()> {
    validate_target(&target)?;
    let connection = shared.connect(&target).await?;
    {
        let current = mapping.target.lock().expect("映射目标锁");
        let mut cached = mapping.connection.lock().expect("映射连接锁");
        if !mapping.cancel.is_cancelled() && current.provider_id == target.provider_id {
            *cached = Some(connection.clone());
        }
    }
    let (send, recv) = request(&connection, &target, Operation::Forward).await?;
    let mut stream = tokio::io::join(recv, send);
    tokio::io::copy_bidirectional(&mut tcp, &mut stream)
        .await
        .map_err(|_| "TCP转发流中断")?;
    Ok(())
}

pub(super) async fn request(
    connection: &Connection,
    target: &TunnelTarget,
    op: Operation,
) -> RuntimeResult<(SendStream, RecvStream)> {
    tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
        let (mut send, mut recv) = connection
            .open_bi()
            .await
            .map_err(|_| "无法打开隧道双向流")?;
        let probe = matches!(op, Operation::Probe);
        wire::write_frame(
            &mut send,
            &Header {
                op,
                tunnel_id: target.tunnel_id.clone(),
                service_token: target.service_token.clone(),
            },
        )
        .await?;
        if probe {
            send.finish().map_err(|_| "无法结束隧道探测请求")?;
        }
        wire::read_frame::<_, Reply>(&mut recv).await?.result()?;
        Ok((send, recv))
    })
    .await
    .map_err(|_| "隧道流握手超时")?
}

pub(super) async fn accept_connections(shared: Arc<Shared>) {
    let Ok(endpoint) = shared.endpoint() else {
        return;
    };
    loop {
        let slot = tokio::select! {
            biased;
            _ = shared.cancel.cancelled() => break,
            slot = shared.connection_slots.clone().acquire_owned() => match slot { Ok(slot) => slot, Err(_) => break },
        };
        let incoming = tokio::select! {
            biased;
            _ = shared.cancel.cancelled() => break,
            incoming = endpoint.accept() => match incoming { Some(incoming) => incoming, None => break },
        };
        let accepted_shared = shared.clone();
        shared.tasks.spawn(async move {
            tokio::select! {
                biased;
                _ = accepted_shared.cancel.cancelled() => {},
                result = tokio::time::timeout(HANDSHAKE_TIMEOUT, incoming) => {
                    match result {
                        Ok(Ok(connection)) if connection.alpn() == ALPN => connection_loop(accepted_shared.clone(), connection, slot).await,
                        _ => debug!("隧道入站握手未完成或ALPN不匹配"),
                    }
                }
            }
        });
    }
    shared.cancel.cancel();
    endpoint.close().await;
    shared.endpoint.lock().expect("端点锁").take();
}

pub(super) async fn connection_loop(
    shared: Arc<Shared>,
    connection: Connection,
    _slot: OwnedSemaphorePermit,
) {
    tokio::select! {
        biased;
        _ = shared.cancel.cancelled() => {},
        _ = connection.closed() => {},
        _ = shared.observe_connection(&connection) => {},
        _ = accept_streams(&shared, &connection) => {},
    }
    connection.close(0u32.into(), b"tunnel connection stopped");
    let mut outgoing = shared.outgoing.lock().await;
    let id = connection.remote_id();
    if outgoing
        .get(&id)
        .is_some_and(|cached| cached.stable_id() == connection.stable_id())
    {
        outgoing.remove(&id);
    }
}

async fn accept_streams(shared: &Arc<Shared>, connection: &Connection) {
    loop {
        let Ok(slot) = shared.stream_slots.clone().acquire_owned().await else {
            break;
        };
        let Ok((send, recv)) = connection.accept_bi().await else {
            break;
        };
        let stream_shared = shared.clone();
        let connection = connection.clone();
        shared.tasks.spawn(async move {
            let _slot = slot;
            let result = tokio::select! {
                biased;
                _ = stream_shared.cancel.cancelled() => Ok(()),
                result = receive_stream(&stream_shared, &connection, send, recv) => result,
            };
            if let Err(error) = result {
                debug!(peer_id = %connection.remote_id(), %error, "隧道入站流结束");
            }
        });
    }
}

async fn receive_stream(
    shared: &Arc<Shared>,
    connection: &Connection,
    mut send: SendStream,
    mut recv: RecvStream,
) -> RuntimeResult<()> {
    let header =
        tokio::time::timeout(HANDSHAKE_TIMEOUT, wire::read_frame::<_, Header>(&mut recv)).await;
    let header = match header {
        Ok(Ok(header)) => header,
        _ => {
            let _ = wire::write_frame(&mut send, &Reply::InvalidRequest).await;
            let _ = send.finish();
            return Err("隧道控制头无效或握手超时".to_owned());
        }
    };
    let service = {
        let services = shared.services.lock().expect("端口登记锁");
        services
            .get(&header.tunnel_id)
            .filter(|service| {
                service.config.service_token == header.service_token
                    && !service.cancel.is_cancelled()
            })
            .map(|service| (service.clone(), service.tasks.token()))
    };
    let Some((service, _tracked)) = service else {
        wire::write_frame(&mut send, &Reply::Unauthorized).await?;
        send.finish().map_err(|_| "无法结束授权拒绝响应")?;
        return Err("隧道登记不存在或授权已失效".to_owned());
    };
    tokio::select! {
        biased;
        _ = service.cancel.cancelled() => Ok(()),
        result = serve_registered(shared, connection, &service, header.op, send, recv) => result,
    }
}

async fn serve_registered(
    shared: &Arc<Shared>,
    connection: &Connection,
    service: &Service,
    op: Operation,
    mut send: SendStream,
    recv: RecvStream,
) -> RuntimeResult<()> {
    if matches!(op, Operation::Probe) {
        wire::write_frame(&mut send, &Reply::Ready).await?;
        send.finish().map_err(|_| "无法结束隧道探测响应")?;
        return Ok(());
    }
    let tcp = tokio::time::timeout(
        HANDSHAKE_TIMEOUT,
        TcpStream::connect(service.config.local_addr),
    )
    .await;
    let mut tcp = match tcp {
        Ok(Ok(tcp)) => tcp,
        _ => {
            wire::write_frame(&mut send, &Reply::Unavailable).await?;
            send.finish().map_err(|_| "无法结束本地连接失败响应")?;
            return Err("提供端本地TCP服务不可用".to_owned());
        }
    };
    let _count = shared.count(connection, recv.id().into(), service);
    wire::write_frame(&mut send, &Reply::Ready).await?;
    let mut stream = tokio::io::join(recv, send);
    tokio::io::copy_bidirectional(&mut tcp, &mut stream)
        .await
        .map_err(|_| "入站TCP转发流中断")?;
    Ok(())
}
