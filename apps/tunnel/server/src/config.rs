use std::env;
use std::net::Ipv6Addr;
use std::num::NonZeroU16;

use anyhow::{Context, Result, anyhow};
use pi_desk_tunnel_common::protocol::{TunnelRelayConfig, default_relay_quic_port, parse_key_hex};

pub struct ServerConfig {
    pub control_bind: String,
    pub control_key: [u8; 32],
    pub public_host: String,
    pub relay: TunnelRelayConfig,
}

impl ServerConfig {
    pub fn load() -> Result<Self> {
        let key_hex = env::var("PI_DESK_TUNNEL_SERVER_KEY")
            .context("必须设置 PI_DESK_TUNNEL_SERVER_KEY（64 位十六进制密钥）")?;
        let control_key = parse_key_hex(&key_hex)
            .map_err(|_| anyhow!("PI_DESK_TUNNEL_SERVER_KEY 必须是严格 64 位十六进制密钥"))?;
        let relay_url = env::var("PI_DESK_TUNNEL_IROH_RELAY_URL")
            .context("必须设置 PI_DESK_TUNNEL_IROH_RELAY_URL")?;
        let relay_token = env::var("PI_DESK_TUNNEL_IROH_RELAY_TOKEN")
            .context("必须设置 PI_DESK_TUNNEL_IROH_RELAY_TOKEN")?;
        if relay_url.trim().is_empty() || relay_token.trim().is_empty() {
            return Err(anyhow!("iroh relay 地址和准入 token 不能为空"));
        }
        let relay_quic_port = match env::var("PI_DESK_TUNNEL_IROH_RELAY_QUIC_PORT") {
            Ok(value) => parse_relay_quic_port(Some(&value))?,
            Err(env::VarError::NotPresent) => parse_relay_quic_port(None)?,
            Err(error) => {
                return Err(error)
                    .context("PI_DESK_TUNNEL_IROH_RELAY_QUIC_PORT 必须是 1–65535 的端口");
            }
        };
        let public_host = validate_public_host(
            &env::var("PI_DESK_TUNNEL_PUBLIC_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        )?;

        Ok(Self {
            control_bind: validate_socket_address(
                &env::var("PI_DESK_TUNNEL_BIND").unwrap_or_else(|_| "0.0.0.0:7001".to_string()),
                "PI_DESK_TUNNEL_BIND",
            )?,
            control_key,
            public_host,
            relay: TunnelRelayConfig {
                url: relay_url,
                auth_token: relay_token,
                quic_port: relay_quic_port,
            },
        })
    }
}

fn parse_relay_quic_port(value: Option<&str>) -> Result<u16> {
    match value {
        None => Ok(default_relay_quic_port()),
        Some(value) => value
            .parse::<NonZeroU16>()
            .map(NonZeroU16::get)
            .map_err(|_| anyhow!("PI_DESK_TUNNEL_IROH_RELAY_QUIC_PORT 必须是 1–65535 的端口")),
    }
}

fn validate_socket_address(value: &str, variable: &str) -> Result<String> {
    if value.is_empty() || value.trim() != value || value.chars().any(char::is_whitespace) {
        return Err(anyhow!("{variable} 不能为空且不能包含空白字符"));
    }
    let (_, port) = value
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("{variable} 必须是 host:port"))?;
    let port = port
        .trim_end_matches(']')
        .parse::<u16>()
        .map_err(|_| anyhow!("{variable} 的端口无效"))?;
    if port == 0 {
        return Err(anyhow!("{variable} 的端口必须大于 0"));
    }
    Ok(value.to_owned())
}

fn validate_public_host(value: &str) -> Result<String> {
    if value.is_empty()
        || value.trim() != value
        || value.chars().any(char::is_whitespace)
        || value.contains('[')
        || value.contains(']')
        || value.contains(':') && value.parse::<Ipv6Addr>().is_err()
    {
        return Err(anyhow!(
            "PI_DESK_TUNNEL_PUBLIC_HOST 必须是无端口主机名或 IP"
        ));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::{parse_relay_quic_port, validate_public_host, validate_socket_address};

    #[test]
    fn relay_quic_port_defaults_and_accepts_custom_boundaries() {
        assert_eq!(parse_relay_quic_port(None).unwrap(), 7842);
        assert_eq!(parse_relay_quic_port(Some("20012")).unwrap(), 20012);
        assert_eq!(parse_relay_quic_port(Some("1")).unwrap(), 1);
        assert_eq!(parse_relay_quic_port(Some("65535")).unwrap(), 65535);
    }

    #[test]
    fn validates_runtime_listener_addresses_without_a_port_range() {
        assert_eq!(
            validate_socket_address("0.0.0.0:1", "TEST").unwrap(),
            "0.0.0.0:1"
        );
        assert_eq!(
            validate_socket_address("[2001:db8::1]:65535", "TEST").unwrap(),
            "[2001:db8::1]:65535"
        );
        assert!(validate_socket_address("host:0", "TEST").is_err());
        assert!(validate_socket_address("host:65536", "TEST").is_err());
        assert!(validate_public_host("tunnel.example.com").is_ok());
        assert!(validate_public_host("2001:db8::1").is_ok());
        assert!(validate_public_host("host:8080").is_err());
    }
}
