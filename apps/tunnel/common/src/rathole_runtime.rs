// Derived from rathole (Apache-2.0), modified for Pi Desk Noise TCP tunnels.
mod core;

use std::collections::HashMap;

use self::core::{
    ClientConfig, ClientServiceChange, ClientServiceConfig, Config, ConfigChange, ConfigCommand,
    MaskedString, NoiseConfig, RuntimeEvent as CoreRuntimeEvent, ServerConfig, ServerServiceChange,
    ServerServiceConfig, TcpConfig, run_client_with_events, run_server_with_events,
};
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

const HEARTBEAT_INTERVAL_SECS: u64 = 30;
const HEARTBEAT_TIMEOUT_SECS: u64 = 40;
const RETRY_INTERVAL_SECS: u64 = 1;
const UPDATE_CHANNEL_CAPACITY: usize = 64;

pub(crate) struct ClientRuntimeConfig {
    pub remote_addr: String,
    pub server_public_key: String,
}

pub(crate) struct ServerRuntimeConfig {
    pub bind_addr: String,
    pub private_key: String,
}

pub(crate) struct ClientServiceRuntimeConfig {
    pub service_id: String,
    pub local_addr: String,
    pub token: String,
}

pub(crate) struct ServerServiceRuntimeConfig {
    pub service_id: String,
    pub bind_addr: String,
    pub token: String,
}

pub(crate) struct ClientRuntimeHandle {
    shutdown_tx: broadcast::Sender<bool>,
    update_tx: mpsc::Sender<ConfigCommand>,
    event_rx: Option<mpsc::Receiver<RuntimeEvent>>,
    task: Option<JoinHandle<Result<(), String>>>,
}

pub(crate) struct ServerRuntimeHandle {
    shutdown_tx: broadcast::Sender<bool>,
    update_tx: mpsc::Sender<ConfigCommand>,
    event_rx: Option<mpsc::Receiver<RuntimeEvent>>,
    task: Option<JoinHandle<Result<(), String>>>,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RuntimeEvent {
    ClientControlConnected {
        service_id: String,
    },
    ClientControlDisconnected {
        service_id: String,
        error: Option<String>,
    },
    ServerServiceListening {
        service_id: String,
        bind_addr: String,
    },
    ServerServiceFailed {
        service_id: String,
        error: String,
    },
    Stopped,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RuntimeError {
    MissingRuntime,
    CommandChannelClosed,
    CommandAcknowledgementClosed,
    CommandRejected(String),
    TaskJoin(String),
    Runtime(String),
}

pub(crate) fn start_client(
    config: ClientRuntimeConfig,
) -> Result<ClientRuntimeHandle, RuntimeError> {
    let runtime =
        tokio::runtime::Handle::try_current().map_err(|_| RuntimeError::MissingRuntime)?;
    let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
    let (update_tx, update_rx) = mpsc::channel(UPDATE_CHANNEL_CAPACITY);
    let (core_event_tx, core_event_rx) = mpsc::unbounded_channel();
    let (event_tx, event_rx) = mpsc::channel(UPDATE_CHANNEL_CAPACITY);
    forward_events(runtime.clone(), core_event_rx, event_tx);
    let task = runtime.spawn(async move {
        run_client_with_events(
            client_config(config),
            shutdown_rx,
            update_rx,
            Some(core_event_tx),
        )
        .await
        .map_err(|error| error.to_string())
    });
    Ok(ClientRuntimeHandle {
        shutdown_tx,
        update_tx,
        event_rx: Some(event_rx),
        task: Some(task),
    })
}

pub(crate) fn start_server(
    config: ServerRuntimeConfig,
) -> Result<ServerRuntimeHandle, RuntimeError> {
    let runtime =
        tokio::runtime::Handle::try_current().map_err(|_| RuntimeError::MissingRuntime)?;
    let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
    let (update_tx, update_rx) = mpsc::channel(UPDATE_CHANNEL_CAPACITY);
    let (core_event_tx, core_event_rx) = mpsc::unbounded_channel();
    let (event_tx, event_rx) = mpsc::channel(UPDATE_CHANNEL_CAPACITY);
    forward_events(runtime.clone(), core_event_rx, event_tx);
    let task = runtime.spawn(async move {
        run_server_with_events(
            server_config(config),
            shutdown_rx,
            update_rx,
            Some(core_event_tx),
        )
        .await
        .map_err(|error| error.to_string())
    });
    Ok(ServerRuntimeHandle {
        shutdown_tx,
        update_tx,
        event_rx: Some(event_rx),
        task: Some(task),
    })
}

impl ClientRuntimeHandle {
    pub(crate) fn take_event_receiver(&mut self) -> Option<mpsc::Receiver<RuntimeEvent>> {
        self.event_rx.take()
    }

    pub(crate) async fn add_service(
        &self,
        config: ClientServiceRuntimeConfig,
    ) -> Result<(), RuntimeError> {
        send_command(
            &self.update_tx,
            ConfigChange::ClientChange(ClientServiceChange::Add(client_service_config(config))),
        )
        .await
    }

    pub(crate) async fn remove_service(&self, service_id: String) -> Result<(), RuntimeError> {
        send_command(
            &self.update_tx,
            ConfigChange::ClientChange(ClientServiceChange::Delete(service_id)),
        )
        .await
    }

    pub(crate) async fn shutdown(mut self) -> Result<(), RuntimeError> {
        let _ = self.shutdown_tx.send(true);
        join_task(self.task.take()).await
    }
}

impl Drop for ClientRuntimeHandle {
    fn drop(&mut self) {
        if self.task.is_some() {
            let _ = self.shutdown_tx.send(true);
        }
    }
}

impl ServerRuntimeHandle {
    pub(crate) fn take_event_receiver(&mut self) -> Option<mpsc::Receiver<RuntimeEvent>> {
        self.event_rx.take()
    }

    pub(crate) async fn add_service(
        &self,
        config: ServerServiceRuntimeConfig,
    ) -> Result<(), RuntimeError> {
        send_command(
            &self.update_tx,
            ConfigChange::ServerChange(ServerServiceChange::Add(server_service_config(config))),
        )
        .await
    }

    pub(crate) async fn remove_service(&self, service_id: String) -> Result<(), RuntimeError> {
        send_command(
            &self.update_tx,
            ConfigChange::ServerChange(ServerServiceChange::Delete(service_id)),
        )
        .await
    }

    pub(crate) async fn shutdown(mut self) -> Result<(), RuntimeError> {
        let _ = self.shutdown_tx.send(true);
        join_task(self.task.take()).await
    }
}

impl Drop for ServerRuntimeHandle {
    fn drop(&mut self) {
        if self.task.is_some() {
            let _ = self.shutdown_tx.send(true);
        }
    }
}

fn forward_events(
    runtime: tokio::runtime::Handle,
    mut source: mpsc::UnboundedReceiver<CoreRuntimeEvent>,
    target: mpsc::Sender<RuntimeEvent>,
) {
    runtime.spawn(async move {
        while let Some(event) = source.recv().await {
            if target.send(event.into()).await.is_err() {
                break;
            }
        }
    });
}

impl From<CoreRuntimeEvent> for RuntimeEvent {
    fn from(event: CoreRuntimeEvent) -> Self {
        match event {
            CoreRuntimeEvent::ClientControlConnected { service_id } => {
                Self::ClientControlConnected { service_id }
            }
            CoreRuntimeEvent::ClientControlDisconnected { service_id, error } => {
                Self::ClientControlDisconnected { service_id, error }
            }
            CoreRuntimeEvent::ServerServiceListening {
                service_id,
                bind_addr,
            } => Self::ServerServiceListening {
                service_id,
                bind_addr,
            },
            CoreRuntimeEvent::ServerServiceFailed { service_id, error } => {
                Self::ServerServiceFailed { service_id, error }
            }
            CoreRuntimeEvent::Stopped => Self::Stopped,
        }
    }
}

pub(crate) fn generate_noise_keypair() -> anyhow::Result<core::NoiseKeypair> {
    core::generate_noise_keypair()
}
pub(crate) fn derive_noise_public_key(private_key: &str) -> anyhow::Result<String> {
    core::derive_noise_public_key(private_key)
}

async fn send_command(
    update_tx: &mpsc::Sender<ConfigCommand>,
    change: ConfigChange,
) -> Result<(), RuntimeError> {
    let (command, acknowledgement) = ConfigCommand::with_ack(change);
    update_tx
        .send(command)
        .await
        .map_err(|_| RuntimeError::CommandChannelClosed)?;
    match acknowledgement.await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(RuntimeError::CommandRejected(error)),
        Err(_) => Err(RuntimeError::CommandAcknowledgementClosed),
    }
}

async fn join_task(task: Option<JoinHandle<Result<(), String>>>) -> Result<(), RuntimeError> {
    match task.expect("运行时任务必须存在").await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(RuntimeError::Runtime(error)),
        Err(error) => Err(RuntimeError::TaskJoin(error.to_string())),
    }
}

