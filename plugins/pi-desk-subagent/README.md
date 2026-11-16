# Pi Desk — pi-desk-subagent

包名：`@jetcrab/pi-desk-subagent`。插件接口以源码导出为准，个人配置不随包分发。

官方说明：[使用说明](https://pidesk.dev/docs/subagents/)

配置通过绑定的 `plugin.config` 读取：全局为 `<AgentDir>/config/pi-desk.yaml`，可信项目为当前会话 `<cwd>/.pi/pi-desk.yaml`，均使用 `plugins.subagent` 分组。对象逐字段递归覆盖，数组整体替换；未信任项目只用全局配置，不读取旧 `.pi/config/pi-desk-subagent.json`，也不向父目录查找配置。

```yaml
plugins:
  subagent:
    agents:
      dev:
        model: example-provider/example-model
        thinking: high
```

设置页只编辑全局层。项目只填写需要覆盖的字段，不复制默认或继承值。Agent Markdown 仍是独立资源：包内置、`<AgentDir>/agents/`、可信项目发现的 `.pi/agents/` 按同名覆盖；资源目录发现不决定 YAML 配置来源。

许可与第三方来源见本目录的 LICENSE 及适用的归属说明。
