use super::*;
use crate::api::{AppState, router};
use pi_desk_tunnel_common::control::{ControlClient, ControlClientError, ControlServerError};
use pi_desk_tunnel_common::protocol::{CryptoContext, LEASE_DURATION, RENEW_INTERVAL};
use pi_desk_tunnel_common::runtime::TunnelPath;
use pi_desk_tunnel_common::worker::{
    TunnelForwardConfig, TunnelPhase, TunnelPublicationConfig, TunnelWorkerConfig,
    TunnelWorkerHandle, start_tunnel_worker,
};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Backend {
    addr: SocketAddr,
    accepts: Arc<AtomicUsize>,
    stop: oneshot::Sender<()>,
    task: JoinHandle<Result<(), String>>,
}

impl Backend {
    async fn start() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(text)?;
        let addr = listener.local_addr().map_err(text)?;
        let (stop, mut stopped) = oneshot::channel();
        let accepts = Arc::new(AtomicUsize::new(0));
        let accept_count = accepts.clone();
        let task = tokio::spawn(async move {
            let mut flows = JoinSet::new();
            let mut result = loop {
                tokio::select! {
                    _ = &mut stopped => break Ok(()),
                    Some(result) = flows.join_next(), if !flows.is_empty() => {
                        if let Err(error) = result { break Err(text(error)); }
                    }
                    accepted = listener.accept() => match accepted {
                        Ok((mut tcp, _)) => {
                            accept_count.fetch_add(1, Ordering::SeqCst);
                            // Tokio 管理 accepted socket 的非阻塞就绪，不使用 std read_exact。
                            flows.spawn(async move {
                                let (mut read, mut write) = tcp.split();
                                let _ = tokio::io::copy(&mut read, &mut write).await;
                            });
                        }
                        Err(error) => break Err(text(error)),
                    }
                }
            };
            flows.abort_all();
            while let Some(joined) = flows.join_next().await {
                if let Err(error) = joined
                    && !error.is_cancelled()
                {
                    eprintln!("Worker验收后端任务异常：{error}");
                    if result.is_ok() {
                        result = Err(text(error));
                    }
                }
            }
            result
        });
        Ok(Self {
            addr,
            accepts,
            stop,
            task,
        })
    }

    async fn close(self) -> Result<(), String> {
        let _ = self.stop.send(());
        let result = self.task.await.map_err(text)?;
        let released = std::net::TcpListener::bind(self.addr)
            .map(|_| ())
            .map_err(text);
        result.and(released)
    }
}

struct HttpControl {
    stop: oneshot::Sender<()>,
    task: JoinHandle<Result<(), String>>,
}

struct WorkerFixture {
    relay: Option<Server>,
    relay_config: Option<TunnelRelayConfig>,
    registry: Option<Arc<TunnelRegistry>>,
    probe: Option<TunnelEndpoint>,
    http: Option<HttpControl>,
    control_addr: SocketAddr,
    provider: Option<TunnelWorkerHandle>,
    visitor: Option<TunnelWorkerHandle>,
    backends: Vec<Backend>,
    local_addrs: Vec<SocketAddr>,
}

impl WorkerFixture {
    async fn start() -> Result<Self, String> {
        let mut fixture = Self {
            relay: None,
            relay_config: None,
            registry: None,
            probe: None,
            http: None,
            control_addr: ([127, 0, 0, 1], 0).into(),
            provider: None,
            visitor: None,
            backends: Vec::new(),
            local_addrs: Vec::new(),
        };
        if let Err(error) = fixture.init().await {
            if let Err(cleanup) = fixture.close(false).await {
                eprintln!("Worker fixture初始化回收失败：{cleanup}");
            }
            return Err(error);
        }
        Ok(fixture)
    }

