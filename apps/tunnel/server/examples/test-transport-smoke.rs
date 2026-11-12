use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use iroh_relay::server::{Access, AccessControl, ClientRequest, RelayConfig, Server, ServerConfig};
use pi_desk_tunnel_common::protocol::{
    CryptoContext, TunnelRelayConfig, parse_key_hex, random_hex,
};
use pi_desk_tunnel_common::runtime::{
    TunnelEndpointConfig, TunnelMode, TunnelPath, TunnelSource, start_endpoint,
};
use pi_desk_tunnel_common::worker::{
    TunnelForwardConfig, TunnelPhase, TunnelPublicationConfig, TunnelWorkerConfig,
    TunnelWorkerHandle, start_tunnel_worker,
};
use pi_desk_tunnel_server::api::{AppState, router};
use pi_desk_tunnel_server::tunnel::{TunnelRegistry, TunnelRegistryConfig};

const DEADLINE: Duration = Duration::from_secs(30);

fn main() -> Result<(), String> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let (local, config) = match arguments.as_slice() {
        [] => {
            let control_server_url = std::env::var("PI_DESK_TUNNEL_CONTROL_URL")
                .map_err(|_| "缺少验收控制地址".to_string())?;
            let control_key = parse_key_hex(
                &std::env::var("PI_DESK_TUNNEL_SERVER_KEY")
                    .map_err(|_| "缺少验收控制密钥".to_string())?,
            )
            .map_err(|error| error.to_string())?;
            (
                None,
                TunnelWorkerConfig {
                    control_server_url,
                    control_key,
                    provider_secret_key: None,
                    mode: TunnelMode::Auto,
                    discovery_scope: None,
                },
            )
        }
        [argument] if argument == "--local" => {
            eprintln!(
                "验收模式：隔离原生网关，不代表容器；使用本次内存密钥与shared-token HTTP relay。"
            );
            let (gateway, config) = LocalGateway::start()?;
            (Some(gateway), config)
        }
        _ => return Err("用法：test-transport-smoke [--local]".to_owned()),
    };
    let local_mode = local.is_some();
    let echo = Echo::start()?;
    let public_port = unused_port()?;
    let local_port = unused_port()?;
    let provider = start_tunnel_worker(config.clone())?;
    let visitor = match start_tunnel_worker(config) {
        Ok(visitor) => visitor,
        Err(error) => {
            let _ = provider.shutdown();
            return Err(error);
        }
    };
    let result = verify(&provider, &visitor, echo.address, public_port, local_port);
    let visitor_cleanup = visitor.shutdown();
    let provider_cleanup = provider.shutdown();
    let echo_port = echo.address.port();
    let echo_cleanup = echo.shutdown();
    let gateway_cleanup = match local {
        Some(gateway) => gateway.shutdown(),
        None => Ok(()),
    };
    for (owner, cleanup) in [
        ("访问端Worker", &visitor_cleanup),
        ("提供端Worker", &provider_cleanup),
        ("echo", &echo_cleanup),
        ("隔离网关", &gateway_cleanup),
    ] {
        if let Err(error) = cleanup {
            eprintln!("{owner}回收失败：{error}");
        }
    }
    result?;
    visitor_cleanup?;
    provider_cleanup?;
    echo_cleanup?;
    gateway_cleanup?;
    for port in [public_port, local_port, echo_port] {
        wait_until("监听端口释放", || {
            Ok(TcpListener::bind(("127.0.0.1", port)).is_ok())
        })?;
    }
    if local_mode {
        println!(
            "隔离原生网关验收通过（不代表容器）：公网入口、本地映射、强制中继、TCP计数和资源释放。"
        );
    } else {
        println!("网关制品验收通过：公网入口、本地映射、强制中继、TCP计数和资源释放。");
    }
    Ok(())
}

