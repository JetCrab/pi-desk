use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::http::StatusCode;
use pi_desk_tunnel_common::protocol::{CryptoContext, TunnelRelayConfig, default_relay_quic_port};
use pi_desk_tunnel_common::runtime::{TunnelEndpointConfig, TunnelMode, start_endpoint};
use tower::ServiceBuilder;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tracing_subscriber::EnvFilter;

use pi_desk_tunnel_server::api::{self, AppState};
use pi_desk_tunnel_server::config::ServerConfig;
use pi_desk_tunnel_server::tunnel::{TunnelRegistry, TunnelRegistryConfig};

mod http;
mod relay;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[tokio::main]
async fn main() -> Result<()> {
    init_tracing();
    let config = ServerConfig::load()?;
    let listener = tokio::net::TcpListener::bind(&config.control_bind)
        .await
        .with_context(|| format!("无法监听 PI_DESK_TUNNEL_BIND：{}", config.control_bind))?;
    let mut relay_addr = listener.local_addr().context("无法获取隧道监听地址")?;
    if relay_addr.ip().is_unspecified() {
        relay_addr.set_ip(match relay_addr.ip() {
            IpAddr::V4(_) => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(_) => IpAddr::V6(Ipv6Addr::LOCALHOST),
        });
    }
    let mut relay_config = TunnelRelayConfig {
        url: format!("http://{relay_addr}"),
        auth_token: config.relay_token.clone(),
        quic_port: default_relay_quic_port(),
    };
    let relay = relay::service(config.relay_token);
    let endpoint = start_endpoint(TunnelEndpointConfig {
        secret_key: None,
        relay: relay_config.clone(),
        mode: TunnelMode::Auto,
    })
    .await
    .map_err(anyhow::Error::msg)
    .context("无法启动隧道 iroh 网关")?;
    // 访问端从自身控制 URL 派生同入口地址，不分发网关内部回环地址。
    relay_config.url.clear();
    let tunnels = TunnelRegistry::new(
        endpoint,
        TunnelRegistryConfig {
            relay: relay_config,
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

    eprintln!("隧道控制与 HTTP 中继已监听 {}", listener.local_addr()?);
    eprintln!("iroh 网关已启动；公网可达性由宿主机防火墙控制");
    let result = http::serve(listener, app, relay.clone(), shutdown_signal()).await;
    tunnels.shutdown().await;
    relay.shutdown().await;
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
