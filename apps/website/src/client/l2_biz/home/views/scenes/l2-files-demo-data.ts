export const demoReadme = [
  '# 轻舟项目',
  '',
  '一个清楚、轻量的任务管理页面。',
  '',
  '## 本次交付',
  '',
  '- 导出全部任务，包含已完成项',
  '- 文件名：qingzhou-tasks.csv',
  '- 移动端空状态',
  '',
  '## 查看页面',
  '',
  '打开 preview.html，查看任务列表。'
]
export const demoHtml = [
  '<!doctype html><html lang="zh-CN"><meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width,initial-scale=1">',
  '<title>轻舟任务</title>',
  '<style>body{margin:0;padding:24px 18px;font:14px/1.6 system-ui;color:#262626;background:#fff}header{display:flex;align-items:center;gap:12px}h1{font-size:22px;margin:0}button{margin-left:auto;padding:6px 10px;border:0;border-radius:6px;background:#262626;color:white}p,small{color:#666}table{width:100%;border-collapse:collapse}td,th{padding:12px 4px;text-align:left;border-bottom:1px solid #eee}</style>',
  '<header><h1>轻舟任务</h1><button>导出 CSV</button></header>',
  '<p>把今天的任务，安排得清清楚楚。</p>',
  '<table><tr><th>任务</th><th>状态</th></tr><tr><td>完成 CSV 导出</td><td>已完成</td></tr><tr><td>检查手机空状态</td><td>进行中</td></tr></table>',
  '<small>导出包含已完成项</small></html>'
]
export const demoExportSource = [
  'export function exportTasks(tasks) {',
  '  const rows = tasks;',
  '  const csv = toCsv(rows);',
  '  download(csv, "qingzhou-tasks.csv");',
  '}'
]
export const demoExportDiff = [
  ' export function exportTasks(tasks) {',
  '-  const rows = tasks.filter(t => !t.done);',
  '+  const rows = tasks;',
  '   const csv = toCsv(rows);',
  '-  download(csv, "tasks.csv");',
  '+  download(csv, "qingzhou-tasks.csv");',
  ' }'
]
export const demoFiles = {
  'README.md': demoReadme,
  'preview.html': demoHtml,
  'src/export.ts': demoExportSource
}
export type DemoFilePath = keyof typeof demoFiles
export const demoCommits = [
  {
    id: '8fd210a',
    title: '增加 CSV 导出',
    path: 'src/export.ts',
    delta: '+5 −0',
    change: 'A',
    lines: [
      '+export function exportTasks(tasks) {',
      '+  const rows = tasks.filter(t => !t.done);',
      '+  const csv = toCsv(rows);',
      '+  download(csv, "tasks.csv");',
      '+}'
    ]
  },
  {
    id: '45b913c',
    title: '完善任务列表',
    path: 'preview.html',
    delta: '+2 −0',
    change: 'M',
    lines: [
      ' <h1>轻舟任务</h1>',
      '+<p>把今天的任务，安排得清清楚楚。</p>',
      '+<table><tr><th>任务</th><th>状态</th></tr></table>'
    ]
  },
  {
    id: '10f483a',
    title: '初始化轻舟项目',
    path: 'README.md',
    delta: '+3 −0',
    change: 'A',
    lines: ['+# 轻舟项目', '+', '+一个清楚、轻量的任务管理页面。']
  }
] as const
export const demoBranchDiff = [
  ' export function exportTasks(tasks) {',
  '+  // feature/export：支持完成时间列',
  '   const rows = tasks.filter(t => !t.done);',
  '-  const csv = toCsv(rows);',
  '+  const csv = toCsv(rows, { completedAt: true });',
  '   download(csv, "tasks.csv");',
  ' }'
]
