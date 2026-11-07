use super::*;

#[path = "release_tests.rs"]
mod release_tests;
#[path = "worker_lifecycle_tests.rs"]
mod worker_lifecycle_tests;
use iroh_relay::server::{Access, AccessControl, ClientRequest, RelayConfig, Server, ServerConfig};
use pi_desk_tunnel_common::runtime::{
    TunnelEndpointConfig, TunnelMode, TunnelServiceConfig, TunnelSource, start_endpoint,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinSet;
use tokio::time::timeout;

const RELAY_TOKEN: &str = "gateway-test-relay-token";
const TRAILER: &[u8] = b"response-after-fin";

#[derive(Debug)]
struct TokenAccess;

impl AccessControl for TokenAccess {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        if request.auth_token().as_deref() == Some(RELAY_TOKEN) {
            Access::Allow
        } else {
            Access::Deny {
                reason: Some("gateway test denied".to_owned()),
            }
        }
    }
}

struct Fixture {
    registry: Arc<TunnelRegistry>,
    provider: TunnelEndpoint,
    visitor: TunnelEndpoint,
    relay: Server,
    echo_addr: SocketAddr,
    echo_stop: oneshot::Sender<()>,
    echo_task: JoinHandle<()>,
}

impl Fixture {
    async fn start() -> Result<Self, String> {
        let mut relay = RelayConfig::new(([127, 0, 0, 1], 0));
        relay.access = Arc::new(TokenAccess);
        let mut config = ServerConfig::default();
        config.relay = Some(relay);
        let relay = Server::spawn(config).await.map_err(text)?;
        let relay_config = TunnelRelayConfig {
            url: format!("http://{}", relay.http_addr().ok_or("缺少relay监听")?),
            auth_token: RELAY_TOKEN.to_owned(),
            quic_port: 20012,
        };
        // 本地数据链强制经过隔离 relay，不向开发机路由器申请端口映射。
        let gateway = start_endpoint(TunnelEndpointConfig {
            secret_key: None,
            relay: relay_config.clone(),
            mode: TunnelMode::RelayOnly,
        })
        .await?;
        let registry = TunnelRegistry::new(
            gateway,
            TunnelRegistryConfig {
                relay: relay_config.clone(),
            },
        );
        let provider = start_endpoint(TunnelEndpointConfig {
            secret_key: None,
            relay: relay_config.clone(),
            mode: TunnelMode::RelayOnly,
        })
        .await?;
        let visitor = start_endpoint(TunnelEndpointConfig {
            secret_key: None,
            relay: relay_config,
            mode: TunnelMode::RelayOnly,
        })
        .await?;
        let echo = TcpListener::bind("127.0.0.1:0").await.map_err(text)?;
        let echo_addr = echo.local_addr().map_err(text)?;
        let (echo_stop, mut stopped) = oneshot::channel();
        let echo_task = tokio::spawn(async move {
            let mut flows = JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    _ = flows.join_next(), if !flows.is_empty() => {},
                    accepted = echo.accept() => {
                        let Ok((tcp, _)) = accepted else { break };
                        flows.spawn(async move {
                            let (mut reader, mut writer) = tcp.into_split();
                            if tokio::io::copy(&mut reader, &mut writer).await.is_ok() {
                                let _ = writer.write_all(TRAILER).await;
                                let _ = writer.shutdown().await;
                            }
                        });
                    }
                }
            }
            flows.abort_all();
            while flows.join_next().await.is_some() {}
        });
        Ok(Self {
            registry,
            provider,
            visitor,
            relay,
            echo_addr,
            echo_stop,
            echo_task,
        })
    }

    async fn open(&self, id: &str, public_port: Option<u16>) -> Result<OpenTunnelResponse, String> {
        self.registry
            .open(OpenTunnelRequest {
                request_id: id.to_owned(),
                provider_id: self.provider.id(),
                port: self.echo_addr.port(),
                public_port,
            })
            .await
            .map_err(text)
    }

    async fn install(&self, opened: &OpenTunnelResponse) -> Result<(), String> {
        self.provider
            .register_service(TunnelServiceConfig {
                tunnel_id: opened.tunnel_id.clone(),
                service_token: opened.service_token.clone(),
                local_addr: self.echo_addr,
                gateway_id: opened.gateway_id.clone(),
            })
            .await
    }

    async fn ready(&self, id: &str) -> Result<(), String> {
        timeout(Duration::from_secs(15), async {
            let mut poll = tokio::time::interval(Duration::from_millis(20));
            loop {
                let status = self.registry.status(id).await.map_err(text)?;
                match status.status {
                    TunnelStatus::Ready => return Ok(()),
                    TunnelStatus::Failed => {
                        return Err(status.error.unwrap_or_else(|| "网关探测失败".to_owned()));
                    }
                    TunnelStatus::AwaitingProvider => {
                        poll.tick().await;
                    }
                }
            }
        })
        .await
        .map_err(|_| "等待网关就绪超时".to_owned())?
    }

    async fn resolve(&self) -> Result<ResolveTunnelResponse, TunnelError> {
        self.registry
            .resolve(ResolveTunnelRequest {
                provider_id: self.provider.id(),
                port: self.echo_addr.port(),
            })
            .await
    }

    async fn close(self) {
        self.registry.shutdown().await;
        self.visitor.shutdown().await.expect("应关闭原生访问端");
        self.provider.shutdown().await.expect("应关闭提供端");
        let _ = self.echo_stop.send(());
        self.echo_task.await.expect("应结束echo任务");
        std::net::TcpListener::bind(self.echo_addr).expect("echo端口应释放");
        let addr = self.relay.http_addr().expect("relay监听地址");
        self.relay.shutdown().await.expect("应关闭relay");
        std::net::TcpListener::bind(addr).expect("relay端口应释放");
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn check(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.to_owned())
    }
}

