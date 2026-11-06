use std::fs;
use std::net::TcpListener as StdTcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use iroh_relay::server::{RelayConfig, Server, ServerConfig};
use pi_desk_tunnel_common::protocol::{CryptoContext, TunnelRelayConfig};
use pi_desk_tunnel_common::runtime::{TunnelEndpointConfig, TunnelMode, start_endpoint};
use pi_desk_tunnel_server::api::{AppState, router};
use pi_desk_tunnel_server::tunnel::{TunnelRegistry, TunnelRegistryConfig};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdout, Command};
use tokio::time::{sleep, timeout};

#[tokio::test]
async fn cli_rejects_removed_client_flag_with_one_ndjson_failure() {
    let output = Command::new(env!("CARGO_BIN_EXE_pi-desk-tunnel-client"))
        .args(["--client", "remoteDebug"])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .expect("应执行独立 CLI 参数检查");
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stderr.is_empty());
    let text = String::from_utf8(output.stdout).expect("stdout 应为 UTF-8");
    assert_eq!(text.lines().count(), 1);
    let event: Value = serde_json::from_str(text.trim()).expect("stdout 应为 NDJSON");
    assert_eq!(event["type"], "failed");
    assert!(
        event["detail"]
            .as_str()
            .unwrap()
            .contains("--client 已移除")
    );
}

