// Derived from rathole (Apache-2.0), reduced to Pi Desk Noise TCP clients.
use super::config::{ClientConfig, ClientServiceConfig, Config};
use super::constants::run_control_chan_backoff;
use super::multiplex::{MultiplexStream, start_parent};
use super::protocol::Hello::{self, *};
use super::protocol::{
    self, Ack, Auth, CURRENT_PROTO_VERSION, ControlChannelCmd, DataChannelCmd, HASH_WIDTH_IN_BYTES,
    read_ack, read_control_cmd, read_data_cmd, read_hello,
};
use super::service_updates::{ClientServiceChange, ConfigChange, ConfigCommand};
use super::transport::{AddrMaybeCached, NoiseTransport, SocketOpts, Transport};
use anyhow::{Context, Result, anyhow, bail};
use backoff::ExponentialBackoff;
use backoff::backoff::Backoff;
use backoff::future::retry_notify;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::io::{AsyncWriteExt, copy_bidirectional};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time::{self, Duration, Instant};
use tracing::{Instrument, Span, debug, error, info, instrument, warn};
use yamux::Mode;

const TRANSPORT_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

pub async fn run_client_with_events(
    config: Config,
    shutdown_rx: broadcast::Receiver<bool>,
    update_rx: mpsc::Receiver<ConfigCommand>,
    events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
) -> Result<()> {
    let result = async {
        let config = config
            .client
            .ok_or_else(|| anyhow!("Noise 客户端配置缺失"))?;
        let mut client = Client::<NoiseTransport>::from(config, events.clone()).await?;
        client.run(shutdown_rx, update_rx).await
    }
    .await;
    super::emit_event(&events, super::RuntimeEvent::Stopped);
    result
}

type ServiceDigest = protocol::Digest;
type Nonce = protocol::Digest;

// Holds the state of a client
struct Client<T: Transport> {
    config: ClientConfig,
    service_handles: HashMap<String, ControlChannelHandle>,
    transport: Arc<T>,
    events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
}

impl<T: 'static + Transport> Client<T> {
    // Create a Client from `[client]` config block
    async fn from(
        config: ClientConfig,
        events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
    ) -> Result<Client<T>> {
        let transport = Arc::new(
            T::new(&config.tcp, None, config.noise.remote_public_key.as_deref())
                .with_context(|| "无法创建 Noise transport")?,
        );
        Ok(Client {
            config,
            service_handles: HashMap::new(),
            transport,
            events,
        })
    }

    // The entrypoint of Client
    async fn run(
        &mut self,
        mut shutdown_rx: broadcast::Receiver<bool>,
        mut update_rx: mpsc::Receiver<ConfigCommand>,
    ) -> Result<()> {
        for (name, config) in &self.config.services {
            // Create a control channel for each service defined
            let handle = ControlChannelHandle::new(
                (*config).clone(),
                self.config.remote_addr.clone(),
                self.transport.clone(),
                self.config.heartbeat_timeout,
                self.events.clone(),
            );
            self.service_handles.insert(name.clone(), handle);
        }

        // Wait for the shutdown signal
        loop {
            tokio::select! {
                val = shutdown_rx.recv() => {
                    match val {
                        Ok(_) => {}
                        Err(err) => {
                            error!("Unable to listen for shutdown signal: {}", err);
                        }
                    }
                    break;
                },
                e = update_rx.recv() => {
                    if let Some(e) = e {
                        self.handle_hot_reload(e).await;
                    }
                }
            }
        }

        // Shutdown all services
        let handles = std::mem::take(&mut self.service_handles);
        for (_, handle) in handles {
            handle.shutdown().await;
        }

        Ok(())
    }

    async fn handle_hot_reload(&mut self, command: ConfigCommand) {
        let (change, ack) = command.into_parts();
        let result = match change {
            ConfigChange::ClientChange(client_change) => match client_change {
                ClientServiceChange::Add(cfg) => match self.validate_service_config(cfg) {
                    Ok(cfg) => {
                        let name = cfg.name.clone();
                        if let Some(handle) = self.service_handles.remove(&name) {
                            handle.shutdown().await;
                        }

                        let handle = ControlChannelHandle::new(
                            cfg,
                            self.config.remote_addr.clone(),
                            self.transport.clone(),
                            self.config.heartbeat_timeout,
                            self.events.clone(),
                        );
                        self.service_handles.insert(name, handle);
                        Ok(())
                    }
                    Err(err) => Err(format!("{:#}", err)),
                },
                ClientServiceChange::Delete(s) => {
                    if let Some(handle) = self.service_handles.remove(&s) {
                        handle.shutdown().await;
                    }
                    Ok(())
                }
            },
            ignored => {
                let error = format!("Cannot apply {:?} while running as a client", ignored);
                warn!("{}", error);
                Err(error)
            }
        };

        ConfigCommand::acknowledge(ack, result);
    }

    fn validate_service_config(&self, service: ClientServiceConfig) -> Result<ClientServiceConfig> {
        if service.name.is_empty() {
            bail!("Service name is not set");
        }

        let name = service.name.clone();
        let mut client = self.config.clone();
        client.services = [(name, service)].into_iter().collect();
        let config = Config {
            server: None,
            client: Some(client),
        }
        .validate_and_complete()?;

        config
            .client
            .and_then(|client| {
                client
                    .services
                    .into_iter()
                    .next()
                    .map(|(_, service)| service)
            })
            .ok_or_else(|| anyhow!("Service validation returned no service"))
    }
}

