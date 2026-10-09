## 让 AI 帮你安装

把下面这句话发给能操作电脑的 AI：

> 请按 https://pidesk.dev/docs/installation/ 帮我安装并启动 Pi Desk。

## 下载客户端

<!-- client-downloads -->

**Windows 版**：先安装 [Node.js](https://nodejs.org/zh-cn/download)（22.19.0 或更新版本）和 [Git for Windows](https://git-scm.com/download/win)。安装客户端后打开控制中心，点击“启动”，再打开本机网址。首次提示安装 Pi 时，点击“安装”。中国用户可在“安装选项 → 下载源”选择“国内镜像”，加速下载所需组件。

**Android 版**：填写电脑上已启动的 Pi Desk 访问地址。手机只负责访问，不运行服务；连接方法见[远程访问](/docs/devices/)。

## 通过 Docker 启动

在 Linux amd64 主机上，可使用 `ghcr.io/jetcrab/pi-desk` 正式镜像运行 Pi Desk 服务，无需在宿主机安装 Node.js 或 Pi。首次部署前请确认 GHCR 中已有正式版本标签。

完整的 Compose 配置、数据目录、访问方式和升级备份步骤见 [Docker 部署与使用](/docs/docker/)。

## 通过 Node.js 安装

1. 从 [Node.js 官网](https://nodejs.org/zh-cn/download)安装 22.19.0 或更新版本。Windows 还需安装 [Git for Windows](https://git-scm.com/download/win)。
2. 打开终端（Windows 使用 PowerShell），逐行执行：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.1 --registry=https://registry.npmjs.org
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.1 --registry=https://mirrors.cloud.tencent.com/npm # 中国用户可改用这个加速下载
npm install -g @jetcrab/pi-desk --registry=https://registry.npmjs.org
npm install -g @jetcrab/pi-desk --registry=https://mirrors.cloud.tencent.com/npm # 中国用户可改用这个加速下载
pi-desk
```

3. 浏览器打开 [http://127.0.0.1:6233/](http://127.0.0.1:6233/)。使用期间保持终端开启；停止时按 `Ctrl+C`。

第一条命令安装 Pi，第二条安装 Pi Desk；**只安装 Pi Desk 不会自动安装 Pi**。已有可用的全局 Pi（1.0.1 或更新的兼容版本）时可跳过第一条命令。Pi 必须安装在启动 Pi Desk 所用的 Node/npm 环境中。

安装后按[第一次对话](/docs/quickstart/)连接模型；遇到问题看[常见问题](/docs/faq/)。

## 使用 npx 启动

不想全局安装 Pi Desk 时，可以用 npx 运行。**仍需先安装可用的全局 Pi**，安装命令见[通过 Node.js 安装](#通过-nodejs-安装)。

```bash
npx --registry=https://registry.npmjs.org @jetcrab/pi-desk@latest
npx --registry=https://mirrors.cloud.tencent.com/npm @jetcrab/pi-desk@latest # 中国用户可改用这个加速下载
```

首次提示下载 Pi Desk 时确认即可；这不会替你安装 Pi。浏览器访问地址和停止方式与上面的命令行安装相同。

## 更新 Pi 和 Pi Desk

Docker 部署通过拉取新镜像更新 Pi 和 Pi Desk，见 [Docker 升级步骤](/docs/docker/#升级)；不使用下面的全局 npm 更新命令。

Pi、Pi Desk 和插件分别更新。更新前先结束正在运行的任务，停止 Pi Desk 服务；命令行方式按 `Ctrl+C`，桌面端在控制中心停止服务。

### 更新 Pi

本文通过 npm 安装的 Pi，以及桌面端安装的全局 Pi，可在同一个 Node/npm 环境中执行以下命令更新到最新正式版。

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest --registry=https://registry.npmjs.org
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@latest --registry=https://mirrors.cloud.tencent.com/npm # 中国用户可改用这个加速下载
pi --version
```

若 Pi Desk 的启动提示要求某个版本，可将 `@latest` 换成提示中的版本，例如 `@1.0.1`。通过 Pi 官方安装脚本或其他包管理器安装的 Pi，按 [Pi 官方说明](https://pi.dev/docs/latest/cli#update-pi-or-packages)更新。

更新完成后重新启动 Pi Desk；桌面端可先点击“重新检测”。插件更新或“重载 Pi 配置”不会升级 Pi 本体。

### 更新 Pi Desk

通过 npm 全局安装的 Pi Desk，执行以下任一命令，再运行 `pi-desk`：

```bash
npm install -g @jetcrab/pi-desk@latest --registry=https://registry.npmjs.org
npm install -g @jetcrab/pi-desk@latest --registry=https://mirrors.cloud.tencent.com/npm # 中国用户可改用这个加速下载
```

使用 npx 时，重新执行上面的带 `@latest` 的启动命令。桌面端托管的 Pi Desk 使用控制中心的更新入口。更新 Pi Desk 不会自动更新 Pi；插件更新见[更新与加载](/docs/plugins/#更新与加载)。
