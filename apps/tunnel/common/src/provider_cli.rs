use std::io::{self, Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use crate::runtime::{TunnelConnectionRow, TunnelMode};
use crate::worker::{
    self, TunnelPhase, TunnelPublicationConfig, TunnelPublicationSnapshot, TunnelWorkerConfig,
};
use serde::Serialize;

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
    Connections {
        rows: &'a [TunnelConnectionRow],
    },
    Stopped,
}

struct Output<W> {
    writer: W,
    last_event: Option<String>,
    last_connections: Option<Vec<TunnelConnectionRow>>,
    stats: bool,
}

impl<W: Write> Output<W> {
    fn emit(&mut self, event: CliEvent<'_>) -> Result<(), String> {
        let line = serde_json::to_string(&event).map_err(|error| error.to_string())?;
        self.writer
            .write_all(line.as_bytes())
            .and_then(|()| self.writer.write_all(b"\n"))
            .and_then(|()| self.writer.flush())
            .map_err(|error| format!("输出隧道事件失败：{error}"))
    }

    fn publication(&mut self, row: Option<&TunnelPublicationSnapshot>) -> Result<(), String> {
        let event = match row {
            None => CliEvent::Opening,
            Some(row) => match row.phase {
                TunnelPhase::Opening => CliEvent::Opening,
                TunnelPhase::Connecting | TunnelPhase::Listening => {
                    let address = row
                        .public_addr
                        .as_deref()
                        .filter(|value| !value.trim().is_empty());
                    let Some(public_addr) = address else {
                        if row.phase == TunnelPhase::Listening {
                            return Err("公网隧道已就绪但未返回 publicAddr".into());
                        }
                        return Ok(());
                    };
                    if row.phase == TunnelPhase::Listening {
                        CliEvent::Listening { public_addr }
                    } else {
                        CliEvent::Connecting { public_addr }
                    }
                }
                TunnelPhase::Recovering => CliEvent::Recovering {
                    detail: &row.detail,
                },
                TunnelPhase::Failed => CliEvent::Failed {
                    detail: &row.detail,
                },
                // stopped 只能在 owner 完成同步 shutdown/join 后输出。
                TunnelPhase::Stopping | TunnelPhase::Stopped => return Ok(()),
            },
        };
        let key = serde_json::to_string(&event).map_err(|error| error.to_string())?;
        if self.last_event.as_ref() != Some(&key) {
            self.emit(event)?;
            self.last_event = Some(key);
        }
        Ok(())
    }

    fn connections(&mut self, rows: &[TunnelConnectionRow]) -> Result<(), String> {
        if self.stats && self.last_connections.as_deref() != Some(rows) {
            self.emit(CliEvent::Connections { rows })?;
            self.last_connections = Some(rows.to_vec());
        }
        Ok(())
    }
}

