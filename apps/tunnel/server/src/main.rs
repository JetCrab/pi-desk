use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::http::StatusCode;
use pi_desk_tunnel_common::protocol::CryptoContext;
use pi_desk_tunnel_common::runtime::{TunnelServerConfig, start_server};
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
    let mut relay = start_server(TunnelServerConfig {
        bind_addr: config.relay_bind.clone(),
        private_key: config.relay_private_key,
    })
    .context("无法启动隧道 Noise relay")?;
    let relay_events = relay
        .take_event_receiver()
        .expect("隧道 relay 必须提供事件接收器");
    let tunnels = TunnelRegistry::new(
        relay,
        relay_events,
        TunnelRegistryConfig {
            public_relay: config.public_relay.clone(),
            public_host: config.public_host.clone(),
            server_public_key: config.relay_public_key,
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
        tunnels,
    })
    .layer(middleware);
    let listener = tokio::net::TcpListener::bind(&config.control_bind)
        .await
        .with_context(|| format!("无法监听 PI_DESK_TUNNEL_BIND：{}", config.control_bind))?;

    eprintln!("隧道控制服务已监听 {}", config.control_bind);
    eprintln!("隧道 Noise relay 已监听 {}", config.relay_bind);
    eprintln!("已取消注册端口范围限制；公网可达性由宿主机防火墙控制");
    axum::serve(listener, app)
        .await
        .context("隧道 HTTP 服务异常退出")
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}
