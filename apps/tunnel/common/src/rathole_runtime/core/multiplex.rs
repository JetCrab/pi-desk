use anyhow::{Result, anyhow};
use std::future::poll_fn;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_util::compat::{Compat, FuturesAsyncReadCompatExt, TokioAsyncReadCompatExt};
use tracing::debug;
use yamux::{Config, Connection, Mode, Stream};

use super::transport::Transport;

const OPEN_REQUEST_CAPACITY: usize = 256;

pub type MultiplexStream = Compat<Stream>;
pub type IncomingStreams = mpsc::UnboundedReceiver<Result<MultiplexStream>>;

#[derive(Clone)]
pub struct MultiplexController {
    open_tx: mpsc::Sender<oneshot::Sender<Result<MultiplexStream>>>,
    shutdown_tx: broadcast::Sender<()>,
    closed: Arc<AtomicBool>,
}

impl MultiplexController {
    pub async fn open_stream(&self) -> Result<MultiplexStream> {
        if self.closed.load(Ordering::Acquire) {
            return Err(anyhow!("data multiplex parent is closed"));
        }

        let (response_tx, response_rx) = oneshot::channel();
        self.open_tx
            .send(response_tx)
            .await
            .map_err(|_| anyhow!("data multiplex parent is closed"))?;
        response_rx
            .await
            .map_err(|_| anyhow!("data multiplex parent stopped while opening a stream"))?
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub fn is_same_parent(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.closed, &other.closed)
    }

    pub fn shutdown(&self) {
        let _ = self.shutdown_tx.send(());
    }
}

/// Starts the single yamux driver for an authenticated data parent.
///
/// The caller that opens visitor streams uses `MultiplexController`; the opposite
/// endpoint receives the resulting streams from `IncomingStreams`. The transport
/// stream is converted exactly once here, so client and server do not duplicate
/// Tokio/Futures compatibility code.
pub fn start_parent<T: Transport>(
    stream: T::Stream,
    mode: Mode,
    forward_incoming: bool,
) -> (MultiplexController, IncomingStreams) {
    let (open_tx, mut open_rx) = mpsc::channel(OPEN_REQUEST_CAPACITY);
    let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();
    let (shutdown_tx, mut shutdown_rx) = broadcast::channel(1);
    let closed = Arc::new(AtomicBool::new(false));
    let controller = MultiplexController {
        open_tx,
        shutdown_tx,
        closed: closed.clone(),
    };

    tokio::spawn(async move {
        // Yamux defaults to 512 streams and a 1 GiB aggregate receive window. Neither is a
        // SuperTool product limit: stream count is only bounded by yamux's u32 stream ID space,
        // while memory is naturally bounded by the host.
        let mut config = Config::default();
        config
            .set_max_connection_receive_window(None)
            .set_max_num_streams(u32::MAX as usize);
        let mut connection = Connection::new(stream.compat(), config, mode);
        loop {
            tokio::select! {
                request = open_rx.recv() => match request {
                    Some(response_tx) => {
                        let result = poll_fn(|context| connection.poll_new_outbound(context))
                            .await
                            .map(|stream| stream.compat())
                            .map_err(anyhow::Error::from);
                        let parent_ended = result.is_err();
                        let _ = response_tx.send(result);
                        if parent_ended {
                            debug!("data multiplex parent failed while opening a stream");
                            break;
                        }
                    }
                    None => break,
                },
                incoming = poll_fn(|context| connection.poll_next_inbound(context)) => match incoming {
                    Some(Ok(stream)) if forward_incoming => {
                        if incoming_tx.send(Ok(stream.compat())).is_err() {
                            break;
                        }
                    }
                    Some(Ok(_)) => {
                        debug!("discarded unexpected inbound multiplex stream");
                    }
                    Some(Err(error)) => {
                        debug!(%error, "data multiplex parent ended");
                        break;
                    }
                    None => break,
                },
                _ = shutdown_rx.recv() => break,
            }
        }
        closed.store(true, Ordering::Release);
    });

    (controller, incoming_rx)
}