struct RunDataChannelArgs<T: Transport> {
    session_key: Nonce,
    remote_addr: AddrMaybeCached,
    connector: Arc<T>,
    socket_opts: SocketOpts,
    service: ClientServiceConfig,
}

async fn do_data_channel_handshake<T: Transport>(
    args: Arc<RunDataChannelArgs<T>>,
) -> Result<T::Stream> {
    // Retry at least every 100ms, at most for 10 seconds
    let backoff = ExponentialBackoff {
        max_interval: Duration::from_millis(100),
        max_elapsed_time: Some(Duration::from_secs(10)),
        ..Default::default()
    };

    // Connect to remote_addr
    let mut conn: T::Stream = retry_notify(
        backoff,
        || async {
            time::timeout(
                TRANSPORT_HANDSHAKE_TIMEOUT,
                args.connector.connect(&args.remote_addr),
            )
            .await
            .map_err(|_| {
                anyhow!(
                    "Timed out after {:?} while connecting to {}",
                    TRANSPORT_HANDSHAKE_TIMEOUT,
                    args.remote_addr
                )
            })
            .and_then(|result| {
                result.with_context(|| format!("Failed to connect to {}", args.remote_addr))
            })
            .map_err(backoff::Error::transient)
        },
        |e, duration| {
            warn!("{:#}. Retry in {:?}", e, duration);
        },
    )
    .await?;

    T::hint(&conn, args.socket_opts);

    // Send nonce
    let v: &[u8; HASH_WIDTH_IN_BYTES] = args.session_key[..].try_into().unwrap();
    let hello = Hello::DataChannelHello(CURRENT_PROTO_VERSION, v.to_owned());
    conn.write_all(&bincode::serialize(&hello).unwrap()).await?;
    conn.flush().await?;

    Ok(conn)
}

