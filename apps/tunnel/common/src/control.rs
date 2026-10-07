use std::time::Duration;

use crate::protocol::{
    CLOSE_TUNNEL_PATH, CloseTunnelRequest, CryptoContext, CryptoError, ErrorResponse,
    MAX_REQUEST_BYTES, MutationResponse, OPEN_TUNNEL_PATH, OpenTunnelRequest, OpenTunnelResponse,
    STATUS_TUNNEL_PATH, StatusTunnelRequest, StatusTunnelResponse,
};

const OCTET_STREAM: &str = "application/octet-stream";

pub struct ControlClient {
    agent: ureq::Agent,
    base_url: String,
    crypto: CryptoContext,
}

#[derive(Debug)]
pub enum ControlClientError {
    InvalidBaseUrl,
    RequestSerialization(serde_json::Error),
    RequestEncryption(CryptoError),
    Network(ureq::Error),
    ResponseRead(ureq::Error),
    InvalidContentType,
    ResponseDecryption(CryptoError),
    ResponseDeserialization(serde_json::Error),
    InvalidResponse,
    Rejected(ControlServerError),
    TransportStatus(u16),
    UnexpectedStatus(u16),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlServerError {
    InvalidPort,
    PortConflict,
    RequestConflict,
    NotFound,
    Unauthorized,
    InvalidRequest,
    Internal,
}

impl std::fmt::Display for ControlServerError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPort => formatter.write_str("公网端口必须是 1 到 65535 的有效端口"),
            Self::PortConflict => formatter.write_str("公网端口已被占用"),
            Self::RequestConflict => formatter.write_str("请求标识与已有请求冲突"),
            Self::NotFound => formatter.write_str("隧道不存在或已关闭"),
            Self::Unauthorized => formatter.write_str("隧道控制密钥无效"),
            Self::InvalidRequest => formatter.write_str("隧道请求无效"),
            Self::Internal => formatter.write_str("隧道服务端无法处理请求"),
        }
    }
}

impl std::fmt::Display for ControlClientError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBaseUrl => formatter.write_str("控制服务地址必须使用 http://"),
            Self::RequestSerialization(_) => formatter.write_str("无法编码隧道控制请求"),
            Self::RequestEncryption(_) => formatter.write_str("无法加密隧道控制请求"),
            Self::Network(_) => formatter.write_str("隧道控制服务网络请求失败"),
            Self::ResponseRead(_) => formatter.write_str("无法读取隧道控制服务响应"),
            Self::InvalidContentType => formatter.write_str("隧道控制服务响应类型无效"),
            Self::ResponseDecryption(_) => formatter.write_str("隧道控制服务响应无法验证"),
            Self::ResponseDeserialization(_) | Self::InvalidResponse => {
                formatter.write_str("隧道控制服务响应格式无效")
            }
            Self::Rejected(error) => error.fmt(formatter),
            Self::TransportStatus(status) => {
                write!(formatter, "隧道控制服务暂不可用，状态码 {status}")
            }
            Self::UnexpectedStatus(status) => {
                write!(formatter, "隧道控制服务返回意外状态码 {status}")
            }
        }
    }
}

impl std::error::Error for ControlClientError {}

impl ControlClient {
    pub fn new(base_url: &str, key: [u8; 32]) -> Result<Self, ControlClientError> {
        if !base_url.starts_with("http://") {
            return Err(ControlClientError::InvalidBaseUrl);
        }
        let base_url = base_url.trim_end_matches('/');
        if base_url == "http:" || base_url == "http://" {
            return Err(ControlClientError::InvalidBaseUrl);
        }

        let agent = ureq::Agent::config_builder()
            .proxy(None)
            .timeout_global(Some(Duration::from_secs(10)))
            .http_status_as_error(false)
            .build()
            .into();
        Ok(Self {
            agent,
            base_url: base_url.to_owned(),
            crypto: CryptoContext::new(key),
        })
    }

    pub fn open_tunnel(
        &self,
        request: OpenTunnelRequest,
    ) -> Result<OpenTunnelResponse, ControlClientError> {
        let response = self.post_encrypted(
            OPEN_TUNNEL_PATH,
            serde_json::to_vec(&request).map_err(ControlClientError::RequestSerialization)?,
        )?;
        let plaintext = self.tunnel_plaintext(OPEN_TUNNEL_PATH, response)?;
        serde_json::from_slice(&plaintext).map_err(ControlClientError::ResponseDeserialization)
    }

