# 第三方归属

Pi Desk TCP 隧道使用 [iroh 1.4.1](https://github.com/n0-computer/iroh/tree/v1.4.1) 提供加密端点、可靠双向流、直连和中继能力。自托管中继构建固定于发布提交 `d6c6963b9602d1b8dd2ba53b6519e7eb19cc7940`。

上游采用 MIT OR Apache-2.0 双许可；本项目保留两份原始许可证：

- [Apache-2.0](licenses/iroh-APACHE-2.0.txt)
- [MIT](licenses/iroh-MIT.txt)

iroh 主库及 `iroh-relay` 的部分实现来自 Tailscale，分别保留上游归属说明：

- [iroh BSD-3-Clause](licenses/iroh-BSD-3-Clause.txt)
- [iroh-relay BSD-3-Clause](licenses/iroh-relay-BSD-3-Clause.txt)

分发桌面程序、网关或中继时保留适用的原始声明。

其他 Rust 依赖以 `Cargo.lock` 为实际清单，各自许可证和版权不受本声明改写。本项目自有代码继续使用根目录的 [Apache-2.0 许可证](LICENSE)。
