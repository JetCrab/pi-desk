use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc as sync_mpsc;

use super::*;
use crate::protocol::{
    CLOSE_TUNNEL_PATH, CryptoContext, OPEN_TUNNEL_PATH, STATUS_TUNNEL_PATH, TunnelRelayConfig,
};

fn config(url: &str) -> TunnelWorkerConfig {
    TunnelWorkerConfig {
        control_server_url: url.to_owned(),
        control_key: [7; 32],
        provider_secret_key: Some([3; 32]),
        mode: TunnelMode::Auto,
    }
}

fn snapshot() -> SharedSnapshot {
    Arc::new(Mutex::new(TunnelWorkerSnapshot {
        provider_id: None,
        mode: TunnelMode::Auto,
        publications: Vec::new(),
        forwards: Vec::new(),
        connections: Vec::new(),
    }))
}

fn cancellation() -> (watch::Sender<bool>, watch::Sender<bool>, Cancellation) {
    let (item, item_rx) = watch::channel(false);
    let (worker, worker_rx) = watch::channel(false);
    (
        item,
        worker,
        Cancellation {
            item: item_rx,
            worker: worker_rx,
        },
    )
}

#[test]
fn lease_uses_request_start_and_cannot_be_revived_after_deadline() {
    let start = Instant::now();
    let mut lease = Lease::new(start);
    assert_eq!(lease.deadline, start + Duration::from_secs(30));
    assert!(lease.renew(
        start + Duration::from_secs(5),
        start + Duration::from_secs(14)
    ));
    assert_eq!(lease.deadline, start + Duration::from_secs(35));
    assert!(!lease.renew(
        start + Duration::from_secs(34),
        start + Duration::from_secs(35)
    ));
    assert_eq!(lease.deadline, start + Duration::from_secs(35));
    assert!(!lease.renew(
        start + Duration::from_secs(5),
        start + Duration::from_secs(36)
    ));
}

#[tokio::test]
async fn item_cancellation_does_not_cancel_other_registrations() {
    let (item, worker, mut first) = cancellation();
    let (_other_stop, other_rx) = watch::channel(false);
    let mut second = Cancellation {
        item: other_rx,
        worker: worker.subscribe(),
    };
    item.send_replace(true);
    first.cancelled().await;
    assert!(!second.is_cancelled());
    worker.send_replace(true);
    second.cancelled().await;
    assert!(second.is_cancelled());
}

#[test]
fn stop_bypasses_a_full_command_queue_and_shutdown_joins() {
    let (commands, _receiver) = mpsc::channel(COMMAND_CAPACITY);
    let (stop, stopped) = watch::channel(false);
    let (release, released) = sync_mpsc::channel();
    let thread = std::thread::spawn(move || {
        released.recv_timeout(Duration::from_secs(5)).unwrap();
        Ok(())
    });
    let handle = TunnelWorkerHandle {
        commands,
        stop,
        snapshot: snapshot(),
        thread: Some(thread),
    };
    for _ in 0..COMMAND_CAPACITY {
        handle.set_mode(TunnelMode::Auto).unwrap();
    }
    assert!(handle.set_mode(TunnelMode::RelayOnly).is_err());
    handle.stop();
    assert!(*stopped.borrow());
    assert!(handle.set_mode(TunnelMode::Auto).is_err());
    release.send(()).unwrap();
    handle.shutdown().unwrap();
}

#[test]
fn snapshot_is_latest_state_without_control_or_registration_credentials() {
    let state = snapshot();
    state.lock().unwrap().forwards.push(TunnelForwardSnapshot {
        provider_id: "aa".repeat(32),
        remote_port: 80,
        local_port: 8080,
        phase: TunnelPhase::Recovering,
        detail: "重新解析端口".to_owned(),
        path: TunnelPath::Unknown,
    });
    let old = state.lock().unwrap().clone();
    state.lock().unwrap().forwards[0].phase = TunnelPhase::Listening;
    let json = serde_json::to_value(&old).unwrap();
    assert_eq!(json["forwards"][0]["phase"], "recovering");
    assert_eq!(json["forwards"][0]["localPort"], 8080);
    assert_eq!(old.forwards[0].path, TunnelPath::Unknown);
    for field in [
        "controlKey",
        "controlServerUrl",
        "providerSecretKey",
        "serviceToken",
        "tunnelId",
        "enabled",
    ] {
        assert!(!serde_json::to_string(&json).unwrap().contains(field));
    }
}