fn verify(
    provider: &TunnelWorkerHandle,
    visitor: &TunnelWorkerHandle,
    echo: SocketAddr,
    public_port: u16,
    local_port: u16,
) -> Result<(), String> {
    provider.publish(TunnelPublicationConfig {
        local_addr: echo,
        public_port: Some(public_port),
    })?;
    wait_until("公网就绪", || {
        let snapshot = provider.snapshot();
        let Some(publication) = snapshot.publications.first() else {
            return Ok(false);
        };
        if publication.phase == TunnelPhase::Failed {
            return Err(publication.detail.clone());
        }
        Ok(publication.phase == TunnelPhase::Listening)
    })?;
    let public = transfer(public_port)?;
    wait_until("公网连接计数", || {
        Ok(provider.snapshot().connections.iter().any(|row| {
            row.source == TunnelSource::Public
                && row.local_port == echo.port()
                && row.active_tcp == 1
        }))
    })?;
    println!("公网入口：TCP字节一致，Public活动TCP=1。");
    drop(public);
    let provider_id = provider
        .snapshot()
        .provider_id
        .ok_or_else(|| "提供端未报告公钥".to_string())?;
    visitor.forward(TunnelForwardConfig {
        provider_id,
        remote_port: echo.port(),
        local_port,
    })?;
    wait_for_mapping(visitor)?;
    let direct_or_relay = transfer(local_port)?;
    wait_until("原生连接计数与路径", || {
        let provider_ready = provider.snapshot().connections.iter().any(|row| {
            row.source == TunnelSource::Client
                && row.local_port == echo.port()
                && row.active_tcp == 1
                && row.path != TunnelPath::Unknown
        });
        let visitor_ready = visitor.snapshot().forwards.first().is_some_and(|mapping| {
            mapping.phase == TunnelPhase::Listening && mapping.path != TunnelPath::Unknown
        });
        Ok(provider_ready && visitor_ready)
    })?;
    println!(
        "自动模式实际路径：{:?}",
        visitor.snapshot().forwards[0].path
    );
    println!("原生入口：TCP字节一致，Client活动TCP=1。");
    drop(direct_or_relay);
    visitor.set_mode(TunnelMode::RelayOnly)?;
    wait_until("访问策略生效", || {
        Ok(visitor.snapshot().mode == TunnelMode::RelayOnly)
    })?;
    wait_for_mapping(visitor)?;
    let relayed = transfer(local_port)?;
    wait_until("强制中继实际路径", || {
        Ok(visitor.snapshot().forwards.first().is_some_and(|mapping| {
            mapping.phase == TunnelPhase::Listening && mapping.path == TunnelPath::Relay
        }))
    })?;
    wait_until("提供端中继统计", || {
        Ok(provider.snapshot().connections.iter().any(|row| {
            row.source == TunnelSource::Client
                && row.path == TunnelPath::Relay
                && row.active_tcp == 1
        }))
    })?;
    println!("强制中继：实际路径=Relay，Client活动TCP=1。");
    drop(relayed);
    wait_until("活动TCP归零", || {
        Ok(provider.snapshot().connections.is_empty())
    })?;
    println!("连接清理：活动TCP=0。");
    Ok(())
}

fn wait_for_mapping(visitor: &TunnelWorkerHandle) -> Result<(), String> {
    wait_until("本地映射就绪", || {
        let snapshot = visitor.snapshot();
        let Some(mapping) = snapshot.forwards.first() else {
            return Ok(false);
        };
        if mapping.phase == TunnelPhase::Failed {
            return Err(mapping.detail.clone());
        }
        Ok(mapping.phase == TunnelPhase::Listening)
    })
}

fn transfer(port: u16) -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect_timeout(
        &SocketAddr::from(([127, 0, 0, 1], port)),
        Duration::from_secs(5),
    )
    .map_err(|error| format!("连接验收端口失败：{error}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(10)))
        .map_err(|error| error.to_string())?;
    let payload = b"GET /tunnel-smoke HTTP/1.1\r\nHost: fixture.local\r\n\r\n\0\xff";
    stream
        .write_all(payload)
        .map_err(|error| error.to_string())?;
    let mut response = vec![0; payload.len()];
    stream
        .read_exact(&mut response)
        .map_err(|error| error.to_string())?;
    if response != payload {
        return Err("隧道转发字节不一致".to_string());
    }
    Ok(stream)
}

fn wait_until(
    label: &str,
    mut condition: impl FnMut() -> Result<bool, String>,
) -> Result<(), String> {
    let deadline = Instant::now() + DEADLINE;
    loop {
        if condition()? {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!("等待{label}超时"));
        }
        thread::sleep(Duration::from_millis(25));
    }
}

