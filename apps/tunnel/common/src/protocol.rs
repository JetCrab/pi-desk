use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

pub const HEALTH_PATH: &str = "/api/v1/system/health";
pub const OPEN_TUNNEL_PATH: &str = "/api/v1/tunnel/open";
pub const STATUS_TUNNEL_PATH: &str = "/api/v1/tunnel/status";
pub const CLOSE_TUNNEL_PATH: &str = "/api/v1/tunnel/close";
pub const MAX_REQUEST_BYTES: usize = 512 * 1024;

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

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct OpenTunnelRequest {
    pub request_id: String,
    pub device_id: String,
    pub public_port: u16,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelRelayTransport {
    #[default]
    Noise,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct OpenTunnelResponse {
    pub tunnel_id: String,
    pub public_port: u16,
    pub public_addr: String,
    pub relay_addr: String,
    pub service_token: String,
    pub server_public_key: String,
    #[serde(default)]
    pub relay_transport: TunnelRelayTransport,
}

#[derive(Debug, Deserialize, Serialize, PartialEq)]
pub struct StatusTunnelRequest {
    pub tunnel_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TunnelStatus {
    AwaitingClient,
    Listening,
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