    pub fn status_tunnel(
        &self,
        tunnel_id: &str,
    ) -> Result<StatusTunnelResponse, ControlClientError> {
        let response = self.post_encrypted(
            STATUS_TUNNEL_PATH,
            serde_json::to_vec(&StatusTunnelRequest {
                tunnel_id: tunnel_id.to_owned(),
            })
            .map_err(ControlClientError::RequestSerialization)?,
        )?;
        let response: StatusTunnelResponse =
            serde_json::from_slice(&self.tunnel_plaintext(STATUS_TUNNEL_PATH, response)?)
                .map_err(ControlClientError::ResponseDeserialization)?;
        if response.tunnel_id != tunnel_id {
            return Err(ControlClientError::InvalidResponse);
        }
        Ok(response)
    }

    pub fn close_tunnel(&self, tunnel_id: &str) -> Result<(), ControlClientError> {
        let response = self.post_encrypted(
            CLOSE_TUNNEL_PATH,
            serde_json::to_vec(&CloseTunnelRequest {
                tunnel_id: tunnel_id.to_owned(),
            })
            .map_err(ControlClientError::RequestSerialization)?,
        )?;
        let response: MutationResponse =
            serde_json::from_slice(&self.tunnel_plaintext(CLOSE_TUNNEL_PATH, response)?)
                .map_err(ControlClientError::ResponseDeserialization)?;
        if response.success {
            Ok(())
        } else {
            Err(ControlClientError::InvalidResponse)
        }
    }

    fn post_encrypted(
        &self,
        path: &str,
        plaintext: Vec<u8>,
    ) -> Result<ureq::http::Response<ureq::Body>, ControlClientError> {
        let body = self
            .crypto
            .encrypt(path, &plaintext)
            .map_err(ControlClientError::RequestEncryption)?;
        self.agent
            .post(self.url(path))
            .content_type(OCTET_STREAM)
            .send(body)
            .map_err(ControlClientError::Network)
    }

    fn tunnel_plaintext(
        &self,
        path: &str,
        mut response: ureq::http::Response<ureq::Body>,
    ) -> Result<Vec<u8>, ControlClientError> {
        let status = response.status().as_u16();
        if status != 200 {
            return Err(self.tunnel_error(path, status, &mut response)?);
        }
        self.require_content_type(&response)?;
        let body = self.read_body(&mut response)?;
        self.crypto
            .decrypt(path, &body)
            .map_err(ControlClientError::ResponseDecryption)
    }

    fn tunnel_error(
        &self,
        path: &str,
        status: u16,
        response: &mut ureq::http::Response<ureq::Body>,
    ) -> Result<ControlClientError, ControlClientError> {
        if matches!(status, 408 | 413 | 503) {
            return Ok(ControlClientError::TransportStatus(status));
        }
        if !matches!(status, 400 | 401 | 404 | 409 | 500) {
            return Ok(ControlClientError::UnexpectedStatus(status));
        }
        self.require_content_type(response)?;
        let body = self.read_body(response)?;
        let plaintext = self
            .crypto
            .decrypt(path, &body)
            .map_err(ControlClientError::ResponseDecryption)?;
        let error: ErrorResponse = serde_json::from_slice(&plaintext)
            .map_err(ControlClientError::ResponseDeserialization)?;
        let error = match error.error.as_str() {
            "invalid_port" => ControlServerError::InvalidPort,
            "port_conflict" => ControlServerError::PortConflict,
            "request_conflict" => ControlServerError::RequestConflict,
            "not_found" => ControlServerError::NotFound,
            "unauthorized" => ControlServerError::Unauthorized,
            "invalid_request" => ControlServerError::InvalidRequest,
            _ => ControlServerError::Internal,
        };
        Ok(ControlClientError::Rejected(error))
    }

    fn read_body(
        &self,
        response: &mut ureq::http::Response<ureq::Body>,
    ) -> Result<Vec<u8>, ControlClientError> {
        response
            .body_mut()
            .with_config()
            .limit(MAX_REQUEST_BYTES as u64)
            .read_to_vec()
            .map_err(ControlClientError::ResponseRead)
    }

    fn require_content_type(
        &self,
        response: &ureq::http::Response<ureq::Body>,
    ) -> Result<(), ControlClientError> {
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim);
        if content_type == Some(OCTET_STREAM) {
            Ok(())
        } else {
            Err(ControlClientError::InvalidContentType)
        }
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url, path)
    }
}
