import { createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import {
  PluginButton,
  PluginErrorBoundary,
  PluginHostProvider,
  PluginLoadingState,
  PluginSection,
  PluginSurface
} from '@jetcrab/pi-desk-sdk/react/base'

const application = {
  mount({ container, host, signal }) {
    const root = createRoot(container)
    let disposed = false
    let loading = false
    let error = null
    let message = null

    async function readStatus() {
      if (disposed || signal.aborted || loading) return
      loading = true
      error = null
      render()

      try {
        const result = await host.piDesk.invokeGlobal('status-get', {})
        // 视图关闭不取消服务端方法；旧视图不能使用迟到结果。
        if (disposed || signal.aborted) return
        if (typeof result.message !== 'string') {
          throw new Error('服务信息格式不正确')
        }
        message = result.message
      } catch (cause) {
        if (disposed || signal.aborted) return
        console.error('[本地应用示例] 读取服务信息失败', cause)
        error = cause instanceof Error ? cause.message : String(cause)
      } finally {
        if (!disposed && !signal.aborted) {
          loading = false
          render()
        }
      }
    }

    function render() {
      root.render(
        h(
          PluginHostProvider,
          { host },
          h(
            PluginErrorBoundary,
            null,
            h(
              PluginSurface,
              {
                style: {
                  width: 'min(24rem, calc(100vw - 2rem))',
                  maxWidth: '100%',
                  boxSizing: 'border-box',
                  padding: '1rem',
                  display: 'grid',
                  gap: '1rem',
                  overflowWrap: 'anywhere'
                }
              },
              h(
                PluginSection,
                { title: '服务信息' },
                h(
                  PluginButton,
                  {
                    variant: 'primary',
                    disabled: loading,
                    onClick: () => void readStatus()
                  },
                  '读取服务信息'
                )
              ),
              h(
                PluginLoadingState,
                {
                  loading,
                  error,
                  loadingLabel: '正在读取…',
                  retryLabel: '重试',
                  onRetry: () => void readStatus()
                },
                message === null ? null : h('p', { role: 'status', style: { margin: 0 } }, message)
              )
            )
          )
        )
      )
    }

    render()
    return () => {
      if (disposed) return
      disposed = true
      root.unmount()
    }
  }
}

export default application
