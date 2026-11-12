# Pi Desk SDK

包名：`@jetcrab/pi-desk-sdk`。公开接口以本版本 `package.json` 的 exports 和对应 TypeScript 声明为准。

Node-only `/config` 只提供当前配置目录、同目标串行读改写与原子文本写入，`/secrets` 提供凭据引用与加密存储；不从根入口或 Browser 导出，不依赖常驻 Global Host。配置只读取当前路径和格式，旧配置需在升级前另行准备，启动和读取不会自动搬迁或回写旧文件。

SDK 的运行依赖为 Zod（协议 Schema）、`proper-lockfile`（Node 跨进程锁）和 `@napi-rs/keyring`（Node 系统持久密钥存储）。协议与 Browser 子入口不加载这些 Node 配置或凭据能力，非 React 使用不要求安装公共 UI 库。

本包自有代码使用 Apache-2.0，见 [LICENSE](./LICENSE)。第三方代码继续遵循其原有许可，构建时保留上游法律注释。
