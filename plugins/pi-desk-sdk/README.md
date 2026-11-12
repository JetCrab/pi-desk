# Pi Desk SDK

包名：`@jetcrab/pi-desk-sdk`。公开接口以本版本 `package.json` 的 exports 和对应 TypeScript 声明为准。

Node 与 Session 插件通过绑定身份的 `plugin.config` 使用 `encrypt`、`decrypt`、`set`、`get` 四接口；用户级配置统一保存在 `<AgentDir>/config/pi-desk.yaml`，可按 JSON Pointer 与 `*` 路径选择加解密。密文内联，系统仅托管主密钥。`/config` 提供宿主装配和文件级工具，`/secrets` 保留旧凭据接口供现有项目配置使用。旧全局配置不迁移、不删除、不回退读取；原生 Pi 配置与项目配置位置保持不变。

SDK 的运行依赖为 Zod（协议 Schema）、`yaml`（统一配置）、`proper-lockfile`（Node 跨进程锁）和 `@napi-rs/keyring`（Node 系统持久密钥存储）。协议与 Browser 子入口不加载这些 Node 配置或凭据能力，非 React 使用不要求安装公共 UI 库。

本包自有代码使用 Apache-2.0，见 [LICENSE](./LICENSE)。第三方代码继续遵循其原有许可，构建时保留上游法律注释。
