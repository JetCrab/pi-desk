// Derived from rathole (Apache-2.0), reduced to Pi Desk Noise TCP servers.
use super::config::{Config, ServerConfig, ServerServiceConfig};
use super::constants::listen_backoff;
use super::helper::{retry_notify_with_deadline, write_and_flush};
use super::multi_map::MultiMap;
use super::multiplex::{MultiplexController, MultiplexStream, start_parent};
use super::protocol::Hello::{ControlChannelHello, DataChannelHello};
use super::protocol::{
    self, Ack, ControlChannelCmd, DataChannelCmd, HASH_WIDTH_IN_BYTES, Hello, read_auth, read_hello,
};
use super::service_updates::{ConfigChange, ConfigCommand, ServerServiceChange};
use super::transport::{NoiseTransport, SocketOpts, Transport};
use anyhow::{Context, Result, anyhow, bail};
use backoff::ExponentialBackoff;
use backoff::backoff::Backoff;
use rand::RngCore;
use std::collections::HashMap;
use std::io;
use std::marker::PhantomData;
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::Duration;
use tokio::io::{AsyncWriteExt, copy_bidirectional};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Mutex, Notify, RwLock, broadcast, mpsc, oneshot};
use tokio::task::{JoinHandle, JoinSet};
use tokio::time;
use tracing::{Instrument, Span, debug, error, info, info_span, instrument, warn};
use yamux::Mode;

const HANDSHAKE_TIMEOUT: u64 = 5;
const CONTROL_CHANNEL_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const TCP_PARENT_STREAM_TARGET: usize = 32;
type ServiceDigest = protocol::Digest;
type Nonce = protocol::Digest;

pub async fn run_server_with_events(
    config: Config,
    shutdown_rx: broadcast::Receiver<bool>,
    update_rx: mpsc::Receiver<ConfigCommand>,
    events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
) -> Result<()> {
    let result = async {
        let config = config
            .server
            .ok_or_else(|| anyhow!("Noise 服务端配置缺失"))?;
        let mut server = Server::<NoiseTransport>::from(config, events.clone()).await?;
        server.run(shutdown_rx, update_rx).await
    }
    .await;
    super::emit_event(&events, super::RuntimeEvent::Stopped);
    result
}

// A hash map of ControlChannelHandles, indexed by ServiceDigest or Nonce
// See also MultiMap
type ControlChannelMap<T> = MultiMap<ServiceDigest, Nonce, ControlChannelHandle<T>>;

#[derive(Clone)]
struct ServerServiceEntry {
    config: ServerServiceConfig,
    generation: u64,
}

struct ServerServices {
    entries: HashMap<ServiceDigest, ServerServiceEntry>,
    next_generation: u64,
}

impl ServerServices {
    fn from_config(server_config: &ServerConfig) -> Self {
        let mut services = Self {
            entries: HashMap::new(),
            next_generation: 0,
        };
        for (name, service) in &server_config.services {
            services.insert(protocol::digest(name.as_bytes()), service.clone());
        }
        services
    }

    fn insert(&mut self, digest: ServiceDigest, config: ServerServiceConfig) {
        self.next_generation = self
            .next_generation
            .checked_add(1)
            .expect("server service generation exhausted");
        self.entries.insert(
            digest,
            ServerServiceEntry {
                config,
                generation: self.next_generation,
            },
        );
    }
}

// Server holds all states of running a server
struct Server<T: Transport> {
    // `[server]` config
    config: Arc<ServerConfig>,

    // `[server.services]` config and lifecycle generations, indexed by ServiceDigest
    services: Arc<RwLock<ServerServices>>,
    // Collection of contorl channels
    control_channels: Arc<RwLock<ControlChannelMap<T>>>,
    // Wrapper around the transport layer
    transport: Arc<T>,
    events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
}

