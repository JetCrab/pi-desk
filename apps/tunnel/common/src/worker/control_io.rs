use std::sync::Arc;

use tokio::sync::Semaphore;
use tokio::time::Instant;

use crate::control::{ControlClient, ControlClientError, ControlServerError};
use crate::protocol::{
    OpenTunnelRequest, OpenTunnelResponse, ResolveTunnelResponse, StatusTunnelResponse,
};

use super::{Cancellation, TunnelPublicationConfig, TunnelWorkerConfig};

pub(super) const HTTP_CONCURRENCY: usize = 8;

pub(super) struct Timed<T> {
    pub started: Instant,
    pub value: T,
}

#[derive(Clone)]
pub(super) struct ControlIo {
    url: String,
    key: [u8; 32],
    permits: Arc<Semaphore>,
}

impl ControlIo {
    pub fn new(config: &TunnelWorkerConfig) -> Self {
        Self {
            url: config.control_server_url.clone(),
            key: config.control_key,
            permits: Arc::new(Semaphore::new(HTTP_CONCURRENCY)),
        }
    }

    // 所有调用者持有并等待此 future；取消后也必须等待，不能丢弃迟到 open。
    async fn request<T: Send + 'static>(
        &self,
        cancel: Option<Cancellation>,
        request: impl FnOnce(ControlClient) -> Result<T, ControlClientError> + Send + 'static,
    ) -> Result<Timed<T>, ControlClientError> {
        let permits = self.permits.clone();
        let permit = if let Some(mut cancel) = cancel {
            if cancel.is_cancelled() {
                return Err(ControlClientError::InvalidResponse);
            }
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(ControlClientError::InvalidResponse),
                permit = permits.acquire_owned() => permit.expect("HTTP 限流器保持开放"),
            }
        } else {
            permits.acquire_owned().await.expect("HTTP 限流器保持开放")
        };
        let url = self.url.clone();
        let key = self.key;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let client = ControlClient::new(&url, key)?;
            let started = Instant::now();
            request(client).map(|value| Timed { started, value })
        })
        .await
        .unwrap_or(Err(ControlClientError::InvalidResponse))
    }

    pub async fn open(
        &self,
        request_id: String,
        provider_id: String,
        config: TunnelPublicationConfig,
        cancel: Cancellation,
    ) -> Result<Timed<OpenTunnelResponse>, ControlClientError> {
        self.request(Some(cancel), move |client| {
            client.open_tunnel(OpenTunnelRequest {
                request_id,
                provider_id,
                port: config.local_addr.port(),
                public_port: config.public_port,
            })
        })
        .await
    }

    pub async fn status(
        &self,
        tunnel_id: String,
        cancel: Cancellation,
    ) -> Result<Timed<StatusTunnelResponse>, ControlClientError> {
        self.request(Some(cancel), move |client| client.status_tunnel(&tunnel_id))
            .await
    }

    pub async fn resolve(
        &self,
        provider_id: String,
        port: u16,
        cancel: Cancellation,
    ) -> Result<Timed<ResolveTunnelResponse>, ControlClientError> {
        self.request(Some(cancel), move |client| {
            client.resolve_tunnel(&provider_id, port)
        })
        .await
    }

    pub async fn close(&self, tunnel_id: String) -> Result<(), String> {
        self.request(None, move |client| client.close_tunnel(&tunnel_id))
            .await
            .map(|_| ())
            .map_err(|error| format!("服务端隧道清理未确认：{error}"))
    }
}

pub(super) fn retryable(error: &ControlClientError) -> bool {
    matches!(
        error,
        ControlClientError::Network(_)
            | ControlClientError::ResponseRead(_)
            | ControlClientError::TransportStatus(_)
            | ControlClientError::UnexpectedStatus(_)
            | ControlClientError::Rejected(ControlServerError::Internal)
    )
}

pub(super) fn resolve_retryable(error: &ControlClientError) -> bool {
    retryable(error)
        || matches!(
            error,
            ControlClientError::Rejected(
                ControlServerError::NotFound | ControlServerError::NotReady
            )
        )
}

pub(super) fn registration_invalid(error: &ControlClientError) -> bool {
    matches!(
        error,
        ControlClientError::Rejected(
            ControlServerError::NotFound
                | ControlServerError::Unauthorized
                | ControlServerError::InvalidRequest
        )
    )
}
