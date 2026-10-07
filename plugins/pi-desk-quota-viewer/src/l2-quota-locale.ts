import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'

export type QuotaLocale = 'zh-CN' | 'en'

export interface QuotaRegion {
  locale: QuotaLocale
  timeZone: string
}

export function readQuotaRegion(host: BrowserPluginHost): QuotaRegion {
  const region = host.locale?.getSnapshot()
  let browser: Intl.ResolvedDateTimeFormatOptions | undefined
  if (!region?.locale || !region.timeZone) {
    try {
      browser = new Intl.DateTimeFormat().resolvedOptions()
    } catch {
      // 旧宿主没有地区能力时，无法识别浏览器时区则使用 UTC。
    }
  }
  return {
    locale: region?.locale ?? (browser?.locale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'),
    timeZone: region?.timeZone ?? browser?.timeZone ?? 'UTC'
  }
}

const english: Readonly<Record<string, string>> = {
  全部渠道: 'All channels',
  渠道: 'Channel',
  额度渠道: 'Quota channels',
  '搜索渠道、来源或账号': 'Search channels, sources or accounts',
  搜索渠道或显示内容: 'Search channels or display items',
  显示项: 'Display items',
  额度记录: 'Quota records',
  刷新: 'Refresh',
  刷新中: 'Refreshing',
  '刷新中…': 'Refreshing…',
  保存: 'Save',
  '保存中…': 'Saving…',
  取消: 'Cancel',
  全部显示: 'Show all',
  仅周: 'Weekly only',
  详情: 'Details',
  收起: 'Collapse',
  展开: 'Expand',
  来源异常: 'Source error',
  已过期: 'Stale',
  余额: 'Balance',
  可用: 'Available',
  剩余: 'Remaining',
  已用: 'Used',
  总额: 'Limit',
  额度: 'Quota',
  未知: 'Unknown',
  无限: 'Unlimited',
  请求: 'requests',
  次: 'resets',
  剩余重置次数: 'Remaining resets',
  '5 小时额度': '5-hour quota',
  周额度: 'Weekly quota',
  月额度: 'Monthly quota',
  主额度: 'Primary quota',
  次额度: 'Secondary quota',
  '可用 Credits': 'Available credits',
  可用余额: 'Available balance',
  现金余额: 'Cash balance',
  代金券余额: 'Voucher balance',
  '月度 Credits': 'Monthly credits',
  '购买 Credits': 'Purchased credits',
  '赠送 Credits': 'Free credits',
  '官方 API': 'Official API',
  官方产品: 'Official product',
  '内部 API': 'Internal API',
  本地估算: 'Local estimate',
  并发额度: 'Concurrent quota',
  账期额度: 'Billing-period quota',
  滚动窗口: 'Rolling window',
  固定窗口: 'Fixed window',
  窗口未知: 'Unknown window',
  组织: 'Organization',
  项目: 'Project',
  模型: 'Model',
  功能: 'Feature',
  区域: 'Region',
  密钥: 'Key',
  'Codex（通过 CPA）': 'Codex (via CPA)',
  '智谱 Coding Plan': 'Zhipu Coding Plan',
  重置时间格式: 'Reset time format',
  倒计时: 'Countdown',
  具体时间: 'Date and time',
  显示设置: 'Display settings',
  额度来源: 'Quota sources',
  重新加载: 'Reload',
  '加载中…': 'Loading…',
  添加来源: 'Add source',
  搜索来源: 'Search sources',
  额度来源导航: 'Quota source navigation',
  来源列表: 'Sources',
  '正在读取…': 'Loading…',
  没有匹配来源: 'No matching sources',
  未命名来源: 'Unnamed source',
  待完善: 'Incomplete',
  未保存: 'Unsaved',
  启用: 'Enabled',
  停用: 'Disabled',
  来源编辑: 'Source editor',
  返回来源: 'Back to sources',
  选择渠道: 'Select a channel',
  删除来源: 'Delete source',
  '正在读取额度来源…': 'Loading quota sources…',
  尚未配置额度来源: 'No quota sources configured',
  有未保存更改: 'Unsaved changes',
  放弃更改: 'Discard changes',
  保存全部更改: 'Save all changes',
  '放弃未保存的更改？': 'Discard unsaved changes?',
  '额度设置有未保存的更改。': 'Quota settings have unsaved changes.',
  显示名称: 'Display name',
  启用来源: 'Enable source',
  '当前渠道不可用，可删除此来源。': 'This channel is unavailable. You can delete this source.',
  清除搜索: 'Clear search',
  恢复显示项: 'Restore display items',
  没有匹配的显示内容: 'No matching display items',
  暂无可选择的额度: 'No quota items available',
  记录分页: 'Record pages',
  上一页: 'Previous',
  下一页: 'Next',
  尚未取得数据: 'No data yet',
  未取得额度数据: 'Quota data unavailable',
  暂无额度数据: 'No quota data',
  '正在查询…': 'Querying…',
  当前额度已全部隐藏: 'All quota items are hidden',
  没有匹配的可见记录: 'No matching visible records',
  '正在读取额度…': 'Loading quotas…',
  暂时无法读取额度来源: 'Quota sources are temporarily unavailable',
  '尚未启用额度来源，请在“设置 → 额度设置”中添加。': 'Add a quota source in Settings → Quotas.',
  显示项已保存: 'Display items saved',
  额度设置已保存: 'Quota settings saved'
}

export function quotaText(locale: QuotaLocale, text: string, translation?: string): string {
  return locale === 'zh-CN' ? text : (translation ?? english[text] ?? text)
}
