# Pi Desk Desktop

Tauri 桌面客户端，共用 React 前端、服务安装/更新、网页窗口和隧道能力。

- Windows：保留现有 32 位构建入口，使用 `pnpm check` 检查 Rust。
- macOS 11+：在 macOS 使用 `pnpm build:mac` 构建 Apple Silicon + Intel 通用应用；云构建须安装两个 Rust target，并为前端及 Rust 产物指定独立临时目录。图标可由现有 `src-tauri/icons/icon.png` 生成。
- macOS 自动准备从 Node.js 官方下载 22.22.2 对应架构归档并核对 SHA256，Node 和 npm 全局包使用应用自有目录，不修改系统 PATH。也可选择已有环境目录。Git 使用已有安装；缺少 Command Line Tools 时请求系统安装，须完成系统对话框后重新检测。

安装依赖后使用 `pnpm typecheck:web` 检查前端。原生安装包及交互须在对应平台单独构建验证；当前 macOS 配置采用 ad-hoc 签名，无 Developer ID、无公证，非 App Store 分发。