/// Manages one authenticated TCP yamux parent for the whole control session.
///
/// The initial manager starts after authentication. Each server `CreateDataChannel` request
/// starts one additional manager, so a disconnected parent only reconnects itself and never
/// replaces the other live parents in the group.
async fn run_tcp_multiplexed_parent_session<T: 'static + Transport>(
    args: Arc<RunDataChannelArgs<T>>,
) -> Result<()> {
    loop {
        let conn = match do_data_channel_handshake(args.clone()).await {
            Ok(conn) => conn,
            Err(error) => {
                warn!("Failed to establish TCP data multiplex parent: {error:#}");
                time::sleep(Duration::from_secs(
                    args.service.retry_interval.unwrap_or(1),
                ))
                .await;
                continue;
            }
        };
        let (_controller, mut incoming) = start_parent::<T>(conn, Mode::Server, true);
        let mut forwarding = JoinSet::new();

        while let Some(stream) = incoming.recv().await {
            match stream {
                Ok(stream) => {
                    let local_addr = args.service.local_addr.clone();
                    forwarding.spawn(async move {
                        if let Err(error) = run_multiplexed_tcp_stream(stream, &local_addr).await {
                            debug!("Multiplexed TCP stream ended: {error:#}");
                        }
                    });
                }
                Err(error) => {
                    debug!("Multiplexed TCP parent reported an error: {error:#}");
                    break;
                }
            }
        }

        forwarding.abort_all();
        while forwarding.join_next().await.is_some() {}
        debug!("TCP data multiplex parent disconnected; reconnecting while control stays alive");
        time::sleep(Duration::from_secs(
            args.service.retry_interval.unwrap_or(1),
        ))
        .await;
    }
}

async fn run_multiplexed_tcp_stream(mut stream: MultiplexStream, local_addr: &str) -> Result<()> {
    let DataChannelCmd::StartForwardTcp = read_data_cmd(&mut stream).await?;
    run_data_channel_for_tcp(stream, local_addr).await
}

// Simply copying back and forth for TCP
#[instrument(skip(conn))]
async fn run_data_channel_for_tcp<S>(mut conn: S, local_addr: &str) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    debug!("New data channel starts forwarding");

    let mut local = TcpStream::connect(local_addr)
        .await
        .with_context(|| format!("Failed to connect to {local_addr}"))?;
    // Keep the Yamux stream in one state machine. Splitting it into concurrent read/write
    // halves has known deadlock risks in the upstream Yamux implementation.
    let (from_local, from_yamux) = copy_bidirectional(&mut conn, &mut local)
        .await
        .context("client local socket <-> yamux stream forwarding failed")?;
    debug!(
        from_local,
        from_yamux, "Client TCP stream forwarding completed"
    );
    Ok(())
}

// Control channel, using T as the transport layer
struct ControlChannel<T: Transport> {
    digest: ServiceDigest,                      // SHA256 of the service name
    service: ClientServiceConfig,               // `[client.services.foo]` config block
    shutdown_rx: Option<oneshot::Receiver<u8>>, // Receives the shutdown signal
    remote_addr: String,                        // `client.remote_addr`
    transport: Arc<T>,                          // Wrapper around the transport layer
    heartbeat_timeout: u64,                     // Application layer heartbeat timeout in secs
    events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
    connected: bool,
}

// Handle of a control channel
struct ControlChannelHandle {
    shutdown_tx: Option<oneshot::Sender<u8>>,
    task: JoinHandle<()>,
}

