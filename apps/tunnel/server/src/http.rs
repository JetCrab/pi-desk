use std::future::Future;
use std::io;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use axum::Router;
use axum::body::Body;
use axum::http::{Method, Response};
use hyper::server::conn::http1;
use hyper::service::{Service, service_fn};
use hyper::{Request, body::Incoming};
use hyper_util::rt::TokioIo;
use iroh_relay::http::{RELAY_PATH, RELAY_PROBE_PATH};
use iroh_relay::server::http_server::{RelayService, RelayServiceWithNotify};
use iroh_relay::server::streams::MaybeTlsStream;
use tokio::net::TcpListener;
use tokio::sync::{Notify, watch};
use tokio::task::JoinSet;
use tower::ServiceExt;

const HTTP_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);

pub(super) async fn serve(
    listener: TcpListener,
    app: Router,
    relay: RelayService,
    shutdown: impl Future<Output = ()>,
) -> Result<()> {
    let (shutdown_tx, _) = watch::channel(());
    let mut connections = JoinSet::new();
    tokio::pin!(shutdown);

    let result = loop {
        tokio::select! {
            biased;
            _ = &mut shutdown => break Ok(()),
            Some(result) = connections.join_next() => {
                if let Err(error) = result {
                    eprintln!("隧道 HTTP 连接任务异常 error={error}");
                }
            }
            accepted = listener.accept() => {
                let (stream, peer) = match accepted {
                    Ok(connection) => connection,
                    Err(error) => break Err(error).context("无法接收隧道 HTTP 连接"),
                };
                let app = app.clone();
                let relay = RelayServiceWithNotify::new(relay.clone(), Arc::new(Notify::new()));
                let mut shutdown_rx = shutdown_tx.subscribe();
                connections.spawn(async move {
                    let service = service_fn(move |request| {
                        dispatch(app.clone(), relay.clone(), request)
                    });
                    // iroh 通过此具体类型取回升级后的流，不能直接包装 TcpStream。
                    let stream = TokioIo::new(MaybeTlsStream::Plain(stream));
                    let connection = http1::Builder::new()
                        .serve_connection(stream, service)
                        .with_upgrades();
                    tokio::pin!(connection);
                    let result = tokio::select! {
                        result = &mut connection => result,
                        _ = shutdown_rx.changed() => {
                            connection.as_mut().graceful_shutdown();
                            match tokio::time::timeout(HTTP_SHUTDOWN_TIMEOUT, connection).await {
                                Ok(result) => result,
                                Err(_) => {
                                    eprintln!("隧道 HTTP 连接关闭超时，释放连接 peer={peer}");
                                    return;
                                }
                            }
                        }
                    };
                    if let Err(error) = result {
                        eprintln!("隧道 HTTP 连接失败 peer={peer} error={error}");
                    }
                });
            }
        }
    };

    drop(listener);
    let _ = shutdown_tx.send(());
    while let Some(result) = connections.join_next().await {
        if let Err(error) = result {
            eprintln!("隧道 HTTP 连接任务回收失败 error={error}");
        }
    }
    result
}

async fn dispatch(
    app: Router,
    relay: RelayServiceWithNotify,
    request: Request<Incoming>,
) -> io::Result<Response<Body>> {
    if request.method() == Method::GET && request.uri().path() == RELAY_PROBE_PATH {
        return Ok(Response::builder()
            .header("Access-Control-Allow-Origin", "*")
            .body(Body::empty())
            .expect("固定探测响应必须有效"));
    }
    if request.uri().path() == RELAY_PATH {
        return relay
            .call(request)
            .await
            .map(|response| response.map(Body::new))
            .map_err(io::Error::other);
    }
    match app.oneshot(request).await {
        Ok(response) => Ok(response),
        Err(error) => match error {},
    }
}

#[cfg(test)]
mod tests {
    use std::net::SocketAddr;
    use std::time::Duration;

    use axum::routing::get;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::sync::oneshot;

    use super::*;

    async fn request(address: SocketAddr, path: &str) -> String {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream
            .write_all(
                format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        String::from_utf8(response).unwrap()
    }

    #[tokio::test]
    async fn shutdown_releases_an_incomplete_request_header() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route("/control", get(|| async { "control" }));
        let relay = crate::relay::service("test-relay-token".to_owned());
        let (stop, stopped) = oneshot::channel();
        let mut server = tokio::spawn(serve(listener, app, relay, async {
            let _ = stopped.await;
        }));
        let mut incomplete = TcpStream::connect(address).await.unwrap();
        incomplete
            .write_all(b"GET /ping HTTP/1.1\r\nHost: x")
            .await
            .unwrap();
        assert!(request(address, "/control").await.ends_with("control"));
        stop.send(()).unwrap();
        let result = tokio::time::timeout(Duration::from_secs(12), &mut server).await;
        if result.is_err() {
            server.abort();
            let _ = server.await;
        }
        drop(incomplete);
        let released = TcpListener::bind(address).await;
        result
            .expect("半包请求不应无限阻塞服务关闭")
            .unwrap()
            .unwrap();
        assert!(released.is_ok());
    }

    #[tokio::test]
    async fn one_listener_serves_control_and_relay_probe_then_releases() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = Router::new().route("/control", get(|| async { "control" }));
        let relay = crate::relay::service("test-relay-token".to_owned());
        let (stop, stopped) = oneshot::channel();
        let server = tokio::spawn(serve(listener, app, relay, async {
            let _ = stopped.await;
        }));
        let control = request(address, "/control").await;
        assert!(control.starts_with("HTTP/1.1 200"));
        assert!(control.ends_with("control"));
        let probe = request(address, RELAY_PROBE_PATH).await;
        assert!(probe.starts_with("HTTP/1.1 200"));
        stop.send(()).unwrap();
        server.await.unwrap().unwrap();
        TcpListener::bind(address).await.unwrap();
    }
}