#[test]
fn publication_addresses_use_control_host_and_published_port() {
    for (url, expected) in [
        (
            "http://tunnel.example.com:7001/",
            "tunnel.example.com:40333",
        ),
        ("http://127.0.0.1:7001", "127.0.0.1:40333"),
        ("http://[2001:db8::1]:7001", "[2001:db8::1]:40333"),
        (
            "http://tunnel.example.com/control",
            "tunnel.example.com:40333",
        ),
    ] {
        let control = ControlIo::new(&config(url));
        assert_eq!(
            control.public_addr(Some(40333)).unwrap().as_deref(),
            Some(expected)
        );
        assert_eq!(control.public_addr(None).unwrap(), None);
    }
}

#[test]
fn control_errors_have_explicit_recovery_boundaries() {
    use crate::control::{ControlClientError as Error, ControlServerError as Server};
    assert!(control_io::resolve_retryable(&Error::Rejected(
        Server::NotReady
    )));
    assert!(control_io::resolve_retryable(&Error::Rejected(
        Server::NotFound
    )));
    assert!(control_io::registration_invalid(&Error::Rejected(
        Server::NotFound
    )));
    assert!(!control_io::retryable(&Error::Rejected(
        Server::PortConflict
    )));
    assert!(!control_io::resolve_retryable(&Error::ProtocolMismatch));
}

#[tokio::test]
async fn mode_rebuild_releases_visitor_listener_without_touching_provider() {
    let cfg = config("http://127.0.0.1:9");
    let provider = start_endpoint(TunnelEndpointConfig {
        secret_key: cfg.provider_secret_key,
        relay: relay(),
        mode: TunnelMode::Auto,
    })
    .await
    .unwrap();
    let visitor = start_endpoint(TunnelEndpointConfig {
        secret_key: None,
        relay: relay(),
        mode: TunnelMode::Auto,
    })
    .await
    .unwrap();
    let listener = visitor
        .forward(
            "127.0.0.1:0".parse().unwrap(),
            TunnelTarget {
                provider_id: provider.id(),
                tunnel_id: "test-registration".to_owned(),
                service_token: "test-token".to_owned(),
            },
        )
        .await
        .unwrap();
    let port = listener.local_addr().port();
    let (item_stop, mut item_rx) = watch::channel(false);
    let released = Arc::new(AtomicBool::new(false));
    let finished = released.clone();
    let task = tokio::spawn(async move {
        item_rx.changed().await.unwrap();
        listener.shutdown().await?;
        finished.store(true, Ordering::SeqCst);
        Ok(())
    });
    let (_worker_stop, stop) = watch::channel(false);
    let mut worker = Worker {
        config: cfg.clone(),
        identity: provider.id(),
        control: ControlIo::new(&cfg),
        provider: Arc::new(tokio::sync::Mutex::new(Some(provider.clone()))),
        visitor: Arc::new(tokio::sync::Mutex::new(Some(visitor))),
        snapshot: snapshot(),
        stop,
        publications: BTreeMap::new(),
        forwards: BTreeMap::from([(
            port,
            Item {
                config: TunnelForwardConfig {
                    provider_id: provider.id(),
                    remote_port: 80,
                    local_port: port,
                },
                stop: item_stop,
                task,
            },
        )]),
        cleanup_error: None,
    };
    worker.change_mode(TunnelMode::RelayOnly).await;
    assert!(released.load(Ordering::SeqCst));
    assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
    assert_eq!(worker.snapshot.lock().unwrap().mode, TunnelMode::RelayOnly);
    assert_eq!(
        worker.snapshot.lock().unwrap().forwards[0].path,
        TunnelPath::Unknown
    );
    assert_eq!(
        worker.provider.lock().await.as_ref().unwrap().id(),
        provider.id()
    );
    // 仍能在提供端登记，证明模式切换没有关闭共享提供端。
    provider
        .register_service(TunnelServiceConfig {
            tunnel_id: "provider-survives".to_owned(),
            service_token: "test-token".to_owned(),
            local_addr: "127.0.0.1:80".parse().unwrap(),
            gateway_id: provider.id(),
        })
        .await
        .unwrap();
    worker.shutdown().await.unwrap();
    assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
}