impl<T: 'static + Transport> Server<T> {
    // Create a server from `[server]`
    pub async fn from(
        config: ServerConfig,
        events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
    ) -> Result<Server<T>> {
        let config = Arc::new(config);
        let services = Arc::new(RwLock::new(ServerServices::from_config(&config)));
        let control_channels = Arc::new(RwLock::new(ControlChannelMap::new()));
        let transport = Arc::new(T::new(
            &config.tcp,
            config.noise.local_private_key.as_deref(),
            None,
        )?);
        Ok(Server {
            config,
            services,
            control_channels,
            transport,
            events,
        })
    }

    // The entry point of Server
    pub async fn run(
        &mut self,
        mut shutdown_rx: broadcast::Receiver<bool>,
        mut update_rx: mpsc::Receiver<ConfigCommand>,
    ) -> Result<()> {
        // Listen at `server.bind_addr`
        let l = self
            .transport
            .bind(&self.config.bind_addr)
            .await
            .with_context(|| "Failed to listen at `server.bind_addr`")?;
        info!("Listening at {}", self.config.bind_addr);

        // Retry at least every 100ms
        let mut backoff = ExponentialBackoff {
            max_interval: Duration::from_millis(100),
            max_elapsed_time: None,
            ..Default::default()
        };

        let mut connection_tasks = JoinSet::new();

        // Wait for connections and shutdown signals
        loop {
            tokio::select! {
                // Wait for incoming control and data channels
                ret = self.transport.accept(&l) => {
                    match ret {
                        Err(err) => {
                            // Detects whether it's an IO error
                            if let Some(err) = err.downcast_ref::<io::Error>() {
                                // If it is an IO error, then it's possibly an
                                // EMFILE. So sleep for a while and retry
                                // TODO: Only sleep for EMFILE, ENFILE, ENOMEM, ENOBUFS
                                if let Some(d) = backoff.next_backoff() {
                                    error!("Failed to accept: {:#}. Retry in {:?}...", err, d);
                                    time::sleep(d).await;
                                } else {
                                    // This branch will never be executed according to the current retry policy
                                    error!("Too many retries. Aborting...");
                                    break;
                                }
                            }
                            // If it's not an IO error, then it comes from
                            // the transport layer, so just ignore it
                        }
                        Ok((conn, addr)) => {
                            backoff.reset();
                            // A slow or malicious transport handshake must not delay accepting
                            // later control/data parents. Shutdown aborts these tasks below.
                            let transport = self.transport.clone();
                            let services = self.services.clone();
                            let control_channels = self.control_channels.clone();
                            let server_config = self.config.clone();
                            let events = self.events.clone();
                            connection_tasks.spawn(async move {
                                let conn = match time::timeout(
                                    Duration::from_secs(HANDSHAKE_TIMEOUT),
                                    transport.handshake(conn),
                                )
                                .await
                                {
                                    Ok(Ok(conn)) => conn,
                                    Ok(Err(error)) => {
                                        error!("Failed to do transport handshake: {error:#}");
                                        return;
                                    }
                                    Err(error) => {
                                        error!("Transport handshake timeout: {error}");
                                        return;
                                    }
                                };

                                if let Err(error) = handle_connection(
                                    conn,
                                    services,
                                    control_channels,
                                    server_config,
                                    events,
                                )
                                .await
                                {
                                    error!("{error:#}");
                                }
                            }.instrument(info_span!("connection", %addr)));
                        }
                    }
                },
                // Wait for the shutdown signal
                _ = shutdown_rx.recv() => {
                    info!("Shuting down gracefully...");
                    break;
                },
                e = update_rx.recv() => {
                    if let Some(e) = e {
                        self.handle_hot_reload(e).await;
                    }
                }
                task = connection_tasks.join_next(), if !connection_tasks.is_empty() => {
                    if let Some(Err(err)) = task {
                        error!("Connection task failed: {}", err);
                    }
                }
            }
        }

        shutdown_tasks(&mut connection_tasks).await;
        self.shutdown_control_channels().await;

        info!("Shutdown");

        Ok(())
    }

    async fn shutdown_control_channels(&self) {
        let handles = self.control_channels.write().await.drain();
        for handle in handles {
            handle.shutdown().await;
        }
    }

    async fn handle_hot_reload(&mut self, command: ConfigCommand) {
        let (change, ack) = command.into_parts();
        let result = match change {
            ConfigChange::ServerChange(server_change) => match server_change {
                ServerServiceChange::Add(cfg) => match self.validate_service_config(cfg) {
                    Ok(cfg) => {
                        let hash = protocol::digest(cfg.name.as_bytes());
                        // All service mutations acquire services before control_channels. This makes
                        // Add/Delete atomic with a handshake's generation revalidation.
                        let replaced = {
                            let mut services = self.services.write().await;
                            services.insert(hash, cfg);
                            self.control_channels.write().await.remove1(&hash)
                        };
                        if let Some(handle) = replaced {
                            handle.shutdown().await;
                        }
                        Ok(())
                    }
                    Err(err) => Err(format!("{:#}", err)),
                },
                ServerServiceChange::Delete(s) => {
                    let hash = protocol::digest(s.as_bytes());
                    // Removing the generation before releasing services prevents an in-flight
                    // handshake from committing or activating after this command is acknowledged.
                    let removed = {
                        let mut services = self.services.write().await;
                        services.entries.remove(&hash);
                        self.control_channels.write().await.remove1(&hash)
                    };
                    if let Some(handle) = removed {
                        handle.shutdown().await;
                    }
                    Ok(())
                }
            },
            ignored => {
                let error = format!("Cannot apply {:?} while running as a server", ignored);
                warn!("{}", error);
                Err(error)
            }
        };

        ConfigCommand::acknowledge(ack, result);
    }

    fn validate_service_config(&self, service: ServerServiceConfig) -> Result<ServerServiceConfig> {
        if service.name.is_empty() {
            bail!("Service name is not set");
        }

        let name = service.name.clone();
        let mut server = (*self.config).clone();
        server.services = [(name, service)].into_iter().collect();
        let config = Config {
            server: Some(server),
            client: None,
        }
        .validate_and_complete()?;

        config
            .server
            .and_then(|server| {
                server
                    .services
                    .into_iter()
                    .next()
                    .map(|(_, service)| service)
            })
            .ok_or_else(|| anyhow!("Service validation returned no service"))
    }
}

