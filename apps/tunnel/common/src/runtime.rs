use crate::rathole_runtime::{
    self, ClientRuntimeConfig, ClientRuntimeHandle, ClientServiceRuntimeConfig, RuntimeError,
    ServerRuntimeConfig, ServerRuntimeHandle, ServerServiceRuntimeConfig,
};
use tokio::sync::mpsc;

#[derive(Clone, PartialEq, Eq)]
pub struct TunnelNoiseKeypair {
    pub private_key: String,
    pub public_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TunnelRuntimeEvent {
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

#[derive(Clone, PartialEq, Eq)]
pub struct TunnelClientConfig {
    pub remote_addr: String,
    pub server_public_key: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct TunnelServerConfig {
    pub bind_addr: String,
    pub private_key: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct TunnelClientServiceConfig {
    pub service_id: String,
    pub local_addr: String,
    pub token: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct TunnelServerServiceConfig {
    pub service_id: String,
    pub bind_addr: String,
    pub token: String,
}

pub struct TunnelClientHandle {
    runtime: ClientRuntimeHandle,
    event_rx: Option<mpsc::Receiver<TunnelRuntimeEvent>>,
}

pub struct TunnelServerHandle {
    runtime: ServerRuntimeHandle,
    event_rx: Option<mpsc::Receiver<TunnelRuntimeEvent>>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum TunnelError {
    InvalidConfig(&'static str),
    MissingRuntime,
    RuntimeStopped,
    Runtime(String),
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidConfig(message) => formatter.write_str(message),
            Self::MissingRuntime => formatter.write_str("隧道必须在 Tokio 运行时中启动"),
            Self::RuntimeStopped => formatter.write_str("隧道运行时已经停止"),
            Self::Runtime(_) => formatter.write_str("隧道运行失败"),
        }
    }
}

impl std::error::Error for TunnelError {}

pub fn generate_noise_keypair() -> Result<TunnelNoiseKeypair, TunnelError> {
    let keypair = rathole_runtime::generate_noise_keypair()
        .map_err(|_| TunnelError::Runtime("Noise 密钥生成失败".into()))?;
    Ok(TunnelNoiseKeypair {
        private_key: keypair.private_key,
        public_key: keypair.public_key,
    })
}

pub fn derive_noise_public_key(private_key: &str) -> Result<String, TunnelError> {
    rathole_runtime::derive_noise_public_key(private_key)
        .map_err(|_| TunnelError::Runtime("Noise 私钥无效".into()))
}

pub fn start_client(config: TunnelClientConfig) -> Result<TunnelClientHandle, TunnelError> {
    require_value(&config.remote_addr, "中继服务地址不能为空")?;
    require_value(&config.server_public_key, "服务端 Noise 公钥不能为空")?;
    let mut runtime = rathole_runtime::start_client(ClientRuntimeConfig {
        remote_addr: config.remote_addr,
        server_public_key: config.server_public_key,
    })?;
    Ok(TunnelClientHandle {
        event_rx: Some(forward_runtime_events(
            runtime
                .take_event_receiver()
                .expect("客户端必须提供事件接收器"),
        )),
        runtime,
    })
}

pub fn start_server(config: TunnelServerConfig) -> Result<TunnelServerHandle, TunnelError> {
    require_value(&config.bind_addr, "隧道服务监听地址不能为空")?;
    require_value(&config.private_key, "服务端 Noise 私钥不能为空")?;
    let mut runtime = rathole_runtime::start_server(ServerRuntimeConfig {
        bind_addr: config.bind_addr,
        private_key: config.private_key,
    })?;
    Ok(TunnelServerHandle {
        event_rx: Some(forward_runtime_events(
            runtime
                .take_event_receiver()
                .expect("服务端必须提供事件接收器"),
        )),
        runtime,
    })
}

impl TunnelClientHandle {
    pub fn take_event_receiver(&mut self) -> Option<mpsc::Receiver<TunnelRuntimeEvent>> {
        self.event_rx.take()
    }
    pub async fn add_service(&self, config: TunnelClientServiceConfig) -> Result<(), TunnelError> {
        validate_client_service(&config)?;
        self.runtime
            .add_service(ClientServiceRuntimeConfig {
                service_id: config.service_id,
                local_addr: config.local_addr,
                token: config.token,
            })
            .await?;
        Ok(())
    }
    pub async fn remove_service(&self, service_id: impl Into<String>) -> Result<(), TunnelError> {
        let service_id = service_id.into();
        require_value(&service_id, "隧道服务 ID 不能为空")?;
        self.runtime.remove_service(service_id).await?;
        Ok(())
    }
    pub async fn shutdown(self) -> Result<(), TunnelError> {
        self.runtime.shutdown().await?;
        Ok(())
    }
}

impl TunnelServerHandle {
    pub fn take_event_receiver(&mut self) -> Option<mpsc::Receiver<TunnelRuntimeEvent>> {
        self.event_rx.take()
    }
    pub async fn add_service(&self, config: TunnelServerServiceConfig) -> Result<(), TunnelError> {
        validate_server_service(&config)?;
        self.runtime
            .add_service(ServerServiceRuntimeConfig {
                service_id: config.service_id,
                bind_addr: config.bind_addr,
                token: config.token,
            })
            .await?;
        Ok(())
    }
    pub async fn remove_service(&self, service_id: impl Into<String>) -> Result<(), TunnelError> {
        let service_id = service_id.into();
        require_value(&service_id, "隧道服务 ID 不能为空")?;
        self.runtime.remove_service(service_id).await?;
        Ok(())
    }
    pub async fn shutdown(self) -> Result<(), TunnelError> {
        self.runtime.shutdown().await?;
        Ok(())
    }
}

fn forward_runtime_events(
    mut source: mpsc::Receiver<rathole_runtime::RuntimeEvent>,
) -> mpsc::Receiver<TunnelRuntimeEvent> {
    let (target, receiver) = mpsc::channel(64);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = target.closed() => break,
                event = source.recv() => {
                    let Some(event) = event else {
                        break;
                    };
                    if target.send(event.into()).await.is_err() {
                        break;
                    }
                }
            }
        }
    });
    receiver
}

impl From<rathole_runtime::RuntimeEvent> for TunnelRuntimeEvent {
    fn from(event: rathole_runtime::RuntimeEvent) -> Self {
        match event {
            rathole_runtime::RuntimeEvent::ClientControlConnected { service_id } => {
                Self::ClientControlConnected { service_id }
            }
            rathole_runtime::RuntimeEvent::ClientControlDisconnected { service_id, error } => {
                Self::ClientControlDisconnected { service_id, error }
            }
            rathole_runtime::RuntimeEvent::ServerServiceListening {
                service_id,
                bind_addr,
            } => Self::ServerServiceListening {
                service_id,
                bind_addr,
            },
            rathole_runtime::RuntimeEvent::ServerServiceFailed { service_id, error } => {
                Self::ServerServiceFailed { service_id, error }
            }
            rathole_runtime::RuntimeEvent::Stopped => Self::Stopped,
        }
    }
}

impl From<RuntimeError> for TunnelError {
    fn from(error: RuntimeError) -> Self {
        match error {
            RuntimeError::MissingRuntime => Self::MissingRuntime,
            RuntimeError::CommandChannelClosed | RuntimeError::CommandAcknowledgementClosed => {
                Self::RuntimeStopped
            }
            RuntimeError::CommandRejected(error)
            | RuntimeError::TaskJoin(error)
            | RuntimeError::Runtime(error) => Self::Runtime(error),
        }
    }
}

fn validate_client_service(config: &TunnelClientServiceConfig) -> Result<(), TunnelError> {
    require_value(&config.service_id, "隧道服务 ID 不能为空")?;
    require_value(&config.local_addr, "本地服务地址不能为空")?;
    require_value(&config.token, "隧道服务令牌不能为空")
}

fn validate_server_service(config: &TunnelServerServiceConfig) -> Result<(), TunnelError> {
    require_value(&config.service_id, "隧道服务 ID 不能为空")?;
    require_value(&config.bind_addr, "公网监听地址不能为空")?;
    require_value(&config.token, "隧道服务令牌不能为空")
}

fn require_value(value: &str, message: &'static str) -> Result<(), TunnelError> {
    if value.trim().is_empty() {
        Err(TunnelError::InvalidConfig(message))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::time::timeout;

    use super::{
        generate_noise_keypair, start_client, start_server, TunnelClientConfig,
        TunnelClientServiceConfig, TunnelRuntimeEvent, TunnelServerConfig,
        TunnelServerServiceConfig,
    };

    fn unused_address() -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("应分配端口");
        let address = listener.local_addr().expect("应读取端口").to_string();
        drop(listener);
        address
    }

    async fn start_echo_server() -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("应监听 echo");
        let address = listener.local_addr().expect("应读取 echo 地址").to_string();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buffer = [0_u8; 1024];
                    if let Ok(length) = stream.read(&mut buffer).await {
                        let _ = stream.write_all(&buffer[..length]).await;
                    }
                });
            }
        });
        (address, task)
    }

    #[tokio::test]
    async fn dynamic_noise_tcp_service_forwards_bytes() {
        let (local_address, echo_task) = start_echo_server().await;
        let relay_address = unused_address();
        let public_address = unused_address();
        let keypair = generate_noise_keypair().expect("应生成 Noise 密钥");
        let mut server = start_server(TunnelServerConfig {
            bind_addr: relay_address.clone(),
            private_key: keypair.private_key,
        })
        .expect("应启动 relay");
        let mut server_events = server.take_event_receiver().expect("应读取服务端事件");
        server
            .add_service(TunnelServerServiceConfig {
                service_id: "service".to_string(),
                bind_addr: public_address.clone(),
                token: "token".to_string(),
            })
            .await
            .expect("应登记公网服务");
        let client = start_client(TunnelClientConfig {
            remote_addr: relay_address,
            server_public_key: keypair.public_key,
        })
        .expect("应启动客户端");
        client
            .add_service(TunnelClientServiceConfig {
                service_id: "service".to_string(),
                local_addr: local_address,
                token: "token".to_string(),
            })
            .await
            .expect("应登记本地服务");

        timeout(Duration::from_secs(10), async {
            loop {
                if matches!(
                    server_events.recv().await,
                    Some(TunnelRuntimeEvent::ServerServiceListening { .. })
                ) {
                    break;
                }
            }
        })
        .await
        .expect("应等待公网监听就绪");

        let mut visitor = TcpStream::connect(&public_address)
            .await
            .expect("应连接公网端口");
        visitor.write_all(b"pi-desk").await.expect("应写入数据");
        let mut echoed = [0_u8; 7];
        timeout(Duration::from_secs(10), visitor.read_exact(&mut echoed))
            .await
            .expect("应收到转发数据")
            .expect("应读取转发数据");
        assert_eq!(&echoed, b"pi-desk");

        client.shutdown().await.expect("应关闭客户端");
        server.shutdown().await.expect("应关闭服务端");
        echo_task.abort();
    }
}