    async fn init(&mut self) -> Result<(), String> {
        let mut relay = RelayConfig::new(([127, 0, 0, 1], 0));
        relay.access = Arc::new(TokenAccess);
        let mut config = ServerConfig::default();
        config.relay = Some(relay);
        let relay = Server::spawn(config).await.map_err(text)?;
        let relay_config = TunnelRelayConfig {
            url: format!("http://{}", relay.http_addr().ok_or("relay缺少HTTP地址")?),
            auth_token: RELAY_TOKEN.to_owned(),
            quic_port: 7842,
        };
        self.relay = Some(relay);
        self.relay_config = Some(relay_config.clone());
        let gateway = start_endpoint(TunnelEndpointConfig {
            secret_key: None,
            relay: relay_config.clone(),
            mode: TunnelMode::RelayOnly,
        })
        .await?;
        self.registry = Some(TunnelRegistry::new(
            gateway,
            TunnelRegistryConfig {
                relay: relay_config.clone(),
                public_host: "127.0.0.1".to_owned(),
            },
        ));
        self.probe = Some(
            start_endpoint(TunnelEndpointConfig {
                secret_key: None,
                relay: relay_config,
                mode: TunnelMode::RelayOnly,
            })
            .await?,
        );
        self.start_http().await?;
        for _ in 0..2 {
            self.backends.push(Backend::start().await?);
            let addr = SocketAddr::from(([127, 0, 0, 1], unused_port().await?));
            self.local_addrs.push(addr);
        }
        let config = TunnelWorkerConfig {
            control_server_url: self.url(),
            control_key: [31; 32],
            provider_secret_key: None,
            mode: TunnelMode::Auto,
        };
        self.provider = Some(start_tunnel_worker(config.clone())?);
        self.visitor = Some(start_tunnel_worker(config)?);
        Ok(())
    }

    fn url(&self) -> String {
        format!("http://{}", self.control_addr)
    }
    fn provider(&self) -> &TunnelWorkerHandle {
        self.provider.as_ref().expect("已启动提供端")
    }
    fn visitor(&self) -> &TunnelWorkerHandle {
        self.visitor.as_ref().expect("已启动访问端")
    }
    fn probe(&self) -> &TunnelEndpoint {
        self.probe.as_ref().expect("已启动探测端")
    }