async fn shutdown_tasks(tasks: &mut JoinSet<()>) {
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
}

// Handle connections to `server.bind_addr`
async fn handle_connection<T: 'static + Transport>(
    mut conn: T::Stream,
    services: Arc<RwLock<ServerServices>>,
    control_channels: Arc<RwLock<ControlChannelMap<T>>>,
    server_config: Arc<ServerConfig>,
    events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
) -> Result<()> {
    // Read hello
    let hello = read_hello(&mut conn).await?;
    match hello {
        ControlChannelHello(_, service_digest) => {
            do_control_channel_handshake(
                conn,
                services,
                control_channels,
                service_digest,
                server_config,
                events,
            )
            .await?;
        }
        DataChannelHello(_, nonce) => {
            do_data_channel_handshake(conn, control_channels, nonce).await?;
        }
    }
    Ok(())
}

async fn do_control_channel_handshake<T: 'static + Transport>(
    mut conn: T::Stream,
    services: Arc<RwLock<ServerServices>>,
    control_channels: Arc<RwLock<ControlChannelMap<T>>>,
    service_digest: ServiceDigest,
    server_config: Arc<ServerConfig>,
    events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
) -> Result<()> {
    info!("Try to handshake a control channel");

    T::hint(&conn, SocketOpts::for_control_channel());

    // Generate a nonce
    let mut nonce = vec![0u8; HASH_WIDTH_IN_BYTES];
    rand::thread_rng().fill_bytes(&mut nonce);

    // Send hello
    let hello_send = Hello::ControlChannelHello(
        protocol::CURRENT_PROTO_VERSION,
        nonce.clone().try_into().unwrap(),
    );
    conn.write_all(&bincode::serialize(&hello_send).unwrap())
        .await?;
    conn.flush().await?;

    // Capture the service configuration and generation used for authentication. The
    // generation is revalidated atomically before this handshake can expose a listener.
    let (service_config, service_generation) =
        match services.read().await.entries.get(&service_digest) {
            Some(entry) => (entry.config.clone(), entry.generation),
            None => {
                conn.write_all(&bincode::serialize(&Ack::ServiceNotExist).unwrap())
                    .await?;
                bail!("No such a service {}", hex::encode(service_digest));
            }
        };

    let service_name = service_config.name.clone();

    // Calculate the checksum
    let mut concat = Vec::from(service_config.token.as_ref().unwrap().as_bytes());
    concat.append(&mut nonce);

    // Read auth
    let protocol::Auth(d) = read_auth(&mut conn).await?;

    // Validate
    let session_key = protocol::digest(&concat);
    if session_key != d {
        conn.write_all(&bincode::serialize(&Ack::AuthFailed).unwrap())
            .await?;
        debug!(service = %service_name, "Control channel authentication failed");
        bail!("Service {} failed the authentication", service_name);
    } else {
        // Send ack before the commit, as required by the existing wire protocol. A Delete or
        // replacement after this point is caught by commit_control_channel's generation check.
        conn.write_all(&bincode::serialize(&Ack::Ok).unwrap())
            .await?;
        conn.flush().await?;

        info!(service = %service_config.name, "Control channel authenticated");
        let (handle, activation) = ControlChannelHandle::new(
            conn,
            service_config,
            server_config.heartbeat_interval,
            events,
        );
        if !commit_control_channel(
            &services,
            &control_channels,
            service_digest,
            service_generation,
            session_key,
            handle,
            activation,
        )
        .await
        {
            debug!(service = %service_name, "Discarded stale control channel handshake");
        }
    }

    Ok(())
}