async fn unused_port() -> Result<u16, String> {
    Ok(TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(text)?
        .local_addr()
        .map_err(text)?
        .port())
}

async fn live(addr: SocketAddr) -> Result<TcpStream, String> {
    let mut tcp = TcpStream::connect(addr).await.map_err(text)?;
    tcp.write_all(b"ping").await.map_err(text)?;
    let mut reply = [0; 4];
    tcp.read_exact(&mut reply).await.map_err(text)?;
    check(&reply == b"ping", "公网TCP响应不一致")?;
    Ok(tcp)
}

async fn count(provider: &TunnelEndpoint, public: u32, native: u32) -> Result<(), String> {
    timeout(Duration::from_secs(5), async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        loop {
            let rows = provider.connections();
            let public_count = rows
                .iter()
                .filter(|r| r.source == TunnelSource::Public)
                .map(|r| r.active_tcp)
                .sum::<u32>();
            let native_count = rows
                .iter()
                .filter(|r| r.source == TunnelSource::Client)
                .map(|r| r.active_tcp)
                .sum::<u32>();
            if public_count == public && native_count == native {
                return;
            }
            poll.tick().await;
        }
    })
    .await
    .map_err(|_| format!("活动流未收敛 public={public} native={native}"))
}

async fn ended(tcp: &mut TcpStream) -> Result<(), String> {
    let mut byte = [0; 1];
    let result = timeout(Duration::from_secs(5), tcp.read(&mut byte))
        .await
        .map_err(|_| "网关旧TCP未结束".to_owned())?;
    check(!matches!(result, Ok(n) if n > 0), "已撤销网关流仍有数据")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn encrypted_http_open_and_resolve_preserve_custom_relay_quic_port() {
    use crate::api::{AppState, router};
    use pi_desk_tunnel_common::{control::ControlClient, protocol::CryptoContext};

    let fixture = Fixture::start().await.expect("应启动真实网关fixture");
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = router(AppState {
        crypto: Arc::new(CryptoContext::new([7; 32])),
        tunnels: fixture.registry.clone(),
    });
    let (stop, stopped) = oneshot::channel();
    let http = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = stopped.await;
            })
            .await
    });
    let client = ControlClient::new(&format!("http://{addr}"), [7; 32]).unwrap();
    let request = OpenTunnelRequest {
        request_id: "custom-qad-port".to_owned(),
        provider_id: fixture.provider.id(),
        port: fixture.echo_addr.port(),
        public_port: None,
    };
    let result = timeout(Duration::from_secs(25), async {
        let opener = client.clone();
        let opened = tokio::task::spawn_blocking(move || opener.open_tunnel(request))
            .await
            .map_err(text)?
            .map_err(text)?;
        check(opened.relay.quic_port == 20012, "open丢失自定义QAD端口")?;
        check(
            opened.relay.auth_token == RELAY_TOKEN,
            "open改变relay准入token",
        )?;
        fixture.install(&opened).await?;
        fixture.ready(&opened.tunnel_id).await?;
        let provider_id = fixture.provider.id();
        let port = fixture.echo_addr.port();
        let resolved =
            tokio::task::spawn_blocking(move || client.resolve_tunnel(&provider_id, port))
                .await
                .map_err(text)?
                .map_err(text)?;
        check(
            resolved.relay.quic_port == 20012,
            "resolve丢失自定义QAD端口",
        )?;
        check(
            resolved.relay.auth_token == RELAY_TOKEN,
            "resolve改变relay准入token",
        )?;
        check(
            resolved.tunnel_id == opened.tunnel_id,
            "resolve返回错误注册",
        )
    })
    .await;
    let _ = stop.send(());
    http.await.unwrap().expect("应停止测试HTTP服务");
    std::net::TcpListener::bind(addr).expect("控制HTTP监听应释放");
    fixture.close().await;
    result
        .expect("控制序列不应超时")
        .expect("加密open和resolve应保留自定义QAD端口");
}

