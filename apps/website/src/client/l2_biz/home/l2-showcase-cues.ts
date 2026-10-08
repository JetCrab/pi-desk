import type { ShowcaseChapterId } from './l2-showcase-story'

type ShowcaseCue = {
  label?: string
  fallback?: string
  text?: string
  prefix?: string
  selector?: string
  guide?: string
  description?: string
  waiting?: boolean
  terminal?: 'mobile'
}
const targets: Partial<Record<ShowcaseChapterId, readonly (ShowcaseCue | null)[]>> = {
  pin: [
    {
      label: '固定工作会话 整理使用文档',
      guide: '固定文档',
      description: '点击图钉，文档会话会在右侧并排显示。'
    },
    {
      label: '固定工作会话 移动端验收',
      guide: '把验收也放在旁边',
      description: '再固定一个会话，开发、文档和验收一起看。'
    },
    {
      label: '选择会话 发布前检查',
      guide: '换一个主任务',
      description: '只切换主窗口，固定的对照内容仍然留在旁边。'
    },
    {
      label: '发送消息',
      guide: '对照结果，继续对话',
      description: '参考文档和验收结果，发送发布检查的要求。'
    },
    {
      selector: '[data-guide-target="pin-working"]',
      guide: '正在整理发布清单',
      description: '助手正在处理刚刚发出的要求。',
      waiting: true
    },
    {
      selector: '[data-demo-focus="docs"] > header',
      fallback: '展开固定会话 整理使用文档',
      guide: '文档仍在旁边',
      description: '不用切走主任务，就能对照已完成的使用说明。'
    },
    {
      selector: '[data-demo-focus="qa"] > header',
      fallback: '展开固定会话 移动端验收',
      guide: '再看验收结果',
      description: '空间不足时展开这一列；手机可左右滑动查看。'
    },
    {
      label: '取消固定工作会话 移动端验收',
      guide: '收起验收窗口',
      description: '取消固定只收起这一列，聊天仍保留在列表里。'
    },
    {
      label: '取消固定工作会话 整理使用文档',
      guide: '收起文档窗口',
      description: '剩下的会话窗口会自动获得更多空间。'
    },
    {
      label: '选择会话 开发导出功能',
      guide: '回到原来的任务',
      description: '打开开发会话，之前的聊天和处理结果都还在。'
    },
    null
  ],
  sync: [
    {
      label: '发送消息',
      guide: '电脑上开始',
      description: '在电脑发送要求；未发送的草稿不会同步到另一端。'
    },
    {
      selector: '[data-guide-target="sync-working"]',
      terminal: 'mobile',
      guide: '手机已收到',
      description: '电脑发送后，手机显示同一条消息。助手正在处理要求。',
      waiting: true
    },
    {
      selector: '[data-guide-target="sync-reply"]',
      waiting: true,
      terminal: 'mobile',
      guide: '两端看到同一结果',
      description: '回复也会同步，不用重新复制聊天记录。'
    },
    {
      label: '发送消息',
      terminal: 'mobile',
      guide: '在手机继续',
      description: '手机可以接着原来的会话追加要求；草稿仍只属于本设备。'
    },
    {
      selector: '[data-guide-target="sync-working"]',
      guide: '电脑也收到追加要求',
      description: '手机发出的消息回到电脑，助手沿用之前的上下文继续处理。',
      waiting: true
    },
    {
      selector: '[data-guide-target="sync-followup"]',
      waiting: true,
      guide: '继续完成这项任务',
      description: '两端共享消息与结果，各自的焦点、滚动和发送前草稿独立。'
    }
  ],
  files: [
    {
      label: '打开文件 README.md',
      guide: '打开项目文件',
      description: '从真实项目目录选择文件，直接在当前界面查看源码。'
    },
    {
      label: '打开文件 preview.html',
      fallback: '打开项目文件列表',
      guide: '查看页面效果',
      description: 'HTML 可以在预览与源码之间切换，不必离开当前会话。'
    },
    {
      label: '打开文件 export.ts',
      fallback: '打开项目文件列表',
      guide: '看清这次改了什么',
      description: '打开标记 M 的导出文件，对照修改前后的代码。'
    },
    {
      label: '项目预览',
      fallback: '打开项目文件列表',
      guide: '打开整个项目预览',
      description: '侧栏右上角打开独立只读弹窗，目录、代码和 Git 记录放在一起。'
    },
    {
      label: '查看 Git 记录',
      guide: '查看提交历史',
      description: '在项目预览里展开 Git 记录，不切换当前会话。'
    },
    {
      label: '查看提交 增加 CSV 导出',
      guide: '选择一条提交',
      description: '查看提交说明和变更文件，历史差异按固定提交读取。'
    },
    {
      label: '关闭项目预览',
      guide: '回到当前会话',
      description: '关闭只读预览，聊天、当前工作区和 Git 分支都保持不变。'
    },
    {
      label: '打开仓库 Git 分支',
      fallback: '打开项目文件列表',
      guide: '需要时再切换仓库分支',
      description: '文件目录项目栏或输入框的 Git 入口打开仓库分支弹窗；它与聊天分支不是一回事。'
    },
    {
      label: '选择 Git 分支 feature/export',
      guide: '选择目标 Git 分支',
      description: '先选中分支，再确认切换。不会因为浏览提交历史就改变分支。'
    },
    {
      text: '切换 Git 分支',
      guide: '切换到目标分支',
      description: '当前任务空闲时切换；演示只展示已可保留工作区修改的情况。'
    },
    {
      selector: '[data-guide-target="composer-draft"]',
      guide: '继续当前会话',
      description: '仓库分支显示为 feature/export，聊天记录没有被回滚。',
      waiting: true
    }
  ],
  'create-plugin': [
    {
      label: '发送消息',
      guide: '把使用习惯说出来',
      description: '用交付清单作为示例，要求独立应用、设置、输入辅助与聊天结果。'
    },
    {
      selector: '[data-guide-target="plugin-working"]',
      guide: '正在生成并构建',
      description: '助手制作示例插件代码；这里快进展示过程，不调用真实模型。',
      waiting: true
    },
    {
      selector: '[data-guide-target="plugin-install"]',
      guide: '助手直接安装并加载',
      description: '通过 pidesk 命令安装插件并加载界面，完成通知到达后继续。',
      waiting: true
    },
    {
      selector: '[data-guide-target="plugin-reload"]',
      guide: '当前会话也由命令重载',
      description: 'pidesk session reload 会在空闲后生效，保留聊天和当前分支。',
      waiting: true
    },
    {
      label: '打开应用 交付清单',
      guide: '出现自己的应用入口',
      description: '已注册的独立应用从侧栏底部打开，沿用宿主弹窗。'
    },
    {
      label: '关闭交付清单',
      guide: '有了自己的交付清单',
      description: '代码、文档和测试放在一起，少漏一项交付。'
    },
    {
      label: '打开设置',
      guide: '进入插件设置',
      description: '关闭应用后，从设置中的插件设置分组维护默认检查项。'
    },
    {
      text: '保存默认项',
      guide: '保存自己的默认项',
      description: '常用检查保存一次，下次直接沿用。'
    },
    {
      text: '本轮检查',
      guide: '只检查这一轮需要的',
      description: '从更多操作打开本轮检查，选择本次范围。'
    },
    {
      text: '开始检查',
      guide: '选择本轮范围',
      description: '在宿主面板弹窗选择检查项，再把结果带回当前聊天。'
    },
    {
      label: '展开交付检查结果',
      guide: '结果直接进入对话',
      description: '示例消息视图显示检查摘要，点击可展开证据。工具、界面和结果连成一个完整流程。'
    }
  ],
  install: [
    {
      label: '发送消息',
      guide: '按需要安装能力',
      description: '请求安装额度与用量插件，直接扩展 Pi Desk 的能力。'
    },
    {
      selector: '[data-guide-target="install-working"]',
      guide: '正在安装并加载',
      description: '软件包安装和外层界面加载完成后，入口才会出现。',
      waiting: true
    },
    {
      selector: '[aria-label="快捷入口"]',
      guide: '新插件入口已经加到这里',
      description: '安装完成后，左下角新增“额度”和“用量”。从这里打开各自的应用。',
      waiting: true
    },
    {
      text: '额度设置',
      guide: '先配置额度来源',
      description: '在宿主设置的插件设置分组中选择额度设置。'
    },
    {
      text: '保存全部更改',
      guide: '保存来源与认证',
      description: '额度插件需要支持的渠道和认证信息；这里使用不可用的示例值。'
    },
    {
      label: '打开应用 额度',
      guide: '随时查看剩余额度',
      description: '从这里打开账户额度，决定接下来用哪个渠道。'
    },
    {
      label: '查看示例账户额度详情',
      guide: '查看剩余额度',
      description: '实际界面按渠道列出账户和额度窗口，详情可展开完整数值与更新时间。'
    },
    {
      label: '关闭额度查看器',
      guide: '额度详情可回查',
      description: '查看数值与更新时间，关闭后继续原来的对话。'
    },
    {
      label: '打开应用 用量',
      guide: '打开模型用量',
      description: '用量读取已有 Pi 会话记录，并不是供应商实时账单。'
    },
    {
      selector: '[data-guide-target="usage-overview"]',
      waiting: true,
      guide: '总览与会话一起看',
      description: '看哪段会话、哪个模型用了多少，再决定如何调整。'
    },
    {
      selector: '[data-guide-target="usage-agents"]',
      waiting: true,
      guide: '展开主代理与子代理',
      description: '会话卡片可展开各代理用量；关闭后仍回到原来的聊天。'
    },
    {
      text: '会话分析',
      guide: '分析当前这段会话',
      description: '更多操作中的会话分析属于输入辅助，使用宿主面板弹窗。'
    },
    {
      text: '代理',
      guide: '查看当前会话的细节',
      description: '切换趋势、代理与事件，检查使用量、上下文和可观测活动。'
    }
  ],
  context: [
    {
      label: '查看上下文占用',
      guide: '长任务，给下一轮留空间',
      description: '旧工具输出越积越多，先看看还有多少可用空间。'
    },
    {
      label: '立即忽略 76K 示例上下文',
      guide: '旧过程不必每轮都带上',
      description: '手动忽略早期大段过程，保留你的要求和已写出的结论。'
    },
    {
      selector: '[data-guide-target="context-current"]',
      waiting: true,
      guide: '预计腾出 76K 空间',
      description: '这次示例从 74% 降至预计 36%，后续对话有更多余量。'
    },
    {
      label: '发送消息',
      guide: '不用重讲一遍任务',
      description: '直接追加日期筛选；旧工具记录仍在聊天里，随时可展开。'
    },
    {
      selector: '[data-guide-target="context-next"]',
      guide: '沿用原来的要求继续',
      description: '仍包含已完成任务，也保留项目文件名；细节需要时回查历史。',
      waiting: true
    }
  ],
  branches: [
    {
      label: '更多操作',
      guide: '打开会话操作',
      description: '会话分支从输入框的更多操作进入，不是 Git 分支入口。'
    },
    {
      text: '会话分支',
      guide: '查看当前会话的分支树',
      description: '在聊天列内打开选择器，上方看详情，下方选择历史节点。'
    },
    {
      label: '切换到选中的会话分支',
      guide: '回到另一条思路',
      description: '切换同一会话的当前路径，原有分支仍然保留。'
    },
    {
      label: '更多操作',
      guide: '再次查看分岔点',
      description: '回到更多操作里的会话分支，选择一条用户消息新开探索。'
    },
    {
      label: '从用户消息 full-request Fork 新会话',
      guide: '从这条用户消息 Fork',
      description: '新会话继承这条消息之前的历史，并把正文放回草稿。'
    },
    {
      selector: '[data-guide-target="composer-draft"]',
      guide: '要求已回填到草稿',
      description: '还没有再次发送这条要求；可以先修改，源会话保持不变。'
    },
    {
      label: '发送消息',
      guide: '修改要求再继续',
      description: '发送修改后的草稿，在新会话中探索另一种方案。'
    },
    {
      selector: '[data-guide-target="fork-result"]',
      guide: '新思路有自己的后续',
      description: '会话分支和 Fork 不回滚工作区文件，也不切换仓库 Git 分支。',
      waiting: true
    }
  ],
  agents: [
    {
      label: '发送消息',
      guide: '分出一个独立任务',
      description: '让 explore 只读调查导出实现，把目标、范围和禁止事项说清楚。'
    },
    {
      prefix: '查看任务：',
      guide: '查看正在运行的任务',
      description: '输入区出现运行摘要，点击进入当前会话的任务中心。'
    },
    {
      label: '查看任务 只读调查 CSV 导出实现',
      guide: '打开这次调查',
      description: '任务列表显示状态、名称、类型和时长；选择后查看详细过程。'
    },
    {
      selector: '[data-guide-target="agent-working"]',
      guide: '子代理正在只读调查',
      description: '独立对话展示要求和工具结果，任务仍在运行，不提前宣布结论。',
      waiting: true
    },
    {
      label: '关闭任务中心',
      fallback: '关闭子代理对话',
      guide: '调查完成，回到主对话',
      description: '完成状态与结论来自任务运行态；关闭任务中心不删除执行记录。'
    },
    {
      label: '展开子代理返回结论',
      guide: '查看返回的调查结论',
      description: '子代理返回消息可展开完整结论，主代理再据此继续。'
    },
    {
      selector: '[data-guide-target="agent-parent-result"]',
      waiting: true,
      guide: '主代理接着处理',
      description: '返回的是路径、范围与文件名来源；只读调查没有修改任何文件。'
    }
  ]
}
const mobileOverrides: Partial<Record<ShowcaseChapterId, Record<number, Partial<ShowcaseCue>>>> = {
  pin: {
    0: { description: '固定后加入会话分页，左右滑动就能查看文档。' },
    1: { description: '文档和验收都加入分页，不用重新打开会话。' },
    2: { description: '主会话换到发布检查，固定的会话分页仍保留。' },
    5: { description: '左右滑动查看文档，主会话保持不变。' },
    6: { description: '继续滑动查看验收，不必重新打开另一份记录。' }
  },
  sync: {
    0: {
      selector: '[data-demo-focus="sync-mobile"] > header',
      guide: '电脑上开始，手机待接续',
      description: '电脑发送前，手机仍是空会话。未发送的草稿不会同步过来。'
    }
  },
  files: {
    1: { description: '手机先回到文件目录，再选择 preview.html，查看页面效果或源码。' },
    2: { description: '回到目录，打开标记 M 的导出文件，查看本次差异。' },
    3: { description: '从文件目录右上角打开项目预览，在独立只读窗口里查看整个项目。' }
  },
  install: {
    2: { description: '手机打开会话列表后，可以在底部看到新增的“额度”和“用量”入口。' },
    3: {
      selector: '[data-guide-target="settings-category"]',
      description: '手机用顶部设置分类选择额度设置，进入插件自己的来源配置页。'
    },
    9: {
      selector: '[data-guide-target="usage-overview"]',
      description: '先看总输入、缓存命中率和费用；向下滚动可查看 Session 与模型明细。'
    }
  },
  branches: {
    2: {
      label: '切换到历史消息 open-only',
      description: '手机在每一行直接选择切换，原分支仍保留在这份会话中。'
    }
  },
  agents: { 4: { label: '关闭子代理对话' } }
}
export function getShowcaseCue(
  chapter: ShowcaseChapterId,
  step: number,
  mobile = false
): ShowcaseCue | null {
  const target = targets[chapter]?.[step] ?? null
  if (!target || !mobile) return target
  return { ...target, ...mobileOverrides[chapter]?.[step] }
}
