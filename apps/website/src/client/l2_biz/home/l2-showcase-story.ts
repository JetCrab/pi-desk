export type ShowcaseStep = { title: string; description: string; duration: number }
export type ShowcaseSceneProps = { step: number; elapsed?: number; onStep: (step: number) => void }

export const showcaseChapters = [
  {
    id: 'pin',
    title: '固定多窗口',
    headline: '把相关的对话，放在一起。',
    description: '固定会话，在同一页面对照开发、文档和验收。',
    steps: [
      { title: '固定文档', description: '图钉固定文档会话。', duration: 2400 },
      { title: '固定验收', description: '再固定移动端验收。', duration: 2200 },
      { title: '切换主任务', description: '固定列保留，打开发布检查。', duration: 2200 },
      { title: '继续输入', description: '对照固定结果，输入发布要求。', duration: 2200 },
      { title: '整理结果', description: '主任务继续处理。', duration: 1100 },
      { title: '对照文档', description: '发布结果与文档在同一页面。', duration: 2400 },
      { title: '对照验收', description: '窄屏切换固定会话焦点。', duration: 1700 },
      { title: '收起验收', description: '完成对照后取消固定。', duration: 2300 },
      { title: '收起文档', description: '剩余窗口平滑调整。', duration: 1700 },
      { title: '回到开发', description: '所有会话与消息仍然保留。', duration: 1500 },
      { title: '继续对话', description: '自然回到下一轮展示。', duration: 650 }
    ]
  },
  {
    id: 'sync',
    title: '多端接续',
    headline: '电脑上开始，手机上继续。',
    description: '连接同一个 Pi Desk 服务，消息与结果在两端接续。',
    href: '/docs/devices/',
    steps: [
      { title: '电脑输入', description: '空会话显示水獭欢迎；电脑草稿只在本机。', duration: 2400 },
      { title: '消息同步', description: '电脑发送后手机收到，助手处理要求。', duration: 1900 },
      { title: '两端看结果', description: '回复在两端的同一会话显示。', duration: 2200 },
      { title: '手机追加', description: '手机接着已有会话输入新的要求。', duration: 2400 },
      { title: '同步回电脑', description: '手机发出的要求出现在电脑，继续处理。', duration: 1900 },
      { title: '继续完成', description: '共享消息，各端草稿、焦点和滚动独立。', duration: 2300 }
    ]
  },
  {
    id: 'files',
    title: '文件与 Git',
    headline: '看结果，也看清每一处修改。',
    description: '项目文件、页面预览、代码差异与独立项目 Git 预览。',
    steps: [
      { title: '打开文件', description: '从项目目录打开 README.md。', duration: 2100 },
      { title: '查看源码', description: '源码有行号；继续打开 HTML 页面。', duration: 2100 },
      { title: '预览页面', description: '查看页面效果，再打开标记变更的文件。', duration: 2300 },
      { title: '查看差异', description: '对照 HEAD 与工作区的导出修改。', duration: 2300 },
      { title: '项目预览', description: '独立只读弹窗显示在当前页面上方。', duration: 2300 },
      { title: 'Git 记录', description: '展开项目的提交历史。', duration: 2100 },
      { title: '历史差异', description: '选择提交查看详情与变更文件。', duration: 2400 },
      {
        title: '回到当前会话',
        description: '关闭预览，再进入真正的仓库分支操作。',
        duration: 1900
      },
      { title: '选择仓库分支', description: '先选择一个最近使用的 Git 分支。', duration: 2100 },
      { title: '确认切换', description: '从所选分支的操作区执行切换。', duration: 1900 },
      { title: '继续对话', description: '仓库分支更新，当前聊天记录保留。', duration: 2000 }
    ]
  },
  {
    id: 'create-plugin',
    title: '对话造插件',
    headline: '把使用习惯，变成自己的工具。',
    description: '以交付清单示例，把对话、独立应用、设置和输入辅助连起来。',
    href: '/docs/development/',
    steps: [
      { title: '说出需求', description: '要求制作交付清单示例插件。', duration: 2400 },
      { title: '生成并构建', description: '快进展示制作过程，不运行真实模型。', duration: 1700 },
      {
        title: '命令安装与加载',
        description: '助手执行 pidesk 安装命令，等待宿主完成通知。',
        duration: 1800
      },
      {
        title: '命令重载当前会话',
        description: '通过 pidesk session reload 在空闲后重载当前会话。',
        duration: 1800
      },
      { title: '打开应用', description: '从侧栏底部打开交付清单。', duration: 2200 },
      { title: '查看清单', description: '独立应用沿用宿主图标、标题和关闭入口。', duration: 2200 },
      { title: '打开设置', description: '关闭应用，再进入宿主插件设置。', duration: 1800 },
      { title: '维护默认项', description: '在示例设置页保存自己的默认项。', duration: 2300 },
      {
        title: '打开输入辅助',
        description: '更多操作中的本轮检查打开宿主面板弹窗。',
        duration: 2100
      },
      { title: '检查本轮范围', description: '选择范围后在当前聊天启动检查。', duration: 2200 },
      { title: '查看聊天结果', description: '示例消息视图展示摘要与可展开证据。', duration: 2500 }
    ]
  },
  {
    id: 'install',
    title: '安装即用',
    headline: '需要的能力，随时装进来。',
    description: '安装额度与用量插件，加载后从侧栏直接打开。',
    href: '/docs/plugins/',
    steps: [
      { title: '发起安装', description: '请求安装额度与模型用量插件。', duration: 2400 },
      {
        title: '安装与加载',
        description: '先安装软件包，再加载外层服务和网页界面。',
        duration: 1800
      },
      {
        title: '新增插件入口',
        description: '安装完成后，侧栏底部新增额度和用量。',
        duration: 2600
      },
      { title: '配置入口', description: '在宿主设置中找到额度设置。', duration: 2300 },
      {
        title: '保存来源',
        description: '配置渠道、来源和认证，使用不可用示例值。',
        duration: 2300
      },
      { title: '打开额度', description: '在侧栏底部选择额度应用。', duration: 1900 },
      { title: '查看窗口额度', description: '按渠道查看账户与多个额度窗口。', duration: 2200 },
      { title: '展开额度详情', description: '回查完整数值与更新时间。', duration: 2100 },
      { title: '打开用量', description: '关闭额度后，从侧栏打开模型用量。', duration: 1900 },
      { title: '模型用量总览', description: '查看趋势、会话及模型列表。', duration: 2400 },
      { title: '查看各代理', description: '展开会话卡片查看主代理与子代理。', duration: 2300 },
      { title: '会话分析入口', description: '从更多操作打开会话分析。', duration: 2100 },
      { title: '分析当前会话', description: '在宿主面板弹窗看趋势、代理与事件。', duration: 2400 }
    ]
  },
  {
    id: 'context',
    title: '上下文减负',
    headline: '少带重复过程，保留完整历史。',
    description: '忽略较早的工具过程，给下一轮对话留出空间。',
    href: '/docs/plugins/',
    steps: [
      {
        title: '给下一轮留空间',
        description: '长任务积累的旧过程占用了上下文空间。',
        duration: 3400
      },
      {
        title: '忽略旧过程',
        description: '保留要求和结论，手动省略较早的大段过程。',
        duration: 3200
      },
      {
        title: '预计腾出空间',
        description: '本例预计腾出76K，给接下来的对话留余量。',
        duration: 3200
      },
      {
        title: '历史仍可查',
        description: '旧记录留在聊天中，直接追加新要求即可。',
        duration: 3500
      },
      {
        title: '沿用要求继续',
        description: '继续包含已完成任务，并保留项目文件名。',
        duration: 3200
      }
    ]
  },
  {
    id: 'branches',
    title: '分支与 Fork',
    headline: '另一种思路，不必从头开始。',
    description: '回到对话分岔点，切换思路，或新开一段探索。',
    steps: [
      { title: '打开更多操作', description: '在当前会话进入分支操作。', duration: 1900 },
      { title: '进入分支树', description: '聊天列内浮层展示消息与当前路径。', duration: 2200 },
      { title: '选择另一条路径', description: '看节点详情后切换当前分支。', duration: 2300 },
      { title: '再次查看分岔点', description: '原分支仍在，回去选择用户消息。', duration: 2000 },
      {
        title: '从用户消息 Fork',
        description: '新会话继承此前历史，正文回填草稿。',
        duration: 2300
      },
      { title: '先检查草稿', description: '正文还未发送，源会话没有改变。', duration: 2100 },
      { title: '修改后发送', description: '改变范围，在新会话中继续探索。', duration: 2300 },
      { title: '新思路继续', description: '对话分支不会回滚文件或切换 Git 分支。', duration: 2300 }
    ]
  },
  {
    id: 'agents',
    title: '子代理协作',
    headline: '分出去的任务，也看得清过程。',
    description: '派发明确的独立任务，查看执行过程，再回到主对话接收结果。',
    href: '/docs/plugins/',
    steps: [
      { title: '分配独立任务', description: '要求 explore 只读调查导出逻辑。', duration: 2400 },
      { title: '查看运行摘要', description: '输入区运行摘要可打开任务中心。', duration: 2100 },
      {
        title: '选择本次调查',
        description: 'Task Center 列表展示状态、类型与时长。',
        duration: 2200
      },
      { title: '查看完整过程', description: '只读子对话中查看要求与工具调用。', duration: 1900 },
      { title: '调查完成', description: '完成状态形成后回到主对话。', duration: 2200 },
      { title: '展开返回结论', description: '可展开子代理返回消息，核对证据。', duration: 2200 },
      { title: '主代理继续', description: '结论回到父会话，主代理据此继续处理。', duration: 2300 }
    ]
  }
] as const
export type ShowcaseChapterId = (typeof showcaseChapters)[number]['id']
