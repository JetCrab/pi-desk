# Upstream

本扩展从本地归档的 `tidy-tools` 定制实现中提取工具 `reasoning` 参数的注入与执行前剥离逻辑；该本地归档不随本仓库分发。

归档实现基于 [`@mobrienv/pi-tidy-tools`](https://github.com/mikeyobrien/pi-tidy-tools) **0.4.1**，遵循随本扩展保留的 MIT `LICENSE`。

当前扩展只保留 `reasoning` 工具参数逻辑，不包含上游的 TUI 渲染、命令、配置、Diff 或 Bash 高亮功能。
