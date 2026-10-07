use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::Duration;

use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::control::{ControlClient, ControlClientError, ControlServerError};
use crate::protocol::{OpenTunnelRequest, TunnelStatus, random_hex};
use crate::runtime::{
    TunnelClientConfig, TunnelClientHandle, TunnelClientServiceConfig, TunnelRuntimeEvent,
    start_client,
};

const OPEN_STATUS_INTERVAL: Duration = Duration::from_millis(400);
const LISTENING_STATUS_INTERVAL: Duration = Duration::from_secs(5);
const RECOVERY_INTERVAL: Duration = Duration::from_secs(1);
const MAX_CONSECUTIVE_STATUS_FAILURES: u8 = 3;

#[derive(Clone)]
pub struct TunnelWorkerConfig {
    pub control_server_url: String,
    pub control_key: [u8; 32],
    pub device_id: String,
    pub local_addr: String,
    pub public_port: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TunnelWorkerEvent {
    Opening,
    Connecting { public_addr: String },
    Listening { public_addr: String },
    Recovering(String),
    Failed(String),
    Stopped,
}

enum TunnelWorkerCommand {
    Stop,
}

pub struct TunnelWorkerHandle {
    commands: UnboundedSender<TunnelWorkerCommand>,
    events: Receiver<TunnelWorkerEvent>,
}

impl TunnelWorkerHandle {
    pub fn stop(&self) {
        let _ = self.commands.send(TunnelWorkerCommand::Stop);
    }

    pub fn try_recv(&self) -> Result<TunnelWorkerEvent, mpsc::TryRecvError> {
        self.events.try_recv()
    }

    pub fn recv_timeout(&self, timeout: Duration) -> Result<TunnelWorkerEvent, RecvTimeoutError> {
        self.events.recv_timeout(timeout)
    }
}

impl Drop for TunnelWorkerHandle {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn start_tunnel_worker(config: TunnelWorkerConfig) -> Result<TunnelWorkerHandle, String> {
    let (events, event_receiver) = mpsc::channel();
    let (commands, command_receiver) = tokio::sync::mpsc::unbounded_channel();
    let fallback_events = events.clone();
    std::thread::Builder::new()
        .name("pi-desk-tunnel".to_string())
        .spawn(move || {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build();
            match runtime {
                Ok(runtime) => runtime.block_on(run_worker(config, command_receiver, events)),
                Err(error) => {
                    send_event(
                        &fallback_events,
                        TunnelWorkerEvent::Failed(format!("无法启动隧道后台运行时：{error}")),
                    );
                    send_event(&fallback_events, TunnelWorkerEvent::Stopped);
                }
            }
        })
        .map_err(|error| format!("无法创建隧道后台线程：{error}"))?;

