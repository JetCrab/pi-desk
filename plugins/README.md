# Pi Desk 公开插件

每个目录是独立 npm 包，包名前缀为 `@jetcrab/`。新增插件或调整开源范围须先确认，个人配置不属于插件源码。

| 目录                   | 用途                                      |
| ---------------------- | ----------------------------------------- |
| `pi-desk-sdk`          | 宿主协议、插件声明和 Browser Host Runtime |
| `pi-desk-bg-run`       | 后台命令、日志与任务中心                  |
| `pi-desk-subagent`     | 子代理执行与任务中心                      |
| `pi-desk-deliverables` | 交付物预览                                |
| `pi-desk-usage`        | 模型用量与费用分析                        |
| `pi-desk-ctx`          | 上下文管理与历史回查                      |
| `pi-desk-quota-viewer` | 模型服务额度查看                          |
| `pi-desk-tibo-monitor` | Tibo 动态与通知                           |
| `pi-desk-tool-reason`  | 工具调用理由                              |
| `pi-desk-remote-debug` | 开发页面远程调试                          |

## 开发

从仓库根目录安装依赖，先构建 SDK，再构建需要修改的插件：

```bash
pnpm build:plugin-host-runtime
pnpm --filter @jetcrab/pi-desk-usage build
pnpm --filter @jetcrab/pi-desk-usage test
```

插件的开发依赖归属于各自 manifest。Pi 核心通过 peerDependencies 由宿主提供，不打包第二份运行时。界面开发所需的详细规范由维护者提供，公开接口以 SDK 类型声明为准。

## 授权与发布

自有代码使用 Apache-2.0；带有上游来源的包保留原有许可证和归属说明，不覆盖 MIT、ISC 或 Apache-2.0 第三方授权。

构建、直接相关测试和 `pnpm pack` 内容验证通过后，列出待发布包、版本及 Registry，经明确确认才能发布。公开源码中的包名不代表对应 npm 版本已经存在；自动发布将在后续单独接入。
