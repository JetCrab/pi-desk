# Pi Desk Desktop

Tauri 桌面客户端，共用 React 前端、服务安装/更新、网页窗口和隧道能力。

- Windows：保留现有 32 位构建入口，使用 `pnpm check` 检查 Rust。
- macOS 11+：在 macOS 使用 `pnpm build:mac` 构建 Apple Silicon + Intel 通用应用；云构建须安装两个 Rust target，并为前端及 Rust 产物指定独立临时目录。图标可由现有 `src-tauri/icons/icon.png` 生成。
- macOS 自动准备从 Node.js 官方下载 22.22.2 对应架构归档并核对 SHA256，Node 和 npm 全局包使用应用自有目录，不修改系统 PATH。也可选择已有 Node.js 安装目录或其 `bin` 目录。Git 使用已有安装；缺少 Command Line Tools 时请求系统安装，须完成系统对话框后重新检测。

本机服务优先复用应用环境中可执行且版本兼容的 Node.js/npm，不要求固定安装目录。缺少环境时可点击“安装并打开”下载准备，或直接选择已有 Node.js 安装目录（目录内含 `node` / `node.exe` 或 `bin/` 下的同名程序）。仅访问远程地址不需要 Node.js。桌面应用与终端可能继承不同的 PATH；检测失败不代表机器没有安装 Node.js。

安装依赖后使用 `pnpm typecheck:web` 检查前端。原生安装包及交互须在对应平台单独构建验证；当前 macOS 配置采用 ad-hoc 签名，无 Developer ID、无公证，非 App Store 分发。