fn relay() -> TunnelRelayConfig {
    TunnelRelayConfig {
        url: "http://127.0.0.1:9".to_owned(),
        auth_token: "test-relay-token".to_owned(),
        quic_port: 7842,
    }
}

struct Call {
    path: String,
    body: serde_json::Value,
    response: sync_mpsc::Sender<serde_json::Value>,
}

struct ControlServer {
    url: String,
    calls: sync_mpsc::Receiver<Call>,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl ControlServer {
    fn start() -> Self {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let (calls, receiver) = sync_mpsc::channel();
        let stop = Arc::new(AtomicBool::new(false));
        let stopping = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut children = Vec::new();
            while !stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let calls = calls.clone();
                        children.push(std::thread::spawn(move || serve(stream, calls)));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2));
                    }
                    Err(error) => panic!("测试控制服务接纳失败：{error}"),
                }
            }
            let mut child_failed = false;
            for child in children {
                child_failed |= child.join().is_err();
            }
            assert!(!child_failed, "测试控制服务请求线程失败，全部子线程已回收");
        });
        Self {
            url,
            calls: receiver,
            stop,
            thread: Some(thread),
        }
    }

    fn next(&self) -> Call {
        self.calls
            .recv_timeout(Duration::from_secs(5))
            .expect("应收到控制请求")
    }
}

impl Drop for ControlServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Err(error) = self.thread.take().unwrap().join() {
            if std::thread::panicking() {
                eprintln!("测试控制服务清理发现请求线程失败，保留原始测试异常");
            } else {
                std::panic::resume_unwind(error);
            }
        }
    }
}

fn serve(mut stream: TcpStream, calls: sync_mpsc::Sender<Call>) {
    // Windows accept 可能继承 listener 的非阻塞模式；这里使用带超时的阻塞读取。
    stream.set_nonblocking(false).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut headers = Vec::new();
    let mut byte = [0];
    while !headers.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).unwrap();
        headers.push(byte[0]);
        assert!(headers.len() < 8192);
    }
    let headers = String::from_utf8(headers).unwrap();
    let path = headers.split_whitespace().nth(1).unwrap().to_owned();
    let length: usize = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().unwrap())
        })
        .unwrap();
    let mut encrypted = vec![0; length];
    stream.read_exact(&mut encrypted).unwrap();
    let crypto = CryptoContext::new([7; 32]);
    let body = serde_json::from_slice(&crypto.decrypt(&path, &encrypted).unwrap()).unwrap();
    let (response, receiver) = sync_mpsc::channel();
    if calls
        .send(Call {
            path: path.clone(),
            body,
            response,
        })
        .is_err()
    {
        return;
    }
    let Ok(response) = receiver.recv_timeout(Duration::from_secs(5)) else {
        return;
    };
    let body = crypto
        .encrypt(&path, &serde_json::to_vec(&response).unwrap())
        .unwrap();
    write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).unwrap();
    stream.write_all(&body).unwrap();
}

fn opened(id: &str) -> serde_json::Value {
    serde_json::json!({
        "tunnel_id": id, "service_token": "test-service-token", "relay": relay(),
        "gateway_id": "bb".repeat(32), "public_addr": null,
    })
}

