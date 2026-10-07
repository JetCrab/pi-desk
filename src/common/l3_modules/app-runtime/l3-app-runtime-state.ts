import {
  L3AppRuntimeSchema,
  type L3AppNotificationUpdate,
  type L3AppRuntime,
  type L3AppRuntimeEvent
} from './l3-app-runtime-contract'

function applyNotificationUpdate(
  current: L3AppRuntime['notifications'],
  update: L3AppNotificationUpdate
): L3AppRuntime['notifications'] {
  if (update.type === 'add') {
    if (
      current.some(
        (notification) => notification.notificationId === update.notification.notificationId
      )
    ) {
      throw new Error(`Notification already exists: ${update.notification.notificationId}`)
    }
    return [...current, update.notification]
  }

  const index = current.findIndex(
    (notification) => notification.notificationId === update.notificationId
  )
  if (index < 0) throw new Error(`Notification does not exist: ${update.notificationId}`)

  if (update.type === 'delete') {
    return current.filter((notification) => notification.notificationId !== update.notificationId)
  }

  const next = [...current]
  next[index] = {
    ...current[index],
    ...update.changes
  }
  return next
}

export function applyL3AppRuntimeEvent(
  current: L3AppRuntime,
  event: L3AppRuntimeEvent
): L3AppRuntime {
  if (event.type === 'replace') return L3AppRuntimeSchema.parse(event.runtime)

  if (event.key === 'notifications') {
    return L3AppRuntimeSchema.parse({
      ...current,
      notifications: applyNotificationUpdate(current.notifications, event.update)
    })
  }

  if (event.key === 'settings') {
    return L3AppRuntimeSchema.parse({ ...current, settings: event.update })
  }

  if (event.key === 'capabilityModes') {
    return L3AppRuntimeSchema.parse({ ...current, capabilityModes: event.update })
  }

  const plugins = { ...current.plugins }
  if (event.update.state === null) {
    if (!(event.update.pluginName in plugins)) {
      throw new Error(`Plugin global state does not exist: ${event.update.pluginName}`)
    }
    delete plugins[event.update.pluginName]
  } else {
    plugins[event.update.pluginName] = event.update.state
  }
  return L3AppRuntimeSchema.parse({ ...current, plugins })
}
