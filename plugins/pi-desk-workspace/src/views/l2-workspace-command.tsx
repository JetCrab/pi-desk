import { useState } from 'react'
import {
  PluginActionRow,
  PluginAlert,
  PluginButton,
  PluginCheckbox,
  PluginField,
  PluginInput,
  PluginLogViewer,
  PluginSection,
  PluginSelect,
  PluginTextarea
} from '@jetcrab/pi-desk-sdk/react/base'
import type { WorkspaceCommandSummary, WorkspaceSnapshotItem } from '../contract.js'
import {
  commandImpact,
  type WorkspaceForm,
  type WorkspaceFormValue
} from '../l2-workspace-browser-model.js'

export function WorkspaceCommand({
  workspace,
  command,
  values,
  disabled,
  hasError,
  onValue
}: {
  workspace: WorkspaceSnapshotItem
  command: WorkspaceCommandSummary
  values: WorkspaceForm
  disabled: boolean
  hasError: boolean
  onValue(name: string, value: WorkspaceFormValue): void
}): React.JSX.Element {
  const impact = commandImpact(command)
  const [showLog, setShowLog] = useState(false)
  const latest = workspace.occupation?.operations.at(-1)
  return (
    <div className="workspace-command-form">
      <div>
        <div className="workspace-command-name">{command.id}</div>
        <p className="workspace-description">{command.description}</p>
      </div>
      {impact ? (
        <PluginAlert tone="warning" density="compact">
          {impact}
        </PluginAlert>
      ) : null}
      <PluginSection title="执行目录" density="compact">
        <code className="workspace-path">{workspace.root}</code>
      </PluginSection>
      <div className="workspace-fields">
        {Object.entries(command.parameters.properties).map(([name, property]) => {
          const description =
            [property.description, property.required ? '必填' : null].filter(Boolean).join(' · ') ||
            undefined
          if (property.type === 'boolean') {
            return (
              <PluginField key={name} label={name} description={description} density="compact">
                <PluginCheckbox
                  aria-label={name}
                  checked={values[name] === true}
                  disabled={disabled}
                  onChange={(event) => onValue(name, event.target.checked)}
                />
              </PluginField>
            )
          }
          if (property.enum) {
            const options = property.enum.map((item) => {
              const value = typeof item === 'string' ? item : JSON.stringify(item)
              return { value, label: value }
            })
            if (!property.required && property.default === undefined)
              options.unshift({ value: '', label: '未设置' })
            return (
              <PluginSelect
                key={name}
                label={name}
                description={description}
                size="sm"
                value={String(values[name] ?? '')}
                options={options}
                disabled={disabled}
                onValueChange={(value) => onValue(name, value ?? '')}
              />
            )
          }
          return (
            <PluginField
              key={name}
              label={name}
              description={
                description ?? (property.type === 'array' ? '使用 JSON 数组格式' : undefined)
              }
              density="compact"
            >
              {property.type === 'array' ? (
                <PluginTextarea
                  aria-label={name}
                  controlSize="sm"
                  value={String(values[name] ?? '')}
                  disabled={disabled}
                  placeholder="[]"
                  onChange={(event) => onValue(name, event.target.value)}
                />
              ) : (
                <PluginInput
                  aria-label={name}
                  controlSize="sm"
                  type={
                    property.type === 'integer' || property.type === 'number' ? 'number' : 'text'
                  }
                  step={property.type === 'integer' ? 1 : undefined}
                  value={String(values[name] ?? '')}
                  disabled={disabled}
                  onChange={(event) => onValue(name, event.target.value)}
                />
              )}
            </PluginField>
          )
        })}
      </div>
      {hasError && latest ? (
        <div className="workspace-information">
          <PluginActionRow>
            <PluginButton size="sm" variant="ghost" onClick={() => setShowLog((value) => !value)}>
              {showLog ? '收起日志' : '查看最近操作日志'}
            </PluginButton>
          </PluginActionRow>
          {showLog ? (
            <div className="workspace-log">
              <PluginLogViewer path={latest.logPath} />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