const TEST_TIMEOUT: Duration = Duration::from_secs(20);

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cli_recovers_forwards_rejects_conflict_and_releases_port() {
    let directory = temporary_directory();
    fs::create_dir_all(&directory).expect("应创建测试目录");
    let control_address = unused_address();
    let public_address = unused_address();
    let public_port = public_address
        .rsplit_once(':')
        .expect("公网地址应包含端口")
        .1
        .parse::<u16>()
        .expect("公网端口有效");
    let mut relay_server_config = ServerConfig::default();
    relay_server_config.relay = Some(RelayConfig::new(([127, 0, 0, 1], 0)));
    let relay = Server::spawn(relay_server_config)
        .await
        .expect("应启动隔离 relay");
    let relay_address = relay.http_addr().expect("relay 应监听 HTTP");
    let relay_config = TunnelRelayConfig {
        url: format!("http://{relay_address}"),
        auth_token: "cli-test-relay-token".to_owned(),
        quic_port: 7842,
    };
    let gateway = start_endpoint(TunnelEndpointConfig {
        secret_key: None,
        relay: relay_config.clone(),
        mode: TunnelMode::Auto,
    })
    .await
    .expect("应启动公网网关 Endpoint");
    let (local_address, echo_task) = start_echo_server().await;
    let first_config = directory.join("first.json");
    let second_config = directory.join("second.json");
    write_config(&first_config, &control_address);
    write_config(&second_config, &control_address);
    let original_config = fs::read(&first_config).expect("应保存只读配置基线");

    let (mut first, mut first_lines) =
        spawn_client(&first_config, &local_address, public_port, false);
    wait_for_event(&mut first_lines, "recovering").await;

    let registry = TunnelRegistry::new(
        gateway,
        TunnelRegistryConfig {
            relay: relay_config,
            public_host: "legacy-gateway.example.com".to_string(),
        },
    );
    let control_listener = TcpListener::bind(&control_address)
        .await
        .expect("应启动控制服务");
    let tunnels = Arc::clone(&registry);
    let control_task = tokio::spawn(async move {
        axum::serve(
            control_listener,
            router(AppState {
                crypto: Arc::new(CryptoContext::new([7; 32])),
                tunnels,
            }),
        )
        .await
    });

    let connecting = wait_for_event(&mut first_lines, "connecting").await;
    assert_eq!(
        connecting.get("publicAddr").and_then(Value::as_str),
        Some(public_address.as_str())
    );
    let listening = wait_for_event(&mut first_lines, "listening").await;
    assert_eq!(
        listening.get("publicAddr").and_then(Value::as_str),
        Some(public_address.as_str())
    );
    assert_echo(&public_address).await;

    let (mut second, mut second_lines) =
        spawn_client(&second_config, &local_address, public_port, false);
    let failed = wait_for_event(&mut second_lines, "failed").await;
    assert!(
        failed
            .get("detail")
            .and_then(Value::as_str)
            .is_some_and(|detail| detail.contains("公网端口已被占用"))
    );
    assert_eq!(
        timeout(TEST_TIMEOUT, second.wait())
            .await
            .expect("冲突客户端应退出")
            .expect("应取得退出状态")
            .code(),
        Some(1)
    );

    drop(first.stdin.take());
    wait_for_event(&mut first_lines, "stopped").await;
    assert!(
        timeout(TEST_TIMEOUT, first.wait())
            .await
            .expect("首个客户端应退出")
            .expect("应取得退出状态")
            .success()
    );
    wait_for_port_release(&public_address).await;

    assert_eq!(
        fs::read(&first_config).expect("应读取只读配置"),
        original_config
    );
    registry.shutdown().await;
    control_task.abort();
    let _ = control_task.await;
    echo_task.abort();
    let _ = echo_task.await;
    relay.shutdown().await.expect("应关闭 relay");
    StdTcpListener::bind(relay_address).expect("relay 监听应释放");
    fs::remove_dir_all(directory).expect("应清理测试目录");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cli_stdout_failure_joins_runtime_and_releases_active_publication() {
    let directory = temporary_directory();
    fs::create_dir_all(&directory).expect("应创建测试目录");
    let mut relay_server_config = ServerConfig::default();
    relay_server_config.relay = Some(RelayConfig::new(([127, 0, 0, 1], 0)));
    let relay = Server::spawn(relay_server_config)
        .await
        .expect("应启动隔离 relay");
    let relay_address = relay.http_addr().expect("relay 应监听 HTTP");
    let relay_config = TunnelRelayConfig {
        url: format!("http://{relay_address}"),
        auth_token: "cli-test-relay-token".to_owned(),
        quic_port: 7842,
    };
    let gateway = start_endpoint(TunnelEndpointConfig {
        secret_key: None,
        relay: relay_config.clone(),
        mode: TunnelMode::Auto,
    })
    .await
    .expect("应启动公网网关 Endpoint");
    let registry = TunnelRegistry::new(
        gateway,
        TunnelRegistryConfig {
            relay: relay_config,
            public_host: "127.0.0.1".to_owned(),
        },
    );
    let control_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let control_address = control_listener.local_addr().unwrap();
    let tunnels = Arc::clone(&registry);
    let control_task = tokio::spawn(async move {
        axum::serve(
            control_listener,
            router(AppState {
                crypto: Arc::new(CryptoContext::new([7; 32])),
                tunnels,
            }),
        )
        .await
    });
    let local_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local_address = local_listener.local_addr().unwrap();
    let public_address = unused_address();
    let public_port = public_address
        .parse::<std::net::SocketAddr>()
        .unwrap()
        .port();
    let config_path = directory.join("stdout-closed.json");
    write_config(&config_path, &control_address.to_string());
    let original_config = fs::read(&config_path).unwrap();
    let (mut child, mut lines) =
        spawn_client(&config_path, &local_address.to_string(), public_port, true);
    // Child::wait 会关闭自身持有的 stdin；单独保留它，验证退出确由 stdout 错误触发。
    let stdin = child.stdin.take().expect("stdin 必须保持打开");
    wait_for_event(&mut lines, "listening").await;
    let mut first = TcpStream::connect(&public_address).await.unwrap();
    let (mut local_first, _) = timeout(TEST_TIMEOUT, local_listener.accept())
        .await
        .unwrap()
        .unwrap();
    first.write_all(b"x").await.unwrap();
    let mut payload = [0_u8; 1];
    timeout(TEST_TIMEOUT, local_first.read_exact(&mut payload))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&payload, b"x");
    loop {
        let event = wait_for_event(&mut lines, "connections").await;
        if event["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["activeTcp"].as_u64() == Some(1))
        {
            break;
        }
    }
    drop(lines);
    let mut second = TcpStream::connect(&public_address).await.unwrap();
    let (mut local_second, _) = timeout(TEST_TIMEOUT, local_listener.accept())
        .await
        .unwrap()
        .unwrap();
    let status = timeout(TEST_TIMEOUT, child.wait())
        .await
        .expect("stdout 关闭后不应等待 stdin EOF")
        .unwrap();
    assert_eq!(status.code(), Some(1));
    wait_for_port_release(&public_address).await;
    StdTcpListener::bind(&public_address).expect("输出失败退出后公网监听应已释放");
    for stream in [&mut first, &mut second, &mut local_first, &mut local_second] {
        let result = timeout(TEST_TIMEOUT, stream.read(&mut payload))
            .await
            .expect("活动 TCP 应随退出关闭");
        assert!(!matches!(result, Ok(length) if length > 0));
    }
    assert_eq!(fs::read(&config_path).unwrap(), original_config);
    drop(stdin);
    drop((first, second, local_first, local_second, local_listener));
    registry.shutdown().await;
    control_task.abort();
    let _ = control_task.await;
    relay.shutdown().await.expect("应关闭 relay");
    StdTcpListener::bind(relay_address).expect("relay 监听应释放");
    StdTcpListener::bind(local_address).expect("本机测试监听应释放");
    fs::remove_dir_all(directory).expect("应清理测试目录");
}

fn spawn_client(
    config_path: &PathBuf,
    local_address: &str,
    public_port: u16,
    stats: bool,
) -> (Child, Lines<BufReader<ChildStdout>>) {
    let desktop_executable = std::env::var_os("PI_DESK_TUNNEL_TEST_DESKTOP_EXECUTABLE");
    let desktop = desktop_executable.is_some();
    let mut command = Command::new(
        desktop_executable.unwrap_or_else(|| env!("CARGO_BIN_EXE_pi-desk-tunnel-client").into()),
    );
    if desktop {
        command
            .arg("--tunnel-client")
            .env("PI_DESK_DESKTOP_CONFIG", config_path);
    } else {
        command.args([
            "--config",
            config_path.to_str().expect("配置路径应为 UTF-8"),
        ]);
    }
    command.args([
        "--local",
        local_address,
        "--public-port",
        &public_port.to_string(),
    ]);
    if stats || desktop {
        command.arg("--stats");
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .expect("应启动 Tunnel Client");
    let stdout = child.stdout.take().expect("应捕获 stdout");
    (child, BufReader::new(stdout).lines())
}

async fn wait_for_event(lines: &mut Lines<BufReader<ChildStdout>>, expected: &str) -> Value {
    timeout(TEST_TIMEOUT, async {
        loop {
            let line = lines
                .next_line()
                .await
                .expect("应读取 CLI 输出")
                .expect("CLI 不应提前关闭 stdout");
            let event: Value = serde_json::from_str(&line).expect("CLI 应输出 NDJSON");
            if event.get("type").and_then(Value::as_str) == Some(expected) {
                return event;
            }
        }
    })
    .await
    .unwrap_or_else(|_| panic!("等待 CLI 事件超时：{expected}"))
}

async fn start_echo_server() -> (String, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.expect("应监听 echo");
    let address = listener.local_addr().expect("应读取 echo 地址").to_string();
    let task = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0_u8; 1024];
                if let Ok(length) = stream.read(&mut buffer).await {
                    let _ = stream.write_all(&buffer[..length]).await;
                }
            });
        }
    });
    (address, task)
}

