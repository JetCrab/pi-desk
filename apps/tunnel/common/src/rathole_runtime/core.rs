// Derived from rathole (Apache-2.0), modified for Pi Desk Noise TCP tunnels.
mod config;
mod constants;
mod helper;
mod multi_map;
mod multiplex;
mod protocol;
mod service_updates;
mod transport;

pub use config::{
    ClientConfig, ClientServiceConfig, Config, MaskedString, NoiseConfig, ServerConfig,
    ServerServiceConfig, TcpConfig,
};
pub use service_updates::{ClientServiceChange, ConfigChange, ConfigCommand, ServerServiceChange};

use anyhow::{Context, Result, anyhow};
use snowstorm::snow::resolvers::{CryptoResolver, DefaultResolver};
use tokio::sync::mpsc;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RuntimeEvent {
    ClientControlConnected {
        service_id: String,
    },
    ClientControlDisconnected {
        service_id: String,
        error: Option<String>,
    },
    ServerServiceListening {
        service_id: String,
        bind_addr: String,
    },
    ServerServiceFailed {
        service_id: String,
        error: String,
    },
    Stopped,
}

#[derive(Clone, PartialEq, Eq)]
pub struct NoiseKeypair {
    pub private_key: String,
    pub public_key: String,
}

fn emit_event(events: &Option<mpsc::UnboundedSender<RuntimeEvent>>, event: RuntimeEvent) {
    if let Some(events) = events {
        let _ = events.send(event);
    }
}

mod client;
pub use client::run_client_with_events;
mod server;
pub use server::run_server_with_events;

const NOISE_PATTERN: &str = "Noise_KK_25519_ChaChaPoly_BLAKE2s";

pub fn generate_noise_keypair() -> Result<NoiseKeypair> {
    let builder = snowstorm::Builder::new(NOISE_PATTERN.parse()?);
    let keypair = builder.generate_keypair()?;
    Ok(NoiseKeypair {
        private_key: base64::encode(keypair.private),
        public_key: base64::encode(keypair.public),
    })
}

pub fn derive_noise_public_key(private_key: &str) -> Result<String> {
    let private_key = base64::decode(private_key).context("Noise 私钥不是 base64")?;
    let params: snowstorm::NoiseParams = NOISE_PATTERN.parse()?;
    let resolver = DefaultResolver;
    let mut dh = resolver
        .resolve_dh(&params.dh)
        .ok_or_else(|| anyhow!("Noise X25519 不可用"))?;
    if private_key.len() != dh.priv_len() {
        return Err(anyhow!("Noise 私钥长度无效"));
    }
    dh.set(&private_key);
    Ok(base64::encode(dh.pubkey()))
}

#[cfg(test)]
mod tests {
    use super::{derive_noise_public_key, generate_noise_keypair};

    #[test]
    fn generated_noise_keys_round_trip() {
        let keypair = generate_noise_keypair().expect("应生成密钥");
        assert_eq!(
            derive_noise_public_key(&keypair.private_key).unwrap(),
            keypair.public_key
        );
    }
}
