//! Pi Desk 原生 TCP 隧道的共享运行时与加密控制协议。
//!
//! 共享核心使用 iroh 双向流承载 TCP，提供逐端口授权、路径观察与资源关闭。

pub mod config;
pub mod control;
pub mod protocol;
pub mod provider_cli;
pub mod runtime;
pub mod worker;

mod iroh_runtime;
