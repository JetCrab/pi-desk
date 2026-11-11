use pi_desk_tunnel_common::runtime::{TunnelMode, TunnelPath};
use pi_desk_tunnel_common::worker::{
    start_tunnel_worker, TunnelPhase, TunnelWorkerConfig, TunnelWorkerHandle,
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
                    if self.state.lock().unwrap().documents.get(&owner.label)
                        != Some(&owner.document)
                    {
                        continue;
                    }
                    match self.open(config, provider_id, remote_port) {
                        Ok(port) => {
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
                    let result = result.and_then(|()| self.close(&id));
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
                        if let Err(error) = self.close(&id) {
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
                if let Err(error) = self.close(&id) {
                    self.fail(&id, error);
                }
            }
        }
        if let Some(worker) = self.worker.take() {
            if let Err(error) = worker.shutdown() {
                self.log(&format!("插件映射后台清理失败：{error}"));
            }
        }
        self.state.lock().unwrap().entries.clear();
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

    fn close(&mut self, id: &str) -> Result<(), String> {
        if let Some(port) = self.ports.get(id) {
            let worker = self.worker.as_ref().unwrap();
            if !worker.is_finished() {
                worker.stop_forward_and_wait(*port)?;
            }
            self.ports.remove(id);
        }
        self.state.lock().unwrap().entries.remove(id);
        Ok(())
    }

    fn refresh(&mut self) {
        let Some(worker) = &self.worker else {
            return;
        };
        let snapshot = worker.snapshot();
        let finished = worker.is_finished();
        let ports: Vec<_> = self
            .ports
            .iter()
            .map(|(id, port)| (id.clone(), *port))
            .collect();
        for (id, port) in ports {
            let row = snapshot.forwards.iter().find(|row| row.local_port == port);
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
    fn mapping_ownership_navigation_and_close_release_actual_listeners() {
        let root = std::env::current_dir().unwrap().join(format!(
            "temp/run/desktop-tunnels/owner-{}",
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