async fn commit_control_channel<T: 'static + Transport>(
    services: &Arc<RwLock<ServerServices>>,
    control_channels: &Arc<RwLock<ControlChannelMap<T>>>,
    service_digest: ServiceDigest,
    generation: u64,
    session_key: Nonce,
    handle: ControlChannelHandle<T>,
    activation: ControlChannelActivation,
) -> bool {
    let mut pending = Some(handle);
    let mut activation = Some(activation);
    let mut displaced = None;
    let mut inserted = false;

    {
        // The services -> control_channels order is shared with Add/Delete. The new handle is
        // indexed before its listener is activated, so its data parents can authenticate while
        // the previous public listener finishes releasing the same port.
        let services = services.read().await;
        if services
            .entries
            .get(&service_digest)
            .is_some_and(|entry| entry.generation == generation)
        {
            let mut control_channels = control_channels.write().await;
            let handle = pending.take().expect("pending control handle is missing");
            displaced = control_channels.remove1(&service_digest);
            match control_channels.insert(service_digest, session_key, handle) {
                Ok(()) => inserted = true,
                Err((_, _, handle)) => pending = Some(handle),
            }
        }
    }

    if let Some(handle) = displaced {
        // The listener task only returns after its socket is released. Activating a replacement
        // before this point races two handles for the same public port during control reconnect.
        handle.shutdown().await;
    }

    if !inserted {
        drop(activation);
        if let Some(handle) = pending {
            handle.shutdown().await;
        }
        return false;
    }

    let is_current = {
        let services = services.read().await;
        let control_channels = control_channels.read().await;
        services
            .entries
            .get(&service_digest)
            .is_some_and(|entry| entry.generation == generation)
            && control_channels.get2(&session_key).is_some()
    };
    if is_current
        && activation
            .take()
            .expect("control activation is missing")
            .activate()
            .is_ok()
    {
        return true;
    }

    warn!("Control channel stopped before activation");
    let pending = {
        let mut control_channels = control_channels.write().await;
        if control_channels.get2(&session_key).is_some() {
            control_channels.remove1(&service_digest)
        } else {
            None
        }
    };
    if let Some(handle) = pending {
        handle.shutdown().await;
    }

    false
}