fn unused_port() -> Result<u16, String> {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|error| error.to_string())
}

struct LocalGateway {
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    task: Option<thread::JoinHandle<Result<(), String>>>,
}

impl LocalGateway {
    fn start() -> Result<(Self, TunnelWorkerConfig), String> {
        let (ready, started) = std::sync::mpsc::sync_channel(1);
        let (stop, stopped) = tokio::sync::oneshot::channel();
        let task = thread::Builder::new()
            .name("tunnel-smoke-gateway".to_owned())
            .spawn(move || {
                let result = (|| {
                    let runtime = tokio::runtime::Builder::new_multi_thread()
                        .worker_threads(2)
                        .enable_all()
                        .build()
                        .map_err(|error| error.to_string())?;
                    runtime.block_on(run_local_gateway(&ready, stopped))
                })();
                if let Err(error) = &result {
                    let _ = ready.send(Err(error.clone()));
                }
                result
            })
            .map_err(|error| error.to_string())?;
        let gateway = Self {
            stop: Some(stop),
            task: Some(task),
        };
        match started
            .recv()
            .map_err(|_| "隔离网关启动线程未返回结果".to_owned())
            .and_then(|result| result)
        {
            Ok(config) => Ok((gateway, config)),
            Err(error) => {
                if let Err(cleanup) = gateway.shutdown()
                    && cleanup != error
                {
                    eprintln!("隔离网关启动回收失败：{cleanup}");
                }
                Err(error)
            }
        }
    }

    fn shutdown(mut self) -> Result<(), String> {
        self.finish()
    }

    fn finish(&mut self) -> Result<(), String> {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        match self.task.take() {
            Some(task) => task.join().map_err(|_| "隔离网关线程异常".to_owned())?,
            None => Ok(()),
        }
    }
}

impl Drop for LocalGateway {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("隔离网关回收失败：{error}");
        }
    }
}

struct LocalRelayAccess(String);

impl std::fmt::Debug for LocalRelayAccess {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("LocalRelayAccess")
            .finish_non_exhaustive()
    }
}

impl AccessControl for LocalRelayAccess {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        if request.auth_token().as_deref() == Some(self.0.as_str()) {
            Access::Allow
        } else {
            Access::Deny {
                reason: Some("local smoke relay denied".to_owned()),
            }
        }
    }
}

