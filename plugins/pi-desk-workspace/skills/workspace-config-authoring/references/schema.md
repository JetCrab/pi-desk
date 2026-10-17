# Workspace v3 schema

配置文件固定为 `<project>/.pi/workspace.yml`：

```yaml
schema: pi.workspace/v3
definitions: {}
```

Definition ID、command ID 和参数名使用 kebab-case。每个 definition 固定包含：

```yaml
description: 非空说明
provision: {}
commands: {}
```

## Node Handler

provision：

```yaml
provision:
  description: 首次初始化说明
  parameters:
    type: object
    additionalProperties: false
    properties: {}
  handler: .pi/workspace/provision.mjs
  timeoutSeconds: 3600
```

command：

```yaml
commands:
  reset:
    description: 恢复可复用基线
    from: [occupied]
    onSuccess: available
    parameters:
      type: object
      additionalProperties: false
      properties: {}
    handler: .pi/workspace/commands/reset.mjs
    timeoutSeconds: 900
```

- Handler 必须使用 `/` 分隔、位于 `.pi/workspace/`、以 `.mjs` 结尾，不能使用绝对路径、反斜杠或 `..`。
- `from` 是非空数组，仅支持 `available`、`occupied`。
- `onSuccess` 仅支持 `available`、`occupied`、`removed`。
- timeoutSeconds 是可选正整数。
- 每个 Handler 是一次独立 Node 子进程；内部步骤由 Handler 自己编排。

## 参数

参数固定结构：

```yaml
parameters:
  type: object
  additionalProperties: false
  properties:
    scope:
      type: string
      required: false
      description: 执行范围
      default: related
      enum: [related, full]
```

类型支持 `string`、`boolean`、`integer`、`number`、`array`。每项必须显式包含 `required: true|false`，可包含 description、default、enum、array items。array items 只允许 type、description、enum 和递归 items。

provision 参数属于物理工作区兼容身份。插件只复用相同 projectRoot、definition 和 provisionParameters 的 available 工作区。

## Handler API

Handler 默认导出：

```js
export default async function run(input, context) {
  await context.exec('pnpm', ['test'])
  return { success: true, summary: '测试完成' }
}
```

input：

```text
schema、command、project.root、workspace、occupation、parameters
```

workspace 包含 id、root、definition、provisionParameters；occupation 包含 id、requirement、occupiedAt。

context：

```text
signal
log(message)
exec(program, args, { cwd? })
```

context.exec 按程序与独立参数调用，非零退出码默认抛错。Windows 的 `.cmd`、`.bat` 通过 `cmd.exe` 适配，不应依赖 POSIX shell 的管道或变量展开；外部程序仍需安装在本机。

Handler 返回：

```js
{ success: true, summary?: string }
{ success: false, error: string }
```

插件仅在 Runner 退出码为 0、结果 Schema 合法、success=true 且工作区 Root 后置校验通过后应用 onSuccess。失败时状态不变。

## 状态

持久状态只有：

```text
available：初始化完整、无 occupation、可直接分配
occupied：属于当前 occupation，不进入复用池
```

命令历史保存在当前 occupation.operations。成功进入 available 时清除 occupation。项目命令默认在工作区 Root 执行；除 remove 外，清理类 Handler 必须保留 `.pi-workspace/` 目录；Handler 禁止修改 `.pi-workspace/workspace.json`。
