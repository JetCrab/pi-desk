'use client'

import { ChevronDown, PackagePlus, RefreshCw, RotateCcw } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { Action, IconButton, Settings } from './l2-demo-ui'
import styles from './l2-demo-plugin-management.module.css'

type Plugin = { name: string; description: string; capabilities: readonly string[] }

export function DemoPluginManagement({
  plugins,
  onReload,
  onClose,
  onSettings,
  available = false
}: {
  plugins: readonly Plugin[]
  onReload: () => void
  onClose: () => void
  onSettings: () => void
  available?: boolean
}): ReactElement {
  const [reloaded, setReloaded] = useState(false)
  function reload(): void {
    setReloaded(true)
    onReload()
  }
  const [expanded, setExpanded] = useState<string | null>(plugins[0]?.name ?? null)
  const pages = available
    ? []
    : plugins.flatMap((plugin) =>
        plugin.capabilities
          .filter((item) => item.startsWith('设置页 · '))
          .map((item) => ({ label: item.slice('设置页 · '.length), onSelect: onSettings }))
      )
  return (
    <Settings title="插件" plugin={false} onClose={onClose} pages={pages}>
      <div className={styles.header}>
        <div>
          <h3>插件</h3>
          <p>管理插件包与本地扩展。</p>
        </div>
        <div className={styles.actions}>
          <Action onClick={reload}>
            <RefreshCw size={16} />
            加载变更
          </Action>
          <IconButton label="检查插件更新">
            <RefreshCw size={16} />
          </IconButton>
          <span className={styles.restart}>
            <RotateCcw size={16} />
            重启 Pi Desk
          </span>
        </div>
      </div>
      <details className={styles.install}>
        <summary>安装插件</summary>
        <label>
          来源
          <div>
            <input readOnly placeholder="npm:包名 / 本地目录" />
            <span>
              <PackagePlus size={16} />
              安装
            </span>
          </div>
        </label>
      </details>
      <div className={styles.plugins}>
        {plugins.map((plugin) => (
          <div key={plugin.name} className={styles.plugin}>
            <button
              type="button"
              className={styles.trigger}
              aria-label={`查看插件 ${plugin.name}`}
              aria-expanded={expanded === plugin.name}
              onClick={() => setExpanded(expanded === plugin.name ? null : plugin.name)}
            >
              <div>
                <strong>{plugin.name}</strong>
                <p>{plugin.description}</p>
              </div>
              <ChevronDown size={16} />
            </button>
            {expanded === plugin.name && (
              <div className={styles.detail}>
                <p>{available ? '已发现，尚未加载' : reloaded ? '已加载 · 刚刚更新' : '已加载'}</p>
                <div className={styles.actions}>
                  <Action onClick={reload} label={`重载插件 ${plugin.name}`}>
                    重载
                  </Action>
                  <span>移除</span>
                </div>
                <div className={styles.capabilities}>
                  <strong>能力</strong>
                  {plugin.capabilities.map((capability) => (
                    <span key={capability}>{capability}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </Settings>
  )
}