fn client_config(config: ClientRuntimeConfig) -> Config {
    Config {
        server: None,
        client: Some(ClientConfig {
            remote_addr: config.remote_addr,
            default_token: None,
            services: HashMap::new(),
            tcp: TcpConfig::default(),
            noise: NoiseConfig {
                local_private_key: None,
                remote_public_key: Some(config.server_public_key),
            },
            heartbeat_timeout: HEARTBEAT_TIMEOUT_SECS,
            retry_interval: RETRY_INTERVAL_SECS,
        }),
    }
}

fn server_config(config: ServerRuntimeConfig) -> Config {
    Config {
        server: Some(ServerConfig {
            bind_addr: config.bind_addr,
            default_token: None,
            services: HashMap::new(),
            tcp: TcpConfig::default(),
            noise: NoiseConfig {
                local_private_key: Some(MaskedString::from(config.private_key.as_str())),
                remote_public_key: None,
            },
            heartbeat_interval: HEARTBEAT_INTERVAL_SECS,
        }),
        client: None,
    }
}

fn client_service_config(config: ClientServiceRuntimeConfig) -> ClientServiceConfig {
    ClientServiceConfig {
        name: config.service_id,
        local_addr: config.local_addr,
        token: Some(MaskedString::from(config.token.as_str())),
        nodelay: true,
        retry_interval: Some(RETRY_INTERVAL_SECS),
    }
}

fn server_service_config(config: ServerServiceRuntimeConfig) -> ServerServiceConfig {
    ServerServiceConfig {
        name: config.service_id,
        bind_addr: config.bind_addr,
        token: Some(MaskedString::from(config.token.as_str())),
        nodelay: true,
    }
}
