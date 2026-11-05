use pi_desk_tunnel_common::config::{normalize_tunnel_config, require_ready, TunnelConfig};
use pi_desk_tunnel_common::provider_cli;
use serde::Deserialize;
use std::fs;
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

pub(crate) enum Request {
    Info,
    Client {
        local_addr: String,
        public_port: u16,
        stats: bool,
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
    let mut stats = false;
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
            "--stats" if !stats => stats = true,
            _ => return Err(format!("隧道命令包含未知或重复参数：{argument}")),
        }
    }
    Ok(Request::Client {
        local_addr: local_addr.ok_or("缺少 --local")?,
        public_port: public_port.ok_or("缺少 --public-port")?,
        stats,
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
                provider_cli::emit_failed(&error);
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
            stats,
        } => run_client(&path, local_addr, public_port, stats),
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

fn run_client(
    path: &Path,
    local_addr: String,
    public_port: u16,
    stats: bool,
) -> Result<i32, String> {
    let desktop = read_config(path)?;
    let config = normalize_tunnel_config(TunnelConfig {
        control_server_url: desktop.control_server_url,
        control_key: desktop.control_key,
    })?;
    let control_key = require_ready(&config)?;
    let local_addr = local_addr
        .parse::<SocketAddr>()
        .map_err(|_| "local 地址无效")?;
    provider_cli::run_provider(
        config.control_server_url,
        control_key,
        local_addr,
        public_port,
        stats,
    )
    .map(i32::from)
}

#[cfg(test)]
#[path = "desktop_tunnel_cli_tests.rs"]
mod tests;
