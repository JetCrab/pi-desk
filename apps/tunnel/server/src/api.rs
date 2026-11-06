use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::Response;
use axum::routing::{get, post};
use pi_desk_tunnel_common::protocol::{
    CLOSE_TUNNEL_PATH, CloseTunnelRequest, CryptoContext, CryptoError, ErrorResponse, HEALTH_PATH,
    HealthResponse, MAX_REQUEST_BYTES, MutationResponse, OPEN_TUNNEL_PATH, OpenTunnelRequest,
    RESOLVE_TUNNEL_PATH, ResolveTunnelRequest, STATUS_TUNNEL_PATH, StatusTunnelRequest,
};

use crate::tunnel::{TunnelError, TunnelRegistry};

#[derive(Clone)]
pub struct AppState {
    pub crypto: Arc<CryptoContext>,
    pub tunnels: Arc<TunnelRegistry>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route(HEALTH_PATH, get(health_handler))
        .route(OPEN_TUNNEL_PATH, post(open_handler))
        .route(STATUS_TUNNEL_PATH, post(status_handler))
        .route(RESOLVE_TUNNEL_PATH, post(resolve_handler))
        .route(CLOSE_TUNNEL_PATH, post(close_handler))
        .with_state(state)
}

async fn health_handler() -> Response {
    json_response(StatusCode::OK, serde_json::to_vec(&HealthResponse::ok()))
}

async fn open_handler(State(state): State<AppState>, body: Body) -> Response {
    let plaintext = match decrypt_body(&state.crypto, OPEN_TUNNEL_PATH, body).await {
        Ok(plaintext) => plaintext,
        Err(response) => return response,
    };
    let request: OpenTunnelRequest = match serde_json::from_slice(&plaintext) {
        Ok(request) => request,
        Err(_) => {
            return encrypted_error(
                OPEN_TUNNEL_PATH,
                &state.crypto,
                StatusCode::BAD_REQUEST,
                "invalid_request",
            );
        }
    };
    match state.tunnels.open(request).await {
        Ok(response) => encrypted_response(
            OPEN_TUNNEL_PATH,
            &state.crypto,
            StatusCode::OK,
            serde_json::to_vec(&response),
        ),
        Err(error) => tunnel_error_response(OPEN_TUNNEL_PATH, &state.crypto, error),
    }
}

async fn status_handler(State(state): State<AppState>, body: Body) -> Response {
    let plaintext = match decrypt_body(&state.crypto, STATUS_TUNNEL_PATH, body).await {
        Ok(plaintext) => plaintext,
        Err(response) => return response,
    };
    let request: StatusTunnelRequest = match serde_json::from_slice(&plaintext) {
        Ok(request) => request,
        Err(_) => {
            return encrypted_error(
                STATUS_TUNNEL_PATH,
                &state.crypto,
                StatusCode::BAD_REQUEST,
                "invalid_request",
            );
        }
    };
    match state.tunnels.status(&request.tunnel_id).await {
        Ok(response) => encrypted_response(
            STATUS_TUNNEL_PATH,
            &state.crypto,
            StatusCode::OK,
            serde_json::to_vec(&response),
        ),
        Err(error) => tunnel_error_response(STATUS_TUNNEL_PATH, &state.crypto, error),
    }
}

async fn resolve_handler(State(state): State<AppState>, body: Body) -> Response {
    let plaintext = match decrypt_body(&state.crypto, RESOLVE_TUNNEL_PATH, body).await {
        Ok(plaintext) => plaintext,
        Err(response) => return response,
    };
    let request: ResolveTunnelRequest = match serde_json::from_slice(&plaintext) {
        Ok(request) => request,
        Err(_) => {
            return encrypted_error(
                RESOLVE_TUNNEL_PATH,
                &state.crypto,
                StatusCode::BAD_REQUEST,
                "invalid_request",
            );
        }
    };
    match state.tunnels.resolve(request).await {
        Ok(response) => encrypted_response(
            RESOLVE_TUNNEL_PATH,
            &state.crypto,
            StatusCode::OK,
            serde_json::to_vec(&response),
        ),
        Err(error) => tunnel_error_response(RESOLVE_TUNNEL_PATH, &state.crypto, error),
    }
}

