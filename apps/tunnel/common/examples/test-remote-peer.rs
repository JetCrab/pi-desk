use std::io::{BufRead, Write};
use std::net::SocketAddr;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use pi_desk_tunnel_common::protocol::parse_key_hex;
use pi_desk_tunnel_common::runtime::TunnelMode;
use pi_desk_tunnel_common::worker::{
    TunnelForwardConfig, TunnelPublicationConfig, TunnelWorkerConfig, TunnelWorkerHandle,
    start_tunnel_worker,
};

enum Role {
    Provide(TunnelPublicationConfig),
    Forward(TunnelForwardConfig),
}

fn main() -> Result<(), String> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let role = match arguments.as_slice() {
        [flag, local_port, public_port] if flag == "--provide" => {
            Role::Provide(TunnelPublicationConfig {
                local_addr: SocketAddr::from((
                    [127, 0, 0, 1],
                    local_port.parse::<u16>().map_err(|_| "本机端口无效")?,
                )),
                public_port: Some(public_port.parse().map_err(|_| "公网端口无效")?),
            })
        }
        [provider_id, remote_port, local_port] => Role::Forward(TunnelForwardConfig {
            provider_id: provider_id.clone(),
            remote_port: remote_port.parse().map_err(|_| "目标端口无效")?,
            local_port: local_port.parse().map_err(|_| "本地端口无效")?,
        }),
        _ => {
            return Err("用法：test-remote-peer <提供端标识> <目标端口> <本地端口>；或 --provide <本机端口> <公网端口>。stdin 输入 auto/relay-only，EOF 停止".into());
        }
    };
    let worker = start_tunnel_worker(TunnelWorkerConfig {
        control_server_url: std::env::var("PI_DESK_TUNNEL_CONTROL_URL")
            .map_err(|_| "缺少控制地址".to_owned())?,
        control_key: parse_key_hex(
            &std::env::var("PI_DESK_TUNNEL_SERVER_KEY").map_err(|_| "缺少控制密钥".to_owned())?,
        )
        .map_err(|error| error.to_string())?,
        provider_secret_key: None,
        mode: TunnelMode::Auto,
        discovery_scope: None,
    })?;
    let result = run(&worker, role);
    let cleanup = worker.shutdown();
    if let Err(error) = &cleanup {
        eprintln!("验收端清理失败：{error}");
    }
    result?;
    cleanup?;
    println!("{{\"type\":\"stopped\"}}");
    Ok(())
}

fn run(worker: &TunnelWorkerHandle, role: Role) -> Result<(), String> {
    match role {
        Role::Provide(target) => worker.publish(target)?,
        Role::Forward(target) => worker.forward(target)?,
    }
    let (sender, receiver) = mpsc::sync_channel(8);
    thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            if sender.send(line).is_err() {
                return;
            }
        }
    });
    let deadline = Instant::now() + Duration::from_secs(1200);
    let mut previous = String::new();
    loop {
        if Instant::now() >= deadline {
            return Err("远端验收运行达到20分钟上限".into());
        }
        let snapshot =
            serde_json::to_string(&worker.snapshot()).map_err(|error| error.to_string())?;
        if snapshot != previous {
            let mut output = std::io::stdout().lock();
            writeln!(output, "{snapshot}").map_err(|error| error.to_string())?;
            output.flush().map_err(|error| error.to_string())?;
            previous = snapshot;
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(line)) => match line.trim() {
                "auto" => worker.set_mode(TunnelMode::Auto)?,
                "relay-only" => worker.set_mode(TunnelMode::RelayOnly)?,
                _ => return Err("验收策略只接受 auto 或 relay-only".into()),
            },
            Ok(Err(error)) => return Err(error.to_string()),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}
