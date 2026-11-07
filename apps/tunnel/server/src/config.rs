use std::env;

use anyhow::{Context, Result, anyhow};
use pi_desk_tunnel_common::protocol::parse_key_hex;

pub struct ServerConfig {
    pub control_bind: String,
    pub control_key: [u8; 32],
    pub relay_token: String,
}

impl ServerConfig {
    pub fn load() -> Result<Self> {
        let key_hex = env::var("PI_DESK_TUNNEL_SERVER_KEY")
            .context("必须设置 PI_DESK_TUNNEL_SERVER_KEY（64 位十六进制密钥）")?;
        let control_key = parse_key_hex(&key_hex)
            .map_err(|_| anyhow!("PI_DESK_TUNNEL_SERVER_KEY 必须是严格 64 位十六进制密钥"))?;
        let relay_token = env::var("PI_DESK_TUNNEL_IROH_RELAY_TOKEN")
            .context("必须设置 PI_DESK_TUNNEL_IROH_RELAY_TOKEN")?;
        if relay_token.trim().is_empty() {
            return Err(anyhow!("中继准入 token 不能为空"));
        }
        Ok(Self {
            control_bind: validate_socket_address(
                &env::var("PI_DESK_TUNNEL_BIND").unwrap_or_else(|_| "0.0.0.0:7001".to_string()),
            )?,
            control_key,
            relay_token,
        })
    }
}

fn validate_socket_address(value: &str) -> Result<String> {
    if value.is_empty() || value.trim() != value || value.chars().any(char::is_whitespace) {
        return Err(anyhow!("PI_DESK_TUNNEL_BIND 不能为空且不能包含空白字符"));
    }
    let (_, port) = value
        .rsplit_once(':')
        .ok_or_else(|| anyhow!("PI_DESK_TUNNEL_BIND 必须是 host:port"))?;
    let port = port
        .parse::<u16>()
        .map_err(|_| anyhow!("PI_DESK_TUNNEL_BIND 的端口无效"))?;
    if port == 0 {
        return Err(anyhow!("PI_DESK_TUNNEL_BIND 的端口必须大于 0"));
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::validate_socket_address;

    #[test]
    fn validates_runtime_listener_addresses_without_a_port_range() {
        assert_eq!(validate_socket_address("0.0.0.0:1").unwrap(), "0.0.0.0:1");
        assert_eq!(
            validate_socket_address("[2001:db8::1]:65535").unwrap(),
            "[2001:db8::1]:65535"
        );
        assert!(validate_socket_address("host:0").is_err());
        assert!(validate_socket_address("host:65536").is_err());
    }
}
