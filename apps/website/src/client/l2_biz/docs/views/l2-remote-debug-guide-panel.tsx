import { useEffect, useRef, type ReactElement } from 'react'
import { ChevronDown, MousePointer2, X } from 'lucide-react'
import styles from './l2-remote-debug-guide.module.css'

const command = 'pnpm exec vite --host 127.0.0.1 --port 43120 --strictPort'
const localUrl = 'http://127.0.0.1:43120'
const publicUrl = 'http://preview.example.invalid:11020'

function Address({ title, url }: { title: string; url: string }): ReactElement {
  return (
    <div className={styles.address}>
      <span>{title}</span>
      <span className={styles.addressText} title={`${url}（演示地址，不访问）`}>
        {url.replace('http://', '')}
      </span>
      <span className={styles.addressAction}>复制</span>
      <span className={styles.addressAction}>打开</span>
    </div>
  )
}

function Profile({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  const details = step === 2 || step === 6
  const running = step === 5 || step === 6
  const active = step >= 4 && step <= 7
  const stopping = step === 7
  const status =
    step === 4
      ? '启动中'
      : running
        ? '运行中'
        : stopping
          ? '停止中'
          : step === 8
            ? '已停止'
            : '未启动'
  return (
    <div className={styles.profileCard}>
      <div
        className={styles.profileHead}
        data-scroll-target={step === 1 || step === 4 || step >= 7 ? 'true' : undefined}
      >
        <div>
          <strong>web-preview</strong>
          <span>纸舟示例网页</span>
        </div>
        <span className={styles.badge} role="status">
          {status}
        </span>
        <button
          type="button"
          className={styles.quietButton}
          aria-label={details ? '收起详情' : '查看详情'}
          aria-expanded={details}
          onClick={() => onSelectStep(details ? (running ? 5 : 1) : running ? 6 : 2)}
        >
          {details ? '收起' : '详情'}
        </button>
        {active ? (
          <>
            <span className={styles.secondaryButton}>重启</span>
            <button
              type="button"
              className={styles.stopButton}
              disabled={stopping}
              data-highlighted={stopping}
              onClick={() => onSelectStep(7)}
            >
              {stopping ? '停止中…' : '停止'}
              {stopping && (
                <MousePointer2 className={styles.stopPointer} size={22} aria-hidden="true" />
              )}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={styles.primaryButton}
            data-highlighted={step === 1}
            onClick={() => onSelectStep(4)}
          >
            {step === 8 ? '重新启动' : '启动'}
          </button>
        )}
      </div>
      {running && (
        <div className={styles.addresses} data-scroll-target={step === 5 ? 'true' : undefined}>
          <Address title="本地" url={localUrl} />
          <Address title="远程" url={publicUrl} />
        </div>
      )}
      {details && (
        <div className={styles.details} data-scroll-target={step === 2 ? 'true' : undefined}>
          <dl className={styles.keyValues}>
            <div>
              <dt>名称</dt>
              <dd>web-preview</dd>
            </div>
            <div>
              <dt>简述</dt>
              <dd>纸舟示例网页</dd>
            </div>
            {running && (
              <>
                <div>
                  <dt>本地地址</dt>
                  <dd>{localUrl}</dd>
                </div>
                <div>
                  <dt>远程地址</dt>
                  <dd>{publicUrl}</dd>
                </div>
              </>
            )}
            <div>
              <dt>配置命令</dt>
              <dd className={styles.code}>{command}</dd>
            </div>
            <div>
              <dt>项目目录</dt>
              <dd>C:/demo/paperboat-demo</dd>
            </div>
            <div>
              <dt>配置路由</dt>
              <dd className={styles.code}>/ → 127.0.0.1:43120</dd>
            </div>
            {running && (
              <div>
                <dt>时间</dt>
                <dd>开始 示例时间 10:00 · 结束 —</dd>
              </div>
            )}
          </dl>
          {step === 6 && (
            <div className={styles.logs} data-scroll-target="true">
              <button
                type="button"
                className={styles.secondaryButton}
                aria-expanded="true"
                onClick={() => onSelectStep(5)}
              >
                收起日志
              </button>
              <pre className={styles.logOutput} aria-label="远程调试示例日志">
                {
                  '教学示例日志，未实际运行\n[system] 启动 Profile web-preview\n[command] 本地开发服务已就绪\n[tunnel] 已监听 preview.example.invalid:11020\n[system] 远程地址 http://preview.example.invalid:11020'
                }
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function RemoteDebugGuidePanel({
  step,
  onSelectStep
}: {
  step: number
  onSelectStep: (step: number) => void
}): ReactElement {
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const element = scroll.current
    if (!element) return
    const target = element.querySelector<HTMLElement>('[data-scroll-target="true"]')
    if (!target) {
      element.scrollTop = 0
      return
    }
    const top =
      target.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop
    element.scrollTo({
      top: Math.max(0, top - (element.clientHeight - target.offsetHeight) / 2),
      behavior: 'instant'
    })
  }, [step])

  if (step === 3) {
    return (
      <div className={styles.overlay}>
        <div className={styles.panel} role="group" aria-label="示例远程调试全局设置">
          <div className={styles.panelHeader}>
            <strong>设置</strong>
            <span>全为教学示意</span>
            <button
              type="button"
              aria-label="关闭示例设置并返回远程调试"
              onClick={() => onSelectStep(4)}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <div className={styles.settingsLayout}>
            <nav className={styles.settingsNavigation} aria-label="示例设置分类">
              <span>插件</span>
              <strong>
                插件设置
                <ChevronDown size={12} aria-hidden="true" />
              </strong>
              <span className={styles.selectedSetting}>远程调试</span>
            </nav>
            <div className={styles.settingsContent}>
              <div className={styles.pageHeading}>
                <strong>远程调试</strong>
                <span>刷新</span>
              </div>
              <div className={styles.tabs}>
                <span data-active="true">连接</span>
                <span>端口分配</span>
                <span>端口登记</span>
              </div>
              <div className={styles.connection}>
                <strong>连接地址</strong>
                <span>http://tunnel.example.invalid</span>
                <small>在桌面端设置连接。</small>
              </div>
              <div className={styles.teachingNote}>
                前置条件：同机 Pi Desk
                桌面端托管，并已配置隧道。平台以桌面端实际支持为准；此地址仅为示例。
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.overlay}>
      <div className={styles.panel} role="group" aria-label="示例远程调试应用">
        <div className={styles.panelHeader}>
          <strong>远程调试</strong>
          <span>命令、网络与地址均为示意</span>
          <button type="button" aria-label="关闭示例远程调试应用" onClick={() => onSelectStep(0)}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className={styles.applicationLayout}>
          <nav className={styles.projects} aria-label="远程调试项目">
            <button type="button" aria-current="true" onClick={() => onSelectStep(1)}>
              paperboat-demo{step >= 4 && step <= 7 && <small>1 运行中</small>}
            </button>
            <span>notebook-demo</span>
          </nav>
          <div className={styles.applicationContent}>
            <div className={styles.pageHeading}>
              <strong>paperboat-demo</strong>
              <span>刷新</span>
            </div>
            <div className={styles.profileScroll} ref={scroll}>
              <Profile step={step} onSelectStep={onSelectStep} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
