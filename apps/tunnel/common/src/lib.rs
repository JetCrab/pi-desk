//! Pi Desk 原生 TCP 隧道的共享运行时与加密控制协议。
//!
//! 核心转发实现基于 rathole 裁剪和修改：仅保留 Pi Desk 需要的
//! Noise TCP、Yamux 与动态服务生命周期。许可证与来源说明位于
//! `tunnel/THIRD_PARTY_NOTICES.md` 和 `tunnel/licenses/`。

pub mod config;
pub mod control;
pub mod protocol;
pub mod runtime;
pub mod worker;

mod rathole_runtime;