    async fn start_http(&mut self) -> Result<(), String> {
        let listener = TcpListener::bind(self.control_addr).await.map_err(text)?;
        self.control_addr = listener.local_addr().map_err(text)?;
        let app = router(AppState {
            crypto: Arc::new(CryptoContext::new([31; 32])),
            tunnels: self.registry.as_ref().ok_or("缺少网关")?.clone(),
        });
        let (stop, stopped) = oneshot::channel();
        let task = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
                .map_err(text)
        });
        self.http = Some(HttpControl { stop, task });
        Ok(())
    }

    async fn stop_http(&mut self) -> Result<(), String> {
        if let Some(http) = self.http.take() {
            let _ = http.stop.send(());
            http.task.await.map_err(text)??;
            std::net::TcpListener::bind(self.control_addr).map_err(text)?;
        }
        Ok(())
    }

    async fn resolve(&self, index: usize) -> Result<ResolveTunnelResponse, ControlClientError> {
        let url = self.url();
        let provider_id = self
            .provider()
            .snapshot()
            .provider_id
            .expect("发布后应有公钥");
        let port = self.backends[index].addr.port();
        tokio::task::spawn_blocking(move || {
            ControlClient::new(&url, [31; 32])?.resolve_tunnel(&provider_id, port)
        })
        .await
        .expect("控制解析任务不能panic")
    }

    fn target(&self, response: &ResolveTunnelResponse) -> TunnelTarget {
        TunnelTarget {
            provider_id: self.provider().snapshot().provider_id.expect("提供端公钥"),
            tunnel_id: response.tunnel_id.clone(),
            service_token: response.service_token.clone(),
        }
    }

    async fn connect(&self) -> Result<[TcpStream; 2], String> {
        for backend in &self.backends {
            self.provider().publish(TunnelPublicationConfig {
                local_addr: backend.addr,
                public_port: None,
            })?;
        }
        poll(
            "两个提供端端口ready",
            Duration::from_secs(20),
            || {
                let snapshot = self.provider().snapshot();
                snapshot.publications.len() == 2
                    && snapshot
                        .publications
                        .iter()
                        .all(|row| row.phase == TunnelPhase::Listening)
            },
        )
        .await?;
        let provider_id = self
            .provider()
            .snapshot()
            .provider_id
            .ok_or("缺少提供端公钥")?;
        for (backend, addr) in self.backends.iter().zip(&self.local_addrs) {
            self.visitor().forward(TunnelForwardConfig {
                provider_id: provider_id.clone(),
                remote_port: backend.addr.port(),
                local_port: addr.port(),
            })?;
        }
        poll("两个原生映射ready", Duration::from_secs(10), || {
            let snapshot = self.visitor().snapshot();
            snapshot.forwards.len() == 2
                && snapshot
                    .forwards
                    .iter()
                    .all(|row| row.phase == TunnelPhase::Listening)
        })
        .await?;
        let mut a = TcpStream::connect(self.local_addrs[0])
            .await
            .map_err(text)?;
        let mut b = TcpStream::connect(self.local_addrs[1])
            .await
            .map_err(text)?;
        exchange(&mut a, b"native-a-before-revoke").await?;
        exchange(&mut b, b"native-b-before-revoke").await?;
        poll(
            "两条native direct活动流",
            Duration::from_secs(10),
            || {
                let snapshot = self.provider().snapshot();
                snapshot.connections.len() == 2
                    && snapshot.connections.iter().all(|row| {
                        row.source == TunnelSource::Client
                            && row.active_tcp == 1
                            && row.path == TunnelPath::Direct
                    })
            },
        )
        .await?;
        Ok([a, b])
    }

    async fn reject_old(&self, target: &TunnelTarget) -> Result<(), String> {
        let result = timeout(Duration::from_secs(5), self.probe().probe(target))
            .await
            .map_err(|_| "旧token探测未及时结束".to_owned())?;
        check(
            result == Err("隧道登记不存在或授权已失效".to_owned()),
            "旧凭据未收到提供端明确授权拒绝",
        )
    }

    async fn close(mut self, control_was_down: bool) -> Result<(), String> {
        let mut first = None;
        // 恢复HTTP仅供清理，场景断言全部在恢复之前完成。
        if control_was_down && self.http.is_none() {
            retain(&mut first, self.start_http().await);
        }
        if let Some(visitor) = &self.visitor {
            visitor.stop();
        }
        if let Some(provider) = &self.provider {
            provider.stop();
        }
        for worker in [self.visitor.take(), self.provider.take()]
            .into_iter()
            .flatten()
        {
            let result = tokio::task::spawn_blocking(move || worker.shutdown())
                .await
                .map_err(text)
                .and_then(|result| result);
            match result {
                Err(error)
                    if control_was_down
                        && error == "服务端隧道清理未确认：隧道控制服务网络请求失败" =>
                {
                    eprintln!("控制断线预期清理状态：{error}；Worker已join。");
                }
                result => retain(&mut first, result),
            }
        }
        retain(&mut first, self.stop_http().await);
        if let Some(registry) = self.registry.take() {
            registry.shutdown().await;
        }
        if let Some(probe) = self.probe.take() {
            retain(&mut first, probe.shutdown().await);
        }
        for backend in self.backends.drain(..) {
            retain(&mut first, backend.close().await);
        }
        if let Some(relay) = self.relay.take() {
            let addr = relay.http_addr();
            retain(&mut first, relay.shutdown().await.map_err(text));
            if let Some(addr) = addr {
                retain(
                    &mut first,
                    std::net::TcpListener::bind(addr).map(|_| ()).map_err(text),
                );
            }
        }
        for addr in self.local_addrs {
            retain(
                &mut first,
                std::net::TcpListener::bind(addr).map(|_| ()).map_err(text),
            );
        }
        if first.is_none() {
            eprintln!(
                "Worker生命周期fixture已回收：双Worker、HTTP/router、registry、探测Endpoint、双后端、relay均已join；全部TCP监听端口可重绑。"
            );
        }
        first.map_or(Ok(()), Err)
    }
}