async fn run_local_gateway(
    ready: &std::sync::mpsc::SyncSender<Result<TunnelWorkerConfig, String>>,
    stopped: tokio::sync::oneshot::Receiver<()>,
) -> Result<(), String> {
    let mut control_key = [0; 32];
    getrandom::fill(&mut control_key).map_err(|error| error.to_string())?;
    let relay_token = random_hex::<32>().map_err(|error| error.to_string())?;
    let mut relay_config = RelayConfig::new(([127, 0, 0, 1], 0));
    relay_config.access = Arc::new(LocalRelayAccess(relay_token.clone()));
    let mut server_config = ServerConfig::default();
    server_config.relay = Some(relay_config);
    let relay = Server::spawn(server_config)
        .await
        .map_err(|error| error.to_string())?;
    let relay_addr = relay.http_addr().expect("已配置HTTP relay监听");
    let mut control_addr = None;
    let result = async {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        control_addr = Some(address);
        let relay_config = TunnelRelayConfig {
            url: format!("http://{relay_addr}"),
            auth_token: relay_token,
            quic_port: 7842,
        };
        let endpoint = start_endpoint(TunnelEndpointConfig {
            secret_key: None,
            relay: relay_config.clone(),
            mode: TunnelMode::Auto,
        })
        .await?;
        let tunnels = TunnelRegistry::new(
            endpoint,
            TunnelRegistryConfig {
                relay: relay_config,
            },
        );
        let app = router(AppState {
            crypto: Arc::new(CryptoContext::new(control_key)),
            tunnels: tunnels.clone(),
        });
        let config = TunnelWorkerConfig {
            control_server_url: format!("http://{address}"),
            control_key,
            provider_secret_key: None,
            mode: TunnelMode::Auto,
            discovery_scope: None,
        };
        let served = match ready.send(Ok(config)) {
            Ok(()) => axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .map_err(|error| error.to_string()),
            Err(_) => Err("隔离网关启动通知接收端已关闭".to_owned()),
        };
        tunnels.shutdown().await;
        served
    }
    .await;
    let relay_cleanup = relay.shutdown().await.map_err(|error| error.to_string());
    let ports_cleanup = [Some(relay_addr), control_addr]
        .into_iter()
        .flatten()
        .try_for_each(|address| {
            TcpListener::bind(address)
                .map(|_| ())
                .map_err(|error| format!("隔离网关监听未释放：{error}"))
        });
    for (owner, cleanup) in [("relay", &relay_cleanup), ("监听端口", &ports_cleanup)] {
        if let Err(error) = cleanup {
            eprintln!("隔离{owner}回收失败：{error}");
        }
    }
    result?;
    relay_cleanup?;
    ports_cleanup?;
    println!("隔离网关资源释放：relay和控制监听已关闭，端口可重绑。");
    Ok(())
}

struct Echo {
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    task: Option<thread::JoinHandle<Result<(), String>>>,
}

impl Echo {
    fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").map_err(|error| error.to_string())?;
        let address = listener.local_addr().map_err(|error| error.to_string())?;
        listener
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let task_stop = stop.clone();
        let task = thread::spawn(move || {
            let mut streams = Vec::new();
            let mut result = Ok(());
            while !task_stop.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let stop = task_stop.clone();
                        streams.push(thread::spawn(move || -> Result<(), String> {
                            // Windows accepted socket 可能继承 listener 的非阻塞模式。
                            stream
                                .set_nonblocking(false)
                                .map_err(|error| error.to_string())?;
                            stream
                                .set_read_timeout(Some(Duration::from_millis(100)))
                                .map_err(|error| error.to_string())?;
                            stream
                                .set_write_timeout(Some(Duration::from_secs(5)))
                                .map_err(|error| error.to_string())?;
                            let mut buffer = [0_u8; 8192];
                            while !stop.load(Ordering::Acquire) {
                                match stream.read(&mut buffer) {
                                    Ok(0) => break,
                                    Ok(length) => {
                                        if stream.write_all(&buffer[..length]).is_err() {
                                            break;
                                        }
                                    }
                                    Err(error)
                                        if matches!(
                                            error.kind(),
                                            std::io::ErrorKind::WouldBlock
                                                | std::io::ErrorKind::TimedOut
                                        ) => {}
                                    Err(_) => break,
                                }
                            }
                            Ok(())
                        }));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(10));
                    }
                    Err(error) => {
                        result = Err(format!("验收echo接纳连接失败：{error}"));
                        break;
                    }
                }
            }
            for task in streams {
                let cleanup = task
                    .join()
                    .map_err(|_| "验收回显连接线程异常".to_owned())
                    .and_then(|result| result);
                if let Err(error) = cleanup {
                    eprintln!("echo连接回收失败：{error}");
                    if result.is_ok() {
                        result = Err(error);
                    }
                }
            }
            result
        });
        Ok(Self {
            address,
            stop,
            task: Some(task),
        })
    }

    fn shutdown(mut self) -> Result<(), String> {
        self.finish()
    }

    fn finish(&mut self) -> Result<(), String> {
        self.stop.store(true, Ordering::Release);
        match self.task.take() {
            Some(task) => task.join().map_err(|_| "验收回显线程异常".to_string())?,
            None => Ok(()),
        }
    }
}

impl Drop for Echo {
    fn drop(&mut self) {
        if let Err(error) = self.finish() {
            eprintln!("echo回收失败：{error}");
        }
    }
}