pub fn run_provider(
    control_server_url: String,
    control_key: [u8; 32],
    local_addr: SocketAddr,
    public_port: u16,
    stats: bool,
    discovery_scope: Option<PathBuf>,
) -> Result<u8, String> {
    let stop_receiver = monitor_stdin()?;
    let worker = worker::start_tunnel_worker(TunnelWorkerConfig {
        control_server_url,
        control_key,
        provider_secret_key: None,
        mode: TunnelMode::Auto,
        discovery_scope,
    })?;
    let mut output = Output {
        writer: io::stdout(),
        last_event: None,
        last_connections: None,
        stats,
    };
    let outcome = (|| -> Result<Option<String>, String> {
        worker.publish(TunnelPublicationConfig {
            local_addr,
            public_port: Some(public_port),
        })?;
        output.publication(None)?;
        let mut stopping = false;
        loop {
            if !stopping && stop_receiver.try_recv().is_ok() {
                stopping = true;
                worker.stop();
            }
            let snapshot = worker.snapshot();
            let publication = snapshot
                .publications
                .iter()
                .find(|row| row.local_port == local_addr.port());
            output.publication(publication)?;
            output.connections(&snapshot.connections)?;
            if let Some(row) = publication.filter(|row| row.phase == TunnelPhase::Failed) {
                return Ok(Some(row.detail.clone()));
            }
            if worker.is_finished() {
                return Ok(if stopping {
                    None
                } else {
                    Some("Tunnel Worker 意外退出".into())
                });
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    })();
    if let Err(cleanup_error) = worker.shutdown() {
        eprintln!("隧道资源回收失败：{cleanup_error}");
        return Err(match outcome {
            Err(first_error) | Ok(Some(first_error)) => first_error,
            Ok(None) => cleanup_error,
        });
    }
    let failure = outcome?;
    if let Some(detail) = &failure {
        // 常规 Failed 已在快照投影中发出；异常退出仍需明确失败。
        let key = serde_json::to_string(&CliEvent::Failed { detail })
            .map_err(|error| error.to_string())?;
        if output.last_event.as_ref() != Some(&key) {
            output.emit(CliEvent::Failed { detail })?;
        }
    }
    output.connections(&[])?;
    output.emit(CliEvent::Stopped)?;
    Ok(u8::from(failure.is_some()))
}

pub fn emit_failed(detail: &str) {
    let mut output = Output {
        writer: io::stdout(),
        last_event: None,
        last_connections: None,
        stats: false,
    };
    let _ = output.emit(CliEvent::Failed { detail });
}

fn monitor_stdin() -> Result<mpsc::Receiver<()>, String> {
    let (sender, receiver) = mpsc::channel();
    // 不 join 阻塞中的 stdin reader；Worker 失败也必须能独立退出进程。
    std::thread::Builder::new()
        .name("pi-desk-tunnel-stdin".into())
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::{TunnelPath, TunnelSource};
    use serde_json::Value;

    fn output(stats: bool) -> Output<Vec<u8>> {
        Output {
            writer: Vec::new(),
            last_event: None,
            last_connections: None,
            stats,
        }
    }

    fn events(output: &Output<Vec<u8>>) -> Vec<Value> {
        String::from_utf8(output.writer.clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn default_events_only_report_real_public_readiness_and_phase_changes() {
        let mut output = output(false);
        output.publication(None).unwrap();
        let mut row = TunnelPublicationSnapshot {
            local_port: 6233,
            public_port: Some(11001),
            phase: TunnelPhase::Opening,
            detail: String::new(),
            public_addr: None,
        };
        output.publication(Some(&row)).unwrap();
        row.phase = TunnelPhase::Connecting;
        output.publication(Some(&row)).unwrap();
        row.public_addr = Some("tunnel.example:11001".into());
        output.publication(Some(&row)).unwrap();
        row.phase = TunnelPhase::Listening;
        output.publication(Some(&row)).unwrap();
        output.publication(Some(&row)).unwrap();
        row.phase = TunnelPhase::Recovering;
        row.detail = "控制服务断开".into();
        output.publication(Some(&row)).unwrap();
        row.phase = TunnelPhase::Stopping;
        output.publication(Some(&row)).unwrap();
        output.connections(&[]).unwrap();
        assert_eq!(
            events(&output),
            vec![
                serde_json::json!({"type":"opening"}),
                serde_json::json!({"type":"connecting","publicAddr":"tunnel.example:11001"}),
                serde_json::json!({"type":"listening","publicAddr":"tunnel.example:11001"}),
                serde_json::json!({"type":"recovering","detail":"控制服务断开"}),
            ]
        );
        row.phase = TunnelPhase::Listening;
        row.public_addr = Some(" ".into());
        assert!(output.publication(Some(&row)).is_err());
    }

    #[test]
    fn stats_are_full_changed_snapshots_and_finish_at_zero() {
        let mut output = output(true);
        let mut rows = vec![TunnelConnectionRow {
            peer_id: "peer".into(),
            local_port: 6233,
            source: TunnelSource::Public,
            path: TunnelPath::Direct,
            active_tcp: 2,
        }];
        output.connections(&rows).unwrap();
        output.connections(&rows).unwrap();
        rows[0].path = TunnelPath::Relay;
        output.connections(&rows).unwrap();
        output.connections(&[]).unwrap();
        output.connections(&[]).unwrap();
        let events = events(&output);
        assert_eq!(events.len(), 3);
        assert_eq!(
            events[0],
            serde_json::json!({"type":"connections","rows":[{
                "peerId":"peer","localPort":6233,"source":"public","path":"direct","activeTcp":2
            }]})
        );
        assert_eq!(events[1]["rows"][0]["path"], "relay");
        assert_eq!(
            events[2],
            serde_json::json!({"type":"connections","rows":[]})
        );
    }
}