fn retain(first: &mut Option<String>, result: Result<(), String>) {
    if let Err(error) = result {
        eprintln!("Worker生命周期清理错误：{error}");
        if first.is_none() {
            *first = Some(error);
        }
    }
}

async fn poll(label: &str, duration: Duration, condition: impl Fn() -> bool) -> Result<(), String> {
    timeout(duration, async {
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        while !condition() {
            tick.tick().await;
        }
    })
    .await
    .map_err(|_| format!("等待{label}超时"))
}

async fn exchange(tcp: &mut TcpStream, bytes: &[u8]) -> Result<(), String> {
    timeout(Duration::from_secs(3), async {
        tcp.write_all(bytes).await.map_err(text)?;
        let mut response = vec![0; bytes.len()];
        tcp.read_exact(&mut response).await.map_err(text)?;
        check(response == bytes, "旧native流字节往返不一致")
    })
    .await
    .map_err(|_| "旧native流字节往返超时".to_owned())?
}

async fn closed_by(tcp: &mut TcpStream, deadline: tokio::time::Instant) -> Result<(), String> {
    let mut byte = [0; 1];
    let read = tokio::time::timeout_at(deadline, tcp.read(&mut byte))
        .await
        .map_err(|_| "native旧流超过撤销期限仍未关闭".to_owned())?;
    check(
        !matches!(read, Ok(n) if n > 0),
        "撤销后的native旧流仍返回数据",
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worker_lifecycle_mode_switch_preserves_same_worker_provider_tcp() {
    let fixture = WorkerFixture::start()
        .await
        .expect("应启动双角色Worker fixture");
    let result = timeout(Duration::from_secs(45), async {
        // A/B 各自同时提供一个端口并访问另一个端口，复用同一个 Worker owner。
        fixture.provider().publish(TunnelPublicationConfig {
            local_addr: fixture.backends[0].addr, public_port: None,
        })?;
        fixture.visitor().publish(TunnelPublicationConfig {
            local_addr: fixture.backends[1].addr, public_port: None,
        })?;
        poll("A/B双角色提供端ready", Duration::from_secs(20), || {
            [fixture.provider(), fixture.visitor()].iter().all(|worker| {
                let snapshot = worker.snapshot();
                snapshot.publications.len() == 1 && snapshot.publications[0].phase == TunnelPhase::Listening
            })
        }).await?;
        let a_id = fixture.provider().snapshot().provider_id.ok_or("A缺少提供端身份")?;
        let b_id = fixture.visitor().snapshot().provider_id.ok_or("B缺少提供端身份")?;
        fixture.visitor().forward(TunnelForwardConfig {
            provider_id: a_id.clone(), remote_port: fixture.backends[0].addr.port(),
            local_port: fixture.local_addrs[0].port(),
        })?;
        fixture.provider().forward(TunnelForwardConfig {
            provider_id: b_id, remote_port: fixture.backends[1].addr.port(),
            local_port: fixture.local_addrs[1].port(),
        })?;
        poll("A/B双向访问映射ready", Duration::from_secs(10), || {
            [fixture.provider(), fixture.visitor()].iter().all(|worker| {
                let snapshot = worker.snapshot();
                snapshot.forwards.len() == 1 && snapshot.forwards[0].phase == TunnelPhase::Listening
            })
        }).await?;
        let mut provided_to_b = TcpStream::connect(fixture.local_addrs[0]).await.map_err(text)?;
        let mut old_access_to_b = TcpStream::connect(fixture.local_addrs[1]).await.map_err(text)?;
        exchange(&mut provided_to_b, b"b-to-a-original-tcp-before-mode-change").await?;
        exchange(&mut old_access_to_b, b"a-to-b-old-access-before-mode-change").await?;
        poll("A/B双角色真实活动TCP", Duration::from_secs(5), || {
            [fixture.provider(), fixture.visitor()].iter().all(|worker| {
                let rows = worker.snapshot().connections;
                rows.len() == 1 && rows[0].source == TunnelSource::Client
                    && rows[0].active_tcp == 1 && rows[0].path != TunnelPath::Unknown
            })
        }).await?;
        check(fixture.backends[0].accepts.load(Ordering::SeqCst) == 1, "A后端起始接纳数不是1")?;
        check(fixture.backends[1].accepts.load(Ordering::SeqCst) == 1, "B后端起始接纳数不是1")?;
        let original_registration = fixture.resolve(0).await.map_err(text)?;
        let switched_at = tokio::time::Instant::now();
        fixture.provider().set_mode(TunnelMode::RelayOnly)?;
        closed_by(&mut old_access_to_b, switched_at + Duration::from_secs(8)).await?;
        poll("A访问端RelayOnly重建ready", Duration::from_secs(10), || {
            let snapshot = fixture.provider().snapshot();
            snapshot.mode == TunnelMode::RelayOnly && snapshot.forwards.len() == 1
                && snapshot.forwards[0].phase == TunnelPhase::Listening
        }).await?;
        exchange(&mut provided_to_b, b"b-to-a-same-tcp-after-a-access-rebuilt").await?;
        poll("B提供端旧访问流清零", Duration::from_secs(2), || fixture.visitor().snapshot().connections.is_empty()).await?;
        let mut new_access_to_b = TcpStream::connect(fixture.local_addrs[1]).await.map_err(text)?;
        exchange(&mut new_access_to_b, b"a-to-b-new-relay-access").await?;
        poll("A新访问流实际Relay且B统计一致", Duration::from_secs(5), || {
            let access = fixture.provider().snapshot();
            let provided = fixture.visitor().snapshot();
            access.forwards[0].path == TunnelPath::Relay && provided.connections.len() == 1
                && provided.connections[0].source == TunnelSource::Client
                && provided.connections[0].active_tcp == 1 && provided.connections[0].path == TunnelPath::Relay
        }).await?;
        exchange(&mut provided_to_b, b"b-to-a-original-tcp-after-a-relay-transfer").await?;
        check(fixture.backends[0].accepts.load(Ordering::SeqCst) == 1, "A提供端流被断开后重连，后端接纳数增加")?;
        check(fixture.backends[1].accepts.load(Ordering::SeqCst) == 2, "A访问模式重建不是一次旧流关闭加一次新流")?;
        let a_snapshot = fixture.provider().snapshot();
        check(a_snapshot.provider_id.as_deref() == Some(a_id.as_str()), "切访问模式改变了同Worker提供端身份")?;
        check(a_snapshot.publications.len() == 1 && a_snapshot.publications[0].phase == TunnelPhase::Listening, "切访问模式中断了同Worker的发布")?;
        check(a_snapshot.connections.len() == 1 && a_snapshot.connections[0].active_tcp == 1, "同Worker提供端活动TCP未保持")?;
        let registration_after = fixture.resolve(0).await.map_err(text)?;
        check(registration_after.tunnel_id == original_registration.tunnel_id
            && registration_after.service_token == original_registration.service_token, "切访问模式替换了同Worker的提供端注册")?;
        check(fixture.visitor().snapshot().mode == TunnelMode::Auto, "切A访问模式修改了B的策略")?;
        eprintln!("S1-T12同Worker角色隔离通过：A旧访问TCP已关闭，新访问流实际Relay；B→A原socket持续字节往返，A后端接纳数始终1，A提供端身份和注册不变；B后端接纳数1→2，两个提供端活动TCP均为1。");
        Ok::<_, String>(())
    }).await.map_err(|_| "同Worker角色隔离场景总超时".to_owned()).and_then(|result| result);
    let cleanup = fixture.close(false).await;
    result
        .and(cleanup)
        .expect("切换同Worker访问模式不应中断提供端既有TCP");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worker_lifecycle_control_close_revokes_only_a_and_never_revives_old_token() {
    let fixture = WorkerFixture::start()
        .await
        .expect("应启动真实Worker fixture");
    let result = timeout(Duration::from_secs(45), async {
        let [mut a, mut b] = fixture.connect().await?;
        let old_a = fixture.resolve(0).await.map_err(text)?;
        let old_b = fixture.resolve(1).await.map_err(text)?;
        let old_target = fixture.target(&old_a);
        fixture.probe().probe(&old_target).await?;
        let control = ControlClient::new(&fixture.url(), [31; 32]).map_err(text)?;
        let id = old_a.tunnel_id.clone();
        tokio::task::spawn_blocking(move || control.close_tunnel(&id)).await.map_err(text)?.map_err(text)?;
        let revoked_at = tokio::time::Instant::now();
        closed_by(&mut a, revoked_at + RENEW_INTERVAL + Duration::from_secs(2)).await?;
        fixture.reject_old(&old_target).await?;
        poll("撤销后仅B保留活动流", Duration::from_secs(1), || {
            let rows = fixture.provider().snapshot().connections;
            rows.len() == 1 && rows[0].local_port == fixture.backends[1].addr.port() && rows[0].active_tcp == 1
        }).await?;
        exchange(&mut b, b"b-old-stream-after-a-revoked").await.map_err(|error| format!("A撤销后B旧流失败：{error}"))?;
        eprintln!("逐项撤销阶段：A旧流关闭、旧token拒绝、B旧流仍可往返。");
        let new_a = timeout(Duration::from_secs(10), async {
            let mut tick = tokio::time::interval(Duration::from_millis(50));
            loop {
                match fixture.resolve(0).await {
                    Ok(response) if response.tunnel_id != old_a.tunnel_id => return Ok(response),
                    Ok(_) | Err(ControlClientError::Rejected(ControlServerError::NotFound | ControlServerError::NotReady)) => { tick.tick().await; }
                    Err(error) => return Err(text(error)),
                }
            }
        }).await.map_err(|_| "A自动重新注册未ready".to_owned())??;
        check(new_a.service_token != old_a.service_token, "重新登记复用了旧token")?;
        fixture.probe().probe(&fixture.target(&new_a)).await?;
        fixture.reject_old(&old_target).await?;
        let current_b = fixture.resolve(1).await.map_err(text)?;
        check(current_b.tunnel_id == old_b.tunnel_id && current_b.service_token == old_b.service_token, "撤销A导致B重新登记")?;
        exchange(&mut b, b"b-still-old-flow-after-a-reregister").await.map_err(|error| format!("A重注册后B旧流失败：{error}"))?;
        eprintln!("逐项撤销阶段：新A token探测成功且旧token仍拒绝；B保持原登记与原业务流。");
        poll("A访问映射重新解析后ready", RENEW_INTERVAL + Duration::from_secs(2), || {
            fixture.visitor().snapshot().forwards.iter().any(|row|
                row.local_port == fixture.local_addrs[0].port() && row.phase == TunnelPhase::Listening)
        }).await?;
        let mut replacement_a = TcpStream::connect(fixture.local_addrs[0]).await.map_err(text)?;
        exchange(&mut replacement_a, b"a-new-registration-forward").await.map_err(|error| format!("A重注册后映射首次连接失败：{error}"))?;
        exchange(&mut b, b"b-old-flow-after-new-a-transfer").await?;
        poll("新A和旧B活动流统计", Duration::from_secs(3), || {
            fixture.provider().snapshot().connections.iter().map(|row| row.active_tcp).sum::<u32>() == 2
        }).await?;
        eprintln!("S2-T13逐端口撤销通过：A旧流关闭且旧token拒绝，新token实际转发；B旧登记和旧流持续往返，活动TCP=2。");
        Ok::<_, String>(())
    }).await.map_err(|_| "逐注册Worker撤销场景总超时".to_owned()).and_then(|result| result);
    let cleanup = fixture.close(false).await;
    result.and(cleanup).expect("Worker逐端口撤销真实集成应通过");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn worker_lifecycle_control_outage_revokes_native_direct_with_relay_and_backends_alive() {
    let mut fixture = WorkerFixture::start()
        .await
        .expect("应启动真实Worker fixture");
    let result = timeout(Duration::from_secs(60), async {
        let [mut a, mut b] = fixture.connect().await?;
        let old_a = fixture.resolve(0).await.map_err(text)?;
        let old_b = fixture.resolve(1).await.map_err(text)?;
        let target_a = fixture.target(&old_a);
        let target_b = fixture.target(&old_b);
        fixture.probe().probe(&target_a).await?;
        fixture.probe().probe(&target_b).await?;
        let lost_at = tokio::time::Instant::now();
        fixture.stop_http().await?;
        // 只停止HTTP；同一native direct连接和两个后端继续实际字节转发。
        exchange(&mut a, b"a-control-down-data-still-live").await?;
        exchange(&mut b, b"b-control-down-data-still-live").await?;
        let deadline = lost_at + LEASE_DURATION;
        tokio::try_join!(closed_by(&mut a, deadline), closed_by(&mut b, deadline))?;
        poll("撤销后活动TCP归零", Duration::from_secs(1), || fixture.provider().snapshot().connections.is_empty()).await?;
        fixture.reject_old(&target_a).await?;
        fixture.reject_old(&target_b).await?;
        // 独立relay-only Endpoint在HTTP停服期间仍能认证转发，证明中继未被停止。
        let survivor = start_endpoint(TunnelEndpointConfig { secret_key: None, relay: fixture.relay_config.as_ref().ok_or("缺少relay配置")?.clone(), mode: TunnelMode::RelayOnly }).await?;
        let addr = fixture.backends[0].addr;
        let relay_check = async {
            survivor.register_service(TunnelServiceConfig { tunnel_id: "relay-survivor".to_owned(), service_token: "survivor-test-service-token".to_owned(), local_addr: addr, gateway_id: fixture.probe().id() }).await?;
            let forward = fixture.probe().forward("127.0.0.1:0".parse().map_err(text)?, TunnelTarget { provider_id: survivor.id(), tunnel_id: "relay-survivor".to_owned(), service_token: "survivor-test-service-token".to_owned() }).await?;
            let transferred = async {
                let mut tcp = TcpStream::connect(forward.local_addr()).await.map_err(text)?;
                exchange(&mut tcp, b"relay-alive-with-control-down").await?;
                check(forward.path() == TunnelPath::Relay, "中继存活证据不是真实Relay路径")
            }.await;
            let released = forward.shutdown().await;
            transferred.and(released)
        }.await;
        let survivor_cleanup = survivor.shutdown().await;
        relay_check.and(survivor_cleanup)?;
        for backend in &fixture.backends {
            let mut tcp = TcpStream::connect(backend.addr).await.map_err(text)?;
            exchange(&mut tcp, b"backend-alive-after-native-revoke").await?;
        }
        check(!fixture.provider().is_finished() && !fixture.visitor().is_finished(), "Worker进程停止制造了流关闭")?;
        eprintln!("S2-T13控制失联通过：{:?}内两条native direct旧流关闭，活动TCP=0，旧token明确拒绝；原Worker、relay真实转发和两个后端仍存活。", lost_at.elapsed());
        Ok::<_, String>(())
    }).await.map_err(|_| "控制失联Worker场景总超时".to_owned()).and_then(|result| result);
    let cleanup = fixture.close(true).await;
    result
        .and(cleanup)
        .expect("Worker控制失联期限回收真实集成应通过");
}