async fn close_handler(State(state): State<AppState>, body: Body) -> Response {
    let plaintext = match decrypt_body(&state.crypto, CLOSE_TUNNEL_PATH, body).await {
        Ok(plaintext) => plaintext,
        Err(response) => return response,
    };
    let request: CloseTunnelRequest = match serde_json::from_slice(&plaintext) {
        Ok(request) => request,
        Err(_) => {
            return encrypted_error(
                CLOSE_TUNNEL_PATH,
                &state.crypto,
                StatusCode::BAD_REQUEST,
                "invalid_request",
            );
        }
    };
    match state.tunnels.close(&request.tunnel_id).await {
        Ok(()) => encrypted_response(
            CLOSE_TUNNEL_PATH,
            &state.crypto,
            StatusCode::OK,
            serde_json::to_vec(&MutationResponse::success()),
        ),
        Err(error) => tunnel_error_response(CLOSE_TUNNEL_PATH, &state.crypto, error),
    }
}

async fn decrypt_body(crypto: &CryptoContext, path: &str, body: Body) -> Result<Vec<u8>, Response> {
    let body = match to_bytes(body, MAX_REQUEST_BYTES).await {
        Ok(body) => body,
        Err(_) => {
            return Err(plain_response(
                StatusCode::PAYLOAD_TOO_LARGE,
                "payload too large",
            ));
        }
    };
    match crypto.decrypt(path, &body) {
        Ok(plaintext) => Ok(plaintext),
        Err(CryptoError::MalformedPayload) => Err(encrypted_error(
            path,
            crypto,
            StatusCode::BAD_REQUEST,
            "invalid_request",
        )),
        Err(CryptoError::Randomness(_) | CryptoError::Decryption | CryptoError::Encryption) => Err(
            encrypted_error(path, crypto, StatusCode::UNAUTHORIZED, "unauthorized"),
        ),
    }
}

fn tunnel_error_response(path: &str, crypto: &CryptoContext, error: TunnelError) -> Response {
    let (status, code) = match error {
        TunnelError::InvalidRequest => (StatusCode::BAD_REQUEST, "invalid_request"),
        TunnelError::InvalidPort => (StatusCode::BAD_REQUEST, "invalid_port"),
        TunnelError::PortConflict => (StatusCode::CONFLICT, "port_conflict"),
        TunnelError::RequestConflict => (StatusCode::CONFLICT, "request_conflict"),
        TunnelError::NotFound => (StatusCode::NOT_FOUND, "not_found"),
        TunnelError::NotReady => (StatusCode::CONFLICT, "not_ready"),
        TunnelError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal"),
    };
    encrypted_error(path, crypto, status, code)
}

fn encrypted_error(path: &str, crypto: &CryptoContext, status: StatusCode, code: &str) -> Response {
    encrypted_response(
        path,
        crypto,
        status,
        serde_json::to_vec(&ErrorResponse::new(code)),
    )
}

