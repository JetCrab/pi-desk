# Pi Desk SDK

包名：`@jetcrab/pi-desk-sdk`。公开接口以本版本 `package.json` 的 exports 和对应 TypeScript 声明为准。

Node 与 Session 插件通过绑定身份的 `plugin.config` 使用以下四个异步接口，配置按 JSON Pointer 与 `*` 路径选择加解密：

```ts
await plugin.config.set(
  { server: { port: 2222, password: 'example-password' } },
  { cwd, encryptPaths: ['/server/password'] }
)
const conf = await plugin.config.get({
  cwd,
  defaults: { server: { host: 'localhost', port: 22 } },
  decryptPaths: ['/server/password']
})
const encrypted = await plugin.config.encrypt({ token: 'example-token' })
const value = await plugin.config.decrypt(encrypted)
```

- `set(conf, options?)`：选项为 `{ cwd?: string, encryptPaths?: readonly string[] }`。仅整体替换选定文件内自身分组，保留其他分组和注释，不保存默认值或继承值。
- `get(options?)`：选项为 `{ cwd?: string, defaults?: PluginJsonObject, decryptPaths?: readonly string[], inherit?: boolean }`。默认按默认值 → 全局 → 项目递归覆盖对象字段；数组、标量和 `null` 整体替换，`false`、`0`、`''`、`[]` 均有效，空对象继承已有字段。`inherit: false` 只读选定层，不应用 `defaults` 或额外全局继承，供配置编辑和项目发现使用，不增加第五个接口。
- 不传 `cwd` 时只使用 `<AgentDir>/config/pi-desk.yaml`；传入时项目层固定为 `<cwd>/.pi/pi-desk.yaml`。`cwd` 必须是已存在的绝对普通目录，不读取进程工作目录、不搜索父目录。调用方负责确认项目信任；没有可信项目上下文时不传 `cwd`。
- 各持久层先按 `decryptPaths` 解密再合并；未指定路径上的密文原样参与覆盖。默认值不自动解密，读取不回写，不修改输入。文件缺失视为空层；YAML、权限或解密错误明确失败，不回退旧格式。
- 密文内联，系统仅托管主密钥；项目加解密始终使用全局 AgentDir 配置目录的密钥身份。路径数组参数旧调用不再支持。

`/config` 提供宿主装配和文件级工具，`getProjectConfigPath(cwd)` 返回固定项目文件位置，`readConfigSection()` 保持全局同步读取合同，不作为第五个插件方法。`/config` 的旧文件级工具与 `/secrets` 的旧凭据接口作为历史工具兼容 API 保留；Pi Desk 自有新版功能不消费旧配置。旧文件不迁移、不删除、不回退读取；原生 Pi 配置位置和格式保持不变，Markdown Agent 定义与 Skills 等资源仍独立。共享 YAML 继续使用跨进程锁、原子写入、Owner 校验、8 MiB 容量限制及符号链接边界。

宿主统一备份全局和既有项目的 `pi-desk.yaml`，动态识别 `enc:v1:` 内联密文，并在恢复时用目标 AgentDir 的主密钥重新加密。插件不重复声明共享文件归属，仍可通过 `piDesk.environment.files` 声明自有 data 与配套资源。完整调用与路径合同见[插件指南](../../docs/plugins.md#配置与凭据node)。

SDK 的运行依赖为 Zod（协议 Schema）、`yaml`（统一配置）、`proper-lockfile`（Node 跨进程锁）和 `@napi-rs/keyring`（Node 系统持久密钥存储）。协议与 Browser 子入口不加载这些 Node 配置或凭据能力，非 React 使用不要求安装公共 UI 库。

本包自有代码使用 Apache-2.0，见 [LICENSE](./LICENSE)。第三方代码继续遵循其原有许可，构建时保留上游法律注释。
