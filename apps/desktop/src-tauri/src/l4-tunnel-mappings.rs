use pi_desk_tunnel_common::runtime::{TunnelMode, TunnelPath};
use pi_desk_tunnel_common::worker::{
    start_tunnel_worker, TunnelForwardSnapshot, TunnelPhase, TunnelWorkerConfig, TunnelWorkerHandle,
};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub status: &'static str,
    pub local_port: Option<u16>,
    pub path: Option<TunnelPath>,
    pub error: Option<String>,
}

impl Snapshot {
    fn connecting() -> Self {
        Self {
            status: "connecting",
            local_port: None,
            path: Some(TunnelPath::Unknown),
            error: None,
        }
    }

    fn failed(error: String) -> Self {
        Self {
            status: "failed",
            local_port: None,
            path: None,
            error: Some(error),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Owner {
    pub label: String,
    pub document: String,
}

struct Entry {
    owner: Owner,
    snapshot: Snapshot,
    observed: Option<(Option<String>, TunnelPhase, TunnelPath, String)>,
}

#[derive(Default)]
struct State {
    documents: HashMap<String, String>,
    entries: HashMap<String, Entry>,
    closing: bool,
}

type Reply<T> = mpsc::Sender<Result<T, String>>;

enum Command {
    Open {
        id: String,
        owner: Owner,
        config: TunnelWorkerConfig,
        provider_id: String,
        remote_port: u16,
    },
    Get(Owner, String, Reply<Snapshot>),
    Close(Owner, String, Reply<()>),
    Release(Owner),
    Shutdown,
}

pub(crate) struct Mappings {
    state: Arc<Mutex<State>>,
    commands: mpsc::SyncSender<Command>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl Mappings {
    pub fn new(log_path: std::path::PathBuf) -> Result<Self, String> {
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let (commands, receiver) = mpsc::sync_channel(256);
        let thread = std::thread::Builder::new()
            .name("pi-desk-plugin-tunnels".into())
            .spawn(move || Actor::new(shared, log_path).run(receiver))
            .map_err(|error| format!("无法启动插件映射后台：{error}"))?;
        Ok(Self {
            state,
            commands,
            thread: Mutex::new(Some(thread)),
        })
    }

    pub fn document(&self, label: &str) -> Result<String, String> {
        let mut state = self.state.lock().unwrap();
        if state.closing {
            return Err("桌面程序正在退出".into());
        }
        if let Some(document) = state.documents.get(label) {
            return Ok(document.clone());
        }
        let document = pi_desk_tunnel_common::runtime::generate_secret_key()?;
        state.documents.insert(label.into(), document.clone());
        Ok(document)
    }

    pub fn validate(&self, owner: &Owner) -> Result<(), String> {
        validate(&self.state.lock().unwrap(), owner)
    }

    pub fn invalidate(&self, label: &str) {
        let mut state = self.state.lock().unwrap();
        if let Some(document) = state.documents.remove(label) {
            let _ = self.commands.try_send(Command::Release(Owner {
                label: label.into(),
                document,
            }));
        }
    }

    pub fn release(&self, owner: &Owner) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        validate(&state, owner)?;
        state.documents.remove(&owner.label);
        // 后台也按失效文档扫描，队列已满时仍会完成原生回收。
        let _ = self.commands.try_send(Command::Release(owner.clone()));
        Ok(())
    }

    pub fn open(
        &self,
        owner: Owner,
        id: String,
        config: TunnelWorkerConfig,
        provider_id: String,
        remote_port: u16,
    ) -> Result<Snapshot, String> {
        let mut state = self.state.lock().unwrap();
        validate(&state, &owner)?;
        if state.entries.contains_key(&id) {
            return Err("映射标识已被使用".into());
        }
        if state.entries.len() >= 128
            || state
                .entries
                .values()
                .filter(|entry| entry.owner.label == owner.label)
                .count()
                >= 64
        {
            return Err("插件映射数量已达到上限".into());
        }
        let snapshot = Snapshot::connecting();
        state.entries.insert(
            id.clone(),
            Entry {
                owner: owner.clone(),
                snapshot: snapshot.clone(),
                observed: None,
            },
        );
        if self
            .commands
            .try_send(Command::Open {
                id: id.clone(),
                owner,
                config,
                provider_id,
                remote_port,
            })
            .is_err()
        {
            state.entries.remove(&id);
            return Err("插件映射后台不可用或请求队列已满".into());
        }
        Ok(snapshot)
    }

    pub fn get(&self, owner: Owner, id: String) -> Result<Snapshot, String> {
        let (sender, receiver) = mpsc::channel();
        {
            let state = self.state.lock().unwrap();
            owned(&state, &owner, &id)?;
            self.commands
                .try_send(Command::Get(owner, id, sender))
                .map_err(|_| "插件映射后台不可用或请求队列已满")?;
        }
        receiver.recv().map_err(|_| "插件映射后台已结束")?
    }

    pub fn close(&self, owner: Owner, id: String) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel();
        {
            let state = self.state.lock().unwrap();
            validate(&state, &owner)?;
            if !state.entries.contains_key(&id) {
                return Ok(());
            }
            owned(&state, &owner, &id)?;
            self.commands
                .try_send(Command::Close(owner, id, sender))
                .map_err(|_| "插件映射后台不可用或请求队列已满")?;
        }
        receiver.recv().map_err(|_| "插件映射后台已结束")?
    }

    pub fn shutdown(&self) {
        {
            let mut state = self.state.lock().unwrap();
            state.closing = true;
            state.documents.clear();
        }
        let _ = self.commands.send(Command::Shutdown);
        if let Some(thread) = self.thread.lock().unwrap().take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Mappings {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn validate(state: &State, owner: &Owner) -> Result<(), String> {
    if state.closing || state.documents.get(&owner.label) != Some(&owner.document) {
        return Err("工作台文档已释放".into());
    }
    Ok(())
}

fn owned<'a>(state: &'a State, owner: &Owner, id: &str) -> Result<&'a Entry, String> {
    validate(state, owner)?;
    state
        .entries
        .get(id)
        .filter(|entry| &entry.owner == owner)
        .ok_or_else(|| "当前文档不拥有此映射".into())
}

struct Actor {
    state: Arc<Mutex<State>>,
    worker: Option<TunnelWorkerHandle>,
    captured: Option<TunnelWorkerConfig>,
    ports: HashMap<String, u16>,
    log_path: std::path::PathBuf,
}

impl Actor {
    fn new(state: Arc<Mutex<State>>, log_path: std::path::PathBuf) -> Self {
        Self {
            state,
            worker: None,
            captured: None,
            ports: HashMap::new(),
            log_path,
        }
    }

    fn run(mut self, receiver: mpsc::Receiver<Command>) {
        loop {
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(Command::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Ok(Command::Open {
                    id,
                    owner,
                    config,
                    provider_id,
                    remote_port,
                }) => {
                    self.log(&format!(
                        "创建插件映射：窗口={} 映射={id} controlServerUrl={} targetProviderId={provider_id} remotePort={remote_port}",
                        owner.label, config.control_server_url
                    ));
                    if self.state.lock().unwrap().documents.get(&owner.label)
                        != Some(&owner.document)
                    {
                        continue;
                    }
                    match self.open(config, provider_id, remote_port) {
                        Ok(port) => {
                            self.log(&format!(
                                "本地端口已分配：窗口={} 映射={id} localPort={port}",
                                owner.label
                            ));
                            self.ports.insert(id, port);
                        }
                        Err(error) => self.fail(&id, error),
                    }
                }
                Ok(Command::Get(owner, id, reply)) => {
                    self.refresh();
                    let result = owned(&self.state.lock().unwrap(), &owner, &id)
                        .map(|entry| entry.snapshot.clone());
                    let _ = reply.send(result);
                }
                Ok(Command::Close(owner, id, reply)) => {
                    let result = {
                        let state = self.state.lock().unwrap();
                        validate(&state, &owner).and_then(|()| {
                            if state.entries.contains_key(&id) {
                                owned(&state, &owner, &id).map(|_| ())
                            } else {
                                Ok(())
                            }
                        })
                    };
                    let result = result.and_then(|()| self.close(&id, "主动关闭"));
                    if let Err(error) = &result {
                        self.log(&format!(
                            "插件映射关闭失败：窗口={} 映射={id} error={error}",
                            owner.label
                        ));
                    }
                    let _ = reply.send(result);
                }
                Ok(Command::Release(owner)) => {
                    let ids: Vec<_> = self
                        .state
                        .lock()
                        .unwrap()
                        .entries
                        .iter()
                        .filter(|(_, entry)| entry.owner == owner)
                        .map(|(id, _)| id.clone())
                        .collect();
                    for id in ids {
                        if let Err(error) = self.close(&id, "文档释放") {
                            self.fail(&id, error);
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            self.refresh();
            // 导航回收遇到短暂的命令队列拥塞时继续重试，不留下无主监听。
            let orphaned: Vec<_> = {
                let state = self.state.lock().unwrap();
                state
                    .entries
                    .iter()
                    .filter(|(_, entry)| {
                        state.documents.get(&entry.owner.label) != Some(&entry.owner.document)
                    })
                    .map(|(id, _)| id.clone())
                    .collect()
            };
            for id in orphaned {
                if let Err(error) = self.close(&id, "文档失效") {
                    self.fail(&id, error);
                }
            }
        }
        let cleanup = self
            .worker
            .take()
            .map(|worker| worker.shutdown())
            .unwrap_or(Ok(()));
        if let Err(error) = &cleanup {
            self.log(&format!("插件映射后台清理失败：{error}"));
        }
        for (id, entry) in self.state.lock().unwrap().entries.drain() {
            self.log(&format!(
                "插件映射关闭{}：窗口={} 映射={id} localPort={:?} 原因=程序退出 error={:?}",
                if cleanup.is_ok() { "完成" } else { "失败" },
                entry.owner.label,
                self.ports.get(&id),
                cleanup.as_ref().err()
            ));
        }
    }

    fn open(
        &mut self,
        config: TunnelWorkerConfig,
        provider_id: String,
        remote_port: u16,
    ) -> Result<u16, String> {
        if let Some(captured) = &self.captured {
            if captured.control_server_url != config.control_server_url
                || captured.control_key != config.control_key
            {
                return Err("隧道连接设置已变化，请退出并重启桌面程序".into());
            }
        }
        if self.worker.is_none() {
            self.worker = Some(start_tunnel_worker(config.clone())?);
            self.captured = Some(config);
        }
        self.worker
            .as_ref()
            .unwrap()
            .forward_auto(provider_id, remote_port)
    }

    fn close(&mut self, id: &str, reason: &str) -> Result<(), String> {
        let port = self.ports.get(id).copied();
        if let Some(port) = port {
            let worker = self.worker.as_ref().unwrap();
            if !worker.is_finished() {
                worker.stop_forward_and_wait(port)?;
            }
            self.ports.remove(id);
        }
        if let Some(entry) = self.state.lock().unwrap().entries.remove(id) {
            self.log(&format!(
                "插件映射关闭完成：窗口={} 映射={id} localPort={port:?} 原因={reason}",
                entry.owner.label
            ));
        }
        Ok(())
    }

    fn refresh(&mut self) {
        let Some(worker) = &self.worker else {
            return;
        };
        let snapshot = worker.snapshot();
        let visitor_id = worker.visitor_id();
        let finished = worker.is_finished();
        let ports: Vec<_> = self
            .ports
            .iter()
            .map(|(id, port)| (id.clone(), *port))
            .collect();
        for (id, port) in ports {
            let row = snapshot.forwards.iter().find(|row| row.local_port == port);
            if let Some(row) = row {
                self.log_forward(&id, visitor_id.as_deref(), row);
            }
            let failure = if finished {
                Some("插件映射后台已结束".into())
            } else {
                row.filter(|row| row.phase == TunnelPhase::Failed)
                    .map(|row| row.detail.clone())
            };
            if let Some(error) = failure {
                // failed 也必须先释放 listener 和业务流，再保留失败快照。
                if !finished {
                    if let Err(cleanup) = self.worker.as_ref().unwrap().stop_forward_and_wait(port)
                    {
                        self.fail(&id, format!("{error}；释放映射失败：{cleanup}"));
                        continue;
                    }
                }
                self.ports.remove(&id);
                self.fail(&id, error);
            } else if let Some(row) = row {
                if let Some(entry) = self.state.lock().unwrap().entries.get_mut(&id) {
                    entry.snapshot = Snapshot {
                        status: match row.phase {
                            TunnelPhase::Listening => "ready",
                            TunnelPhase::Recovering => "recovering",
                            TunnelPhase::Stopped | TunnelPhase::Stopping => "closed",
                            _ => "connecting",
                        },
                        local_port: Some(port),
                        path: Some(row.path),
                        error: None,
                    };
                }
            }
        }
    }

    fn log_forward(&self, id: &str, visitor_id: Option<&str>, row: &TunnelForwardSnapshot) {
        let mut state = self.state.lock().unwrap();
        let Some(entry) = state.entries.get_mut(id) else {
            return;
        };
        if entry
            .observed
            .as_ref()
            .is_some_and(|(visitor, phase, path, detail)| {
                visitor.as_deref() == visitor_id
                    && *phase == row.phase
                    && *path == row.path
                    && detail == &row.detail
            })
        {
            return;
        }
        self.log(&format!(
            "插件映射状态变化：窗口={} 映射={id} visitorId={visitor_id:?} targetProviderId={} localPort={} remotePort={} phase={:?} path={:?} detail={}",
            entry.owner.label, row.provider_id, row.local_port, row.remote_port, row.phase, row.path, row.detail
        ));
        entry.observed = Some((
            visitor_id.map(str::to_owned),
            row.phase,
            row.path,
            row.detail.clone(),
        ));
    }

    fn fail(&self, id: &str, error: String) {
        let mut state = self.state.lock().unwrap();
        if let Some(entry) = state.entries.get_mut(id) {
            if entry.snapshot.error.as_ref() != Some(&error) {
                self.log(&format!(
                    "插件映射失败：窗口={} 映射={id} 原因={error}",
                    entry.owner.label
                ));
            }
            entry.snapshot = Snapshot::failed(error);
        }
    }

    fn log(&self, message: &str) {
        crate::logging::write(&self.log_path, "plugin-tunnels", message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::time::Instant;

    fn port(mappings: &Mappings, owner: &Owner, id: &str) -> u16 {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot = mappings.get(owner.clone(), id.into()).unwrap();
            if let Some(port) = snapshot.local_port {
                return port;
            }
            assert!(Instant::now() < deadline, "映射应分配本地端口");
            std::thread::yield_now();
        }
    }

    #[test]
    fn mapping_logs_only_changes_and_releases_log_state_on_close() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../../../temp/run/desktop-tunnels/mapping-log-changes-{}",
            std::process::id()
        ));
        let state = Arc::new(Mutex::new(State::default()));
        state.lock().unwrap().entries.insert(
            "mapping-log".into(),
            Entry {
                owner: Owner {
                    label: "browser-log".into(),
                    document: "private-document".into(),
                },
                snapshot: Snapshot::connecting(),
                observed: None,
            },
        );
        let mut actor = Actor::new(state.clone(), root.join("desktop.log"));
        let local_provider = "dd".repeat(32);
        let mut row = TunnelForwardSnapshot {
            provider_id: "ee".repeat(32),
            remote_port: 43191,
            local_port: 53191,
            phase: TunnelPhase::Listening,
            path: TunnelPath::Unknown,
            detail: "监听就绪".into(),
        };
        actor.log_forward("mapping-log", None, &row);
        actor.log_forward("mapping-log", None, &row);
        actor.log_forward("mapping-log", Some(&local_provider), &row);
        row.path = TunnelPath::Direct;
        actor.log_forward("mapping-log", Some(&local_provider), &row);
        row.detail = "直连已建立".into();
        actor.log_forward("mapping-log", Some(&local_provider), &row);
        row.phase = TunnelPhase::Recovering;
        actor.log_forward("mapping-log", Some(&local_provider), &row);
        actor.log_forward("mapping-log", Some(&local_provider), &row);
        actor.fail("mapping-log", "测试失败".into());
        actor.fail("mapping-log", "测试失败".into());
        actor.close("mapping-log", "主动关闭").unwrap();
        actor.close("mapping-log", "主动关闭").unwrap();
        actor.log_forward("mapping-log", Some(&local_provider), &row);
        let log = std::fs::read_to_string(root.join("desktop.log")).unwrap();
        assert_eq!(log.matches("插件映射状态变化").count(), 5);
        assert_eq!(log.matches("插件映射失败").count(), 1);
        assert_eq!(log.matches("插件映射关闭完成").count(), 1);
        assert!(log.contains(&format!("visitorId=Some(\"{local_provider}\")")));
        assert!(log.contains(&format!("targetProviderId={}", row.provider_id)));
        assert!(log.contains("localPort=53191 remotePort=43191"));
        assert!(log.contains("phase=Listening path=Unknown"));
        assert!(log.contains("phase=Recovering path=Direct detail=直连已建立"));
        assert!(state.lock().unwrap().entries.is_empty());
        assert!(!log.contains("private-document"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn mapping_ownership_navigation_and_close_release_actual_listeners() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
            "../../../temp/run/desktop-tunnels/mapping-owner-{}",
            std::process::id()
        ));
        let mappings = Mappings::new(root.join("desktop.log")).unwrap();
        let first = Owner {
            label: "browser-one".into(),
            document: mappings.document("browser-one").unwrap(),
        };
        let second = Owner {
            label: "browser-two".into(),
            document: mappings.document("browser-two").unwrap(),
        };
        let config = worker_config("http://127.0.0.1:9".into(), [7; 32]);
        mappings
            .open(
                first.clone(),
                "first".into(),
                config.clone(),
                "aa".repeat(32),
                80,
            )
            .unwrap();
        mappings
            .open(
                second.clone(),
                "second".into(),
                config.clone(),
                "bb".repeat(32),
                81,
            )
            .unwrap();
        let first_port = port(&mappings, &first, "first");
        let second_port = port(&mappings, &second, "second");
        assert!(mappings.get(second.clone(), "first".into()).is_err());
        assert!(mappings.close(second.clone(), "first".into()).is_err());
        assert!(mappings
            .open(
                first.clone(),
                "first".into(),
                config.clone(),
                "aa".repeat(32),
                80
            )
            .is_err());
        mappings.close(first.clone(), "first".into()).unwrap();
        TcpListener::bind(("127.0.0.1", first_port)).expect("close返回后必须可以立即重绑");
        mappings.close(first.clone(), "first".into()).unwrap();
        assert!(TcpListener::bind(("127.0.0.1", second_port)).is_err());
        mappings.invalidate("browser-two");
        let replacement = Owner {
            label: "browser-two".into(),
            document: mappings.document("browser-two").unwrap(),
        };
        assert_ne!(second.document, replacement.document);
        assert!(mappings.validate(&second).is_err());
        mappings
            .open(
                replacement.clone(),
                "replacement".into(),
                config,
                "cc".repeat(32),
                82,
            )
            .unwrap();
        let replacement_port = port(&mappings, &replacement, "replacement");
        assert!(mappings.close(second, "replacement".into()).is_err());
        let deadline = Instant::now() + Duration::from_secs(5);
        while TcpListener::bind(("127.0.0.1", second_port)).is_err() {
            assert!(Instant::now() < deadline, "导航必须回收旧文档的监听");
            std::thread::yield_now();
        }
        mappings.shutdown();
        TcpListener::bind(("127.0.0.1", replacement_port)).expect("退出必须释放所有映射");
        drop(mappings);
        let log = std::fs::read_to_string(root.join("desktop.log")).unwrap();
        assert!(log.contains("[plugin-tunnels] 创建插件映射：窗口=browser-one 映射=first"));
        assert!(log.contains("controlServerUrl=http://127.0.0.1:9"));
        assert!(log.contains(&format!(
            "targetProviderId={} remotePort=80",
            "aa".repeat(32)
        )));
        assert!(log.contains(&format!("映射=first localPort={first_port}")));
        assert!(log.lines().any(|line| line.contains("插件映射状态变化")
            && line.contains("映射=first ")
            && line.contains(&format!("localPort={first_port}"))));
        assert!(log.contains("映射=first localPort=Some(") && log.contains("原因=主动关闭"));
        assert!(log.lines().any(|line| line.contains("插件映射关闭完成")
            && line.contains("映射=second ")
            && (line.contains("原因=文档释放") || line.contains("原因=文档失效"))));
        assert!(log.lines().any(|line| line.contains("插件映射关闭完成")
            && line.contains("映射=replacement ")
            && line.contains("原因=程序退出")));
        assert_eq!(log.matches("插件映射关闭完成").count(), 3);
        assert!(!log.contains(&first.document));
        assert!(!log.contains(&replacement.document));
        assert!(!log.contains(&"07".repeat(32)));
        if root.exists() {
            std::fs::remove_dir_all(root).unwrap();
        }
    }
}

pub(crate) fn worker_config(
    control_server_url: String,
    control_key: [u8; 32],
) -> TunnelWorkerConfig {
    TunnelWorkerConfig {
        control_server_url,
        control_key,
        provider_secret_key: None,
        mode: TunnelMode::Auto,
        discovery_scope: None,
    }
}
