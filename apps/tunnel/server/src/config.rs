use std::env;
use std::net::Ipv6Addr;

use anyhow::{Context, Result, anyhow};
use pi_desk_tunnel_common::protocol::parse_key_hex;
use pi_desk_tunnel_common::runtime::derive_noise_public_key;

pub struct ServerConfig {
    pub control_bind: String,
    pub control_key: [u8; 32],
    pub relay_bind: String,
    pub public_relay: String,
    pub public_host: String,
    pub relay_private_key: String,
    pub relay_public_key: String,
}

impl ServerConfig {
    pub fn load() -> Result<Self> {
        let key_hex = env::var("PI_DESK_TUNNEL_SERVER_KEY")
            .context("必须设置 PI_DESK_TUNNEL_SERVER_KEY（64 位十六进制密钥）")?;
        let control_key = parse_key_hex(&key_hex)
            .map_err(|_| anyhow!("PI_DESK_TUNNEL_SERVER_KEY 必须是严格 64 位十六进制密钥"))?;
        let relay_private_key = env::var("PI_DESK_TUNNEL_PRIVATE_KEY")
            .context("必须设置 PI_DESK_TUNNEL_PRIVATE_KEY")?;
        let relay_public_key = derive_noise_public_key(&relay_private_key)
            .map_err(|_| anyhow!("PI_DESK_TUNNEL_PRIVATE_KEY 无效"))?;
        let public_relay = validate_socket_address(
            &env::var("PI_DESK_TUNNEL_PUBLIC_RELAY")
                .unwrap_or_else(|_| "127.0.0.1:7002".to_string()),
            "PI_DESK_TUNNEL_PUBLIC_RELAY",
        )?;
        let public_host = validate_public_host(
            &env::var("PI_DESK_TUNNEL_PUBLIC_HOST").unwrap_or_else(|_| "127.0.0.1".to_string()),
        )?;

        Ok(Self {
            control_bind: validate_socket_address(
                &env::var("PI_DESK_TUNNEL_BIND").unwrap_or_else(|_| "0.0.0.0:7001".to_string()),
                "PI_DESK_TUNNEL_BIND",
            )?,
            control_key,
            relay_bind: validate_socket_address(
                &env::var("PI_DESK_TUNNEL_RELAY_BIND")
                    .unwrap_or_else(|_| "0.0.0.0:7002".to_string()),
                "PI_DESK_TUNNEL_RELAY_BIND",
            )?,
            public_relay,
            public_host,
            relay_private_key,
            relay_public_key,
        })
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
    use super::{validate_public_host, validate_socket_address};

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