async fn do_data_channel_handshake<T: 'static + Transport>(
    conn: T::Stream,
    control_channels: Arc<RwLock<ControlChannelMap<T>>>,
    nonce: Nonce,
) -> Result<()> {
    let target = {
        let control_channels = control_channels.read().await;
        control_channels.get2(&nonce).map(|handle| {
            (
                handle.data_parents.clone(),
                SocketOpts::from_server_cfg(&handle.service),
            )
        })
    };
    let Some((data_parents, socket_opts)) = target else {
        warn!("Data channel has incorrect nonce");
        return Ok(());
    };
    T::hint(&conn, socket_opts);
    if !data_parents.install::<T>(conn).await {
        warn!("Rejected TCP data multiplex parent after control shutdown");
    }
    Ok(())
}

/// One active yamux parent and its number of assigned logical streams.
#[derive(Clone)]
struct DataParent {
    controller: MultiplexController,
    streams: Arc<AtomicUsize>,
}

/// Releases a parent's load only after its visitor forwarding task finishes.
struct DataParentLease {
    streams: Arc<AtomicUsize>,
}

impl Drop for DataParentLease {
    fn drop(&mut self) {
        self.streams.fetch_sub(1, Ordering::Release);
    }
}

struct DataParentGroupState {
    parents: Vec<DataParent>,
    // The initial client session counts as one pending parent. Later pending parents are each
    // requested over the control channel, which prevents every overloaded visitor from sending
    // another request before the prior one has completed its handshake.
    pending: usize,
    closed: bool,
}

/// Holds all TCP yamux parents for one authenticated control session.
struct DataParentGroup {
    state: Mutex<DataParentGroupState>,
    ready: Notify,
    request_tx: mpsc::UnboundedSender<bool>,
}

impl DataParentGroup {
    fn new(request_tx: mpsc::UnboundedSender<bool>) -> Self {
        Self {
            state: Mutex::new(DataParentGroupState {
                parents: Vec::new(),
                pending: 1,
                closed: false,
            }),
            ready: Notify::new(),
            request_tx,
        }
    }

    fn discard_closed_parents(state: &mut DataParentGroupState) {
        let original_count = state.parents.len();
        state
            .parents
            .retain(|parent| !parent.controller.is_closed());
        // Every installed parent belongs to exactly one client session manager. A closed parent
        // has a manager reconnecting it, so reserve that replacement before deciding whether to
        // request an additional parent over the control connection.
        state.pending = state
            .pending
            .saturating_add(original_count - state.parents.len());
    }

    async fn install<T: Transport>(&self, conn: T::Stream) -> bool {
        let (controller, _incoming) = start_parent::<T>(conn, Mode::Client, false);
        let mut state = self.state.lock().await;
        if state.closed {
            controller.shutdown();
            return false;
        }

        Self::discard_closed_parents(&mut state);
        state.pending = state.pending.saturating_sub(1);
        state.parents.push(DataParent {
            controller,
            streams: Arc::new(AtomicUsize::new(0)),
        });
        drop(state);
        self.ready.notify_waiters();
        true
    }

    fn request_parent(state: &mut DataParentGroupState, request_tx: &mpsc::UnboundedSender<bool>) {
        if state.pending == 0 && request_tx.send(true).is_ok() {
            state.pending = 1;
        }
    }

