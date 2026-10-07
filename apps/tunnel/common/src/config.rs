use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use url::Url;

use crate::protocol::{parse_key_hex, random_hex};

pub const TUNNEL_CONFIG_VERSION: u8 = 1;
pub const DESKTOP_DEVICE_KEY: &str = "desktop";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunnelConfig {
    pub version: u8,
    #[serde(default)]
    pub control_server_url: String,
    #[serde(default)]
    pub control_key: String,
    #[serde(default)]
    pub device_ids: BTreeMap<String, String>,
}

impl Default for TunnelConfig {
    fn default() -> Self {
        Self {
            version: TUNNEL_CONFIG_VERSION,
            control_server_url: String::new(),
            control_key: String::new(),
            device_ids: BTreeMap::new(),
        }
    }
}

pub fn normalize_tunnel_config(mut config: TunnelConfig) -> Result<TunnelConfig, String> {
    if config.version != TUNNEL_CONFIG_VERSION {
        return Err(format!("不支持的 Tunnel 配置版本：{}", config.version));
    }

    config.control_server_url = normalize_control_server_url(&config.control_server_url)?;
    config.control_key = config.control_key.trim().to_string();
    if !config.control_key.is_empty() {
        parse_key_hex(&config.control_key).map_err(|error| error.to_string())?;
    }

    let mut device_ids = BTreeMap::new();
    for (raw_name, raw_device_id) in config.device_ids {
        let name = raw_name.trim();
        if !is_device_name(name) {
            return Err(format!("Tunnel 客户端名称无效：{raw_name}"));
        }
        let device_id = raw_device_id.trim();
        if !is_device_id(device_id) {
            return Err(format!("Tunnel 客户端 {name} 的设备标识无效"));
        }
        device_ids.insert(name.to_string(), device_id.to_string());
    }
    config.device_ids = device_ids;
    Ok(config)
}

pub fn ensure_device_id(config: &mut TunnelConfig, client: &str) -> Result<String, String> {
    if !is_device_name(client) {
        return Err("Tunnel 客户端名称无效".to_string());
    }
    if let Some(device_id) = config.device_ids.get(client) {
        return Ok(device_id.clone());
    }
    let device_id = random_hex::<16>().map_err(|error| format!("无法生成隧道设备标识：{error}"))?;
    config
        .device_ids
        .insert(client.to_string(), device_id.clone());
    Ok(device_id)
}

pub fn require_ready(config: &TunnelConfig, client: &str) -> Result<([u8; 32], String), String> {
    if config.control_server_url.is_empty() {
        return Err("启用隧道前请填写控制服务地址".to_string());
    }
    if config.control_key.is_empty() {
        return Err("启用隧道前请填写控制密钥".to_string());
    }
    let device_id = config
        .device_ids
        .get(client)
        .filter(|value| !value.is_empty())
        .cloned()
        .ok_or_else(|| "隧道设备标识尚未初始化".to_string())?;
    let key = parse_key_hex(&config.control_key).map_err(|error| error.to_string())?;
    Ok((key, device_id))
}

fn normalize_control_server_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(String::new());
    }
    let url = Url::parse(value).map_err(|_| "控制服务地址不是有效 URL".to_string())?;
    if url.scheme() != "http" {
        return Err("控制服务地址必须使用 http://".to_string());
    }
    if url.host_str().is_none() {
        return Err("控制服务地址必须包含主机名".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("控制服务地址不能包含账号或密码".to_string());
    }
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn is_device_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_device_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::{
        DESKTOP_DEVICE_KEY, TunnelConfig, ensure_device_id, normalize_tunnel_config, require_ready,
    };

    #[test]
    fn generates_stable_device_id_in_memory() {
        let mut config = TunnelConfig {
            control_server_url: "http://tunnel.example:7001/".to_string(),
            control_key: "ab".repeat(32),
            ..TunnelConfig::default()
        };
        let device_id = ensure_device_id(&mut config, DESKTOP_DEVICE_KEY).expect("应生成设备 ID");

        assert_eq!(
            ensure_device_id(&mut config, DESKTOP_DEVICE_KEY).expect("应复用设备 ID"),
            device_id
        );
        assert!(require_ready(&config, DESKTOP_DEVICE_KEY).is_ok());
    }

    #[test]
    fn rejects_unknown_versions_and_invalid_device_ids() {
        let config = TunnelConfig {
            version: 2,
            ..TunnelConfig::default()
        };
        assert!(normalize_tunnel_config(config).is_err());

        let mut config = TunnelConfig::default();
        config
            .device_ids
            .insert(DESKTOP_DEVICE_KEY.to_string(), "invalid".to_string());
        assert!(normalize_tunnel_config(config).is_err());
    }
}
