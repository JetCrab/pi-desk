use std::{
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use iroh::{EndpointAddr, Watcher};
use iroh_relay::server::{Access, AccessControl, ClientRequest, RelayConfig, Server, ServerConfig};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    task::{JoinHandle, JoinSet},
    time::timeout,
};
use tokio_util::sync::CancellationToken;

use super::{
    wire::{self, Reply},
    *,
};
use crate::{
    protocol::TunnelRelayConfig,
    runtime::{TunnelEndpoint, TunnelForwarder, generate_secret_key, provider_id, start_endpoint},
};

const RELAY_TOKEN: &str = "relay-test-token";
const SERVICE_TOKEN: &str = "service-test-token";
const TRAILER: &[u8] = b"response-after-request-fin";

#[derive(Debug)]
struct TokenAccess;

impl AccessControl for TokenAccess {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        if request.auth_token().as_deref() == Some(RELAY_TOKEN) {
            Access::Allow
        } else {
            Access::Deny {
                reason: Some("test relay denied".to_owned()),
            }
        }
    }
}

struct Echo {
    addr: SocketAddr,
    accepted: Arc<AtomicUsize>,
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl Echo {
    async fn start() -> RuntimeResult<Self> {
        Self::with_banner(b"").await
    }

    async fn with_banner(banner: &'static [u8]) -> RuntimeResult<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(text)?;
        let addr = listener.local_addr().map_err(text)?;
        let cancel = CancellationToken::new();
        let stopped = cancel.clone();
        let accepted = Arc::new(AtomicUsize::new(0));
        let observed = accepted.clone();
        let task = tokio::spawn(async move {
            let mut flows = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    _ = stopped.cancelled() => break,
                    _ = flows.join_next(), if !flows.is_empty() => {},
                    accepted = listener.accept() => {
                        let Ok((tcp, _)) = accepted else { break };
                        observed.fetch_add(1, Ordering::SeqCst);
                        flows.spawn(async move {
                            let (mut reader, mut writer) = tcp.into_split();
                            if writer.write_all(banner).await.is_err() {
                                return;
                            }
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
            addr,
            accepted,
            cancel,
            task,
        })
    }

    async fn close(self) {
        self.cancel.cancel();
        self.task.await.expect("echo任务应结束");
        std::net::TcpListener::bind(self.addr).expect("echo监听应释放");
        println!("后端任务已join且TCP端口可重绑定 {}", self.addr);
    }
}

struct Fixture {
    relay: Server,
    relay_config: TunnelRelayConfig,
    provider: TunnelEndpoint,
    visitor: TunnelEndpoint,
    echo: Echo,
}

impl Fixture {
    async fn start(provider_mode: TunnelMode, visitor_mode: TunnelMode) -> RuntimeResult<Self> {
        let mut relay = RelayConfig::new(([127, 0, 0, 1], 0));
        relay.access = Arc::new(TokenAccess);
        let mut config = ServerConfig::default();
        config.relay = Some(relay);
        let server = Server::spawn(config).await.map_err(text)?;
        let relay_config = TunnelRelayConfig {
            url: format!("http://{}", server.http_addr().expect("HTTP relay")),
            auth_token: RELAY_TOKEN.to_owned(),
            quic_port: 7842,
        };
        let provider = start_endpoint(TunnelEndpointConfig {
            secret_key: None,
            relay: relay_config.clone(),
            mode: provider_mode,
        })
        .await?;
        let visitor = start_endpoint(TunnelEndpointConfig {
            secret_key: None,
            relay: relay_config.clone(),
            mode: visitor_mode,
        })
        .await?;
        let echo = Echo::start().await?;
        Ok(Self {
            relay: server,
            relay_config,
            provider,
            visitor,
            echo,
        })
    }

    fn service(&self, id: &str) -> TunnelServiceConfig {
        TunnelServiceConfig {
            tunnel_id: id.to_owned(),
            service_token: SERVICE_TOKEN.to_owned(),
            local_addr: self.echo.addr,
            gateway_id: self.provider.id(),
        }
    }

    fn target(&self, id: &str) -> TunnelTarget {
        TunnelTarget {
            provider_id: self.provider.id(),
            tunnel_id: id.to_owned(),
            service_token: SERVICE_TOKEN.to_owned(),
        }
    }

    async fn mapping(&self, id: &str) -> RuntimeResult<TunnelForwarder> {
        self.visitor
            .forward("127.0.0.1:0".parse().expect("回环地址"), self.target(id))
            .await
    }

    async fn close(self) {
        let ports = [self.relay.http_addr(), self.relay.https_addr()];
        self.visitor.shutdown().await.expect("应关闭访问端");
        self.provider.shutdown().await.expect("应关闭提供端");
        self.echo.close().await;
        self.relay.shutdown().await.expect("应关闭relay");
        for addr in ports.into_iter().flatten() {
            std::net::TcpListener::bind(addr).expect("relay监听应释放");
        }
    }
}

fn text(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn check(condition: bool, message: &str) -> RuntimeResult<()> {
    if condition {
        Ok(())
    } else {
        Err(message.to_owned())
    }
}

async fn count(endpoint: &TunnelEndpoint, expected: u32) -> RuntimeResult<()> {
    timeout(Duration::from_secs(5), async {
        let mut poll = tokio::time::interval(Duration::from_millis(10));
        loop {
            if endpoint
                .connections()
                .iter()
                .map(|row| row.active_tcp)
                .sum::<u32>()
                == expected
            {
                break;
            }
            poll.tick().await;
        }
    })
    .await
    .map_err(|_| format!("活动TCP数量未收敛到{expected}"))
}

async fn open(mapping: &TunnelForwarder) -> RuntimeResult<TcpStream> {
    let mut tcp = TcpStream::connect(mapping.local_addr())
        .await
        .map_err(text)?;
    tcp.write_all(b"ping").await.map_err(text)?;
    let mut data = [0; 4];
    tcp.read_exact(&mut data).await.map_err(text)?;
    check(&data == b"ping", "echo内容不同")?;
    Ok(tcp)
}

async fn payload(mapping: &TunnelForwarder, size: usize) -> RuntimeResult<()> {
    let tcp = TcpStream::connect(mapping.local_addr())
        .await
        .map_err(text)?;
    let (mut reader, mut writer) = tcp.into_split();
    let data = (0..size).map(|i| (i % 256) as u8).collect::<Vec<_>>();
    let (write, read) = tokio::join!(
        async {
            writer.write_all(&data).await.map_err(text)?;
            writer.shutdown().await.map_err(text)
        },
        async {
            let mut received = Vec::new();
            reader.read_to_end(&mut received).await.map_err(text)?;
            check(received.len() == size + TRAILER.len(), "半关闭响应长度不同")?;
            check(received[..size] == data, "TCP二进制载荷不同")?;
            check(&received[size..] == TRAILER, "FIN后尾部响应丢失")
        }
    );
    write?;
    read
}

async fn slow_payload(mapping: &TunnelForwarder) -> RuntimeResult<()> {
    let data = (0..4 * 1024 * 1024)
        .map(|i| (i % 256) as u8)
        .collect::<Vec<_>>();
    let tcp = TcpStream::connect(mapping.local_addr())
        .await
        .map_err(text)?;
    let (mut reader, mut writer) = tcp.into_split();
    let (write, read) = tokio::join!(
        async {
            writer.write_all(&data).await.map_err(text)?;
            writer.shutdown().await.map_err(text)
        },
        async {
            let mut offset = 0;
            let mut buffer = [0; 8192];
            let mut pace = tokio::time::interval(Duration::from_millis(2));
            loop {
                pace.tick().await;
                let length = reader.read(&mut buffer).await.map_err(text)?;
                if length == 0 {
                    break;
                }
                for byte in &buffer[..length] {
                    let expected = if offset < data.len() {
                        data[offset]
                    } else {
                        *TRAILER
                            .get(offset - data.len())
                            .ok_or("慢读取返回多余数据")?
                    };
                    check(*byte == expected, "慢读取载荷不同")?;
                    offset += 1;
                }
            }
            check(offset == data.len() + TRAILER.len(), "慢读取EOF丢失数据")
        }
    );
    write?;
    read
}

#[test]
fn keys_and_public_serialization() {
    let secret = generate_secret_key().expect("应生成私钥");
    assert_eq!(secret.len(), 64);
    let id = provider_id(&secret).expect("应导出公钥");
    assert_eq!(id.len(), 64);
    assert!(provider_id("bad").is_err());
    assert!(provider_id(&"z".repeat(64)).is_err());
    assert_eq!(
        serde_json::to_string(&TunnelMode::RelayOnly).unwrap(),
        "\"relay-only\""
    );
    assert_eq!(TunnelMode::default(), TunnelMode::Auto);
    assert_eq!(
        serde_json::to_string(&TunnelPath::Direct).unwrap(),
        "\"direct\""
    );
    assert_eq!(
        serde_json::to_string(&TunnelSource::Public).unwrap(),
        "\"public\""
    );
}

async fn rejected_forward(fixture: &Fixture, target: TunnelTarget) -> RuntimeResult<()> {
    let mapping = fixture
        .visitor
        .forward("127.0.0.1:0".parse().expect("回环地址"), target)
        .await?;
    let addr = mapping.local_addr();
    let result = async {
        let mut tcp = TcpStream::connect(addr).await.map_err(text)?;
        tcp.write_all(b"must-not-reach-backend")
            .await
            .map_err(text)?;
        let mut reply = [0; 1];
        match timeout(Duration::from_secs(5), tcp.read(&mut reply)).await {
            Ok(Ok(0) | Err(_)) => Ok(()),
            Ok(Ok(_)) => Err("未授权Forward收到业务响应".to_owned()),
            Err(_) => Err("未授权Forward未关闭客户端TCP".to_owned()),
        }
    }
    .await;
    mapping.shutdown().await?;
    std::net::TcpListener::bind(addr).map_err(text)?;
    result
}

#[tokio::test]
async fn prebound_listener_forwards_tcp_without_rebinding_and_releases_on_shutdown() {
    let fixture = Fixture::start(TunnelMode::Auto, TunnelMode::RelayOnly)
        .await
        .expect("应启动隔离隧道");
    let result = timeout(Duration::from_secs(30), async {
        fixture
            .provider
            .register_service(fixture.service("reserved"))
            .await?;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(text)?;
        let addr = listener.local_addr().map_err(text)?;
        check(
            std::net::TcpListener::bind(addr).is_err(),
            "预绑定期间端口必须保持独占",
        )?;
        let mapping = fixture
            .visitor
            .forward_listener(listener, fixture.target("reserved"))
            .await?;
        check(mapping.local_addr() == addr, "接管监听不能换号")?;
        let result = payload(&mapping, 4096).await;
        mapping.shutdown().await?;
        std::net::TcpListener::bind(addr).map_err(text)?;
        result
    })
    .await;
    fixture.close().await;
    result
        .expect("预绑定转发不应超时")
        .expect("应保留数据和释放监听");
}

#[tokio::test]
async fn auto_endpoint_sends_quic_probe_to_custom_relay_udp_port() {
    let fixture = Fixture::start(TunnelMode::RelayOnly, TunnelMode::RelayOnly)
        .await
        .expect("应准备本地relay fixture");
    let udp = tokio::net::UdpSocket::bind("127.0.0.1:0")
        .await
        .expect("应监听隔离QAD端口");
    let addr = udp.local_addr().unwrap();
    let mut relay = fixture.relay_config.clone();
    relay.quic_port = addr.port();
    let endpoint = start_endpoint(TunnelEndpointConfig {
        secret_key: None,
        relay,
        mode: TunnelMode::Auto,
    })
    .await;
    let result = if let Ok(endpoint) = endpoint {
        let mut packet = [0; 2048];
        let received = timeout(Duration::from_secs(10), udp.recv_from(&mut packet)).await;
        endpoint.shutdown().await.expect("应关闭探测端点");
        match received {
            Ok(Ok((size, _))) => check(
                size >= 1200 && packet[0] & 0xc0 == 0xc0 && packet[1..5] != [0; 4],
                "指定UDP端口应收到QUIC Initial探测",
            ),
            Ok(Err(error)) => Err(text(error)),
            Err(_) => Err("正式Endpoint未向自定义QAD端口发出探测".to_owned()),
        }
    } else {
        endpoint.map(|_| ())
    };
    fixture.close().await;
    drop(udp);
    std::net::UdpSocket::bind(addr).expect("QAD测试UDP监听应释放");
    result.expect("正式Endpoint必须使用控制配置中的QAD端口");
}

#[tokio::test]
async fn endpoint_rejects_zero_relay_quic_port() {
    let result = start_endpoint(TunnelEndpointConfig {
        secret_key: None,
        relay: TunnelRelayConfig {
            url: "http://127.0.0.1:9".to_owned(),
            auth_token: RELAY_TOKEN.to_owned(),
            quic_port: 0,
        },
        mode: TunnelMode::Auto,
    })
    .await;
    assert!(matches!(result, Err(error) if error.contains("QUIC") && error.contains("端口")));
}

#[tokio::test]
async fn distinct_backend_ports_route_concurrently_and_revoke_independently() {
    let fixture = Fixture::start(TunnelMode::Auto, TunnelMode::RelayOnly)
        .await
        .expect("应准备fixture");
    let backend_b = Echo::with_banner(b"backend-b")
        .await
        .expect("应启动独立后端B");
    let result = timeout(Duration::from_secs(25), async {
        check(
            fixture.echo.addr.port() != backend_b.addr.port(),
            "必须是真正不同的两个本机端口",
        )?;
        fixture
            .provider
            .register_service(fixture.service("a"))
            .await?;
        fixture
            .provider
            .register_service(TunnelServiceConfig {
                local_addr: backend_b.addr,
                ..fixture.service("b")
            })
            .await?;
        let a = fixture.mapping("a").await?;
        let b = fixture.mapping("b").await?;
        let (flow_a, flow_b) = tokio::join!(open(&a), async {
            let mut tcp = TcpStream::connect(b.local_addr()).await.map_err(text)?;
            let mut banner = [0; 9];
            tcp.read_exact(&mut banner).await.map_err(text)?;
            check(&banner == b"backend-b", "B映射未到达独立后端B")?;
            tcp.write_all(b"port-b-first").await.map_err(text)?;
            let mut reply = [0; 12];
            tcp.read_exact(&mut reply).await.map_err(text)?;
            check(&reply == b"port-b-first", "B初次往返内容不同")?;
            Ok::<_, String>(tcp)
        });
        let mut flow_a = flow_a?;
        let mut flow_b = flow_b?;
        check(
            fixture.echo.accepted.load(Ordering::SeqCst) == 1,
            "A后端接纳数量错误",
        )?;
        check(
            backend_b.accepted.load(Ordering::SeqCst) == 1,
            "B后端接纳数量错误",
        )?;
        count(&fixture.provider, 2).await?;
        let rows = fixture.provider.connections();
        check(
            rows.len() == 2
                && rows
                    .iter()
                    .any(|row| row.local_port == fixture.echo.addr.port() && row.active_tcp == 1)
                && rows
                    .iter()
                    .any(|row| row.local_port == backend_b.addr.port() && row.active_tcp == 1),
            "两个本机端口的统计未分开",
        )?;
        fixture.provider.remove_service("a").await?;
        count(&fixture.provider, 1).await?;
        let mut end = [0; 1];
        check(
            !matches!(flow_a.read(&mut end).await, Ok(n) if n > 0),
            "撤销A未关闭其旧流",
        )?;
        flow_b.write_all(b"port-b-still-live").await.map_err(text)?;
        let mut reply = [0; 17];
        flow_b.read_exact(&mut reply).await.map_err(text)?;
        check(&reply == b"port-b-still-live", "撤销A影响了B已有流")?;
        check(
            backend_b.accepted.load(Ordering::SeqCst) == 1,
            "B不应依靠重建TCP维持往返",
        )?;
        let addresses = [a.local_addr(), b.local_addr()];
        a.shutdown().await?;
        b.shutdown().await?;
        count(&fixture.provider, 0).await?;
        for addr in addresses {
            std::net::TcpListener::bind(addr).map_err(text)?;
        }
        drop((flow_a, flow_b));
        Ok::<_, String>(())
    })
    .await;
    fixture.close().await;
    backend_b.close().await;
    result
        .expect("双后端用例超时")
        .expect("双后端路由与撤销隔离应通过");
}

#[tokio::test]
async fn auto_visitor_falls_back_to_relay_only_provider_with_real_tcp() {
    let fixture = Fixture::start(TunnelMode::RelayOnly, TunnelMode::Auto)
        .await
        .expect("应准备fixture");
    let result = timeout(Duration::from_secs(25), async {
        fixture
            .provider
            .register_service(fixture.service("fallback"))
            .await?;
        let mapping = fixture.mapping("fallback").await?;
        payload(&mapping, 256).await?;
        check(
            mapping.path() == TunnelPath::Relay,
            "Auto访问端应实际选择Relay路径",
        )?;
        check(
            fixture.echo.accepted.load(Ordering::SeqCst) == 1,
            "正式Forward没有触达真实后端",
        )?;
        let live = open(&mapping).await?;
        count(&fixture.provider, 1).await?;
        let rows = fixture.provider.connections();
        check(
            rows.len() == 1 && rows[0].path == TunnelPath::Relay && rows[0].active_tcp == 1,
            "提供端应观察到实际Relay业务流",
        )?;
        let addr = mapping.local_addr();
        mapping.shutdown().await?;
        count(&fixture.provider, 0).await?;
        std::net::TcpListener::bind(addr).map_err(text)?;
        drop(live);
        Ok::<_, String>(())
    })
    .await;
    fixture.close().await;
    result
        .expect("受控回退用例超时")
        .expect("正式runtime受控回退应通过");
}

#[tokio::test]
async fn unauthorized_expired_and_unpublished_forward_never_connect_backend() {
    let fixture = Fixture::start(TunnelMode::Auto, TunnelMode::RelayOnly)
        .await
        .expect("应准备fixture");
    let result = timeout(Duration::from_secs(25), async {
        fixture
            .provider
            .register_service(fixture.service("registered"))
            .await?;
        let legitimate = fixture.mapping("registered").await?;
        payload(&legitimate, 256).await?;
        check(
            fixture.echo.accepted.load(Ordering::SeqCst) == 1,
            "合法Forward应被后端接纳",
        )?;
        let mut wrong = fixture.target("registered");
        wrong.service_token = "wrong-forward-token".to_owned();
        rejected_forward(&fixture, wrong).await?;
        check(
            fixture.echo.accepted.load(Ordering::SeqCst) == 1,
            "错误token触达后端TCP",
        )?;
        rejected_forward(&fixture, fixture.target("unpublished")).await?;
        check(
            fixture.echo.accepted.load(Ordering::SeqCst) == 1,
            "未发布注册触达后端TCP",
        )?;
        let expired = fixture.target("registered");
        fixture.provider.remove_service("registered").await?;
        fixture
            .provider
            .register_service(TunnelServiceConfig {
                service_token: "renewed-forward-token".to_owned(),
                ..fixture.service("registered")
            })
            .await?;
        rejected_forward(&fixture, expired).await?;
        check(
            fixture.echo.accepted.load(Ordering::SeqCst) == 1,
            "过期token触达后端TCP",
        )?;
        count(&fixture.provider, 0).await?;
        legitimate.set_target(TunnelTarget {
            service_token: "renewed-forward-token".to_owned(),
            ..fixture.target("registered")
        });
        payload(&legitimate, 256).await?;
        check(
            fixture.echo.accepted.load(Ordering::SeqCst) == 2,
            "拒绝后合法Forward不可用或产生额外后端连接",
        )?;
        let addr = legitimate.local_addr();
        legitimate.shutdown().await?;
        count(&fixture.provider, 0).await?;
        std::net::TcpListener::bind(addr).map_err(text)?;
        Ok::<_, String>(())
    })
    .await;
    fixture.close().await;
    result
        .expect("Forward鉴权用例超时")
        .expect("未授权Forward不得触达后端");
}

#[tokio::test]
async fn real_relay_tcp_half_close_counts_and_mapping_shutdown() {
    let fixture = Fixture::start(TunnelMode::Auto, TunnelMode::RelayOnly)
        .await
        .expect("应准备隔离fixture");
    let result = timeout(Duration::from_secs(35), async {
        fixture
            .provider
            .register_service(fixture.service("one"))
            .await?;
        fixture.visitor.probe(&fixture.target("one")).await?;
        count(&fixture.provider, 0).await?;
        let mapping = fixture.mapping("one").await?;
        check(
            mapping.path() == TunnelPath::Unknown,
            "尚无连接时不应有路径",
        )?;
        let first = open(&mapping).await?;
        let second = open(&mapping).await?;
        count(&fixture.provider, 2).await?;
        let rows = fixture.provider.connections();
        check(
            rows.len() == 1 && rows[0].active_tcp == 2,
            "应按peer和端口聚合",
        )?;
        check(
            rows[0].source == TunnelSource::Client && rows[0].path == TunnelPath::Relay,
            "应为实际中继客户端路径",
        )?;
        check(
            rows[0].peer_id == fixture.visitor.id()
                && rows[0].local_port == fixture.echo.addr.port(),
            "统计身份或端口不符",
        )?;
        check(
            fixture.visitor.connections().is_empty(),
            "出站流不得计入入站统计",
        )?;
        payload(&mapping, 256).await?;
        payload(&mapping, 4 * 1024 * 1024).await?;
        slow_payload(&mapping).await?;
        count(&fixture.provider, 2).await?;
        check(mapping.path() == TunnelPath::Relay, "应读取实际选中relay")?;
        check(
            fixture.visitor.runtime.shared.outgoing.lock().await.len() == 1,
            "同端点应复用连接",
        )?;
        check(
            fixture
                .visitor
                .runtime
                .shared
                .endpoint()?
                .bound_sockets()
                .is_empty(),
            "relay-only不应有IP socket",
        )?;
        let addr = mapping.local_addr();
        mapping.shutdown().await?;
        count(&fixture.provider, 0).await?;
        std::net::TcpListener::bind(addr).map_err(text)?;
        drop((first, second));
        Ok::<_, String>(())
    })
    .await;
    fixture.close().await;
    result.expect("真实TCP用例超时").expect("真实TCP用例应通过");
}

#[tokio::test]
async fn revokes_only_one_service_and_replaces_target_without_rebinding() {
    let fixture = Fixture::start(TunnelMode::Auto, TunnelMode::RelayOnly)
        .await
        .expect("应准备隔离fixture");
    let result = timeout(Duration::from_secs(35), async {
        fixture
            .provider
            .register_service(fixture.service("a"))
            .await?;
        fixture
            .provider
            .register_service(fixture.service("b"))
            .await?;
        let a = fixture.mapping("a").await?;
        let b = fixture.mapping("b").await?;
        let mut old_a = open(&a).await?;
        let mut live_b = open(&b).await?;
        count(&fixture.provider, 2).await?;
        fixture.provider.remove_service("a").await?;
        count(&fixture.provider, 1).await?;
        let mut end = [0; 1];
        check(
            !matches!(old_a.read(&mut end).await, Ok(n) if n > 0),
            "撤销后旧业务流仍可读取",
        )?;
        check(
            fixture.visitor.probe(&fixture.target("a")).await.is_err(),
            "撤销后旧token仍可探测",
        )?;
        let mut wrong = fixture.target("b");
        wrong.service_token = "wrong-token-never-log".to_owned();
        let error = fixture
            .visitor
            .probe(&wrong)
            .await
            .err()
            .ok_or("错误token被放行")?;
        check(!error.contains(&wrong.service_token), "错误包含token")?;
        count(&fixture.provider, 1).await?;
        live_b.write_all(b"live").await.map_err(text)?;
        let mut echo = [0; 4];
        live_b.read_exact(&mut echo).await.map_err(text)?;
        check(&echo == b"live", "其他端口被撤销影响")?;
        let mut replacement = fixture.service("a");
        replacement.service_token = "replacement-test-token".to_owned();
        replacement.gateway_id = fixture.visitor.id();
        fixture.provider.register_service(replacement).await?;
        let old_target = fixture.target("a");
        check(
            fixture.visitor.probe(&old_target).await.is_err(),
            "旧登记token复活",
        )?;
        let addr = a.local_addr();
        a.set_target(TunnelTarget {
            service_token: "replacement-test-token".to_owned(),
            ..old_target
        });
        let new_a = open(&a).await?;
        count(&fixture.provider, 2).await?;
        check(a.local_addr() == addr, "替换token改变了监听地址")?;
        let rows = fixture.provider.connections();
        check(
            rows.len() == 2
                && rows.iter().any(|r| r.source == TunnelSource::Public)
                && rows.iter().any(|r| r.source == TunnelSource::Client),
            "来源应仅按gateway公钥区分",
        )?;
        a.shutdown().await?;
        b.shutdown().await?;
        count(&fixture.provider, 0).await?;
        drop((new_a, live_b, old_a));
        Ok::<_, String>(())
    })
    .await;
    fixture.close().await;
    result
        .expect("逐登记撤销用例超时")
        .expect("逐登记撤销应通过");
}

#[tokio::test]
async fn malformed_headers_wrong_alpn_and_handshake_timeout_are_bounded() {
    let fixture = Fixture::start(TunnelMode::Auto, TunnelMode::RelayOnly)
        .await
        .expect("应准备隔离fixture");
    let result = timeout(Duration::from_secs(35), async {
        fixture
            .provider
            .register_service(fixture.service("one"))
            .await?;
        let connection = fixture
            .visitor
            .runtime
            .shared
            .connect(&fixture.target("one"))
            .await?;
        for data in [vec![0, 0, 32, 0], vec![0, 0, 0, 10, b'{']] {
            let (mut send, mut recv) = connection.open_bi().await.map_err(text)?;
            send.write_all(&data).await.map_err(text)?;
            send.finish().map_err(text)?;
            check(
                matches!(
                    wire::read_frame::<_, Reply>(&mut recv).await?,
                    Reply::InvalidRequest
                ),
                "坏控制头应拒绝",
            )?;
        }
        let (mut send, mut recv) = connection.open_bi().await.map_err(text)?;
        wire::write_frame(
            &mut send,
            &serde_json::json!({"op":"unknown", "tunnel_id":"one", "service_token": SERVICE_TOKEN}),
        )
        .await?;
        check(
            matches!(
                wire::read_frame::<_, Reply>(&mut recv).await?,
                Reply::InvalidRequest
            ),
            "未知操作应拒绝",
        )?;
        let (mut send, mut recv) = connection.open_bi().await.map_err(text)?;
        send.write_all(&[0]).await.map_err(text)?;
        check(
            matches!(
                wire::read_frame::<_, Reply>(&mut recv).await?,
                Reply::InvalidRequest
            ),
            "截断头必须握手超时释放",
        )?;
        let endpoint = fixture.visitor.runtime.shared.endpoint()?;
        let addr = EndpointAddr::new(fixture.provider.id().parse().map_err(text)?)
            .with_relay_url(fixture.visitor.runtime.shared.relay_url.clone());
        check(
            endpoint.connect(addr, b"wrong/alpn").await.is_err(),
            "错误ALPN被接受",
        )?;
        fixture.visitor.probe(&fixture.target("one")).await?;
        count(&fixture.provider, 0).await
    })
    .await;
    fixture.close().await;
    result
        .expect("控制头边界用例超时")
        .expect("控制头边界应通过");
}

#[tokio::test]
async fn endpoint_shutdown_closes_clones_flows_listeners_and_udp() {
    let fixture = Fixture::start(TunnelMode::Auto, TunnelMode::Auto)
        .await
        .expect("应准备隔离fixture");
    let result = timeout(Duration::from_secs(35), async {
        fixture
            .provider
            .register_service(fixture.service("one"))
            .await?;
        let mapping = fixture.mapping("one").await?;
        let live = open(&mapping).await?;
        count(&fixture.provider, 1).await?;
        timeout(Duration::from_secs(10), async {
            let mut poll = tokio::time::interval(Duration::from_millis(10));
            while mapping.path() != TunnelPath::Direct {
                poll.tick().await;
            }
        })
        .await
        .map_err(|_| "本机自动模式没有选中direct")?;
        let sockets = fixture.visitor.runtime.shared.endpoint()?.bound_sockets();
        let addr = mapping.local_addr();
        fixture.visitor.clone().shutdown().await?;
        count(&fixture.provider, 0).await?;
        check(mapping.path() == TunnelPath::Unknown, "关闭后路径没有归零")?;
        check(
            fixture.visitor.probe(&fixture.target("one")).await.is_err(),
            "已关闭克隆仍可探测",
        )?;
        check(
            fixture
                .visitor
                .forward(addr, fixture.target("one"))
                .await
                .is_err(),
            "已关闭克隆仍可监听",
        )?;
        std::net::TcpListener::bind(addr).map_err(text)?;
        for addr in sockets {
            std::net::UdpSocket::bind(addr).map_err(text)?;
        }
        mapping.shutdown().await?;
        drop(live);
        Ok::<_, String>(())
    })
    .await;
    fixture.close().await;
    result.expect("端点关闭用例超时").expect("端点关闭应通过");
}

async fn wait_for(
    duration: Duration,
    message: &str,
    mut ready: impl FnMut() -> bool,
) -> RuntimeResult<()> {
    timeout(duration, async {
        let mut poll = tokio::time::interval(Duration::from_millis(5));
        while !ready() {
            poll.tick().await;
        }
    })
    .await
    .map_err(|_| message.to_owned())
}

#[tokio::test]
async fn offline_dial_does_not_block_cached_peer_new_tcp_or_probe() {
    let fixture = Fixture::start(TunnelMode::RelayOnly, TunnelMode::RelayOnly)
        .await
        .expect("应准备隔离fixture");
    let mut callers = JoinSet::new();
    let result = timeout(Duration::from_secs(30), async {
        fixture
            .provider
            .register_service(fixture.service("online"))
            .await?;
        let target = fixture.target("online");
        fixture.visitor.probe(&target).await?;
        let shared = &fixture.visitor.runtime.shared;
        wait_for(Duration::from_secs(2), "预热探测未释放", || {
            shared.tasks.len() == 2
        })
        .await?;
        let baseline_connections = shared.connection_slots.available_permits();
        let baseline_streams = shared.stream_slots.available_permits();
        let offline = TunnelTarget {
            provider_id: provider_id(&generate_secret_key()?)?,
            ..target.clone()
        };
        let visitor = fixture.visitor.clone();
        let pending = callers.spawn(async move { visitor.probe(&offline).await });
        wait_for(Duration::from_secs(2), "离线拨号未开始", || {
            shared.connection_slots.available_permits() == baseline_connections - 1
        })
        .await?;
        check(!pending.is_finished(), "离线目标未处于握手等待")?;
        let started = tokio::time::Instant::now();
        timeout(Duration::from_secs(2), async {
            fixture.visitor.probe(&target).await?;
            let mapping = fixture.mapping("online").await?;
            let stream = open(&mapping).await?;
            count(&fixture.provider, 1).await?;
            mapping.shutdown().await?;
            drop(stream);
            Ok::<_, String>(())
        })
        .await
        .map_err(|_| "离线拨号阻塞了正常目标的新探测或TCP")??;
        println!(
            "离线握手等待期间，缓存目标新probe/TCP完成耗时={}ms",
            started.elapsed().as_millis()
        );
        check(
            !pending.is_finished(),
            "未在离线拨号等待期间完成正常目标请求",
        )?;

        // 调用future被drop后，现有probe后台任务仍以握手超时为释放界限。
        callers.abort_all();
        while callers.join_next().await.is_some() {}
        let dropped = tokio::time::Instant::now();
        wait_for(
            HANDSHAKE_TIMEOUT + Duration::from_secs(2),
            "drop的probe未最终释放任务或槽位",
            || {
                shared.tasks.len() == 2
                    && shared.connection_slots.available_permits() == baseline_connections
                    && shared.stream_slots.available_permits() == baseline_streams
            },
        )
        .await?;
        println!(
            "drop调用方后probe后台任务及槽位释放耗时={}ms",
            dropped.elapsed().as_millis()
        );
        check(
            shared.outgoing.lock().await.len() == 1,
            "失败离线目标污染连接缓存",
        )?;
        count(&fixture.provider, 0).await
    })
    .await;
    callers.abort_all();
    while callers.join_next().await.is_some() {}
    fixture.close().await;
    result
        .expect("离线拨号隔离用例超时")
        .expect("离线拨号不得阻塞正常目标");
}

#[tokio::test]
async fn concurrent_same_peer_dials_keep_one_cache_and_release_losing_connections() {
    let fixture = Fixture::start(TunnelMode::RelayOnly, TunnelMode::RelayOnly)
        .await
        .expect("应准备隔离fixture");
    let mut dials = JoinSet::new();
    let result = timeout(Duration::from_secs(20), async {
        fixture
            .provider
            .register_service(fixture.service("one"))
            .await?;
        wait_for(Duration::from_secs(2), "接纳任务未就绪", || {
            fixture
                .provider
                .runtime
                .shared
                .connection_slots
                .available_permits()
                == MAX_CONNECTIONS - 1
                && fixture
                    .visitor
                    .runtime
                    .shared
                    .connection_slots
                    .available_permits()
                    == MAX_CONNECTIONS - 1
        })
        .await?;
        let barrier = Arc::new(tokio::sync::Barrier::new(8));
        for _ in 0..8 {
            let shared = fixture.visitor.runtime.shared.clone();
            let target = fixture.target("one");
            let barrier = barrier.clone();
            dials.spawn(async move {
                barrier.wait().await;
                shared.connect(&target).await
            });
        }
        let mut chosen = None;
        while let Some(dial) = dials.join_next().await {
            let connection = dial.map_err(text)??;
            if let Some(id) = chosen {
                check(connection.stable_id() == id, "并发拨号没有收敛到同一连接")?;
            } else {
                chosen = Some(connection.stable_id());
            }
        }
        fixture.visitor.probe(&fixture.target("one")).await?;
        check(
            fixture.visitor.runtime.shared.outgoing.lock().await.len() == 1,
            "同peer缓存数量泄漏",
        )?;
        wait_for(
            Duration::from_secs(3),
            "并发落选连接或permit未释放",
            || {
                fixture
                    .visitor
                    .runtime
                    .shared
                    .connection_slots
                    .available_permits()
                    == MAX_CONNECTIONS - 2
                    && fixture
                        .provider
                        .runtime
                        .shared
                        .connection_slots
                        .available_permits()
                        == MAX_CONNECTIONS - 2
                    && fixture.visitor.runtime.shared.tasks.len() == 2
                    && fixture.provider.runtime.shared.tasks.len() == 2
            },
        )
        .await?;
        let mapping = fixture.mapping("one").await?;
        payload(&mapping, 256).await?;
        mapping.shutdown().await?;
        count(&fixture.provider, 0).await
    })
    .await;
    dials.abort_all();
    while dials.join_next().await.is_some() {}
    fixture.close().await;
    result
        .expect("同peer并发拨号用例超时")
        .expect("同peer竞争连接应释放");
}

#[tokio::test]
async fn cancelled_handshake_releases_its_permit_without_caching() {
    let fixture = Fixture::start(TunnelMode::RelayOnly, TunnelMode::RelayOnly)
        .await
        .expect("应准备隔离fixture");
    let mut dials = JoinSet::new();
    let result = timeout(Duration::from_secs(10), async {
        let shared = fixture.visitor.runtime.shared.clone();
        wait_for(Duration::from_secs(2), "接纳任务未就绪", || {
            shared.connection_slots.available_permits() == MAX_CONNECTIONS - 1
        })
        .await?;
        let target = TunnelTarget {
            provider_id: provider_id(&generate_secret_key()?)?,
            ..fixture.target("offline")
        };
        let dialing = shared.clone();
        dials.spawn(async move { dialing.connect(&target).await });
        wait_for(Duration::from_secs(2), "取消前拨号未开始", || {
            shared.connection_slots.available_permits() == MAX_CONNECTIONS - 2
        })
        .await?;
        dials.abort_all();
        while dials.join_next().await.is_some() {}
        check(
            shared.connection_slots.available_permits() == MAX_CONNECTIONS - 1,
            "取消拨号泄漏permit",
        )?;
        check(shared.outgoing.lock().await.is_empty(), "取消拨号污染缓存")?;
        check(shared.tasks.len() == 1, "取消拨号遗留观察任务")
    })
    .await;
    dials.abort_all();
    while dials.join_next().await.is_some() {}
    fixture.close().await;
    result
        .expect("拨号取消用例超时")
        .expect("拨号取消应释放资源");
}

#[tokio::test]
async fn relay_auth_denial_is_separate_from_service_auth() {
    let fixture = Fixture::start(TunnelMode::Auto, TunnelMode::RelayOnly)
        .await
        .expect("应准备隔离fixture");
    let bad = start_endpoint(TunnelEndpointConfig {
        secret_key: None,
        relay: TunnelRelayConfig {
            auth_token: "wrong-relay-token".to_owned(),
            ..fixture.relay_config.clone()
        },
        mode: TunnelMode::RelayOnly,
    })
    .await
    .expect("bind不代表relay已经认证");
    let result = timeout(Duration::from_secs(15), async {
        let endpoint = bad.runtime.shared.endpoint()?;
        let mut statuses = endpoint.home_relay_status().stream();
        while let Some(status) = statuses.next().await {
            if status
                .iter()
                .any(|r| r.auth_denied_reason() == Some("test relay denied"))
            {
                return Ok::<_, String>(());
            }
        }
        Err("没有观察到独立relay认证拒绝".to_owned())
    })
    .await;
    bad.shutdown().await.expect("应关闭错误授权端点");
    fixture.close().await;
    result
        .expect("relay认证拒绝超时")
        .expect("relay认证拒绝应通过");
}