impl<T: 'static + Transport> ControlChannel<T> {
    #[instrument(skip_all)]
    async fn run(&mut self) -> Result<()> {
        let mut shutdown_rx = self
            .shutdown_rx
            .take()
            .expect("control channel shutdown receiver is missing");
        let mut data_channels = JoinSet::new();
        self.connected = false;
        let result = tokio::select! {
            result = self.run_session(&mut data_channels) => result,
            _ = &mut shutdown_rx => Ok(()),
        };
        self.shutdown_rx = Some(shutdown_rx);

        if let Some(error) = result.as_ref().err() {
            // 连接尚未认证时同样通知上层；否则客户端主动关闭只会在服务端表现为 EOF。
            // 对外仅传递固定阶段描述，不泄露中继地址、服务令牌或 Noise 密钥。
            super::emit_event(
                &self.events,
                super::RuntimeEvent::ClientControlDisconnected {
                    service_id: self.service.name.clone(),
                    error: Some(control_channel_failure(error)),
                },
            );
        }
        self.connected = false;

        data_channels.abort_all();
        while let Some(task) = data_channels.join_next().await {
            if let Err(err) = task {
                if !err.is_cancelled() {
                    warn!("Data channel task failed: {}", err);
                }
            }
        }

        result
    }

    async fn run_session(&mut self, data_channels: &mut JoinSet<()>) -> Result<()> {
        let mut remote_addr = AddrMaybeCached::new(&self.remote_addr);
        remote_addr.resolve().await?;

        let mut conn = time::timeout(
            TRANSPORT_HANDSHAKE_TIMEOUT,
            self.transport.connect(&remote_addr),
        )
        .await
        .map_err(|_| {
            anyhow!(
                "Timed out after {:?} while connecting to {}",
                TRANSPORT_HANDSHAKE_TIMEOUT,
                self.remote_addr
            )
        })?
        .with_context(|| format!("Failed to connect to {}", self.remote_addr))?;
        T::hint(&conn, SocketOpts::for_control_channel());

        // Send hello
        debug!("Sending hello");
        let hello_send =
            Hello::ControlChannelHello(CURRENT_PROTO_VERSION, self.digest[..].try_into().unwrap());
        conn.write_all(&bincode::serialize(&hello_send).unwrap())
            .await
            .context("Failed to send control hello")?;
        conn.flush()
            .await
            .context("Failed to flush control hello")?;

        // Read hello
        debug!("Reading hello");
        let nonce = match read_hello(&mut conn)
            .await
            .context("Failed to read server control hello")?
        {
            ControlChannelHello(_, d) => d,
            _ => {
                bail!("Unexpected type of hello");
            }
        };

        // Send auth
        debug!("Sending auth");
        let mut concat = Vec::from(self.service.token.as_ref().unwrap().as_bytes());
        concat.extend_from_slice(&nonce);

        let session_key = protocol::digest(&concat);
        let auth = Auth(session_key);
        conn.write_all(&bincode::serialize(&auth).unwrap())
            .await
            .context("Failed to send control auth")?;
        conn.flush().await.context("Failed to flush control auth")?;

        // Read ack
        debug!("Reading ack");
        match read_ack(&mut conn)
            .await
            .context("Failed to read control authentication acknowledgement")?
        {
            Ack::Ok => {}
            v => {
                return Err(anyhow!("{}", v))
                    .with_context(|| format!("Authentication failed: {}", self.service.name));
            }
        }

        // Channel ready
        info!("Control channel established");
        self.connected = true;
        super::emit_event(
            &self.events,
            super::RuntimeEvent::ClientControlConnected {
                service_id: self.service.name.clone(),
            },
        );

        // Socket options for the data channel
        let socket_opts = SocketOpts::from_client_cfg(&self.service);
        let data_ch_args = Arc::new(RunDataChannelArgs {
            session_key,
            remote_addr,
            connector: self.transport.clone(),
            socket_opts,
            service: self.service.clone(),
        });

        let args = data_ch_args.clone();
        data_channels.spawn(async move {
            if let Err(error) = run_tcp_multiplexed_parent_session(args).await {
                warn!("Initial TCP data multiplex parent session stopped: {error:#}");
            }
        });

        // 只有服务端 HeartBeat 能续期；数据通道命令不能掩盖心跳丢失。
        let heartbeat_period = Duration::from_secs(self.heartbeat_timeout.max(1));
        let mut heartbeat_deadline = Box::pin(time::sleep(heartbeat_period));
        loop {
            tokio::select! {
                val = read_control_cmd(&mut conn) => {
                    let val = match val {
                        Ok(val) => val,
                        Err(err) => break Err(err),
                    };
                    debug!( "Received {:?}", val);
                    match val {
                        ControlChannelCmd::CreateDataChannel => {
                            // V2 TCP reuses this command as an authenticated request for one
                            // additional long-lived yamux parent, never as a legacy UDP path.
                            let args = data_ch_args.clone();
                            data_channels.spawn(async move {
                                if let Err(error) = run_tcp_multiplexed_parent_session(args).await {
                                    warn!("Additional TCP data multiplex parent session stopped: {error:#}");
                                }
                            }.instrument(Span::current()));
                        },
                        ControlChannelCmd::HeartBeat => {
                            heartbeat_deadline.as_mut().reset(Instant::now() + heartbeat_period);
                        }
                    }
                },
                _ = &mut heartbeat_deadline, if self.heartbeat_timeout != 0 => {
                    break Err(anyhow!("Heartbeat timed out"));
                }
                task = data_channels.join_next(), if !data_channels.is_empty() => {
                    if let Some(Err(err)) = task {
                        warn!("Data channel task failed: {}", err);
                    }
                }
            }
        }
    }
}