#[test]
fn control_fixture_waits_for_request_bytes_and_releases_listener() {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    listener.set_nonblocking(true).unwrap();
    let mut client = TcpStream::connect(addr).unwrap();
    client
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    client
        .set_write_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let (accepted, _) = listener.accept().unwrap();
    let (calls, received) = sync_mpsc::channel();
    let (started, entered) = sync_mpsc::channel();
    let task = std::thread::spawn(move || {
        started.send(()).unwrap();
        serve(accepted, calls);
    });
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    // 没有请求字节时应保持等待，而不是 WSAEWOULDBLOCK 导致请求线程提前退出。
    assert!(matches!(
        received.recv_timeout(Duration::from_millis(50)),
        Err(sync_mpsc::RecvTimeoutError::Timeout)
    ));
    let crypto = CryptoContext::new([7; 32]);
    let body = crypto
        .encrypt(OPEN_TUNNEL_PATH, br#"{"port":18083}"#)
        .unwrap();
    write!(
        client,
        "POST {OPEN_TUNNEL_PATH} HTTP/1.1\r\nContent-Length: {}\r\n\r\n",
        body.len()
    )
    .unwrap();
    client.write_all(&body).unwrap();
    let call = received.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(call.path, OPEN_TUNNEL_PATH);
    assert_eq!(call.body["port"], 18083);
    call.response
        .send(serde_json::json!({"success": true}))
        .unwrap();
    let mut response = Vec::new();
    client.read_to_end(&mut response).unwrap();
    assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"));
    task.join().unwrap();
    drop(client);
    drop(listener);
    assert!(TcpListener::bind(addr).is_ok());
}

#[test]
fn fixture_cleanup_preserves_the_first_panic_after_joining() {
    let panic = std::panic::catch_unwind(|| {
        let (_calls, received) = sync_mpsc::channel();
        let _server = ControlServer {
            url: String::new(),
            calls: received,
            stop: Arc::new(AtomicBool::new(false)),
            thread: Some(std::thread::spawn(|| panic!("测试fixture请求线程异常"))),
        };
        panic!("测试原始异常");
    })
    .unwrap_err();
    assert_eq!(panic.downcast_ref::<&str>(), Some(&"测试原始异常"));
}

#[test]
fn stop_waits_for_late_open_and_closes_its_registration() {
    let server = ControlServer::start();
    let worker = start_tunnel_worker(config(&server.url)).unwrap();
    worker
        .publish(TunnelPublicationConfig {
            local_addr: "127.0.0.1:18080".parse().unwrap(),
            public_port: None,
        })
        .unwrap();
    let open = server.next();
    assert_eq!(open.path, OPEN_TUNNEL_PATH);
    worker.stop();
    open.response.send(opened("late-open")).unwrap();
    let close = server.next();
    assert_eq!(close.path, CLOSE_TUNNEL_PATH);
    assert_eq!(close.body["tunnel_id"], "late-open");
    close
        .response
        .send(serde_json::json!({"success": true}))
        .unwrap();
    worker.shutdown().unwrap();
}

#[test]
fn unpublish_cleans_only_its_own_late_registration() {
    let server = ControlServer::start();
    let worker = start_tunnel_worker(config(&server.url)).unwrap();
    for port in [18081, 18082] {
        worker
            .publish(TunnelPublicationConfig {
                local_addr: SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
                public_port: None,
            })
            .unwrap();
    }
    let a = server.next();
    let b = server.next();
    let (first, second) = if a.body["port"] == 18081 {
        (a, b)
    } else {
        (b, a)
    };
    worker.unpublish(18081).unwrap();
    // 等待停止命令开始回收；此时第二项仍在等待自己的 open。
    wait_until(|| {
        worker
            .snapshot()
            .publications
            .iter()
            .any(|row| row.local_port == 18081 && row.phase == TunnelPhase::Stopping)
    });
    first.response.send(opened("first-registration")).unwrap();
    let close = server.next();
    assert_eq!(close.path, CLOSE_TUNNEL_PATH);
    assert_eq!(close.body["tunnel_id"], "first-registration");
    close
        .response
        .send(serde_json::json!({"success": true}))
        .unwrap();
    wait_until(|| worker.snapshot().publications.len() == 1);
    let remaining = worker.snapshot();
    assert_eq!(remaining.publications[0].local_port, 18082);
    assert_eq!(remaining.publications[0].phase, TunnelPhase::Opening);
    worker.stop();
    second.response.send(opened("second-registration")).unwrap();
    let close = server.next();
    assert_eq!(close.path, CLOSE_TUNNEL_PATH);
    assert_eq!(close.body["tunnel_id"], "second-registration");
    close
        .response
        .send(serde_json::json!({"success": true}))
        .unwrap();
    worker.shutdown().unwrap();
}

#[test]
fn cancelled_queued_opens_do_not_start_more_blocking_requests() {
    let server = ControlServer::start();
    let worker = start_tunnel_worker(config(&server.url)).unwrap();
    for port in 18100..18100 + control_io::HTTP_CONCURRENCY as u16 + 1 {
        worker
            .publish(TunnelPublicationConfig {
                local_addr: SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
                public_port: None,
            })
            .unwrap();
    }
    let mut opens = Vec::new();
    for _ in 0..control_io::HTTP_CONCURRENCY {
        let call = server.next();
        assert_eq!(call.path, OPEN_TUNNEL_PATH);
        opens.push(call);
    }
    wait_until(|| worker.snapshot().publications.len() == control_io::HTTP_CONCURRENCY + 1);
    worker.stop();
    for (index, open) in opens.into_iter().enumerate() {
        open.response
            .send(opened(&format!("cancelled-{index}")))
            .unwrap();
    }
    for _ in 0..control_io::HTTP_CONCURRENCY {
        let close = server.next();
        assert_eq!(close.path, CLOSE_TUNNEL_PATH);
        close
            .response
            .send(serde_json::json!({"success": true}))
            .unwrap();
    }
    worker.shutdown().unwrap();
    assert!(server.calls.try_recv().is_err());
}

#[test]
fn failed_remote_close_does_not_stop_local_recovery() {
    let server = ControlServer::start();
    let worker = start_tunnel_worker(config(&server.url)).unwrap();
    worker
        .publish(TunnelPublicationConfig {
            local_addr: "127.0.0.1:18083".parse().unwrap(),
            public_port: None,
        })
        .unwrap();
    let first = server.next();
    let mut response = opened("invalid-gateway");
    response["gateway_id"] = serde_json::json!("invalid");
    first.response.send(response).unwrap();
    let close = server.next();
    assert_eq!(close.path, CLOSE_TUNNEL_PATH);
    close
        .response
        .send(serde_json::json!({"success": false}))
        .unwrap();
    let retry = server.next();
    assert_eq!(retry.path, OPEN_TUNNEL_PATH);
    worker.stop();
    retry
        .response
        .send(opened("recovered-registration"))
        .unwrap();
    let close = server.next();
    assert_eq!(close.path, CLOSE_TUNNEL_PATH);
    assert_eq!(close.body["tunnel_id"], "recovered-registration");
    close
        .response
        .send(serde_json::json!({"success": true}))
        .unwrap();
    assert!(worker.shutdown().is_err());
}

#[test]
fn explicit_unpublish_keeps_cleanup_failure_visible_without_blocking_other_ports() {
    let server = ControlServer::start();
    let worker = start_tunnel_worker(config(&server.url)).unwrap();
    for port in [18201, 18202] {
        worker
            .publish(TunnelPublicationConfig {
                local_addr: SocketAddr::from((Ipv4Addr::LOCALHOST, port)),
                public_port: (port == 18201).then_some(19201),
            })
            .unwrap();
    }
    let a = server.next();
    let b = server.next();
    let (failed, running) = if a.body["port"] == 18201 {
        (a, b)
    } else {
        (b, a)
    };
    worker.unpublish(18201).unwrap();
    wait_until(|| {
        worker
            .snapshot()
            .publications
            .iter()
            .any(|row| row.local_port == 18201 && row.phase == TunnelPhase::Stopping)
    });
    failed
        .response
        .send(opened("explicit-stop-failed"))
        .unwrap();
    let close = server.next();
    assert_eq!(close.path, CLOSE_TUNNEL_PATH);
    assert_eq!(close.body["tunnel_id"], "explicit-stop-failed");
    close
        .response
        .send(serde_json::json!({"success": false}))
        .unwrap();
    wait_until(|| {
        worker
            .snapshot()
            .publications
            .iter()
            .any(|row| row.local_port == 18201 && row.phase == TunnelPhase::Failed)
    });
    let failed_row = worker
        .snapshot()
        .publications
        .into_iter()
        .find(|row| row.local_port == 18201)
        .unwrap();
    assert_eq!(failed_row.public_port, Some(19201));
    assert!(failed_row.detail.contains("旧发布清理失败"));
    assert!(failed_row.detail.contains("服务端隧道清理未确认"));
    assert_eq!(failed_row.public_addr, None);

    let mut ready = opened("unrelated-running");
    ready["gateway_id"] = serde_json::json!(worker.snapshot().provider_id.unwrap());
    running.response.send(ready).unwrap();
    let status = server.next();
    assert_eq!(status.path, STATUS_TUNNEL_PATH);
    assert_eq!(status.body["tunnel_id"], "unrelated-running");
    status
        .response
        .send(serde_json::json!({"tunnel_id": "unrelated-running", "status": "ready"}))
        .unwrap();
    wait_until(|| {
        worker
            .snapshot()
            .publications
            .iter()
            .any(|row| row.local_port == 18202 && row.phase == TunnelPhase::Listening)
    });

    worker.unpublish(18201).unwrap();
    worker
        .publish(TunnelPublicationConfig {
            local_addr: "127.0.0.1:18201".parse().unwrap(),
            public_port: Some(19209),
        })
        .unwrap();
    worker.unpublish(18201).unwrap();
    // 此新端口的 open 证明前面同端口重试命令已处理，并未启动替代登记。
    worker
        .publish(TunnelPublicationConfig {
            local_addr: "127.0.0.1:18203".parse().unwrap(),
            public_port: None,
        })
        .unwrap();
    let other = server.next();
    assert_eq!(other.path, OPEN_TUNNEL_PATH);
    assert_eq!(other.body["port"], 18203);
    let state = worker.snapshot();
    assert_eq!(
        state
            .publications
            .iter()
            .find(|row| row.local_port == 18201),
        Some(&failed_row)
    );
    assert_eq!(
        state
            .publications
            .iter()
            .find(|row| row.local_port == 18202)
            .unwrap()
            .phase,
        TunnelPhase::Listening
    );

    worker.stop();
    other.response.send(opened("unrelated-new")).unwrap();
    let mut closed = Vec::new();
    for _ in 0..2 {
        let close = server.next();
        assert_eq!(close.path, CLOSE_TUNNEL_PATH);
        closed.push(close.body["tunnel_id"].as_str().unwrap().to_owned());
        close
            .response
            .send(serde_json::json!({"success": true}))
            .unwrap();
    }
    closed.sort();
    assert_eq!(closed, ["unrelated-new", "unrelated-running"]);
    wait_until(|| worker.is_finished());
    assert_eq!(
        worker
            .snapshot()
            .publications
            .iter()
            .find(|row| row.local_port == 18201),
        Some(&failed_row)
    );
    assert!(
        worker
            .shutdown()
            .unwrap_err()
            .contains("服务端隧道清理未确认")
    );
    assert!(server.calls.try_recv().is_err());
}

#[test]
fn explicit_publication_replace_does_not_hide_old_cleanup_failure() {
    let server = ControlServer::start();
    let worker = start_tunnel_worker(config(&server.url)).unwrap();
    worker
        .publish(TunnelPublicationConfig {
            local_addr: "127.0.0.1:18204".parse().unwrap(),
            public_port: Some(19204),
        })
        .unwrap();
    let old = server.next();
    worker
        .publish(TunnelPublicationConfig {
            local_addr: "127.0.0.1:18204".parse().unwrap(),
            public_port: Some(19205),
        })
        .unwrap();
    wait_until(|| worker.snapshot().publications[0].phase == TunnelPhase::Stopping);
    old.response
        .send(opened("replaced-old-registration"))
        .unwrap();
    let close = server.next();
    assert_eq!(close.path, CLOSE_TUNNEL_PATH);
    close
        .response
        .send(serde_json::json!({"success": false}))
        .unwrap();
    wait_until(|| worker.snapshot().publications[0].phase == TunnelPhase::Failed);
    assert_eq!(worker.snapshot().publications[0].public_port, Some(19204));
    assert!(
        worker.snapshot().publications[0]
            .detail
            .contains("旧发布清理失败")
    );
    worker
        .publish(TunnelPublicationConfig {
            local_addr: "127.0.0.1:18205".parse().unwrap(),
            public_port: None,
        })
        .unwrap();
    let other = server.next();
    assert_eq!(other.path, OPEN_TUNNEL_PATH);
    assert_eq!(other.body["port"], 18205);
    worker.stop();
    other.response.send(opened("replace-unrelated")).unwrap();
    let close = server.next();
    assert_eq!(close.path, CLOSE_TUNNEL_PATH);
    assert_eq!(close.body["tunnel_id"], "replace-unrelated");
    close
        .response
        .send(serde_json::json!({"success": true}))
        .unwrap();
    assert!(worker.shutdown().is_err());
    assert!(server.calls.try_recv().is_err());
}

#[tokio::test]
async fn forward_cleanup_failure_survives_stop_replace_and_mode_rebuild() {
    for action in 0..3 {
        let cfg = config("http://127.0.0.1:9");
        let (_worker_stop, stop) = watch::channel(false);
        let (item_stop, _item_rx) = watch::channel(false);
        let original = TunnelForwardConfig {
            provider_id: "aa".repeat(32),
            remote_port: 80,
            local_port: 18206,
        };
        let state = snapshot();
        state.lock().unwrap().forwards.push(TunnelForwardSnapshot {
            provider_id: original.provider_id.clone(),
            remote_port: original.remote_port,
            local_port: original.local_port,
            phase: TunnelPhase::Listening,
            detail: "本地映射已就绪".to_owned(),
            path: TunnelPath::Direct,
        });
        let mut worker = Worker {
            config: cfg.clone(),
            identity: "bb".repeat(32),
            control: ControlIo::new(&cfg),
            provider: Arc::new(tokio::sync::Mutex::new(None)),
            visitor: Arc::new(tokio::sync::Mutex::new(None)),
            snapshot: state.clone(),
            stop,
            publications: BTreeMap::new(),
            forwards: BTreeMap::from([(
                original.local_port,
                Item {
                    config: original.clone(),
                    stop: item_stop,
                    task: tokio::spawn(async { Err("测试映射清理未确认".to_owned()) }),
                },
            )]),
            cleanup_error: None,
        };
        let mut replacement = original.clone();
        replacement.remote_port = 81;
        let command = match action {
            0 => Command::StopForward(original.local_port),
            1 => Command::Forward(replacement.clone()),
            _ => Command::SetMode(TunnelMode::RelayOnly),
        };
        worker.command(command).await;
        let failed = state.lock().unwrap().forwards[0].clone();
        assert_eq!(failed.phase, TunnelPhase::Failed);
        assert_eq!(failed.remote_port, 80);
        assert_eq!(failed.path, TunnelPath::Unknown);
        assert!(failed.detail.contains("旧映射清理失败"));
        assert!(failed.detail.contains("测试映射清理未确认"));
        assert!(worker.forwards.is_empty());
        worker
            .command(Command::StopForward(original.local_port))
            .await;
        worker.command(Command::Forward(replacement)).await;
        worker.change_mode(TunnelMode::RelayOnly).await;
        assert!(worker.forwards.is_empty());
        assert_eq!(
            state.lock().unwrap().forwards.as_slice(),
            std::slice::from_ref(&failed)
        );
        worker
            .command(Command::Forward(TunnelForwardConfig {
                local_port: 18207,
                ..original
            }))
            .await;
        assert!(worker.forwards.contains_key(&18207));
        assert_eq!(worker.shutdown().await.unwrap_err(), "测试映射清理未确认");
        assert_eq!(
            state
                .lock()
                .unwrap()
                .forwards
                .iter()
                .find(|row| row.local_port == 18206),
            Some(&failed)
        );
    }
}

fn wait_until(mut condition: impl FnMut() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(std::time::Instant::now() < deadline, "等待隧道状态超时");
        std::thread::sleep(Duration::from_millis(2));
    }
}