    Ok(TunnelWorkerHandle {
        commands,
        events: event_receiver,
    })
}

async fn run_worker(
    config: TunnelWorkerConfig,
    mut commands: UnboundedReceiver<TunnelWorkerCommand>,
    events: Sender<TunnelWorkerEvent>,
) {
    'worker: loop {
        send_event(&events, TunnelWorkerEvent::Opening);
        let request_id = match random_hex::<16>() {
            Ok(request_id) => request_id,
            Err(error) => {
                send_event(
                    &events,
                    TunnelWorkerEvent::Failed(format!("无法生成隧道请求标识：{error}")),
                );
                finish(&config, None, None, &events).await;
                return;
            }
        };
        let mut opening = open_request(config.clone(), request_id);
        let opened = tokio::select! {
            result = &mut opening => match result {
                Ok(Ok(response)) => response,
                Ok(Err(error)) if !open_error_is_retryable(&error) => {
                    send_event(&events, TunnelWorkerEvent::Failed(error.to_string()));
                    finish(&config, None, None, &events).await;
                    return;
                }
                Ok(Err(error)) => {
                    send_event(&events, TunnelWorkerEvent::Recovering(format!("无法打开服务端隧道，将重试：{error}")));
                    if retry_or_stop(&mut commands, WorkerPhase::Recovering).await {
                        finish(&config, None, None, &events).await;
                        return;
                    }
                    continue;
                }
                Err(_) => {
                    send_event(&events, TunnelWorkerEvent::Recovering("创建隧道请求意外停止，将重试。".to_string()));
                    if retry_or_stop(&mut commands, WorkerPhase::Recovering).await {
                        finish(&config, None, None, &events).await;
                        return;
                    }
                    continue;
                }
            },
            command = commands.recv() => {
                let response = opening.await.ok().and_then(Result::ok);
                if requests_stop(command) {
                    finish(&config, None, response.as_ref().map(|response| response.tunnel_id.as_str()), &events).await;
                    return;
                }
                continue;
            }
        };

        let tunnel_id = opened.tunnel_id.clone();
        let public_addr = opened.public_addr.clone();
        send_event(
            &events,
            TunnelWorkerEvent::Connecting {
                public_addr: public_addr.clone(),
            },
        );
        let mut client = match start_client(TunnelClientConfig {
            remote_addr: opened.relay_addr,
            server_public_key: opened.server_public_key,
        }) {
            Ok(client) => client,
            Err(error) => {
                send_event(
                    &events,
                    TunnelWorkerEvent::Recovering(format!(
                        "无法启动本地隧道客户端，将重试：{error}"
                    )),
                );
                if retry_or_stop(&mut commands, WorkerPhase::Recovering).await {
                    finish(&config, None, Some(&tunnel_id), &events).await;
                    return;
                }
                continue;
            }
        };
        let mut runtime_events = client
            .take_event_receiver()
            .expect("隧道客户端必须提供唯一事件接收器");
        if client
            .add_service(TunnelClientServiceConfig {
                service_id: tunnel_id.clone(),
                local_addr: config.local_addr.clone(),
                token: opened.service_token,
            })
            .await
            .is_err()
        {
            recover(client, "无法配置本地 TCP 转发，将重新连接。", &events).await;
            if retry_or_stop(&mut commands, WorkerPhase::Recovering).await {
                finish(&config, None, Some(&tunnel_id), &events).await;
                return;
            }
            continue;
        }

        let mut phase = WorkerPhase::Connecting;
        let mut failures = 0_u8;
        loop {
            let mut status = status_request(config.clone(), tunnel_id.clone());
            let result = loop {
                tokio::select! {
                    command = commands.recv() => {
                        if requests_stop(command) {
                            finish(&config, Some(client), Some(&tunnel_id), &events).await;
                            return;
                        }
                    }
                    event = runtime_events.recv() => {
                        if matches!(event, Some(TunnelRuntimeEvent::Stopped) | None) {
                            recover(client, "本地隧道客户端已停止，将重新连接。", &events).await;
                            if retry_or_stop(&mut commands, WorkerPhase::Recovering).await {
                                finish(&config, None, Some(&tunnel_id), &events).await;
                                return;
                            }
                            continue 'worker;
                        }
                    }
                    result = &mut status => break result,
                }
            };
            let status = result
                .ok()
                .and_then(Result::ok)
                .map(|response| response.status);
            match status {
                Some(TunnelStatus::Listening) => {
                    failures = 0;
                    if phase != WorkerPhase::Listening {
                        send_event(
                            &events,
                            TunnelWorkerEvent::Listening {
                                public_addr: public_addr.clone(),
                            },
                        );
                        phase = WorkerPhase::Listening;
                    }
                }
                Some(TunnelStatus::AwaitingClient) if phase == WorkerPhase::Connecting => {
                    failures = 0;
                }
                Some(TunnelStatus::Failed) | Some(TunnelStatus::AwaitingClient) => {
                    recover(client, "服务端未能保持公网端口监听，将重新连接。", &events).await;
                    if retry_or_stop(&mut commands, WorkerPhase::Recovering).await {
                        finish(&config, None, Some(&tunnel_id), &events).await;
                        return;
                    }
                    break;
                }
                None => {
                    failures = failures.saturating_add(1);
                    if failures >= MAX_CONSECUTIVE_STATUS_FAILURES {
                        recover(client, "连续多次无法确认隧道状态，将重新连接。", &events).await;
                        if retry_or_stop(&mut commands, WorkerPhase::Recovering).await {
                            finish(&config, None, Some(&tunnel_id), &events).await;
                            return;
                        }
                        break;
                    }
                }
            }
            if retry_or_stop(&mut commands, phase).await {
                finish(&config, Some(client), Some(&tunnel_id), &events).await;
                return;
            }
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum WorkerPhase {
    Connecting,
    Listening,
    Recovering,
}

impl WorkerPhase {
    fn interval(self) -> Duration {
        match self {
            Self::Connecting => OPEN_STATUS_INTERVAL,
            Self::Listening => LISTENING_STATUS_INTERVAL,
            Self::Recovering => RECOVERY_INTERVAL,
        }
    }
}

async fn retry_or_stop(
    commands: &mut UnboundedReceiver<TunnelWorkerCommand>,
    phase: WorkerPhase,
) -> bool {
    tokio::select! {
        command = commands.recv() => requests_stop(command),
        _ = tokio::time::sleep(phase.interval()) => false,
    }
}

fn requests_stop(command: Option<TunnelWorkerCommand>) -> bool {
    matches!(command, Some(TunnelWorkerCommand::Stop) | None)
}

fn open_error_is_retryable(error: &ControlClientError) -> bool {
    matches!(
        error,
        ControlClientError::Network(_)
            | ControlClientError::ResponseRead(_)
            | ControlClientError::TransportStatus(_)
            | ControlClientError::UnexpectedStatus(_)
            | ControlClientError::Rejected(ControlServerError::Internal)
    )
}

fn open_request(
    config: TunnelWorkerConfig,
    request_id: String,
) -> tokio::task::JoinHandle<Result<crate::protocol::OpenTunnelResponse, ControlClientError>> {
    tokio::task::spawn_blocking(move || {
        ControlClient::new(&config.control_server_url, config.control_key)?.open_tunnel(
            OpenTunnelRequest {
                request_id,
                device_id: config.device_id,
                public_port: config.public_port,
            },
        )
    })
}

fn status_request(
    config: TunnelWorkerConfig,
    tunnel_id: String,
) -> tokio::task::JoinHandle<Result<crate::protocol::StatusTunnelResponse, String>> {
    tokio::task::spawn_blocking(move || {
        ControlClient::new(&config.control_server_url, config.control_key)
            .map_err(|error| error.to_string())?
            .status_tunnel(&tunnel_id)
            .map_err(|error| error.to_string())
    })
}

async fn recover(client: TunnelClientHandle, detail: &str, events: &Sender<TunnelWorkerEvent>) {
    send_event(events, TunnelWorkerEvent::Recovering(detail.to_string()));
    let _ = client.shutdown().await;
}

async fn finish(
    config: &TunnelWorkerConfig,
    client: Option<TunnelClientHandle>,
    tunnel_id: Option<&str>,
    events: &Sender<TunnelWorkerEvent>,
) {
    let mut cleanup_failed = false;
    if let Some(client) = client {
        cleanup_failed |= client.shutdown().await.is_err();
    }
    if let Some(tunnel_id) = tunnel_id {
        let config = config.clone();
        let tunnel_id = tunnel_id.to_owned();
        cleanup_failed |= !matches!(
            tokio::task::spawn_blocking(move || {
                ControlClient::new(&config.control_server_url, config.control_key)
                    .map_err(|error| error.to_string())?
                    .close_tunnel(&tunnel_id)
                    .map_err(|error| error.to_string())
            })
            .await,
            Ok(Ok(()))
        );
    }
    if cleanup_failed {
        send_event(
            events,
            TunnelWorkerEvent::Failed("隧道已停止，但服务端清理未确认。".to_string()),
        );
    }
    send_event(events, TunnelWorkerEvent::Stopped);
}

fn send_event(events: &Sender<TunnelWorkerEvent>, event: TunnelWorkerEvent) {
    let _ = events.send(event);
}

#[cfg(test)]
mod tests {
    use super::{WorkerPhase, open_error_is_retryable, requests_stop};
    use crate::control::{ControlClientError, ControlServerError};

    #[test]
    fn uses_short_connecting_and_long_running_status_intervals() {
        assert!(WorkerPhase::Connecting.interval() < WorkerPhase::Listening.interval());
        assert!(WorkerPhase::Recovering.interval() < WorkerPhase::Listening.interval());
        assert!(requests_stop(None));
    }

    #[test]
    fn retries_transport_errors_but_fails_port_conflicts() {
        assert!(open_error_is_retryable(
            &ControlClientError::TransportStatus(503)
        ));
        assert!(!open_error_is_retryable(&ControlClientError::Rejected(
            ControlServerError::PortConflict
        )));
    }
}
