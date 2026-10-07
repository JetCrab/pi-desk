# 第三方归属

`tunnel/common/src/rathole_runtime.rs` 及 `tunnel/common/src/rathole_runtime/` 基于 [rathole](https://github.com/rapiz1/rathole) 裁剪和修改，上游基线提交为 `5a9dd6d939744859af322aeff7fd60f7483a68bc`。该实现继承并继续改造了 SuperTool 的程序化运行、运行事件和动态服务生命周期逻辑。

该部分使用 Apache-2.0 许可证，完整文本见 [`licenses/rathole-APACHE-2.0.txt`](./licenses/rathole-APACHE-2.0.txt)。

本仓库只保留 Noise TCP、Yamux 和动态服务生命周期。rathole 上游自带的 TLS、WebSocket、UDP、代理、CLI、TOML/文件配置与热更新能力均已从派生源码及依赖中移除；`apps/tunnel/client` 是本项目基于公共 Worker 新增的无头宿主。
