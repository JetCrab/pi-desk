use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub(super) const MAX_HEADER_BYTES: usize = 4096;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Operation {
    Probe,
    Forward,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Header {
    pub op: Operation,
    pub tunnel_id: String,
    pub service_token: String,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Reply {
    Ready,
    Unauthorized,
    Unavailable,
    InvalidRequest,
}

impl Reply {
    pub fn result(self) -> Result<(), String> {
        match self {
            Self::Ready => Ok(()),
            Self::Unauthorized => Err("隧道登记不存在或授权已失效".to_owned()),
            Self::Unavailable => Err("提供端本地TCP服务不可用".to_owned()),
            Self::InvalidRequest => Err("隧道流控制头无效".to_owned()),
        }
    }
}

pub(super) async fn read_frame<R, T>(reader: &mut R) -> Result<T, String>
where
    R: AsyncRead + Unpin,
    T: serde::de::DeserializeOwned,
{
    let length = reader.read_u32().await.map_err(|_| "隧道控制头被截断")? as usize;
    if length == 0 || length > MAX_HEADER_BYTES {
        return Err("隧道控制头长度超限".to_owned());
    }
    let mut data = vec![0; length];
    reader
        .read_exact(&mut data)
        .await
        .map_err(|_| "隧道控制头被截断")?;
    serde_json::from_slice(&data).map_err(|_| "隧道控制头JSON无效".to_owned())
}

pub(super) async fn write_frame<W, T>(writer: &mut W, value: &T) -> Result<(), String>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let data = serde_json::to_vec(value).map_err(|_| "无法编码隧道控制头")?;
    if data.is_empty() || data.len() > MAX_HEADER_BYTES {
        return Err("隧道控制头长度超限".to_owned());
    }
    tokio::time::timeout(super::HANDSHAKE_TIMEOUT, async {
        writer
            .write_u32(data.len() as u32)
            .await
            .map_err(|_| "无法写入隧道控制头")?;
        writer
            .write_all(&data)
            .await
            .map_err(|_| "无法写入隧道控制头")?;
        Ok(())
    })
    .await
    .map_err(|_| "写入隧道控制头超时".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_oversize_truncated_and_unknown_headers() {
        for data in [
            ((MAX_HEADER_BYTES + 1) as u32).to_be_bytes().to_vec(),
            vec![0, 0, 0, 10, b'{'],
            vec![0, 0, 0, 1, b'{'],
        ] {
            assert!(read_frame::<_, Header>(&mut data.as_slice()).await.is_err());
        }
        let invalid = br#"{"op":"other","tunnel_id":"a","service_token":"test"}"#;
        let mut frame = Vec::new();
        frame.extend_from_slice(&(invalid.len() as u32).to_be_bytes());
        frame.extend_from_slice(invalid);
        assert!(
            read_frame::<_, Header>(&mut frame.as_slice())
                .await
                .is_err()
        );
    }
}
