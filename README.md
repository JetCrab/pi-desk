# Pi Desk

**English** | [简体中文](./README.zh-CN.md)

> Pi Desk stays simple and lightweight. Models evolve rapidly and keep getting more capable. I believe a single, more capable model will directly handle an increasing share of complex work. Agents should minimize extra context and guiding prompts, retaining only essential project rules; subagents stay lightweight and are used on demand, without elaborate team orchestration.

A client for the Pi coding agent — in your browser, on your desktop, and on your phone.

[Website](https://pidesk.dev) · [Documentation](https://pidesk.dev/docs/) · [Upstream Pi](https://github.com/earendil-works/pi)

Pi Desk is a visual, single-user client for [Pi](https://github.com/earendil-works/pi). Keep multiple conversations in view, inspect project files and Git changes, and continue working from another device connected to the same Pi Desk service.

Pi powers the agent. Pi Desk provides the interface, with a lightweight core and plugins for the capabilities you need.

## Highlights

- **Sessions side by side.** Pin sessions to compare messages and results without constantly switching views.
- **Files and Git at hand.** Preview project files, inspect changes, and browse commit history alongside your conversations.
- **Work across devices.** Use a browser or connect a desktop or mobile client to the same service to check progress and continue a conversation.
- **Tasks and results in view.** Follow background commands and subagents in the task center, and preview deliverables with the corresponding plugins.
- **Extend it your way.** Add tools, panels, applications, and custom message views through Pi Desk plugins and the public SDK.

## Interface demo

<p>
  <a href="./docs/images/client-overview.webp">
    <img src="./docs/images/client-overview.webp" alt="File preview" width="300" />
  </a>
  <a href="./docs/images/multi-window.webp">
    <img src="./docs/images/multi-window.webp" alt="Side-by-side conversations" width="300" />
  </a>
</p>

Visit [pidesk.dev](https://pidesk.dev) for product demos and [the documentation](https://pidesk.dev/docs/) for usage guides.

## Getting started

### Requirements

- Node.js **22.19.0 or newer**.
- npm (included with Node.js).
- A compatible global installation of Pi.

If you do not already have a compatible Pi installation:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
npm install -g --ignore-scripts @earendil-works/pi-coding-agent --registry=https://mirrors.cloud.tencent.com/npm # Users in China can use this for faster downloads
```

Configure your model provider and account in Pi before starting a conversation. See [Pi's setup instructions](https://pi.dev/docs/latest). You can open the client without a configured model, but model conversations require one.

### Run with npm

Run directly with npx:

```bash
npx @jetcrab/pi-desk
npx --registry=https://mirrors.cloud.tencent.com/npm @jetcrab/pi-desk # Users in China can use this for faster downloads
```

Or install globally for repeated use:

```bash
npm install -g @jetcrab/pi-desk
npm install -g @jetcrab/pi-desk --registry=https://mirrors.cloud.tencent.com/npm # Users in China can use this for faster downloads
pi-desk
```

Open **<http://localhost:6233>**.

## Applications

The web service runs Pi sessions. Browser, desktop, and mobile clients connect to the same service.

| Application          | Source                              | Purpose                           |
| -------------------- | ----------------------------------- | --------------------------------- |
| Web service          | [`src/`](./src) and [`bin/`](./bin) | Browser client and Pi integration |
| Windows              | [`apps/desktop/`](./apps/desktop)   | Tauri desktop shell               |
| macOS (experimental) | [`apps/desktop/`](./apps/desktop)   | Tauri desktop shell               |
| Android              | [`apps/android/`](./apps/android)   | Native Android client for Pi Desk |
| iOS (experimental)   | [`apps/ios/`](./apps/ios)           | SwiftUI / WKWebView client        |
| Tunnel               | [`apps/tunnel/`](./apps/tunnel)     | Rust TCP tunnel server and client |

> macOS and iOS clients are experimental and are not included in stable releases. The author does not own a Mac or an iOS device, so these clients have not been tested on real hardware and may not work.

## Plugins and SDK

The repository contains a public SDK and nine plugin projects. Plugins are separate packages, so you can choose the capabilities you need rather than adding everything to the core.

| Package                                                             | Purpose                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------- |
| **[@jetcrab/pi-desk-sdk](./plugins/pi-desk-sdk)**                   | Host interfaces, plugin declarations, and Browser Host Runtime |
| **[@jetcrab/pi-desk-bg-run](./plugins/pi-desk-bg-run)**             | Background commands, logs, and task-center integration         |
| **[@jetcrab/pi-desk-subagent](./plugins/pi-desk-subagent)**         | Subagent execution and task-center integration                 |
| **[@jetcrab/pi-desk-deliverables](./plugins/pi-desk-deliverables)** | Deliverable previews                                           |
| **[@jetcrab/pi-desk-usage](./plugins/pi-desk-usage)**               | Model usage and cost analysis                                  |
| **[@jetcrab/pi-desk-ctx](./plugins/pi-desk-ctx)**                   | Context management and historical tool-result lookup           |
| **[@jetcrab/pi-desk-quota-viewer](./plugins/pi-desk-quota-viewer)** | Model-provider quota viewer                                    |
| **[@jetcrab/pi-desk-tibo-monitor](./plugins/pi-desk-tibo-monitor)** | Tibo updates and notifications                                 |
| **[@jetcrab/pi-desk-tool-reason](./plugins/pi-desk-tool-reason)**   | Reasons for tool calls                                         |
| **[@jetcrab/pi-desk-remote-debug](./plugins/pi-desk-remote-debug)** | Remote debugging for development pages                         |

See the [plugin overview](./plugins/README.md) for more about the plugins and SDK. Public npm packages use the `@jetcrab/` namespace and the npmjs registry.

## Access and permissions

Pi Desk is a **single-user tool** with filesystem, command, and plugin execution capabilities. It does not provide multi-tenant execution isolation.

On first startup, if sign-in protection is not configured, anyone who can reach the service can access Pi Desk. Set a password in **Settings → Sign-in protection** before exposing it to other people, and use HTTPS for public access.

Authentication data is stored in your own Pi Agent directory, not in the source repository.

## Run from source

Install pnpm, then run:

```bash
git clone https://github.com/JetCrab/pi-desk.git
cd pi-desk
pnpm install --frozen-lockfile --registry=https://registry.npmjs.org
pnpm install --frozen-lockfile --registry=https://mirrors.cloud.tencent.com/npm # Users in China can use this for faster downloads
pnpm dev
```

Open <http://localhost:6233>. The first page load may take longer while the application compiles.

## Acknowledgments

Pi Desk is built on [Pi](https://github.com/earendil-works/pi), the extensible coding-agent harness by earendil-works. Thanks to the Pi maintainers and contributors for the agent runtime and libraries that make this client possible.

## License

Pi Desk's own code is licensed under [Apache-2.0](./LICENSE). Third-party code retains its original licenses, copyright notices, and source attributions.