    async fn open_stream(
        &self,
        mut shutdown_rx: broadcast::Receiver<bool>,
    ) -> Result<(MultiplexStream, DataParentLease)> {
        loop {
            let notified = self.ready.notified();
            let parent = {
                let mut state = self.state.lock().await;
                if state.closed {
                    bail!("TCP service is shutting down");
                }
                Self::discard_closed_parents(&mut state);

                let parent = state
                    .parents
                    .iter()
                    .min_by_key(|parent| parent.streams.load(Ordering::Acquire))
                    .cloned();
                let parent = parent.filter(|parent| {
                    parent.streams.load(Ordering::Acquire) < TCP_PARENT_STREAM_TARGET
                });
                if let Some(parent) = &parent {
                    parent.streams.fetch_add(1, Ordering::AcqRel);
                } else {
                    // The target is a sharding point, never a capacity limit. Once every live
                    // parent reaches it, keep the visitor queued until the already-requested
                    // parent completes its authenticated handshake instead of concentrating all
                    // later streams on the current TCP connection.
                    Self::request_parent(&mut state, &self.request_tx);
                }
                parent
            };

            if let Some(parent) = parent {
                let lease = DataParentLease {
                    streams: parent.streams.clone(),
                };
                match parent.controller.open_stream().await {
                    Ok(stream) => return Ok((stream, lease)),
                    Err(error) => {
                        debug!("TCP multiplex parent ended while opening a stream: {error:#}");
                        drop(lease);
                        let mut state = self.state.lock().await;
                        let original_count = state.parents.len();
                        state.parents.retain(|active| {
                            !active.controller.is_same_parent(&parent.controller)
                                && !active.controller.is_closed()
                        });
                        state.pending = state
                            .pending
                            .saturating_add(original_count - state.parents.len());
                        continue;
                    }
                }
            }

            tokio::select! {
                _ = notified => {}
                _ = shutdown_rx.recv() => bail!("TCP service is shutting down"),
            }
        }
    }

    async fn shutdown(&self) {
        let parents = {
            let mut state = self.state.lock().await;
            state.closed = true;
            std::mem::take(&mut state.parents)
        };
        for parent in parents {
            parent.controller.shutdown();
        }
        self.ready.notify_waiters();
    }
}

pub struct ControlChannelHandle<T: Transport> {
    shutdown_tx: Option<broadcast::Sender<bool>>,
    _data_ch_req_tx: mpsc::UnboundedSender<bool>,
    data_parents: Arc<DataParentGroup>,
    service: ServerServiceConfig,
    control_task: JoinHandle<()>,
    pool_task: JoinHandle<()>,
    marker: PhantomData<T>,
}

struct ControlChannelActivation {
    listener_tx: oneshot::Sender<()>,
    control_tx: oneshot::Sender<()>,
}

impl ControlChannelActivation {
    fn activate(self) -> Result<(), ()> {
        let listener_result = self.listener_tx.send(());
        let control_result = self.control_tx.send(());
        listener_result.and(control_result)
    }
}

impl<T> ControlChannelHandle<T>
where
    T: 'static + Transport,
{
    // Create a control channel handle, where the control channel handling task
    // and the connection pool task are created.
    #[instrument(name = "handle", skip_all, fields(service = %service.name))]
    fn new(
        conn: T::Stream,
        service: ServerServiceConfig,
        heartbeat_interval: u64,
        events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
    ) -> (ControlChannelHandle<T>, ControlChannelActivation) {
        // Create a shutdown channel
        let (shutdown_tx, shutdown_rx) = broadcast::channel::<bool>(1);
        let (listener_tx, listener_rx) = oneshot::channel();
        let (control_tx, control_rx) = oneshot::channel();

        let (data_ch_req_tx, data_ch_req_rx) = mpsc::unbounded_channel();
        let data_parents = Arc::new(DataParentGroup::new(data_ch_req_tx.clone()));
        let shutdown_rx_clone = shutdown_tx.subscribe();
        let bind_addr = service.bind_addr.clone();
        let service_id = service.name.clone();
        let listener_parents = data_parents.clone();
        let pool_task = tokio::spawn(
            async move {
                if let Err(error) = run_tcp_multiplexed_listener(
                    service_id,
                    bind_addr,
                    listener_parents,
                    shutdown_rx_clone,
                    listener_rx,
                    events,
                )
                .await
                .with_context(|| "Failed to run TCP multiplex listener")
                {
                    error!("{error:#}");
                }
            }
            .instrument(Span::current()),
        );

        // Create the control channel
        let ch = ControlChannel::<T> {
            conn,
            shutdown_rx,
            data_ch_req_rx,
            heartbeat_interval,
        };

        // Do not request data channels until the handshake inserts this handle by nonce.
        // A control disconnect owns the complete service session, so it also stops every TCP
        // parent and listener rather than leaving an orphaned public port behind.
        let control_shutdown_tx = shutdown_tx.clone();
        let control_task = tokio::spawn(
            async move {
                if control_rx.await.is_ok() {
                    if let Err(err) = ch.run().await {
                        error!("{:#}", err);
                    }
                    let _ = control_shutdown_tx.send(true);
                }
            }
            .instrument(Span::current()),
        );

        (
            ControlChannelHandle {
                shutdown_tx: Some(shutdown_tx),
                _data_ch_req_tx: data_ch_req_tx,
                data_parents,
                service,
                control_task,
                pool_task,
                marker: PhantomData,
            },
            ControlChannelActivation {
                listener_tx,
                control_tx,
            },
        )
    }

    async fn shutdown(mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(true);
        }
        self.data_parents.shutdown().await;
        wait_for_task(&mut self.control_task, "control channel").await;
        wait_for_task(&mut self.pool_task, "connection pool").await;
    }
}

