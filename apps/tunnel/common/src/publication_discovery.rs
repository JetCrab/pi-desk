use std::io;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const IPC_TIMEOUT: Duration = Duration::from_millis(500);
const MAX_RESPONSE_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolvedPublication {
    pub control_server_url: String,
    pub provider_id: String,
    pub remote_port: u16,
}

/// 只查询已经运行的本机发布，不创建 Worker 或公网注册。
pub fn resolve_publication(config_path: &Path, port: u16) -> Result<ResolvedPublication, String> {
    // 独立线程允许同步入口也被已有 Tokio 运行时中的宿主调用。
    let config_path = config_path.to_owned();
    std::thread::Builder::new()
        .name("pi-desk-tunnel-discovery".into())
        .spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| format!("无法启动本机发布查询：{error}"))?
                .block_on(resolve_publication_async(&config_path, port))
        })
        .map_err(|error| format!("无法创建本机发布查询线程：{error}"))?
        .join()
        .map_err(|_| "本机发布查询线程意外退出".to_owned())?
}

pub async fn resolve_publication_async(
    config_path: &Path,
    port: u16,
) -> Result<ResolvedPublication, String> {
    let address = discovery_address(config_path, port)?;
    tokio::time::timeout(IPC_TIMEOUT, async {
        let stream = connect(&address)
            .await
            .map_err(|error| format!("本机端口 {port} 的隧道发布不可用：{error}"))?;
        read_response(stream)
            .await?
            .ok_or_else(|| format!("本机端口 {port} 的隧道发布尚未就绪或已停止"))
    })
    .await
    .map_err(|_| format!("本机端口 {port} 的隧道发布查询超时"))?
}

async fn read_response(
    mut stream: impl AsyncRead + AsyncWrite + Unpin,
) -> Result<Option<ResolvedPublication>, String> {
    let result = async {
        let size = stream.read_u32().await? as usize;
        if size > MAX_RESPONSE_BYTES {
            return Err(io::Error::other("本机发布信息超过大小限制"));
        }
        let mut bytes = vec![0; size];
        stream.read_exact(&mut bytes).await?;
        let publication = serde_json::from_slice(&bytes).map_err(io::Error::other)?;
        stream.write_u8(0).await?;
        Ok(publication)
    };
    result
        .await
        .map_err(|error: io::Error| format!("读取本机发布信息失败：{error}"))
}

async fn respond(
    mut stream: impl AsyncRead + AsyncWrite + Unpin,
    publication: Option<ResolvedPublication>,
) {
    let result = async {
        let bytes = serde_json::to_vec(&publication).map_err(io::Error::other)?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(io::Error::other("本机发布信息超过大小限制"));
        }
        stream.write_u32(bytes.len() as u32).await?;
        stream.write_all(&bytes).await?;
        // 等待读取确认后再关闭管道，防止 Windows 丢弃尚未读完的缓冲数据。
        stream.read_u8().await
    };
    // 每次连接最多占用一个有界窗口，随后释放，不保留查询历史。
    let _ = tokio::time::timeout(IPC_TIMEOUT, result).await;
}

fn discovery_address(config_path: &Path, port: u16) -> Result<PathBuf, String> {
    if port == 0 {
        return Err("本机发布查询端口必须是 1 到 65535 的有效端口".into());
    }
    let absolute = std::path::absolute(config_path)
        .map_err(|error| format!("无法解析本机发布配置路径：{error}"))?;
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let bytes = normalized.as_os_str().as_encoded_bytes();
    // 固定 FNV-1a 只用于配置路径作用域命名，不包含控制密钥，也不承担认证。
    let mut hash = 0xcbf29ce484222325_u64;
    for &byte in bytes {
        #[cfg(windows)]
        let byte = if byte == b'/' {
            b'\\'
        } else {
            byte.to_ascii_lowercase()
        };
        hash = (hash ^ u64::from(byte)).wrapping_mul(0x100000001b3);
    }
    let name = format!("pi-desk-tunnel-{hash:016x}-{port}");
    #[cfg(windows)]
    return Ok(PathBuf::from(format!(r"\\.\pipe\{name}")));
    #[cfg(unix)]
    return Ok(std::env::temp_dir().join(format!("{name}.sock")));
}

pub(crate) struct DiscoveryListener {
    task: Option<tokio::task::JoinHandle<()>>,
    #[cfg(unix)]
    address: PathBuf,
}

