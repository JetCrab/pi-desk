# Pi Desk Desktop

Tauri 桌面客户端，共用 React 前端、服务安装/更新、网页窗口和隧道能力。

- Windows：保留现有 32 位构建入口，使用 `pnpm check` 检查 Rust。首次准备与 macOS 共用精简界面，按 Node.js、Git Bash、Pi、Pi Desk 展示实际状态；仅在用户开始安装缺少组件时由官方安装器按需请求管理员确认，不要求整个应用以管理员身份运行。正常授权及安装等待不显示失败；取消准备时等待已启动的系统安装事务结束，再停止后续步骤。手动路径、MSI 和下载设置收在“安装选项”。
- macOS 11+：在 macOS 使用 `pnpm build:mac` 构建 Apple Silicon + Intel 通用应用；云构建须安装两个 Rust target，并为前端及 Rust 产物指定独立临时目录。图标可由现有 `src-tauri/icons/icon.png` 生成。
- macOS 自动准备从 Node.js 官方下载 22.22.2 对应架构归档并核对 SHA256，Node 和 npm 全局包使用应用自有目录，不修改系统 PATH。也可选择已有 Node.js 安装目录或其 `bin` 目录。Git 使用已有安装；缺少 Command Line Tools 时，仅在用户开始准备后请求系统安装，等待期间保持准备状态，检测完成后自动继续，无需重新安装或手动重检。取消准备只停止等待，不关闭 macOS 安装器。不预先申请目录、照片或其他与安装无关的隐私权限。

本机服务优先复用应用环境中可执行且版本兼容的 Node.js/npm，不要求固定安装目录。缺少环境时可点击“安装并打开”下载准备，或在“安装选项”中选择已有 Node.js 安装目录（目录内含 `node` / `node.exe` 或 `bin/` 下的同名程序）。仅访问远程地址不需要 Node.js。桌面应用与终端可能继承不同的 PATH；检测失败不代表机器没有安装 Node.js。

安装依赖后使用 `pnpm typecheck:web` 检查前端。原生安装包及交互须在对应平台单独构建验证；当前 macOS 配置采用 ad-hoc 签名，无 Developer ID、无公证，非 App Store 分发。

## macOS 离线安装器

`pnpm build:mac` 先构建通用主应用，再构建 Swift/AppKit 安装器。最终 DMG 位于 `temp/build/desktop-rust/local/universal-apple-darwin/release/bundle/installer-macos/run-*/`（相对仓库根目录；设置 `CARGO_TARGET_DIR` 时跟随该目录）。打开 DMG 后双击 `Pi Desk Installer.app` 安装，不再拖拽主应用。安装器内置同版本桌面程序；Node.js、Pi 和服务包仍由安装后的控制中心准备。

默认安装到可写的 `/Applications`，已有当前用户安装时复用 `~/Applications`，系统目录不可写时默认使用当前用户目录；也可更换安装位置。不包含提权助手，无写入权限时请改选可写目录。支持真实复制进度、提交前取消、同版本重装和覆盖升级。替换前请求 Pi Desk 正常退出，最多等待 60 秒，不强杀进程；可能中断桌面托管的服务与任务，但不删除配置、包和会话数据。提交失败时尝试恢复旧版，恢复失败时保留并显示备份位置，不承诺断电或强制杀进程后的自动恢复。

没有开发者账号也能构建和分发。下载后的安装器及主应用都可能被 macOS 拦截；先尝试打开，再在“系统设置 → 隐私与安全性”中选择“仍要打开”。具体提示受系统版本和设备策略影响。安装器保留下载隔离标记，不关闭安全检查。可沿用 `APPLE_SIGNING_IDENTITY` 使用 Developer ID 签名，但签名不等于 Apple 公证。

`pnpm test:installer:mac` 使用临时目录和测试身份验证安装事务、原生明暗界面及内置测试应用的通用 DMG 组装，不操作真实安装、配置或会话；不替代真实主程序及旧版 macOS 的发布验收。
