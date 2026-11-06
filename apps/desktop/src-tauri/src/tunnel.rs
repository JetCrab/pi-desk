use crate::config::{TunnelConnectionConfig, TunnelForward, TunnelPublication};
use pi_desk_tunnel_common::config::{require_ready, TunnelConfig};
use pi_desk_tunnel_common::runtime::{provider_id, TunnelConnectionRow, TunnelMode, TunnelPath};
use pi_desk_tunnel_common::worker::{
    start_tunnel_worker, TunnelForwardConfig, TunnelPhase, TunnelPublicationConfig,
    TunnelWorkerConfig, TunnelWorkerHandle,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::net::{Ipv4Addr, SocketAddr};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationSnapshot {
    #[serde(flatten)]
    pub config: TunnelPublication,
    pub phase: TunnelPhase,
    pub detail: String,
    pub public_addr: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardSnapshot {
    #[serde(flatten)]
    pub config: TunnelForward,
    pub phase: TunnelPhase,
    pub detail: String,
    pub path: TunnelPath,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopTunnelSnapshot {
    pub provider_id: Option<String>,
    pub mode: TunnelMode,
    pub restart_required: bool,
    pub publications: Vec<PublicationSnapshot>,
    pub forwards: Vec<ForwardSnapshot>,
    pub connections: Vec<TunnelConnectionRow>,
    pub error: Option<String>,
}

pub enum TunnelRetry {
    Publication(u16),
    Forward(u16),
}

#[derive(Default)]
pub struct DesktopTunnel {
    worker: Option<TunnelWorkerHandle>,
    // 首次启动后固定连接设置；即使 worker 异常结束也不能读取新保存值重连。
    captured: Option<TunnelWorkerConfig>,
    publications: BTreeMap<u16, TunnelPublication>,
    forwards: BTreeMap<u16, TunnelForward>,
    error: Option<String>,
}

impl DesktopTunnel {
    pub fn reconcile(
        &mut self,
        config: &TunnelConnectionConfig,
        retry: Option<TunnelRetry>,
    ) -> Result<(), String> {
        let result = self.apply(config, retry);
        self.error = result.as_ref().err().cloned();
        result
    }

    fn apply(
        &mut self,
        config: &TunnelConnectionConfig,
        retry: Option<TunnelRetry>,
    ) -> Result<(), String> {
        let enabled = config.publications.iter().any(|item| item.enabled)
            || config.forwards.iter().any(|item| item.enabled);
        if self.worker.is_none() && enabled {
            let captured = match &self.captured {
                Some(captured) => captured.clone(),
                None => {
                    let shared = TunnelConfig {
                        control_server_url: config.control_server_url.clone(),
                        control_key: config.control_key.clone(),
                    };
                    let key = require_ready(&shared)?;
                    let bytes = decode_secret(&config.provider_secret_key)?;
                    TunnelWorkerConfig {
                        control_server_url: shared.control_server_url,
                        control_key: key,
                        provider_secret_key: Some(bytes),
                        mode: config.mode,
                    }
                }
            };
            self.worker = Some(start_tunnel_worker(captured.clone())?);
            self.captured = Some(captured);
        }
        let Some(worker) = &self.worker else {
            return Ok(());
        };
        if worker.is_finished() {
            return Err("隧道后台已结束，请退出并重启应用后重试".into());
        }
        let snapshot = worker.snapshot();
        if snapshot.mode != config.mode {
            worker.set_mode(config.mode)?;
        }
        let publication_ports = self
            .publications
            .keys()
            .copied()
            .chain(
                snapshot
                    .publications
                    .iter()
                    .filter(|row| {
                        row.phase != TunnelPhase::Stopped && row.phase != TunnelPhase::Stopping
                    })
                    .map(|row| row.local_port),
            )
            .collect::<std::collections::BTreeSet<_>>();
        for port in publication_ports {
            if !config
                .publications
                .iter()
                .any(|item| item.enabled && item.local_port == port)
            {
                worker.unpublish(port)?;
                self.publications.remove(&port);
            }
        }
        for item in config.publications.iter().filter(|item| item.enabled) {
            if self.publications.get(&item.local_port) != Some(item)
                || matches!(retry, Some(TunnelRetry::Publication(port)) if port == item.local_port)
            {
                worker.publish(TunnelPublicationConfig {
                    local_addr: SocketAddr::from((Ipv4Addr::LOCALHOST, item.local_port)),
                    public_port: item.public_port,
                })?;
                self.publications.insert(item.local_port, item.clone());
            }
        }
        let forward_ports = self
            .forwards
            .keys()
            .copied()
            .chain(
                snapshot
                    .forwards
                    .iter()
                    .filter(|row| {
                        row.phase != TunnelPhase::Stopped && row.phase != TunnelPhase::Stopping
                    })
                    .map(|row| row.local_port),
            )
            .collect::<std::collections::BTreeSet<_>>();
        for port in forward_ports {
            if !config
                .forwards
                .iter()
                .any(|item| item.enabled && item.local_port == port)
            {
                worker.stop_forward(port)?;
                self.forwards.remove(&port);
            }
        }
        for item in config.forwards.iter().filter(|item| item.enabled) {
            if self.forwards.get(&item.local_port) != Some(item)
                || matches!(retry, Some(TunnelRetry::Forward(port)) if port == item.local_port)
            {
                worker.forward(TunnelForwardConfig {
                    provider_id: item.provider_id.clone(),
                    remote_port: item.remote_port,
                    local_port: item.local_port,
                })?;
                self.forwards.insert(item.local_port, item.clone());
            }
        }
        Ok(())
    }

    pub fn snapshot(&self, config: &TunnelConnectionConfig) -> DesktopTunnelSnapshot {
        self.project_snapshot(
            config,
            self.worker.as_ref().map(TunnelWorkerHandle::snapshot),
        )
    }

    fn project_snapshot(
        &self,
        config: &TunnelConnectionConfig,
        worker: Option<pi_desk_tunnel_common::worker::TunnelWorkerSnapshot>,
    ) -> DesktopTunnelSnapshot {
        // 已接纳但尚未出现在 Worker 快照中的端口，以及清理失败的残留，都必须有管理入口。
        let mut config = config.clone();
        for item in self.publications.values() {
            if !config
                .publications
                .iter()
                .any(|row| row.local_port == item.local_port)
            {
                config.publications.push(item.clone());
            }
        }
        for item in self.forwards.values() {
            if !config
                .forwards
                .iter()
                .any(|row| row.local_port == item.local_port)
            {
                config.forwards.push(item.clone());
            }
        }
        if let Some(worker) = &worker {
            for row in &worker.publications {
                if !config
                    .publications
                    .iter()
                    .any(|item| item.local_port == row.local_port)
                {
                    config.publications.push(TunnelPublication {
                        local_port: row.local_port,
                        public_port: row.public_port,
                        enabled: false,
                    });
                }
            }
            for row in &worker.forwards {
                if !config
                    .forwards
                    .iter()
                    .any(|item| item.local_port == row.local_port)
                {
                    config.forwards.push(TunnelForward {
                        provider_id: row.provider_id.clone(),
                        remote_port: row.remote_port,
                        local_port: row.local_port,
                        enabled: false,
                    });
                }
            }
        }
        let error = self.error.clone().or_else(|| {
            self.worker
                .as_ref()
                .filter(|worker| worker.is_finished())
                .map(|_| "隧道后台已结束，请退出并重启应用后重试".into())
        });
        let phase = |enabled| {
            if enabled && error.is_some() {
                TunnelPhase::Failed
            } else if enabled {
                TunnelPhase::Opening
            } else {
                TunnelPhase::Stopped
            }
        };
        DesktopTunnelSnapshot {
            provider_id: provider_id(&config.provider_secret_key).ok(),
            mode: config.mode,
            restart_required: self.captured.as_ref().is_some_and(|captured| {
                captured.control_server_url != config.control_server_url
                    || require_ready(&TunnelConfig {
                        control_server_url: config.control_server_url.clone(),
                        control_key: config.control_key.clone(),
                    })
                    .ok()
                        != Some(captured.control_key)
            }),
            publications: config
                .publications
                .iter()
                .map(|item| {
                    let row = worker.as_ref().and_then(|worker| {
                        worker
                            .publications
                            .iter()
                            .find(|row| row.local_port == item.local_port)
                    });
                    let matches = row.is_some_and(|row| row.public_port == item.public_port);
                    let failed = row.is_some_and(|row| row.phase == TunnelPhase::Failed)
                        || (!item.enabled
                            && error.is_some()
                            && (self.publications.contains_key(&item.local_port)
                                || row.is_some_and(|row| row.phase != TunnelPhase::Stopped)));
                    let stopping = !item.enabled
                        && !failed
                        && row.is_some_and(|row| row.phase != TunnelPhase::Stopped);
                    PublicationSnapshot {
                        config: item.clone(),
                        phase: if failed {
                            TunnelPhase::Failed
                        } else if stopping {
                            TunnelPhase::Stopping
                        } else {
                            row.filter(|_| matches)
                                .map(|row| row.phase)
                                .unwrap_or_else(|| phase(item.enabled))
                        },
                        detail: if failed {
                            match row.filter(|row| row.phase == TunnelPhase::Failed) {
                                Some(row) if !matches => format!(
                                    "旧发布（公网端口 {}）处理失败：{}",
                                    row.public_port
                                        .map_or_else(|| "未开放".into(), |port| port.to_string()),
                                    desktop_detail(&row.detail)
                                ),
                                Some(row) => desktop_detail(&row.detail),
                                None => error.clone().unwrap_or_default(),
                            }
                        } else if stopping {
                            "正在停止端口".into()
                        } else {
                            row.filter(|_| matches)
                                .map(|row| row.detail.clone())
                                .unwrap_or_else(|| {
                                    error.clone().filter(|_| item.enabled).unwrap_or_default()
                                })
                        },
                        public_addr: row
                            .filter(|row| {
                                item.enabled
                                    && matches
                                    && !failed
                                    && row.phase == TunnelPhase::Listening
                            })
                            .and_then(|row| row.public_addr.clone()),
                    }
                })
                .collect(),
            forwards: config
                .forwards
                .iter()
                .map(|item| {
                    let row = worker.as_ref().and_then(|worker| {
                        worker
                            .forwards
                            .iter()
                            .find(|row| row.local_port == item.local_port)
                    });
                    let matches = row.is_some_and(|row| {
                        row.provider_id == item.provider_id && row.remote_port == item.remote_port
                    });
                    let failed = row.is_some_and(|row| row.phase == TunnelPhase::Failed)
                        || (!item.enabled
                            && error.is_some()
                            && (self.forwards.contains_key(&item.local_port)
                                || row.is_some_and(|row| row.phase != TunnelPhase::Stopped)));
                    let stopping = !item.enabled
                        && !failed
                        && row.is_some_and(|row| row.phase != TunnelPhase::Stopped);
                    ForwardSnapshot {
                        config: item.clone(),
                        phase: if failed {
                            TunnelPhase::Failed
                        } else if stopping {
                            TunnelPhase::Stopping
                        } else {
                            row.filter(|_| matches)
                                .map(|row| row.phase)
                                .unwrap_or_else(|| phase(item.enabled))
                        },
                        detail: if failed {
                            match row.filter(|row| row.phase == TunnelPhase::Failed) {
                                Some(row) if !matches => format!(
                                    "旧映射（提供端 {}，目标端口 {}）处理失败：{}",
                                    row.provider_id,
                                    row.remote_port,
                                    desktop_detail(&row.detail)
                                ),
                                Some(row) => desktop_detail(&row.detail),
                                None => error.clone().unwrap_or_default(),
                            }
                        } else if stopping {
                            "正在停止映射".into()
                        } else {
                            row.filter(|_| matches)
                                .map(|row| row.detail.clone())
                                .unwrap_or_else(|| {
                                    error.clone().filter(|_| item.enabled).unwrap_or_default()
                                })
                        },
                        path: row
                            .filter(|_| item.enabled && matches && !failed)
                            .map(|row| row.path)
                            .unwrap_or(TunnelPath::Unknown),
                    }
                })
                .collect(),
            connections: worker.map(|worker| worker.connections).unwrap_or_default(),
            error,
        }
    }

    pub fn take_worker(&mut self) -> Option<TunnelWorkerHandle> {
        self.worker.take()
    }
}

fn desktop_detail(detail: &str) -> String {
    detail.replace("需重建隧道后台后重试", "请退出并重启应用后重试")
}

fn decode_secret(value: &str) -> Result<[u8; 32], String> {
    provider_id(value)?;
    let mut bytes = [0; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .map_err(|_| "提供端私钥无效".to_string())?;
    }
    Ok(bytes)
}

#[cfg(test)]
#[path = "tunnel_tests.rs"]
pub(crate) mod tests;