impl DiscoveryListener {
    pub(crate) fn start(
        config_path: &Path,
        port: u16,
        resolve: impl Fn() -> Option<ResolvedPublication> + Send + 'static,
    ) -> Result<Self, String> {
        let address = discovery_address(config_path, port)?;
        let listener = bind(&address)
            .map_err(|error| format!("无法启动本机端口 {port} 的发布发现监听：{error}"))?;
        #[cfg(windows)]
        let next_address = address.clone();
        let task = tokio::spawn(async move {
            #[cfg(unix)]
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => respond(stream, resolve()).await,
                    Err(error) => {
                        tracing::warn!(port, "本机发布发现监听已退出：{error}");
                        break;
                    }
                }
            }
            #[cfg(windows)]
            {
                let mut listener = listener;
                loop {
                    if let Err(error) = listener.connect().await {
                        tracing::warn!(port, "本机发布发现监听已退出：{error}");
                        break;
                    }
                    // 连接后先创建下一实例，避免响应期间管道名称消失或被抢占。
                    let next = match new_pipe(&next_address, false) {
                        Ok(next) => next,
                        Err(error) => {
                            tracing::warn!(port, "本机发布发现监听无法继续：{error}");
                            break;
                        }
                    };
                    respond(listener, resolve()).await;
                    listener = next;
                }
            }
        });
        Ok(Self {
            task: Some(task),
            #[cfg(unix)]
            address,
        })
    }

    pub(crate) async fn shutdown(mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
            let _ = task.await;
        }
    }
}

impl Drop for DiscoveryListener {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
        #[cfg(unix)]
        if let Err(error) = std::fs::remove_file(&self.address)
            && error.kind() != io::ErrorKind::NotFound
        {
            tracing::warn!("移除本机发布发现 socket 失败：{error}");
        }
    }
}

#[cfg(unix)]
fn bind(address: &Path) -> io::Result<tokio::net::UnixListener> {
    match tokio::net::UnixListener::bind(address) {
        Err(error) if error.kind() == io::ErrorKind::AddrInUse => {
            // 崩溃可能留下 socket 节点；只回收明确没有监听者的地址。
            match std::os::unix::net::UnixStream::connect(address) {
                Err(probe) if probe.kind() == io::ErrorKind::ConnectionRefused => {
                    std::fs::remove_file(address)?;
                    tokio::net::UnixListener::bind(address)
                }
                _ => Err(error),
            }
        }
        result => result,
    }
}

#[cfg(unix)]
async fn connect(address: &Path) -> io::Result<tokio::net::UnixStream> {
    tokio::net::UnixStream::connect(address).await
}

#[cfg(windows)]
fn bind(address: &Path) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    new_pipe(address, true)
}

#[cfg(windows)]
fn new_pipe(
    address: &Path,
    first: bool,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    tokio::net::windows::named_pipe::ServerOptions::new()
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .create(address)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn discovery_only_returns_current_publication_and_releases_its_address() {
        let scope = std::env::current_dir().unwrap().join(format!(
            "temp/run/publication-discovery/ipc-{}-{}.json",
            std::process::id(),
            crate::protocol::random_hex::<8>().unwrap()
        ));
        let other_scope = scope.with_extension("other.json");
        let current = Arc::new(Mutex::new(None));
        let observed = current.clone();
        let listener =
            DiscoveryListener::start(&scope, 43191, move || observed.lock().unwrap().clone())
                .unwrap();
        assert!(resolve_publication_async(&scope, 43191).await.is_err());
        let publication = ResolvedPublication {
            control_server_url: "http://tunnel.example.test:7001".into(),
            provider_id: "ab".repeat(32),
            remote_port: 43191,
        };
        *current.lock().unwrap() = Some(publication.clone());
        assert_eq!(
            resolve_publication_async(&scope, 43191).await.unwrap(),
            publication
        );
        assert!(
            resolve_publication_async(&other_scope, 43191)
                .await
                .is_err()
        );
        assert!(resolve_publication_async(&scope, 43192).await.is_err());
        *current.lock().unwrap() = None;
        assert!(resolve_publication_async(&scope, 43191).await.is_err());
        listener.shutdown().await;
        assert!(resolve_publication_async(&scope, 43191).await.is_err());
        let replacement = DiscoveryListener::start(&scope, 43191, || None).unwrap();
        replacement.shutdown().await;
    }
}

#[cfg(windows)]
async fn connect(address: &Path) -> io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(address) {
            // ERROR_PIPE_BUSY：已有查询正在读取，短暂等待下一实例；总时限由调用方约束。
            Err(error) if error.raw_os_error() == Some(231) => {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            result => return result,
        }
    }
}