async fn wait_for_task(task: &mut JoinHandle<()>, name: &str) {
    if time::timeout(CONTROL_CHANNEL_SHUTDOWN_TIMEOUT, &mut *task)
        .await
        .is_err()
    {
        warn!(
            task = name,
            "Control channel shutdown timed out; aborting task"
        );
        task.abort();
        let _ = task.await;
    }
}

impl<T: Transport> Drop for ControlChannelHandle<T> {
    fn drop(&mut self) {
        if let Some(shutdown_tx) = self.shutdown_tx.take() {
            let _ = shutdown_tx.send(true);
        }
    }
}

// Control channel owns Noise-authenticated TCP parent requests.
struct ControlChannel<T: Transport> {
    conn: T::Stream,                               // The connection of control channel
    shutdown_rx: broadcast::Receiver<bool>,        // Receives the shutdown signal
    data_ch_req_rx: mpsc::UnboundedReceiver<bool>, // Receives visitor connections
    heartbeat_interval: u64,                       // Application-layer heartbeat interval in secs
}

impl<T: Transport> ControlChannel<T> {
    async fn write_and_flush(&mut self, data: &[u8]) -> Result<()> {
        write_and_flush(&mut self.conn, data)
            .await
            .with_context(|| "Failed to write control cmds")?;
        Ok(())
    }
    // Run a control channel
    #[instrument(skip_all)]
    async fn run(mut self) -> Result<()> {
        let create_ch_cmd = bincode::serialize(&ControlChannelCmd::CreateDataChannel).unwrap();
        let heartbeat = bincode::serialize(&ControlChannelCmd::HeartBeat).unwrap();

        // 数据通道请求不能重置心跳期限，否则繁忙的隧道会让客户端错误超时。
        let heartbeat_period = Duration::from_secs(self.heartbeat_interval.max(1));
        let mut heartbeat_timer =
            time::interval_at(time::Instant::now() + heartbeat_period, heartbeat_period);

        // Wait for data channel requests and the shutdown signal
        loop {
            tokio::select! {
                val = self.data_ch_req_rx.recv() => {
                    match val {
                        Some(_) => {
                            if let Err(e) = self.write_and_flush(&create_ch_cmd).await {
                                error!("{:#}", e);
                                break;
                            }
                        }
                        None => {
                            break;
                        }
                    }
                },
                _ = heartbeat_timer.tick(), if self.heartbeat_interval != 0 => {
                            if let Err(e) = self.write_and_flush(&heartbeat).await {
                                error!("{:#}", e);
                                break;
                            }
                }
                // Wait for the shutdown signal
                _ = self.shutdown_rx.recv() => {
                    break;
                }
            }
        }

        info!("Control channel shutdown");

        Ok(())
    }
}

