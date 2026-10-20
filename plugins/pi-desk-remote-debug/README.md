# Pi Desk — pi-desk-remote-debug

包名：`@jetcrab/pi-desk-remote-debug`。插件接口以源码导出为准，个人配置不随包分发。

官方说明：[使用说明](https://pidesk.dev/docs/remote-debug/)

公网调试需要由同机 Pi Desk 桌面端托管服务，并在桌面端配置隧道连接。插件不附带或自动下载独立隧道程序；未由桌面端托管时，公网调试不可用。

启动或重启时，若本机端口已被占用，会列出端口、进程名和 PID，询问是否强制结束并继续启动；取消不影响原服务。确认后重新核对占用者，变化时需再次确认。无法识别占用者、系统或 Pi Desk 自身占用时不提供强杀；其他活动调试任务及公网端口冲突仍需手动处理。macOS/Linux 的进程查询需要系统提供 `lsof`。

许可与来源见本目录的 LICENSE 和 SOURCE.md。