fn control_channel_failure(error: &anyhow::Error) -> String {
    let detail = format!("{error:#}");
    if detail.contains("Protocol version mismatched") {
        "控制协议版本不匹配".into()
    } else if detail.contains("Failed to do noise handshake") {
        "Noise 传输握手失败".into()
    } else if detail.contains("Failed to send control hello") {
        "发送控制 hello 失败".into()
    } else if detail.contains("Failed to read server control hello") {
        "读取服务端控制 hello 失败".into()
    } else if detail.contains("Unexpected type of hello") {
        "服务端返回了无效的控制 hello".into()
    } else if detail.contains("Failed to send control auth") {
        "发送控制认证信息失败".into()
    } else if detail.contains("Failed to read control authentication acknowledgement") {
        "读取服务端认证确认失败".into()
    } else if detail.contains("Authentication failed") || detail.contains("Incorrect token") {
        "隧道服务认证被拒绝".into()
    } else {
        "控制通道连接或握手失败".into()
    }
}

impl ControlChannelHandle {
    #[instrument(name="handle", skip_all, fields(service = %service.name))]
    fn new<T: 'static + Transport>(
        service: ClientServiceConfig,
        remote_addr: String,
        transport: Arc<T>,
        heartbeat_timeout: u64,
        events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
    ) -> ControlChannelHandle {
        let digest = protocol::digest(service.name.as_bytes());

        info!("Starting {}", hex::encode(digest));
        let (shutdown_tx, shutdown_rx) = oneshot::channel();

        let mut retry_backoff = run_control_chan_backoff(service.retry_interval.unwrap());

        let mut s = ControlChannel {
            digest,
            service,
            shutdown_rx: Some(shutdown_rx),
            remote_addr,
            transport,
            heartbeat_timeout,
            events,
            connected: false,
        };

        let task = tokio::spawn(
            async move {
                let mut start = Instant::now();

                while let Err(err) = s
                    .run()
                    .await
                    .with_context(|| "Failed to run the control channel")
                {
                    if s
                        .shutdown_rx
                        .as_mut()
                        .expect("control channel shutdown receiver is missing")
                        .try_recv()
                        != Err(oneshot::error::TryRecvError::Empty)
                    {
                        break;
                    }

                    if start.elapsed() > Duration::from_secs(3) {
                        // The client runs for at least 3 secs and then disconnects
                        retry_backoff.reset();
                    }

                    if let Some(duration) = retry_backoff.next_backoff() {
                        error!(
                            "隧道控制通道失败：{}；将在 {:?} 后重试",
                            control_channel_failure(&err),
                            duration
                        );
                        tokio::select! {
                            _ = time::sleep(duration) => {}
                            _ = s.shutdown_rx.as_mut().expect("control channel shutdown receiver is missing") => break,
                        }
                    } else {
                        // Should never reach
                        panic!("{:#}. Break", err);
                    }

                    start = Instant::now();
                }
            }
            .instrument(Span::current()),
        );

        ControlChannelHandle {
            shutdown_tx: Some(shutdown_tx),
            task,
        }
    }

    async fn shutdown(mut self) {
        // The task listens for this signal during DNS, connects, handshakes, and backoff.
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(0u8);
        }
        let _ = (&mut self.task).await;
    }
}

impl Drop for ControlChannelHandle {
    fn drop(&mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(0u8);
        }
    }
}
