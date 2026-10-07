// Derived from rathole (Apache-2.0), modified for Pi Desk Noise TCP tunnels.
use std::collections::HashMap;
use std::fmt::{Debug, Formatter};
use std::ops::Deref;

use anyhow::{Result, anyhow, bail};

const DEFAULT_HEARTBEAT_INTERVAL_SECS: u64 = 30;
const DEFAULT_HEARTBEAT_TIMEOUT_SECS: u64 = 40;
const DEFAULT_CLIENT_RETRY_INTERVAL_SECS: u64 = 1;

#[derive(Default, PartialEq, Eq, Clone)]
pub struct MaskedString(String);

impl Debug for MaskedString {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("MASKED")
    }
}

impl Deref for MaskedString {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl From<&str> for MaskedString {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoiseConfig {
    pub local_private_key: Option<MaskedString>,
    pub remote_public_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TcpConfig {
    pub nodelay: bool,
    pub keepalive_secs: u64,
    pub keepalive_interval: u64,
}

impl Default for TcpConfig {
    fn default() -> Self {
        Self {
            nodelay: true,
            keepalive_secs: 20,
            keepalive_interval: 8,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientServiceConfig {
    pub name: String,
    pub local_addr: String,
    pub token: Option<MaskedString>,
    pub nodelay: bool,
    pub retry_interval: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerServiceConfig {
    pub name: String,
    pub bind_addr: String,
    pub token: Option<MaskedString>,
    pub nodelay: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientConfig {
    pub remote_addr: String,
    pub default_token: Option<MaskedString>,
    pub services: HashMap<String, ClientServiceConfig>,
    pub tcp: TcpConfig,
    pub noise: NoiseConfig,
    pub heartbeat_timeout: u64,
    pub retry_interval: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerConfig {
    pub bind_addr: String,
    pub default_token: Option<MaskedString>,
    pub services: HashMap<String, ServerServiceConfig>,
    pub tcp: TcpConfig,
    pub noise: NoiseConfig,
    pub heartbeat_interval: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub server: Option<ServerConfig>,
    pub client: Option<ClientConfig>,
}

impl Config {
    pub fn validate_and_complete(mut self) -> Result<Self> {
        match (&mut self.server, &mut self.client) {
            (Some(server), None) => Self::validate_server(server)?,
            (None, Some(client)) => Self::validate_client(client)?,
            _ => return Err(anyhow!("必须且只能设置一个隧道运行模式")),
        }
        Ok(self)
    }

    fn validate_client(client: &mut ClientConfig) -> Result<()> {
        if client.remote_addr.is_empty()
            || client
                .noise
                .remote_public_key
                .as_deref()
                .unwrap_or("")
                .is_empty()
        {
            bail!("Noise 客户端配置不完整");
        }
        for (name, service) in &mut client.services {
            if service.local_addr.is_empty() {
                bail!("TCP 本地地址不能为空");
            }
            service.name = name.clone();
            if service.token.is_none() {
                service.token = client.default_token.clone();
            }
            if service.token.is_none() {
                bail!("TCP 服务令牌不能为空");
            }
            if service.retry_interval.is_none() {
                service.retry_interval = Some(client.retry_interval);
            }
        }
        Ok(())
    }

    fn validate_server(server: &mut ServerConfig) -> Result<()> {
        if server.bind_addr.is_empty() || server.noise.local_private_key.is_none() {
            bail!("Noise 服务端配置不完整");
        }
        for (name, service) in &mut server.services {
            if service.bind_addr.is_empty() {
                bail!("TCP 公网监听地址不能为空");
            }
            service.name = name.clone();
            if service.token.is_none() {
                service.token = server.default_token.clone();
            }
            if service.token.is_none() {
                bail!("TCP 服务令牌不能为空");
            }
        }
        Ok(())
    }
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            remote_addr: String::new(),
            default_token: None,
            services: HashMap::new(),
            tcp: TcpConfig::default(),
            noise: NoiseConfig {
                local_private_key: None,
                remote_public_key: None,
            },
            heartbeat_timeout: DEFAULT_HEARTBEAT_TIMEOUT_SECS,
            retry_interval: DEFAULT_CLIENT_RETRY_INTERVAL_SECS,
        }
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_addr: String::new(),
            default_token: None,
            services: HashMap::new(),
            tcp: TcpConfig::default(),
            noise: NoiseConfig {
                local_private_key: None,
                remote_public_key: None,
            },
            heartbeat_interval: DEFAULT_HEARTBEAT_INTERVAL_SECS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_dynamic_tcp_service_defaults() {
        let config = Config {
            server: None,
            client: Some(ClientConfig {
                remote_addr: "relay.example:2333".into(),
                default_token: Some("token".into()),
                services: [(
                    "service".into(),
                    ClientServiceConfig {
                        name: String::new(),
                        local_addr: "127.0.0.1:30333".into(),
                        token: None,
                        nodelay: true,
                        retry_interval: None,
                    },
                )]
                .into_iter()
                .collect(),
                noise: NoiseConfig {
                    local_private_key: None,
                    remote_public_key: Some("key".into()),
                },
                ..Default::default()
            }),
        }
        .validate_and_complete()
        .expect("配置应完整");
        let service = &config.client.unwrap().services["service"];
        assert_eq!(service.name, "service");
        assert_eq!(&**service.token.as_ref().unwrap(), "token");
        assert_eq!(
            service.retry_interval,
            Some(DEFAULT_CLIENT_RETRY_INTERVAL_SECS)
        );
    }
}
