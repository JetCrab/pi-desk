use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

pub const HEALTH_PATH: &str = "/api/v2/system/health";
pub const OPEN_TUNNEL_PATH: &str = "/api/v2/tunnel/open";
pub const STATUS_TUNNEL_PATH: &str = "/api/v2/tunnel/status";
pub const CLOSE_TUNNEL_PATH: &str = "/api/v2/tunnel/close";
pub const RESOLVE_TUNNEL_PATH: &str = "/api/v2/tunnel/resolve";
pub const MAX_REQUEST_BYTES: usize = 512 * 1024;
pub const LEASE_DURATION: std::time::Duration = std::time::Duration::from_secs(30);
pub const RENEW_INTERVAL: std::time::Duration = std::time::Duration::from_secs(5);

const NONCE_BYTES: usize = 24;
const TAG_BYTES: usize = 16;
const MIN_ENCRYPTED_BYTES: usize = NONCE_BYTES + TAG_BYTES;

#[derive(Debug)]
pub enum KeyParseError {
    InvalidLength,
    InvalidHex(hex::FromHexError),
}

impl std::fmt::Display for KeyParseError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidLength => formatter.write_str("控制密钥必须是严格 64 位十六进制值"),
            Self::InvalidHex(_) => formatter.write_str("控制密钥必须是十六进制值"),
        }
    }
}

impl std::error::Error for KeyParseError {}

pub fn parse_key_hex(key_hex: &str) -> Result<[u8; 32], KeyParseError> {
    if key_hex.len() != 64 {
        return Err(KeyParseError::InvalidLength);
    }

    let mut key = [0_u8; 32];
    hex::decode_to_slice(key_hex, &mut key).map_err(KeyParseError::InvalidHex)?;
    Ok(key)
}

#[derive(Debug)]
pub enum CryptoError {
    MalformedPayload,
    Randomness(getrandom::Error),
    Encryption,
    Decryption,
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MalformedPayload => formatter.write_str("加密负载格式无效"),
            Self::Randomness(_) | Self::Encryption => formatter.write_str("加密负载失败"),
            Self::Decryption => formatter.write_str("加密负载无法验证"),
        }
    }
}

impl std::error::Error for CryptoError {}

#[derive(Clone)]
pub struct CryptoContext {
    key: [u8; 32],
}

impl CryptoContext {
    pub fn new(key: [u8; 32]) -> Self {
        Self { key }
    }