#[tokio::test]
async fn public_tcp_half_close_resolve_sources_and_close_owned_flows() {
    let fixture = Fixture::start().await.expect("应启动真实网关fixture");
    let result = timeout(Duration::from_secs(35), async {
        let port = unused_port().await?;
        let opened = fixture.open("public", Some(port)).await?;
        check(
            fixture
                .registry
                .status(&opened.tunnel_id)
                .await
                .map_err(text)?
                .status
                == TunnelStatus::AwaitingProvider,
            "提供端未安装时提前ready",
        )?;
        check(
            fixture.resolve().await == Err(TunnelError::NotReady),
            "未就绪注册不应解析",
        )?;
        fixture.install(&opened).await?;
        fixture.ready(&opened.tunnel_id).await?;
        let resolved = fixture.resolve().await.map_err(text)?;
        check(
            resolved.tunnel_id == opened.tunnel_id
                && resolved.service_token == opened.service_token,
            "解析资料不一致",
        )?;
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let tcp = TcpStream::connect(addr).await.map_err(text)?;
        let (mut reader, mut writer) = tcp.into_split();
        let data = (0..4 * 1024 * 1024)
            .map(|n| (n % 256) as u8)
            .collect::<Vec<_>>();
        let (write, read) = tokio::join!(
            async {
                writer.write_all(&data).await.map_err(text)?;
                writer.shutdown().await.map_err(text)
            },
            async {
                let mut response = Vec::new();
                reader.read_to_end(&mut response).await.map_err(text)?;
                check(
                    response.len() == data.len() + TRAILER.len(),
                    "公网半关闭响应长度不同",
                )?;
                check(
                    response[..data.len()] == data && &response[data.len()..] == TRAILER,
                    "公网二进制或FIN后响应丢失",
                )
            }
        );
        write?;
        read?;
        let mut public_a = live(addr).await?;
        let mut public_b = live(addr).await?;
        let native = fixture
            .visitor
            .forward(
                "127.0.0.1:0".parse().map_err(text)?,
                TunnelTarget {
                    provider_id: fixture.provider.id(),
                    tunnel_id: resolved.tunnel_id.clone(),
                    service_token: resolved.service_token,
                },
            )
            .await?;
        let mut native_tcp = live(native.local_addr()).await?;
        count(&fixture.provider, 2, 1).await?;
        check(
            fixture
                .provider
                .connections()
                .iter()
                .filter(|r| r.source == TunnelSource::Public)
                .all(|r| r.peer_id == opened.gateway_id),
            "公网来源不匹配真实gateway身份",
        )?;
        fixture
            .registry
            .close(&opened.tunnel_id)
            .await
            .map_err(text)?;
        ended(&mut public_a).await?;
        ended(&mut public_b).await?;
        count(&fixture.provider, 0, 1).await?;
        std::net::TcpListener::bind(addr).map_err(text)?;
        check(
            fixture.resolve().await == Err(TunnelError::NotFound),
            "关闭后仍可解析",
        )?;
        // 控制网关只回收自己的流；原生流由提供端撤销该注册后回收。
        native_tcp.write_all(b"live").await.map_err(text)?;
        let mut reply = [0; 4];
        native_tcp.read_exact(&mut reply).await.map_err(text)?;
        check(&reply == b"live", "网关close错误关闭原生流")?;
        fixture.provider.remove_service(&opened.tunnel_id).await?;
        ended(&mut native_tcp).await?;
        count(&fixture.provider, 0, 0).await?;
        native.shutdown().await?;
        Ok::<_, String>(())
    })
    .await;
    fixture.close().await;
    result
        .expect("真实公网链测试超时")
        .expect("真实公网链应通过");
}

