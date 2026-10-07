use std::fs;
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::mpsc;
use std::time::Duration;

use pi_desk_tunnel_common::config::{TunnelConfig, ensure_device_id, require_ready};
use pi_desk_tunnel_common::worker::{TunnelWorkerConfig, TunnelWorkerEvent, start_tunnel_worker};
use serde::{Deserialize, Serialize};

#[derive(Debug)]
struct Arguments {
    config_path: PathBuf,
    client: String,
    local_addr: String,
    public_port: u16,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum CliEvent<'a> {
    Opening,
    Connecting {
        #[serde(rename = "publicAddr")]
        public_addr: &'a str,
    },
    Listening {
        #[serde(rename = "publicAddr")]
        public_addr: &'a str,
    },
    Recovering {
        detail: &'a str,
    },
    Failed {
        detail: &'a str,
    },
    Stopped,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code),
        Err(error) => {
            emit(CliEvent::Failed { detail: &error });
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<u8, String> {
    let arguments = parse_arguments()?;
    validate_local_address(&arguments.local_addr)?;

    let mut config = read_client_tunnel_config(&arguments.config_path)?;
    ensure_device_id(&mut config, &arguments.client)?;
    let (control_key, device_id) = require_ready(&config, &arguments.client)?;

    let worker = start_tunnel_worker(TunnelWorkerConfig {
        control_server_url: config.control_server_url,
        control_key,
        device_id,
        local_addr: arguments.local_addr,
        public_port: arguments.public_port,
    })?;
    let stop_receiver = monitor_stdin();
    let mut stopping = false;
    let mut failed = false;

    loop {
        if !stopping && stop_receiver.try_recv().is_ok() {
            stopping = true;
            worker.stop();
        }
        match worker.recv_timeout(Duration::from_millis(200)) {
            Ok(TunnelWorkerEvent::Opening) => emit(CliEvent::Opening),
            Ok(TunnelWorkerEvent::Connecting { public_addr }) => emit(CliEvent::Connecting {
                public_addr: &public_addr,
            }),
            Ok(TunnelWorkerEvent::Listening { public_addr }) => emit(CliEvent::Listening {
                public_addr: &public_addr,
            }),
            Ok(TunnelWorkerEvent::Recovering(detail)) => {
                emit(CliEvent::Recovering { detail: &detail })
            }
            Ok(TunnelWorkerEvent::Failed(detail)) => {
                failed = true;
                emit(CliEvent::Failed { detail: &detail });
            }
            Ok(TunnelWorkerEvent::Stopped) => {
                emit(CliEvent::Stopped);
                return Ok(if failed { 1 } else { 0 });
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Tunnel Worker 意外断开".to_string());
            }
        }
    }
}

fn read_client_tunnel_config(path: &Path) -> Result<TunnelConfig, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            format!("Pi Desk 配置不存在：{}", path.display())
        } else {
            format!("读取 Pi Desk 配置失败：{error}")
        }
    })?;
    let desktop: DesktopConfig = serde_json::from_str(&content)
        .map_err(|error| format!("Pi Desk 配置格式无效：{error}"))?;
    Ok(TunnelConfig {
        control_server_url: desktop.tunnel.control_server_url,
        control_key: desktop.tunnel.control_key,
        ..TunnelConfig::default()
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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

fn parse_arguments() -> Result<Arguments, String> {
    let mut values = std::env::args().skip(1);
    let mut config_path = None;
    let mut client = None;
    let mut local_addr = None;
    let mut public_port = None;

    while let Some(argument) = values.next() {
        let value = values
            .next()
            .ok_or_else(|| format!("参数 {argument} 缺少值"))?;
        match argument.as_str() {
            "--config" => config_path = Some(PathBuf::from(value)),
            "--client" => client = Some(value),
            "--local" => local_addr = Some(value),
            "--public-port" => {
                public_port = Some(
                    value
                        .parse::<u16>()
                        .map_err(|_| "public-port 必须是 1 到 65535 的端口".to_string())?,
                )
            }
            _ => return Err(format!("未知参数：{argument}")),
        }
    }

    let public_port = public_port.ok_or_else(|| "缺少 --public-port".to_string())?;
    if public_port == 0 {
        return Err("public-port 必须是 1 到 65535 的端口".to_string());
    }
    Ok(Arguments {
        config_path: config_path.ok_or_else(|| "缺少 --config".to_string())?,
        client: client.ok_or_else(|| "缺少 --client".to_string())?,
        local_addr: local_addr.ok_or_else(|| "缺少 --local".to_string())?,
        public_port,
    })
}

fn validate_local_address(value: &str) -> Result<(), String> {
    let address = value
        .parse::<SocketAddr>()
        .map_err(|_| "local 必须是有效的本机 Socket 地址".to_string())?;
    if !address.ip().is_loopback() || address.port() == 0 {
        return Err("local 只允许有效的回环地址".to_string());
    }
    Ok(())
}

fn monitor_stdin() -> mpsc::Receiver<()> {
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("pi-desk-tunnel-stdin".to_string())
        .spawn(move || {
            let mut stdin = io::stdin().lock();
            let mut buffer = [0_u8; 64];
            loop {
                match stdin.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(_) => {}
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                }
            }
            let _ = sender.send(());
        })
        .expect("应创建 stdin 监听线程");
    receiver
}

fn emit(event: CliEvent<'_>) {
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &event).is_ok() {
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::validate_local_address;

    #[test]
    fn only_accepts_loopback_targets() {
        assert!(validate_local_address("127.0.0.1:30333").is_ok());
        assert!(validate_local_address("[::1]:30333").is_ok());
        assert!(validate_local_address("0.0.0.0:30333").is_err());
    }
}
