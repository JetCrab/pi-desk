import type { BrowserPluginHost, WorkbenchContext } from '@jetcrab/pi-desk-sdk/browser'
import type { PiDeskPluginHost, PluginJsonObject } from '@jetcrab/pi-desk-sdk/entry'

// 此文件由 tsconfig.tests.json 检查，不执行对 Host 的调用。
export function assertPluginEventTypes(browser: BrowserPluginHost, node: PiDeskPluginHost): void {
  const off: () => void = browser.events.on('workbench-context', (context) => {
    const value: Readonly<WorkbenchContext> = context
    void value
  })
  off()
  browser.events.on('chat-submit-result', (result) => {
    if (result.status === 'accepted') {
      const tempId: string = result.tempId
      void tempId
    } else {
      const message: string = result.message
      void message
    }
  })
  node.events.on('chat-input-accepted', (input) => {
    const sessionId: string = input.source.sessionId
    void sessionId
  })
  node.events.on('work-sessions', (sessions) => {
    const cwd: string | undefined = sessions[0]?.cwd
    void cwd
  })
  const receive = (_data: Readonly<PluginJsonObject>): void => {}
  browser.events.onPlugin('example-plugin', 'changed', receive)
  node.events.onPlugin('example-plugin', 'changed', receive)
  browser.events.emit('changed', { value: 1 })
  node.events.emit('changed', { value: 1 })

  // @ts-expect-error 宿主事件名由当前运行域的类型表限定。
  browser.events.on('unknown-event', receive)
  // @ts-expect-error 浏览器不能订阅服务端独有的接管事件。
  browser.events.on('chat-input-accepted', receive)
  // @ts-expect-error Node 全局插件没有页面焦点。
  node.events.on('workbench-context', receive)
  // @ts-expect-error 状态载荷由事件名决定，不能自行指定其他类型。
  browser.events.on('theme', (_data: string): void => {})
  // @ts-expect-error 自定义事件要求 JSON Object。
  browser.events.emit('changed', 'text')
  // @ts-expect-error 发布者身份由宿主提供，不能指定其他插件。
  node.events.emit('example-plugin', 'changed', {})
}
