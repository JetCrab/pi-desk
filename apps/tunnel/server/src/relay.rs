use std::fmt;
use std::sync::Arc;

use axum::http::HeaderMap;
use iroh_relay::KeyCache;
use iroh_relay::server::http_server::{Handlers, RelayService};
use iroh_relay::server::{Access, AccessControl, ClientRequest, Metrics};

struct TokenAccess(String);

impl fmt::Debug for TokenAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("TokenAccess")
    }
}

impl AccessControl for TokenAccess {
    async fn on_connect(&self, request: &ClientRequest) -> Access {
        if request.auth_token().as_deref() == Some(self.0.as_str()) {
            Access::Allow
        } else {
            Access::Deny {
                reason: Some("中继准入令牌无效".to_owned()),
            }
        }
    }
}

pub(super) fn service(token: String) -> RelayService {
    RelayService::new(
        Handlers::default(),
        HeaderMap::new(),
        None,
        KeyCache::new(1024),
        Arc::new(TokenAccess(token)),
        Arc::new(Metrics::default()),
    )
}

#[cfg(test)]
mod tests {
    use axum::http::Request;
    use iroh_relay::http::ProtocolVersion;
    use pi_desk_tunnel_common::runtime::{generate_secret_key, provider_id};

    use super::*;

    #[tokio::test]
    async fn relay_allows_only_the_configured_token() {
        let identity = provider_id(&generate_secret_key().unwrap()).unwrap();
        let access = TokenAccess("test-relay-token".to_owned());
        for token in [None, Some("wrong-token"), Some("test-relay-token")] {
            let mut request = Request::builder();
            if let Some(token) = token {
                request = request.header("Authorization", format!("Bearer {token}"));
            }
            let request = ClientRequest::new(
                identity.parse().unwrap(),
                ProtocolVersion::V2,
                request.body(()).unwrap().into_parts().0,
            );
            let result = access.on_connect(&request).await;
            assert_eq!(
                matches!(result, Access::Allow),
                token == Some("test-relay-token")
            );
        }
    }
}
