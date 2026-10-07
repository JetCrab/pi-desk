use std::fs;
use std::net::TcpListener as StdTcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pi_desk_tunnel_common::protocol::CryptoContext;
use pi_desk_tunnel_common::runtime::{
    TunnelServerConfig, derive_noise_public_key, generate_noise_keypair, start_server,
};
use pi_desk_tunnel_server::api::{AppState, router};
use pi_desk_tunnel_server::tunnel::{TunnelRegistry, TunnelRegistryConfig};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::{Child, ChildStdout, Command};
use tokio::time::{sleep, timeout};

const TEST_TIMEOUT: Duration = Duration::from_secs(20);

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cli_recovers_forwards_rejects_conflict_and_releases_port() {
    let directory = temporary_directory();
    fs::create_dir_all(&directory).expect("应创建测试目录");
    let control_address = unused_address();
    let relay_address = unused_address();
    let public_address = unused_address();
    let public_port = public_address
        .rsplit_once(':')
        .expect("公网地址应包含端口")
        .1
        .parse::<u16>()
        .expect("公网端口有效");
    let keypair = generate_noise_keypair().expect("应生成 Noise 密钥");
    let public_key = derive_noise_public_key(&keypair.private_key).expect("应派生 Noise 公钥");
    let mut relay = start_server(TunnelServerConfig {
        bind_addr: relay_address.clone(),
        private_key: keypair.private_key,
    })
    .expect("应启动 relay");
    let relay_events = relay.take_event_receiver().expect("relay 应提供事件接收器");
    let (local_address, echo_task) = start_echo_server().await;
    let first_config = directory.join("first.json");
    let second_config = directory.join("second.json");
    write_config(
        &first_config,
        &control_address,
        "aabbccddeeff00112233445566778899",
    );
    write_config(
        &second_config,
        &control_address,
        "00112233445566778899aabbccddeeff",
    );

    let (mut first, mut first_lines) = spawn_client(&first_config, &local_address, public_port);
    wait_for_event(&mut first_lines, "recovering").await;

    let registry = TunnelRegistry::new(
        relay,
        relay_events,
        TunnelRegistryConfig {
            public_relay: relay_address,
            public_host: "127.0.0.1".to_string(),
            server_public_key: public_key,
        },
    );
    let control_listener = TcpListener::bind(&control_address)
        .await
        .expect("应启动控制服务");
    let control_task = tokio::spawn(async move {
        axum::serve(
            control_listener,
            router(AppState {
                crypto: Arc::new(CryptoContext::new([7; 32])),
                tunnels: registry,
            }),
        )
        .await
    });

    let listening = wait_for_event(&mut first_lines, "listening").await;
    assert_eq!(
        listening.get("publicAddr").and_then(Value::as_str),
        Some(public_address.as_str())
    );
    assert_echo(&public_address).await;

    let (mut second, mut second_lines) = spawn_client(&second_config, &local_address, public_port);
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

    assert!(
        fs::read_to_string(&first_config)
            .expect("应读取壳配置")
            .contains("deviceId")
    );
    control_task.abort();
    echo_task.abort();
    fs::remove_dir_all(directory).expect("应清理测试目录");
}

fn spawn_client(
    config_path: &PathBuf,
    local_address: &str,
    public_port: u16,
) -> (Child, Lines<BufReader<ChildStdout>>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_pi-desk-tunnel-client"))
        .args([
            "--config",
            config_path.to_str().expect("配置路径应为 UTF-8"),
            "--client",
            "remoteDebug",
            "--local",
            local_address,
            "--public-port",
            &public_port.to_string(),
        ])
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

fn write_config(path: &PathBuf, control_address: &str, device_id: &str) {
    fs::write(
        path,
        format!(
            r#"{{"targets":[],"tunnel":{{"controlServerUrl":"http://{control_address}","controlKey":"{}","deviceId":"{device_id}"}}}}"#,
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
    std::env::temp_dir().join(format!(
        "pi-desk-tunnel-cli-test-{}-{suffix}",
        std::process::id()
    ))
}
