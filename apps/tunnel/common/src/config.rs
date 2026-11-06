use serde::{Deserialize, Serialize};
use url::Url;

use crate::protocol::parse_key_hex;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TunnelConfig {
    pub control_server_url: String,
    pub control_key: String,
}

pub fn normalize_tunnel_config(mut config: TunnelConfig) -> Result<TunnelConfig, String> {
    config.control_server_url = normalize_control_server_url(&config.control_server_url)?;
    config.control_key = config.control_key.trim().to_owned();
    if !config.control_key.is_empty() {
        parse_key_hex(&config.control_key).map_err(|error| error.to_string())?;
    }
    Ok(config)
}

pub fn require_ready(config: &TunnelConfig) -> Result<[u8; 32], String> {
    if normalize_control_server_url(&config.control_server_url)?.is_empty() {
        return Err("启用隧道前请填写控制服务地址".to_owned());
    }
    if config.control_key.is_empty() {
        return Err("启用隧道前请填写控制密钥".to_owned());
    }
    parse_key_hex(&config.control_key).map_err(|error| error.to_string())
}

fn normalize_control_server_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    let url = Url::parse(value).map_err(|_| "控制服务地址不是有效 URL".to_owned())?;
    if url.scheme() != "http" {
        return Err("控制服务地址必须使用 http://".to_owned());
    }
    if url.host_str().is_none() {
        return Err("控制服务地址必须包含主机名".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("控制服务地址不能包含账号或密码".to_owned());
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_config_has_no_desktop_identity_or_version() {
        let config: TunnelConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config, TunnelConfig::default());
        assert!(serde_json::from_str::<TunnelConfig>(r#"{"deviceIds":{}}"#).is_err());
        assert!(serde_json::from_str::<TunnelConfig>(r#"{"version":1}"#).is_err());
    }

    #[test]
    fn normalizes_and_validates_connection_settings() {
        let config = normalize_tunnel_config(TunnelConfig {
            control_server_url: " http://tunnel.example:7001/ ".to_owned(),
            control_key: format!(" {} ", "ab".repeat(32)),
        })
        .unwrap();
        assert_eq!(config.control_server_url, "http://tunnel.example:7001");
        assert_eq!(require_ready(&config).unwrap(), [0xab; 32]);
        assert!(require_ready(&TunnelConfig::default()).is_err());
        assert!(normalize_control_server_url("https://tunnel.example").is_err());
        assert!(normalize_control_server_url("http://user:password@tunnel.example").is_err());
    }
}