fn encrypted_response(
    path: &str,
    crypto: &CryptoContext,
    status: StatusCode,
    plaintext: Result<Vec<u8>, serde_json::Error>,
) -> Response {
    let body = plaintext
        .ok()
        .and_then(|plaintext| crypto.encrypt(path, &plaintext).ok());
    match body {
        Some(body) => response(status, "application/octet-stream", body),
        None => plain_response(StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
    }
}

fn json_response(status: StatusCode, body: Result<Vec<u8>, serde_json::Error>) -> Response {
    match body {
        Ok(body) => response(status, "application/json", body),
        Err(_) => plain_response(StatusCode::INTERNAL_SERVER_ERROR, "internal server error"),
    }
}

fn plain_response(status: StatusCode, body: &str) -> Response {
    response(
        status,
        "text/plain; charset=utf-8",
        body.as_bytes().to_vec(),
    )
}

fn response(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response {
    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        content_type.parse().expect("固定 Content-Type 必须有效"),
    );
    response
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::{Body, to_bytes};
    use axum::http::{Method, Request, StatusCode};
    use pi_desk_tunnel_common::protocol::{
        CLOSE_TUNNEL_PATH, CryptoContext, MAX_REQUEST_BYTES, OPEN_TUNNEL_PATH, OpenTunnelResponse,
        RESOLVE_TUNNEL_PATH, STATUS_TUNNEL_PATH, TunnelRelayConfig,
    };
    use pi_desk_tunnel_common::runtime::{TunnelEndpointConfig, TunnelMode, start_endpoint};
    use tower::ServiceExt;

    use super::{AppState, router};
    use crate::tunnel::{TunnelRegistry, TunnelRegistryConfig};

    async fn test_app() -> (axum::Router, Arc<CryptoContext>, Arc<TunnelRegistry>) {
        let relay = TunnelRelayConfig {
            url: "http://127.0.0.1:9".to_owned(),
            auth_token: "test-relay-token".to_owned(),
            quic_port: 7842,
        };
        let endpoint = start_endpoint(TunnelEndpointConfig {
            secret_key: None,
            relay: relay.clone(),
            mode: TunnelMode::RelayOnly,
        })
        .await
        .unwrap();
        let crypto = Arc::new(CryptoContext::new([7; 32]));
        let tunnels = TunnelRegistry::new(
            endpoint,
            TunnelRegistryConfig {
                relay,
                public_host: "127.0.0.1".to_owned(),
            },
        );
        (
            router(AppState {
                crypto: Arc::clone(&crypto),
                tunnels: Arc::clone(&tunnels),
            }),
            crypto,
            tunnels,
        )
    }

    fn encrypted_request(crypto: &CryptoContext, path: &str, body: serde_json::Value) -> Body {
        Body::from(
            crypto
                .encrypt(path, &serde_json::to_vec(&body).expect("应编码测试请求"))
                .expect("应加密测试请求"),
        )
    }

    #[tokio::test]
    async fn encrypted_open_and_resolve_preserve_registration_lifecycle() {
        let (app, crypto, tunnels) = test_app().await;
        let invalid = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(OPEN_TUNNEL_PATH)
                    .body(encrypted_request(
                        &crypto,
                        OPEN_TUNNEL_PATH,
                        serde_json::json!({
                            "request_id":"invalid-port",
                            "provider_id":"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
                            "port":0,
                            "public_port":null
                        }),
                    ))
                    .expect("应构造请求"),
            )
            .await
            .expect("应得到响应");
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

        let opened = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(OPEN_TUNNEL_PATH)
                    .body(encrypted_request(
                        &crypto,
                        OPEN_TUNNEL_PATH,
                        serde_json::json!({
                            "request_id":"open-port-one",
                            "provider_id":"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
                            "port":1,
                            "public_port":null
                        }),
                    ))
                    .expect("应构造请求"),
            )
            .await
            .expect("应得到响应");
        assert_eq!(opened.status(), StatusCode::OK);
        let opened = to_bytes(opened.into_body(), usize::MAX)
            .await
            .expect("应读取响应正文");
        let opened: OpenTunnelResponse = serde_json::from_slice(
            &crypto
                .decrypt(OPEN_TUNNEL_PATH, &opened)
                .expect("应解密响应"),
        )
        .expect("应解码隧道响应");
        assert_eq!(opened.public_addr, None);
        let unresolved = app.clone().oneshot(Request::builder().method(Method::POST).uri(RESOLVE_TUNNEL_PATH)
            .body(encrypted_request(&crypto, RESOLVE_TUNNEL_PATH, serde_json::json!({
                "provider_id":"aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899", "port":1
            }))).unwrap()).await.unwrap();
        assert_eq!(unresolved.status(), StatusCode::CONFLICT);
        let body = to_bytes(unresolved.into_body(), MAX_REQUEST_BYTES)
            .await
            .unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(
                &crypto.decrypt(RESOLVE_TUNNEL_PATH, &body).unwrap()
            )
            .unwrap()["error"],
            "not_ready"
        );

        let closed = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(CLOSE_TUNNEL_PATH)
                    .body(encrypted_request(
                        &crypto,
                        CLOSE_TUNNEL_PATH,
                        serde_json::json!({"tunnel_id":opened.tunnel_id}),
                    ))
                    .expect("应构造请求"),
            )
            .await
            .expect("应得到响应");
        assert_eq!(closed.status(), StatusCode::OK);
        tunnels.shutdown().await;
    }

    #[tokio::test]
    async fn rejects_wrong_key_wrong_aad_old_routes_and_oversized_body() {
        let (app, crypto, tunnels) = test_app().await;
        for body in [
            encrypted_request(
                &CryptoContext::new([8; 32]),
                OPEN_TUNNEL_PATH,
                serde_json::json!({}),
            ),
            encrypted_request(&crypto, STATUS_TUNNEL_PATH, serde_json::json!({})),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(OPEN_TUNNEL_PATH)
                        .body(body)
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
            let bytes = to_bytes(response.into_body(), MAX_REQUEST_BYTES)
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(
                    &crypto.decrypt(OPEN_TUNNEL_PATH, &bytes).unwrap()
                )
                .unwrap()["error"],
                "unauthorized"
            );
        }
        let old = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/tunnel/open")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(old.status(), StatusCode::NOT_FOUND);
        let oversized = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(OPEN_TUNNEL_PATH)
                    .body(Body::from(vec![0; MAX_REQUEST_BYTES + 1]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
        tunnels.shutdown().await;
    }
}
