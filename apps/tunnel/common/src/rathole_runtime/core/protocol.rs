// Derived from rathole (Apache-2.0), reduced to Noise TCP/Yamux protocol V2.
use anyhow::{Context, Result, bail};
use lazy_static::lazy_static;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite};

pub const HASH_WIDTH_IN_BYTES: usize = 32;
pub const CURRENT_PROTO_VERSION: u8 = 2;
pub type Digest = [u8; HASH_WIDTH_IN_BYTES];

#[derive(Deserialize, Serialize, Debug)]
pub enum Hello {
    ControlChannelHello(u8, Digest),
    DataChannelHello(u8, Digest),
}

#[derive(Deserialize, Serialize, Debug)]
pub struct Auth(pub Digest);

#[derive(Deserialize, Serialize, Debug)]
pub enum Ack {
    Ok,
    ServiceNotExist,
    AuthFailed,
}

impl std::fmt::Display for Ack {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Ok => "Ok",
            Self::ServiceNotExist => "Service not exist",
            Self::AuthFailed => "Incorrect token",
        })
    }
}

#[derive(Deserialize, Serialize, Debug)]
pub enum ControlChannelCmd {
    CreateDataChannel,
    HeartBeat,
}

#[derive(Deserialize, Serialize, Debug)]
pub enum DataChannelCmd {
    StartForwardTcp,
}

pub fn digest(data: &[u8]) -> Digest {
    use sha2::{Digest as _, Sha256};
    Sha256::new().chain_update(data).finalize().into()
}

struct PacketLength {
    hello: usize,
    auth: usize,
    ack: usize,
    control: usize,
    data: usize,
}

lazy_static! {
    static ref PACKET_LENGTH: PacketLength = {
        let digest = digest(b"pi-desk");
        PacketLength {
            hello: bincode::serialized_size(&Hello::ControlChannelHello(
                CURRENT_PROTO_VERSION,
                digest,
            ))
            .unwrap() as usize,
            auth: bincode::serialized_size(&Auth(digest)).unwrap() as usize,
            ack: bincode::serialized_size(&Ack::Ok).unwrap() as usize,
            control: bincode::serialized_size(&ControlChannelCmd::CreateDataChannel).unwrap()
                as usize,
            data: bincode::serialized_size(&DataChannelCmd::StartForwardTcp).unwrap() as usize,
        }
    };
}

pub async fn read_hello<T: AsyncRead + AsyncWrite + Unpin>(connection: &mut T) -> Result<Hello> {
    let hello: Hello = read_exact_bincode(connection, PACKET_LENGTH.hello).await?;
    match hello {
        Hello::ControlChannelHello(version, _) | Hello::DataChannelHello(version, _)
            if version == CURRENT_PROTO_VERSION =>
        {
            Ok(hello)
        }
        Hello::ControlChannelHello(version, _) | Hello::DataChannelHello(version, _) => {
            bail!(
                "Protocol version mismatched. Expected {}, got {}.",
                CURRENT_PROTO_VERSION,
                version
            )
        }
    }
}

pub async fn read_auth<T: AsyncRead + AsyncWrite + Unpin>(connection: &mut T) -> Result<Auth> {
    read_exact_bincode(connection, PACKET_LENGTH.auth).await
}

pub async fn read_ack<T: AsyncRead + AsyncWrite + Unpin>(connection: &mut T) -> Result<Ack> {
    read_exact_bincode(connection, PACKET_LENGTH.ack).await
}

pub async fn read_control_cmd<T: AsyncRead + AsyncWrite + Unpin>(
    connection: &mut T,
) -> Result<ControlChannelCmd> {
    read_exact_bincode(connection, PACKET_LENGTH.control).await
}

pub async fn read_data_cmd<T: AsyncRead + AsyncWrite + Unpin>(
    connection: &mut T,
) -> Result<DataChannelCmd> {
    read_exact_bincode(connection, PACKET_LENGTH.data).await
}

async fn read_exact_bincode<T: AsyncRead + Unpin, V: for<'de> Deserialize<'de>>(
    connection: &mut T,
    length: usize,
) -> Result<V> {
    let mut bytes = vec![0; length];
    connection.read_exact(&mut bytes).await?;
    bincode::deserialize(&bytes).context("隧道协议包无效")
}
