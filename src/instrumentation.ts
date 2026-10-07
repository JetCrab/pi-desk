export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const startedAt = performance.now()
  console.info('[Pi Desk][Instrumentation] 开始装配应用 Runtime')
  const [
    { registerL1AppSocketRuntime },
    { registerL1WebAuthRuntime },
    { getL1AppSocketRuntime },
    { getL1WebAuthRuntime },
    { createL2PluginAppRuntimeSink },
    { getL2WorkSessionManage },
    { getL4PiGlobalPluginRuntime },
    { executeL2PluginCommand },
    { initializeL2PluginManagement },
    { initializeL4PiDeskCommands }
  ] = await Promise.all([
    import('@server/l1_entry/node/l1-app-socket-bridge'),
    import('@server/l1_entry/node/l1-web-auth-bridge'),
    import('@server/l1_entry/websocket/l1-app-socket-runtime'),
    import('@server/l1_entry/l1-web-auth-runtime'),
    import('@server/l2_biz/app-runtime/l2-app-runtime'),
    import('@server/l2_biz/work-session/l2-work-session-manage'),
    import('@server/l4_foundation/pi/l4-pi-global-plugin-runtime'),
    import('@server/l2_biz/plugin-management/l2-plugin-commands'),
    import('@server/l2_biz/plugin-management/l2-plugin-management'),
    import('@server/l4_foundation/pidesk/l4-pidesk-runtime')
  ])

  const modulesLoadedAt = performance.now()
  console.info('[Pi Desk][Instrumentation] 应用模块加载完成，开始初始化命令入口', {
    durationMs: Math.round(modulesLoadedAt - startedAt)
  })
  const manage = getL2WorkSessionManage()
  initializeL2PluginManagement({
    refreshPluginMessages: () => manage.refreshPluginMessages(),
    runPluginRestart: (operation) => manage.runPluginRestart(operation)
  })
  registerL1WebAuthRuntime(getL1WebAuthRuntime())
  await initializeL4PiDeskCommands(executeL2PluginCommand)
  const commandsInitializedAt = performance.now()
  console.info('[Pi Desk][Instrumentation] 命令入口初始化完成，开始恢复基础工作会话', {
    durationMs: Math.round(commandsInitializedAt - modulesLoadedAt)
  })
  const pluginRuntime = getL4PiGlobalPluginRuntime()
  pluginRuntime.bindAppRuntimeSink(createL2PluginAppRuntimeSink())
  await manage.initialize()
  const workSessionsLoadedAt = performance.now()
  pluginRuntime.bindWorkSessionProvider(async () => {
    const snapshot = await manage.listWorkSessions()
    return snapshot.workSessions.map((workSession) => ({
      source: {
        workId: workSession.workId,
        sessionId: workSession.sessionId,
        branchId: workSession.branchId
      },
      cwd: workSession.cwd,
      status: workSession.status
    }))
  })
  const appSocketRuntime = getL1AppSocketRuntime()
  pluginRuntime.bindPushSender((message) => appSocketRuntime.pushPlugin(message))
  registerL1AppSocketRuntime(appSocketRuntime)
  console.info('[Pi Desk][Instrumentation] 登录认证和基础工作会话已就绪，应用 Runtime 已注册', {
    durationMs: Math.round(performance.now() - startedAt),
    moduleImportMs: Math.round(modulesLoadedAt - startedAt),
    commandInitializeMs: Math.round(commandsInitializedAt - modulesLoadedAt),
    workSessionRestoreMs: Math.round(workSessionsLoadedAt - commandsInitializedAt)
  })
  setTimeout(() => {
    void pluginRuntime.initialize().then(
      () => {
        manage.refreshPluginMessages()
        console.info('[Pi Desk][Instrumentation] 插件加载尝试完成，基础聊天不依赖插件就绪')
      },
      (error: unknown) => {
        console.error('[Pi Desk][Instrumentation] 插件加载失败，保留基础聊天', {
          message: error instanceof Error ? error.message : String(error)
        })
      }
    )
  }, 0)
}