async fn assert_echo(public_address: &str) {
    timeout(TEST_TIMEOUT, async {
        loop {
            match TcpStream::connect(public_address).await {
                Ok(mut stream) => {
                    stream.write_all(b"remote-debug").await.expect("应写入数据");
                    let mut echoed = [0_u8; 12];
                    stream
                        .read_exact(&mut echoed)
                        .await
                        .expect("应读取转发数据");
                    assert_eq!(&echoed, b"remote-debug");
                    return;
                }
                Err(_) => sleep(Duration::from_millis(100)).await,
            }
        }
    })
    .await
    .expect("公网端口应转发到本机服务");
}

async fn wait_for_port_release(public_address: &str) {
    timeout(TEST_TIMEOUT, async {
        loop {
            if TcpStream::connect(public_address).await.is_err() {
                return;
            }
            sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("停止 CLI 后应释放公网端口");
}

fn write_config(path: &PathBuf, control_address: &str) {
    fs::write(
        path,
        format!(
            r#"{{"targets":[],"tunnel":{{"controlServerUrl":"http://{control_address}","controlKey":"{}","providerSecretKey":"desktop-identity-must-not-be-read"}}}}"#,
            "07".repeat(32)
        ),
    )
    .expect("应写入壳配置");
}

fn unused_address() -> String {
    let listener = StdTcpListener::bind("127.0.0.1:0").expect("应分配测试端口");
    listener.local_addr().expect("应读取测试端口").to_string()
}

fn temporary_directory() -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("系统时间有效")
        .as_nanos();
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../temp/run/tunnel-cli/iroh-integration-20261103")
        .join(format!("provider-{}-{suffix}", std::process::id()))
}
