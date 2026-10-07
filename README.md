# Pi Desk

面向单用户的 Pi 编程代理 Web 工作台，提供会话、文件与 Git 预览、任务中心和插件扩展，可配合 Windows 桌面壳或 Android 网页客户端使用。

源码仓库：<https://github.com/JetCrab/pi-desk>。自有代码采用 [Apache-2.0](./LICENSE)，第三方代码保留各自授权和来源说明。

## 从源码运行

需要 Node.js 22.19.0 或以上、pnpm 10.15.0，以及兼容的全局 Pi。当前开发依赖基线为 Pi 1.0.1。

```bash
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
# 已安装兼容 Pi 时跳过安装，不替换现有环境。
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.1
node bin/pi-global-runtime.js --check
pnpm dev
```

访问 <http://localhost:6233>，健康检查为 `/api/health`。首次启动需要编译页面，耗时取决于开发环境和缓存。`pnpm dev` 会先构建 SDK Browser Host Runtime。

模型和账号由使用者自行配置，仓库不包含维护者凭据。无需外层私人目录或私人 Registry；没有可用模型时可以进入工作台，但不能完成模型对话。

## 目录

```text
bin/                  命令入口，按功能命名
src/                  Web 主程序，按 client/server/common 分层
apps/desktop/         Tauri Windows 桌面壳
apps/android/         原生 Android 网页客户端
apps/tunnel/          Rust TCP 隧道服务与客户端
plugins/              公开插件与 pi-desk-sdk
```

插件列表和源码边界见 [plugins/README.md](./plugins/README.md)。各应用有自己的构建说明；macOS 仍需平台适配，iOS 尚无可用工程，不将 Tauri 的跨平台能力等同于本项目已经支持这些平台。

## 登录与运行边界

首次启动未配置登录保护时，任何能访问服务的人都能进入工作台。可在“设置 → 登录保护”启用账号密码，通过公网访问时使用 HTTPS。

这是具有文件、命令和插件执行能力的单用户工具，不提供多租户执行隔离。认证数据保存在使用者自己的 Pi Agent 目录，不属于源码。

## 命令入口

`bin/pi-desk.js` 是服务启动命令，`bin/pi-global-runtime.js --check` 检查 Pi 环境，`bin/pi-desk-preflight.js` 对已构建的安装包进行隔离启动预检；实现位于 `src/server/`，不从调用者目录解析包根。

桌面端和服务包需配套升级：当前桌面源码优先使用新的 Pi 检查入口，并兼容旧包的 `l4-pi-global-runtime.js`；固定调用旧文件名的桌面版本需要升级后再使用本版服务包。

## 检查

```bash
pnpm build:plugin-host-runtime
pnpm typecheck
pnpm typecheck:tests
pnpm lint
pnpm check:layers
pnpm format:check
pnpm test:package
node --test tests/l4-public-boundary.test.mjs
```

开发约束见 [AGENTS.md](./AGENTS.md)，当前公开接口以源码中的 Schema 和 SDK 类型声明为准。

## 发布状态

公开包名使用 `@jetcrab/`，目标 Registry 为 npmjs；安装包计划由 GitHub Releases 分发，隧道镜像计划由 GHCR 分发。目录和包名迁移不代表这些制品已经发布，当前使用上面的源码入口。

`.github/workflows/` 提供手动触发的 npm、隧道镜像和 Windows／Android 构建发布流程，默认只构建验证；正式发布须显式选择并配置对应授权。首次推送后仍需完成云端与制品验收，不把工作流文件存在当作已经发布。
