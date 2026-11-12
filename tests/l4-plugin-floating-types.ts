import type {
  BrowserFloatingHandle,
  BrowserFloatingImplementation,
  BrowserPluginHost
} from '@jetcrab/pi-desk-sdk/browser'

function checkFloatingTypes(host: BrowserPluginHost): void {
  const implementation: BrowserFloatingImplementation = {
    mount({ container, target, host: viewHost, signal }) {
      container.textContent = '待办'
      const off = viewHost.events.on('workbench-context', () => {
        if (signal.aborted) return
      })
      target.close()
      return off
    }
  }
  const load = async (): Promise<BrowserFloatingImplementation> => implementation
  const handle: BrowserFloatingHandle = host.floating.open({ id: 'todo', load })
  handle.close()
  // @ts-expect-error ID 必需，不能由宿主隐式生成。
  host.floating.open({ load })
  // @ts-expect-error loader 必需。
  host.floating.open({ id: 'todo' })
  // @ts-expect-error 折叠是插件自己的行为。
  host.floating.open({ id: 'todo', load, collapsed: true })
  // @ts-expect-error 句柄不提供宿主显隐控制。
  handle.show()
}

void checkFloatingTypes
