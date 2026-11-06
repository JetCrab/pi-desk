use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::http::StatusCode;
use pi_desk_tunnel_common::protocol::CryptoContext;
use pi_desk_tunnel_common::runtime::{TunnelEndpointConfig, TunnelMode, start_endpoint};
use tower::ServiceBuilder;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tracing_subscriber::EnvFilter;

use pi_desk_tunnel_server::api::{self, AppState};
use pi_desk_tunnel_server::config::ServerConfig;
use pi_desk_tunnel_server::tunnel::{TunnelRegistry, TunnelRegistryConfig};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let config = ServerConfig::load()?;
    let listener = tokio::net::TcpListener::bind(&config.control_bind)
        .await
        .with_context(|| format!("无法监听 PI_DESK_TUNNEL_BIND：{}", config.control_bind))?;
    let endpoint = start_endpoint(TunnelEndpointConfig {
        secret_key: None,
        relay: config.relay.clone(),
        mode: TunnelMode::Auto,
    })
    .await
    .map_err(anyhow::Error::msg)
    .context("无法启动隧道 iroh 网关")?;
    let tunnels = TunnelRegistry::new(
        endpoint,
        TunnelRegistryConfig {
            relay: config.relay,
            public_host: config.public_host,
        },
    );
    let middleware = ServiceBuilder::new()
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            REQUEST_TIMEOUT,
        ))
        .layer(RequestBodyLimitLayer::new(
            pi_desk_tunnel_common::protocol::MAX_REQUEST_BYTES,
        ));
    let app = api::router(AppState {
        crypto: Arc::new(CryptoContext::new(config.control_key)),
        tunnels: Arc::clone(&tunnels),
    })
    .layer(middleware);

    eprintln!("隧道控制服务已监听 {}", config.control_bind);
    eprintln!("iroh 网关已启动；公网可达性由宿主机防火墙控制");
    let result = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await;
    tunnels.shutdown().await;
    result.context("隧道 HTTP 服务异常退出")
}

async fn shutdown_signal() {
    #[cfg(unix)]
    {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut terminate) => {
                tokio::select! {
                    _ = terminate.recv() => {},
                    result = tokio::signal::ctrl_c() => {
                        if let Err(error) = result { eprintln!("隧道退出信号监听失败 error={error}"); }
                    }
                }
            }
            Err(error) => eprintln!("隧道 SIGTERM 监听失败 error={error}"),
        }
    }
    #[cfg(not(unix))]
    if let Err(error) = tokio::signal::ctrl_c().await {
        eprintln!("隧道退出信号监听失败 error={error}");
    }
    eprintln!("隧道服务正在关闭并回收网关资源");
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}
