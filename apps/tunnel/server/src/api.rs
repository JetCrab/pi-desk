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
    STATUS_TUNNEL_PATH, StatusTunnelRequest,
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
        TunnelError::Internal => (StatusCode::INTERNAL_SERVER_ERROR, "internal_error"),
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
        CLOSE_TUNNEL_PATH, CryptoContext, OPEN_TUNNEL_PATH, OpenTunnelResponse,
    };
    use pi_desk_tunnel_common::runtime::{
        TunnelServerConfig, derive_noise_public_key, generate_noise_keypair, start_server,
    };
    use tower::ServiceExt;

    use super::{AppState, router};
    use crate::tunnel::{TunnelRegistry, TunnelRegistryConfig};

    async fn test_app() -> (axum::Router, Arc<CryptoContext>) {
        let keypair = generate_noise_keypair().expect("应生成测试 Noise 密钥");
        let public_key =
            derive_noise_public_key(&keypair.private_key).expect("应派生测试 Noise 公钥");
        let mut relay = start_server(TunnelServerConfig {
            bind_addr: "127.0.0.1:0".to_string(),
            private_key: keypair.private_key,
        })
        .expect("应启动测试 relay");
        let events = relay
            .take_event_receiver()
            .expect("测试 relay 应提供事件接收器");
        let crypto = Arc::new(CryptoContext::new([7; 32]));
        let tunnels = TunnelRegistry::new(
            relay,
            events,
            TunnelRegistryConfig {
                public_relay: "127.0.0.1:2333".to_string(),
                public_host: "127.0.0.1".to_string(),
                server_public_key: public_key,
            },
        );
        (
            router(AppState {
                crypto: Arc::clone(&crypto),
                tunnels,
            }),
            crypto,
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
    async fn encrypted_open_accepts_any_nonzero_port_and_close_releases_it() {
        let (app, crypto) = test_app().await;
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
                            "device_id":"aabbccddeeff00112233445566778899",
                            "public_port":0
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
                            "device_id":"aabbccddeeff00112233445566778899",
                            "public_port":1
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
        assert_eq!(opened.public_port, 1);

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
    }
}