#[tokio::test]
async fn ready_p2p_only_resolve_does_not_renew_provider_lease() {
    let fixture = Fixture::start().await.expect("应启动真实网关fixture");
    let result = timeout(Duration::from_secs(25), async {
        let opened = fixture.open("p2p-only", None).await?;
        check(opened.public_addr.is_none(), "仅客户端注册不应分配公网地址")?;
        fixture.install(&opened).await?;
        fixture.ready(&opened.tunnel_id).await?;
        let lease_baseline = Instant::now();
        let resolved = fixture.resolve().await.map_err(text)?;
        let forwarder = fixture
            .visitor
            .forward(
                "127.0.0.1:0".parse().map_err(text)?,
                TunnelTarget {
                    provider_id: fixture.provider.id(),
                    tunnel_id: resolved.tunnel_id,
                    service_token: resolved.service_token,
                },
            )
            .await?;
        let mut tcp = live(forwarder.local_addr()).await?;
        count(&fixture.provider, 0, 1).await?;
        fixture.resolve().await.map_err(text)?;
        let (reply, result) = oneshot::channel();
        fixture
            .registry
            .commands
            .send(Command::Expire(lease_baseline + LEASE_DURATION, reply))
            .await
            .map_err(text)?;
        result.await.map_err(text)?;
        check(
            fixture.resolve().await == Err(TunnelError::NotFound),
            "resolve延长了提供端租约",
        )?;
        fixture.provider.remove_service(&opened.tunnel_id).await?;
        ended(&mut tcp).await?;
        count(&fixture.provider, 0, 0).await?;
        forwarder.shutdown().await?;
        Ok::<_, String>(())
    })
    .await;
    fixture.close().await;
    result
        .expect("仅客户端租约测试超时")
        .expect("仅客户端租约应通过");
}

#[tokio::test]
async fn replacement_expiry_and_shutdown_join_active_public_flows() {
    let fixture = Fixture::start().await.expect("应启动真实网关fixture");
    let result = timeout(Duration::from_secs(35), async {
        let port = unused_port().await?;
        let addr = SocketAddr::from(([127, 0, 0, 1], port));
        let first = fixture.open("first", Some(port)).await?;
        fixture.install(&first).await?;
        fixture.ready(&first.tunnel_id).await?;
        let mut first_tcp = live(addr).await?;
        let second = fixture.open("second", Some(port)).await?;
        ended(&mut first_tcp).await?;
        count(&fixture.provider, 0, 0).await?;
        fixture.provider.remove_service(&first.tunnel_id).await?;
        fixture.install(&second).await?;
        fixture.ready(&second.tunnel_id).await?;
        let mut second_tcp = live(addr).await?;
        let (reply, result) = oneshot::channel();
        fixture
            .registry
            .commands
            .send(Command::Expire(Instant::now() + LEASE_DURATION, reply))
            .await
            .map_err(text)?;
        result.await.map_err(text)?;
        ended(&mut second_tcp).await?;
        count(&fixture.provider, 0, 0).await?;
        std::net::TcpListener::bind(addr).map_err(text)?;
        fixture.provider.remove_service(&second.tunnel_id).await?;
        let third = fixture.open("third", Some(port)).await?;
        fixture.install(&third).await?;
        fixture.ready(&third.tunnel_id).await?;
        let mut third_tcp = live(addr).await?;
        fixture.registry.shutdown().await;
        ended(&mut third_tcp).await?;
        count(&fixture.provider, 0, 0).await?;
        std::net::TcpListener::bind(addr).map_err(text)?;
        Ok::<_, String>(())
    })
    .await;
    fixture.close().await;
    result.expect("网关回收测试超时").expect("网关回收应通过");
}
