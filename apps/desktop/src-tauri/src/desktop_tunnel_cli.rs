use pi_desk_tunnel_common::config::{
    ensure_device_id, normalize_tunnel_config, require_ready, TunnelConfig,
};
use pi_desk_tunnel_common::worker::{start_tunnel_worker, TunnelWorkerConfig, TunnelWorkerEvent};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

pub(crate) enum Request {
    Info,
    Client {
        local_addr: String,
        public_port: u16,
    },
}

pub(crate) fn parse_request(args: &[String]) -> Result<Request, String> {
    if args.len() == 1 && args[0] == "--tunnel-info" {
        return Ok(Request::Info);
    }
    if args.first().map(String::as_str) != Some("--tunnel-client") {
        return Err("隧道命令参数无效".into());
    }
    let mut values = args[1..].iter();
    let mut local_addr = None;
    let mut public_port = None;
    while let Some(argument) = values.next() {
        match argument.as_str() {
            "--local" if local_addr.is_none() => {
                let value = values.next().ok_or("缺少 --local 的值")?;
                let address = value
                    .parse::<SocketAddr>()
                    .map_err(|_| "local 必须是有效的本机 Socket 地址")?;
                if !address.ip().is_loopback() || address.port() == 0 {
                    return Err("local 只允许有效的回环地址".into());
                }
                local_addr = Some(value.clone());
            }
            "--public-port" if public_port.is_none() => {
                let value = values.next().ok_or("缺少 --public-port 的值")?;
                let port = value
                    .parse::<u16>()
                    .map_err(|_| "public-port 必须是 1 到 65535 的端口")?;
                if port == 0 {
                    return Err("public-port 必须是 1 到 65535 的端口".into());
                }
                public_port = Some(port);
            }
            _ => return Err("隧道命令包含未知或重复参数".into()),
        }
    }
    Ok(Request::Client {
        local_addr: local_addr.ok_or("缺少 --local")?,
        public_port: public_port.ok_or("缺少 --public-port")?,
    })
}

pub(crate) fn run_if_requested() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if !args
        .iter()
        .any(|value| value == "--tunnel-info" || value == "--tunnel-client")
    {
        return None;
    }
    Some(match run(&args) {
        Ok(code) => code,
        Err(error) => {
            if args.iter().any(|value| value == "--tunnel-client") {
                emit(CliEvent::Failed { detail: &error });
            } else {
                eprintln!("[pi-desk-desktop] stage=tunnel-info-error error={error}");
            }
            1
        }
    })
}

fn run(args: &[String]) -> Result<i32, String> {
    let request = parse_request(args)?;
    let path = std::env::var_os("PI_DESK_DESKTOP_CONFIG")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .ok_or("桌面隧道能力需要 PI_DESK_DESKTOP_CONFIG 绝对路径")?;
    match request {
        Request::Info => {
            let info = serde_json::json!({ "controlServerUrl": inspect_config(&path)? });
            let mut stdout = io::stdout().lock();
            serde_json::to_writer(&mut stdout, &info)
                .map_err(|error| format!("输出隧道信息失败：{error}"))?;
            stdout
                .write_all(b"\n")
                .and_then(|()| stdout.flush())
                .map_err(|error| format!("输出隧道信息失败：{error}"))?;
            Ok(0)
        }
        Request::Client {
            local_addr,
            public_port,
        } => run_client(&path, local_addr, public_port),
    }
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

fn read_config(path: &Path) -> Result<DesktopTunnelConfig, String> {
    let content =
        fs::read_to_string(path).map_err(|error| format!("读取桌面隧道配置失败：{error}"))?;
    let desktop: DesktopConfig =
        serde_json::from_str(&content).map_err(|_| "桌面隧道配置格式无效".to_string())?;
    Ok(desktop.tunnel)
}

pub(crate) fn inspect_config(path: &Path) -> Result<Option<String>, String> {
    let address = read_config(path)?.control_server_url.trim().to_string();
    if address.is_empty() {
        return Ok(None);
    }
    let url = url::Url::parse(&address).map_err(|_| "控制服务地址不是有效 URL")?;
    if url.scheme() != "http" || url.host_str().is_none() {
        return Err("控制服务地址必须使用 http:// 并包含主机名".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("控制服务地址不能包含账号或密码".into());
    }
    Ok(Some(url.to_string().trim_end_matches('/').to_string()))
}

fn run_client(path: &Path, local_addr: String, public_port: u16) -> Result<i32, String> {
    let desktop = read_config(path)?;
    let mut config = normalize_tunnel_config(TunnelConfig {
        control_server_url: desktop.control_server_url,
        control_key: desktop.control_key,
        ..TunnelConfig::default()
    })?;
    // 命令实例独占临时 device id，不复用或修改桌面持久化的隧道目标。
    ensure_device_id(&mut config, "command")?;
    let (control_key, device_id) = require_ready(&config, "command")?;
    let worker = start_tunnel_worker(TunnelWorkerConfig {
        control_server_url: config.control_server_url,
        control_key,
        device_id,
        local_addr,
        public_port,
    })?;
    let stop_receiver = monitor_stdin()?;
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
                return Err("Tunnel Worker 意外断开".into());
            }
        }
    }
}

fn monitor_stdin() -> Result<mpsc::Receiver<()>, String> {
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("desktop-tunnel-stdin".into())
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
        .map_err(|error| format!("创建 stdin 监听失败：{error}"))?;
    Ok(receiver)
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

fn emit(event: CliEvent<'_>) {
    let mut stdout = io::stdout().lock();
    if serde_json::to_writer(&mut stdout, &event).is_ok() {
        let _ = stdout.write_all(b"\n");
        let _ = stdout.flush();
    }
}

#[cfg(test)]
#[path = "desktop_tunnel_cli_tests.rs"]
mod tests;
