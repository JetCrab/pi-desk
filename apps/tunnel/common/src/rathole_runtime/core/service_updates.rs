// Derived from rathole (Apache-2.0), reduced to in-memory Pi Desk service updates.
use tokio::sync::oneshot;

use super::config::{ClientServiceConfig, ServerServiceConfig};

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ConfigChange {
    ServerChange(ServerServiceChange),
    ClientChange(ClientServiceChange),
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ClientServiceChange {
    Add(ClientServiceConfig),
    Delete(String),
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum ServerServiceChange {
    Add(ServerServiceConfig),
    Delete(String),
}

pub struct ConfigCommand {
    pub change: ConfigChange,
    acknowledgement: Option<oneshot::Sender<Result<(), String>>>,
}

impl ConfigCommand {
    pub fn with_ack(change: ConfigChange) -> (Self, oneshot::Receiver<Result<(), String>>) {
        let (acknowledgement, receiver) = oneshot::channel();
        (
            Self {
                change,
                acknowledgement: Some(acknowledgement),
            },
            receiver,
        )
    }

    pub(crate) fn into_parts(self) -> (ConfigChange, Option<oneshot::Sender<Result<(), String>>>) {
        (self.change, self.acknowledgement)
    }

    pub(crate) fn acknowledge(
        acknowledgement: Option<oneshot::Sender<Result<(), String>>>,
        result: Result<(), String>,
    ) {
        if let Some(acknowledgement) = acknowledgement {
            let _ = acknowledgement.send(result);
        }
    }
}