    pub fn encrypt(&self, path: &str, plaintext: &[u8]) -> Result<Vec<u8>, CryptoError> {
        let cipher = XChaCha20Poly1305::new((&self.key).into());
        let mut nonce = [0_u8; NONCE_BYTES];
        getrandom::fill(&mut nonce).map_err(CryptoError::Randomness)?;
        let nonce = XNonce::try_from(&nonce[..]).map_err(|_| CryptoError::Encryption)?;
        let ciphertext = cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: path.as_bytes(),
                },
            )
            .map_err(|_| CryptoError::Encryption)?;

        let mut payload = Vec::with_capacity(NONCE_BYTES + ciphertext.len());
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&ciphertext);
        Ok(payload)
    }

    pub fn decrypt(&self, path: &str, payload: &[u8]) -> Result<Vec<u8>, CryptoError> {
        if payload.len() < MIN_ENCRYPTED_BYTES {
            return Err(CryptoError::MalformedPayload);
        }

        let cipher = XChaCha20Poly1305::new((&self.key).into());
        let nonce =
            XNonce::try_from(&payload[..NONCE_BYTES]).map_err(|_| CryptoError::MalformedPayload)?;
        cipher
            .decrypt(
                &nonce,
                Payload {
                    msg: &payload[NONCE_BYTES..],
                    aad: path.as_bytes(),
                },
            )
            .map_err(|_| CryptoError::Decryption)
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct HealthResponse {
    pub status: String,
}

impl HealthResponse {
    pub fn ok() -> Self {
        Self {
            status: "ok".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct OpenTunnelRequest {
    pub request_id: String,
    pub provider_id: String,
    pub port: u16,
    pub public_port: Option<u16>,
}

#[derive(Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct TunnelRelayConfig {
    pub url: String,
    pub auth_token: String,
    #[serde(default = "default_relay_quic_port")]
    pub quic_port: u16,
}

pub fn default_relay_quic_port() -> u16 {
    7842
}

impl std::fmt::Debug for TunnelRelayConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TunnelRelayConfig")
            .field("url", &self.url)
            .field("quic_port", &self.quic_port)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub struct OpenTunnelResponse {
    pub tunnel_id: String,
    pub service_token: String,
    pub relay: TunnelRelayConfig,
    pub gateway_id: String,
    pub public_addr: Option<String>,
}

impl std::fmt::Debug for OpenTunnelResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("OpenTunnelResponse")
            .field("tunnel_id", &self.tunnel_id)
            .field("public_addr", &self.public_addr)
            .field("gateway_id", &self.gateway_id)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ResolveTunnelRequest {
    pub provider_id: String,
    pub port: u16,
}

#[derive(Clone, Deserialize, Serialize, PartialEq)]
pub struct ResolveTunnelResponse {
    pub tunnel_id: String,
    pub service_token: String,
    pub relay: TunnelRelayConfig,
}

impl std::fmt::Debug for ResolveTunnelResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ResolveTunnelResponse")
            .field("tunnel_id", &self.tunnel_id)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct StatusTunnelRequest {
    pub tunnel_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelStatus {
    AwaitingProvider,
    Ready,
    Failed,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct StatusTunnelResponse {
    pub tunnel_id: String,
    pub status: TunnelStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct CloseTunnelRequest {
    pub tunnel_id: String,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct MutationResponse {
    pub success: bool,
}

impl MutationResponse {
    pub fn success() -> Self {
        Self { success: true }
    }
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct ErrorResponse {
    pub error: String,
}

impl ErrorResponse {
    pub fn new(error: impl Into<String>) -> Self {
        Self {
            error: error.into(),
        }
    }
}

pub fn random_hex<const N: usize>() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; N];
    getrandom::fill(&mut bytes)?;
    Ok(hex::encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_quic_port_supports_old_v2_and_custom_roundtrip_without_debug_token() {
        let old = serde_json::json!({
            "url": "https://relay.example.com",
            "auth_token": "test-relay-token"
        });
        let mut relay: TunnelRelayConfig = serde_json::from_value(old).unwrap();
        assert_eq!(relay.quic_port, 7842);
        relay.quic_port = 20012;
        let custom = serde_json::json!({
            "url": "https://relay.example.com",
            "auth_token": "test-relay-token",
            "quic_port": 20012
        });
        assert_eq!(serde_json::to_value(&relay).unwrap(), custom);
        assert_eq!(
            serde_json::from_value::<TunnelRelayConfig>(custom).unwrap(),
            relay
        );
        let debug = format!("{relay:?}");
        assert!(debug.contains("20012"));
        assert!(!debug.contains("test-relay-token"));
    }

    #[test]
    fn encryption_binds_the_request_path() {
        let crypto = CryptoContext::new([7; 32]);
        let encrypted = crypto.encrypt(OPEN_TUNNEL_PATH, b"hello").unwrap();

        assert_eq!(
            crypto.decrypt(OPEN_TUNNEL_PATH, &encrypted).unwrap(),
            b"hello"
        );
        assert!(matches!(
            crypto.decrypt(STATUS_TUNNEL_PATH, &encrypted),
            Err(CryptoError::Decryption)
        ));
    }

    #[test]
    fn parses_only_a_complete_control_key() {
        assert_eq!(parse_key_hex(&"ab".repeat(32)).unwrap(), [0xab; 32]);
        assert!(parse_key_hex("aa").is_err());
        assert!(parse_key_hex(&"zz".repeat(32)).is_err());
    }
}
