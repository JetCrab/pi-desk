## 让 AI 帮你安装

把下面这句话发给能操作电脑的 AI：

> 请按 https://pidesk.dev/docs/installation/ 帮我安装并启动 Pi Desk。

## 下载客户端

<!-- client-downloads -->

**Windows 版**：先安装 [Node.js](https://nodejs.org/zh-cn/download)（22.19.0 或更新版本）和 [Git for Windows](https://git-scm.com/download/win)。安装客户端后打开控制中心，点击“启动”，再打开本机网址。首次提示安装 Pi 时，点击“安装”。

**Android 版**：填写电脑上已启动的 Pi Desk 访问地址。手机只负责访问，不运行服务；连接方法见[远程访问](/docs/devices/)。

## 通过 Node.js 安装

1. 从 [Node.js 官网](https://nodejs.org/zh-cn/download)安装 22.19.0 或更新版本。Windows 还需安装 [Git for Windows](https://git-scm.com/download/win)。
2. 打开终端（Windows 使用 PowerShell），逐行执行：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.1 --registry=https://registry.npmjs.org
npm install -g @jetcrab/pi-desk --registry=https://registry.npmjs.org
pi-desk
```

3. 浏览器打开 [http://127.0.0.1:6233/](http://127.0.0.1:6233/)。使用期间保持终端开启；停止时按 `Ctrl+C`。

已有可用的全局 Pi 时可跳过第一条命令。安装后按[第一次对话](/docs/quickstart/)连接模型；遇到问题看[常见问题](/docs/faq/)。
