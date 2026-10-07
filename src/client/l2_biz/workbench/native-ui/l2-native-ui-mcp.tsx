'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import type { L2NativeUiState } from './l2-native-ui-biz'
import { L2NativeUiNotices } from './l2-native-ui-notices'

export function L2NativeUiMcp({
  available,
  state,
  disabled,
  onExecute
}: {
  available: boolean
  state: L2NativeUiState
  disabled: boolean
  onExecute: (args: string, login: boolean) => void
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const [action, setAction] = useState<'status' | 'login' | 'logout' | 'reconnect'>('status')
  const [name, setName] = useState('')
  const [confirmLogout, setConfirmLogout] = useState(false)
  const needsName = action !== 'status'
  const target = name.trim()
  const invalidName = needsName && !/^[a-zA-Z0-9_-]+$/.test(target)
  return (
    <div className="space-y-4">
      {available ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (
              disabled ||
              !state.ready ||
              state.commandPending ||
              invalidName ||
              (action === 'logout' && !confirmLogout)
            )
              return
            onExecute(action === 'status' ? '' : `${action} ${target}`, action === 'login')
          }}
        >
          <L4ChoiceGroup
            label={t('mcpSessionActions', { defaultValue: 'MCP 会话操作' })}
            layout="segmented"
            value={action}
            onChange={(value) => {
              setAction(value)
              setConfirmLogout(false)
            }}
            options={[
              { value: 'status', label: t('mcpStatus', { defaultValue: '状态' }) },
              { value: 'login', label: t('mcpLogin', { defaultValue: '登录' }) },
              { value: 'reconnect', label: t('mcpReconnect', { defaultValue: '重连' }) },
              { value: 'logout', label: t('mcpLogout', { defaultValue: '退出登录' }) }
            ]}
          />
          {needsName ? (
            <label className="block space-y-1 text-sm font-medium">
              <span>{t('mcpServerName', { defaultValue: '服务名称' })}</span>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('mcpServerNamePlaceholder', { defaultValue: '输入真实服务名称' })}
                autoComplete="off"
                maxLength={128}
              />
            </label>
          ) : null}
          {needsName && target && invalidName ? (
            <p className="text-sm text-destructive" role="alert">
              {t('mcpServerNameInvalid', {
                defaultValue: '服务名称只能包含字母、数字、下划线和连字符。'
              })}
            </p>
          ) : null}
          {action === 'logout' ? (
            <label className="flex min-h-8 cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-primary"
                checked={confirmLogout}
                onChange={(event) => setConfirmLogout(event.target.checked)}
              />
              <span>
                {t('mcpLogoutConfirm', {
                  defaultValue: '删除共享登录凭据，其他会话下次访问也可能需要重新登录。'
                })}
              </span>
            </label>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                disabled ||
                !state.ready ||
                state.commandPending !== null ||
                invalidName ||
                (action === 'logout' && !confirmLogout)
              }
            >
              {t('mcpExecute', { defaultValue: '执行' })}
            </Button>
            {state.commandPending ? (
              <span role="status" className="wrap-anywhere text-sm text-muted-foreground">
                {t('mcpExecuting', { defaultValue: '正在执行' })} {state.commandPending}
              </span>
            ) : null}
          </div>
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('mcpCommandUnavailable', { defaultValue: '当前会话未注册 MCP 命令。' })}
        </p>
      )}
      <div className="border-t pt-4">
        <h3 className="mb-3 text-sm font-medium">
          {t('nativeCommandOutput', { defaultValue: '会话命令输出' })}
        </h3>
        <L2NativeUiNotices notices={state.notices} />
      </div>
    </div>
  )
}
