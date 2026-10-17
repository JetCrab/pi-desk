---
name: workspace-config-authoring
description: 为新项目创建或修改隔离空间配置时使用；仅使用已有空间时禁止加载。
---

# 配置隔离工作区

先确认项目的仓库边界、依赖准备方式、运行与测试所需端口，以及工作区复用和清理条件。按项目结构选择源码隔离方式，不要求不同项目使用相同的 Git 布局。

将能力组织为首次准备的 `provision` 和面向使用者的 `commands`；每个命令的描述和参数应说明何时执行、会做什么。项目细节由 `.pi/workspace/` 下的 Handler 实现，不加入通用使用说明。

实现前阅读 [配置与 Handler 约束](references/schema.md) 和 [完整样例](assets/workspace.example.yml)。完成后验证实际命令，并提醒用户执行 `/reload`。
