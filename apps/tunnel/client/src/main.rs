use std::fs;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use pi_desk_tunnel_common::config::{TunnelConfig, normalize_tunnel_config, require_ready};
use serde::Deserialize;

use pi_desk_tunnel_common::provider_cli;

#[derive(Debug)]
struct Arguments {
    config_path: PathBuf,
    local_addr: SocketAddr,
    public_port: u16,
    stats: bool,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            provider_cli::emit_failed(&error);
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<u8, String> {
    let arguments = parse_arguments(std::env::args().skip(1))?;
    let config = read_client_tunnel_config(&arguments.config_path)?;
    let control_key = require_ready(&config)?;
    provider_cli::run_provider(
        config.control_server_url,
        control_key,
        arguments.local_addr,
        arguments.public_port,
        arguments.stats,
        Some(arguments.config_path),
    )
}

fn read_client_tunnel_config(path: &Path) -> Result<TunnelConfig, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!("Pi Desk 配置不存在：{}", path.display())
        } else {
            format!("读取 Pi Desk 配置失败：{error}")
        }
    })?;
    let desktop: DesktopConfig =
        serde_json::from_str(&content).map_err(|error| format!("Pi Desk 配置格式无效：{error}"))?;
    normalize_tunnel_config(TunnelConfig {
        control_server_url: desktop.tunnel.control_server_url,
        control_key: desktop.tunnel.control_key,
    })
}

#[derive(Deserialize)]
struct DesktopConfig {
    #[serde(default)]
    tunnel: DesktopTunnelConfig,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopTunnelConfig {
    #[serde(default)]
    control_server_url: String,
    #[serde(default)]
    control_key: String,
}

fn parse_arguments(values: impl IntoIterator<Item = String>) -> Result<Arguments, String> {
    let mut values = values.into_iter();
    let mut config_path = None;
    let mut local_addr = None;
    let mut public_port = None;
    let mut stats = false;

    while let Some(argument) = values.next() {
        match argument.as_str() {
            "--stats" if !stats => stats = true,
            "--client" => {
                return Err("--client 已移除；请删除该参数，CLI 使用本次运行的临时身份".into());
            }
            "--config" if config_path.is_none() => {
                config_path = Some(PathBuf::from(values.next().ok_or("缺少 --config 的值")?));
            }
            "--local" if local_addr.is_none() => {
                local_addr = Some(validate_local_address(
                    &values.next().ok_or("缺少 --local 的值")?,
                )?);
            }
            "--public-port" if public_port.is_none() => {
                let port = values
                    .next()
                    .ok_or("缺少 --public-port 的值")?
                    .parse::<u16>()
                    .map_err(|_| "public-port 必须是 1 到 65535 的端口")?;
                if port == 0 {
                    return Err("public-port 必须是 1 到 65535 的端口".into());
                }
                public_port = Some(port);
            }
            _ => return Err(format!("未知或重复参数：{argument}")),
        }
    }
    Ok(Arguments {
        config_path: config_path.ok_or("缺少 --config")?,
        local_addr: local_addr.ok_or("缺少 --local")?,
        public_port: public_port.ok_or("缺少 --public-port")?,
        stats,
    })
}

fn validate_local_address(value: &str) -> Result<SocketAddr, String> {
    let address = value
        .parse::<SocketAddr>()
        .map_err(|_| "local 必须是有效的本机 Socket 地址".to_string())?;
    if !address.ip().is_loopback() || address.port() == 0 {
        return Err("local 只允许有效的回环地址".to_string());
    }
    Ok(address)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(values: &[&str]) -> Result<Arguments, String> {
        parse_arguments(values.iter().map(|value| value.to_string()))
    }

    #[test]
    fn only_accepts_loopback_targets() {
        assert!(validate_local_address("127.0.0.1:30333").is_ok());
        assert!(validate_local_address("[::1]:30333").is_ok());
        assert!(validate_local_address("0.0.0.0:30333").is_err());
        assert!(validate_local_address("127.0.0.1:0").is_err());
    }

    #[test]
    fn provider_arguments_keep_stats_opt_in_and_reject_removed_identity_flag() {
        let args = [
            "--config",
            "desktop.json",
            "--local",
            "127.0.0.1:6233",
            "--public-port",
            "11001",
        ];
        assert!(!parse(&args).unwrap().stats);
        let mut stats = args.to_vec();
        stats.push("--stats");
        assert!(parse(&stats).unwrap().stats);
        stats.push("--stats");
        assert!(parse(&stats).unwrap_err().contains("重复"));
        assert!(
            parse(&["--client", "remoteDebug"])
                .unwrap_err()
                .contains("已移除")
        );
        assert!(parse(&["--unknown"]).is_err());
        assert!(parse(&["--config"]).is_err());
    }
}