#[instrument(skip_all)]
async fn run_tcp_multiplexed_listener(
    service_id: String,
    bind_addr: String,
    data_parents: Arc<DataParentGroup>,
    mut shutdown_rx: broadcast::Receiver<bool>,
    mut activation_rx: oneshot::Receiver<()>,
    events: Option<mpsc::UnboundedSender<super::RuntimeEvent>>,
) -> Result<()> {
    tokio::select! {
        activation = &mut activation_rx => {
            if activation.is_err() {
                return Ok(());
            }
        }
        _ = shutdown_rx.recv() => return Ok(()),
    }

    let retry_service_id = service_id.clone();
    let retry_events = events.clone();
    let listener = retry_notify_with_deadline(
        listen_backoff(),
        || async { Ok(TcpListener::bind(&bind_addr).await?) },
        move |error, duration| {
            error!("{error:#}. Retry in {duration:?}");
            super::emit_event(
                &retry_events,
                super::RuntimeEvent::ServerServiceFailed {
                    service_id: retry_service_id.clone(),
                    error: "service listener bind failed".to_owned(),
                },
            );
        },
        &mut shutdown_rx,
    )
    .await
    .with_context(|| "Failed to listen for the service");
    let listener = match listener {
        Ok(listener) => listener,
        Err(error) => {
            if !error.to_string().contains("shutdown") {
                super::emit_event(
                    &events,
                    super::RuntimeEvent::ServerServiceFailed {
                        service_id,
                        error: "service listener stopped before binding".to_owned(),
                    },
                );
            }
            return Err(error);
        }
    };

    info!("Listening at {bind_addr}");
    super::emit_event(
        &events,
        super::RuntimeEvent::ServerServiceListening {
            service_id,
            bind_addr: bind_addr.clone(),
        },
    );

    let start_forward = bincode::serialize(&DataChannelCmd::StartForwardTcp).unwrap();
    let mut forwarding = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok((visitor, address)) => {
                    debug!("New visitor from {address}");
                    let data_parents = data_parents.clone();
                    let command = start_forward.clone();
                    let visitor_shutdown = shutdown_rx.resubscribe();
                    forwarding.spawn(async move {
                        let (mut stream, _parent_lease) = data_parents.open_stream(visitor_shutdown).await?;
                        write_and_flush(&mut stream, &command).await?;
                        forward_tcp_visitor(stream, visitor).await
                    });
                }
                Err(error) => error!("TCP listener accept failed: {error}"),
            },
            _ = shutdown_rx.recv() => break,
            completed = forwarding.join_next(), if !forwarding.is_empty() => {
                if let Some(result) = completed {
                    match result {
                        Ok(Err(error)) => warn!("Server visitor/yamux stream forwarding failed: {error:#}"),
                        Err(error) => warn!("TCP multiplex forwarding task failed: {error}"),
                        Ok(Ok(())) => {}
                    }
                }
            }
        }
    }

    forwarding.abort_all();
    while let Some(task) = forwarding.join_next().await {
        if let Err(error) = task {
            if !error.is_cancelled() {
                warn!("TCP multiplex forwarding task failed while stopping: {error}");
            }
        }
    }
    info!("TCP multiplex listener shutdown");
    Ok(())
}

async fn forward_tcp_visitor(mut stream: MultiplexStream, mut visitor: TcpStream) -> Result<()> {
    // Keep the Yamux stream in one state machine. Splitting it into concurrent read/write
    // halves has known deadlock risks in the upstream Yamux implementation.
    let (from_visitor, from_yamux) = copy_bidirectional(&mut stream, &mut visitor)
        .await
        .context("server visitor socket <-> yamux stream forwarding failed")?;
    debug!(
        from_visitor,
        from_yamux, "Server TCP stream forwarding completed"
    );
    Ok(())
}
