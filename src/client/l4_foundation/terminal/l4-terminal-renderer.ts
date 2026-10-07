'use client'

import type { IDisposable, Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'

export interface L4TerminalDimensions {
  cols: number
  rows: number
}

export interface L4TerminalRenderer {
  restore(input: L4TerminalDimensions & { data: string }): Promise<void>
  write(data: string): Promise<void>
  resize(input: L4TerminalDimensions): void
  measure(): L4TerminalDimensions
  focus(): void
  key(key: 'escape' | 'tab' | 'up' | 'down' | 'left' | 'right'): void
  setControl(pressed: boolean): void
  setVisible(visible: boolean): void
  dispose(): void
}

// 查询应答只由服务端 headless 产生；普通颜色设置继续交给浏览器解析器。
export function suppressL4TerminalQueries(terminal: Terminal): IDisposable[] {
  const handlers: IDisposable[] = []
  for (const id of [
    { final: 'c' },
    { prefix: '>', final: 'c' },
    { final: 'n' },
    { prefix: '?', final: 'n' },
    { intermediates: '$', final: 'p' },
    { prefix: '?', intermediates: '$', final: 'p' }
  ]) {
    handlers.push(terminal.parser.registerCsiHandler(id, () => true))
  }
  handlers.push(
    terminal.parser.registerCsiHandler({ final: 't' }, (params) => {
      return params[0] !== 22 && params[0] !== 23
    })
  )
  handlers.push(terminal.parser.registerDcsHandler({ intermediates: '$', final: 'q' }, () => true))
  for (const osc of [4, 10, 11, 12]) {
    handlers.push(terminal.parser.registerOscHandler(osc, (data) => data.split(';').includes('?')))
  }
  return handlers
}

function importTerminalModules(): Promise<
  [typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit'), unknown]
> {
  return Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/xterm/css/xterm.css')
  ])
}

let modules: ReturnType<typeof importTerminalModules> | null = null

function loadTerminalModules(): ReturnType<typeof importTerminalModules> {
  modules ??= importTerminalModules().catch((cause: unknown) => {
    modules = null
    throw cause
  })
  return modules
}

export async function preloadL4TerminalRenderer(): Promise<void> {
  await loadTerminalModules()
}

export async function createL4TerminalRenderer(
  container: HTMLElement,
  input: {
    signal: AbortSignal
    onInput: (data: string) => void
    onActivate: (dimensions: L4TerminalDimensions) => void
    onResize: (dimensions: L4TerminalDimensions) => void
  }
): Promise<L4TerminalRenderer> {
  const [{ Terminal }, { FitAddon }] = await loadTerminalModules()
  input.signal.throwIfAborted()
  const terminal = new Terminal({
    cols: 80,
    rows: 24,
    scrollback: 2000,
    fontFamily: 'Consolas, "Cascadia Mono", Menlo, monospace',
    cursorBlink: true,
    allowProposedApi: true,
    windowOptions: {},
    overviewRuler: { width: 0 }
  })
  const fit: FitAddon = new FitAddon()
  terminal.loadAddon(fit)
  const disposables = suppressL4TerminalQueries(terminal)
  let disposed = false
  let visible = true
  let restoring = true
  let writing = 0
  let control = false
  let gesture = false
  const pendingWrites = new Set<() => void>()
  let lastWrite: Promise<void> = Promise.resolve()
  terminal.open(container)
  if (terminal.textarea) {
    terminal.textarea.setAttribute('aria-label', 'Terminal input')
    terminal.textarea.style.fontSize = '1rem'
  }

  const measurable = (): boolean => {
    const rect = container.parentElement?.getBoundingClientRect()
    return (
      visible &&
      document.visibilityState === 'visible' &&
      Boolean(rect && rect.width > 0 && rect.height > 0)
    )
  }
  const measure = (): L4TerminalDimensions => {
    if (!measurable()) return { cols: terminal.cols, rows: terminal.rows }
    const viewport = container.parentElement
    if (viewport) {
      // 固定测量盒只取外层分配空间，避免 canonical 溢出滚动条反向改变目标网格。
      // 字格仍由 FitAddon 测量，不能从已取整的 canvas 像素反推字宽。
      const rect = viewport.getBoundingClientRect()
      const style = getComputedStyle(viewport)
      const horizontal = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const vertical = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      container.style.width = `${Math.max(0, rect.width - horizontal - 16)}px`
      container.style.height = `${Math.max(0, rect.height - vertical - 16)}px`
    }
    const proposed = fit.proposeDimensions()
    return {
      cols: Math.max(2, Math.min(400, proposed?.cols ?? terminal.cols)),
      rows: Math.max(2, Math.min(200, proposed?.rows ?? terminal.rows))
    }
  }
  const gridSize = (): void => {
    if (!visible) return
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen')
    if (!screen || !terminal.element) return
    terminal.element.style.width = `${screen.offsetWidth + 14}px`
    terminal.element.style.height = `${screen.offsetHeight}px`
  }
  const refreshAppearance = (): void => {
    if (disposed || !visible) return
    const style = getComputedStyle(document.documentElement)
    const dark = document.documentElement.classList.contains('dark')
    terminal.options.fontSize = parseFloat(style.fontSize) * 0.875
    terminal.options.theme = {
      background: style.getPropertyValue('--background').trim() || (dark ? '#202020' : '#ffffff'),
      foreground: style.getPropertyValue('--foreground').trim() || (dark ? '#eeeeee' : '#292929'),
      cursor: dark ? '#eeeeee' : '#292929',
      selectionBackground: dark ? '#555555' : '#cccccc',
      ...(dark
        ? {}
        : {
            black: '#202020',
            red: '#a31515',
            green: '#006b2d',
            yellow: '#795e26',
            blue: '#0451a5',
            magenta: '#7f00aa',
            cyan: '#006b6b',
            white: '#555555',
            brightBlack: '#666666',
            brightRed: '#a31515',
            brightGreen: '#006b2d',
            brightYellow: '#795e26',
            brightBlue: '#0451a5',
            brightMagenta: '#7f00aa',
            brightCyan: '#006b6b',
            brightWhite: '#202020'
          })
    }
    gridSize()
    if (measurable()) input.onResize(measure())
  }
  const write = (data: string): Promise<void> => {
    if (disposed) return Promise.resolve()
    writing += 1
    lastWrite = new Promise((resolve) => {
      const done = (): void => {
        if (!pendingWrites.delete(done)) return
        writing -= 1
        gridSize()
        resolve()
      }
      pendingWrites.add(done)
      terminal.write(data, done)
    })
    return lastWrite
  }
  const emitInput = (data: string): void => {
    if (disposed || restoring || !measurable()) return
    // DECSET 1004 与快照回放也会发 focus report，不能把被动 focus 变成操作。
    if ((data === '\x1b[I' || data === '\x1b[O') && (!gesture || writing > 0)) return
    if (control) {
      if (/^[a-zA-Z@\[\]\\^_]$/.test(data))
        data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64)
      control = false
    }
    input.onInput(data)
  }
  disposables.push(terminal.onData(emitInput))
  disposables.push(terminal.onBinary(emitInput))
  terminal.attachCustomKeyEventHandler((event) => {
    event.stopPropagation()
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'c' &&
      terminal.hasSelection()
    ) {
      return false
    }
    return true
  })
  disposables.push(terminal.onRender(gridSize))
  const activate = (): void => {
    if (restoring || disposed || !measurable()) return
    gesture = true
    input.onActivate(measure())
    queueMicrotask(() => {
      gesture = false
    })
  }
  container.addEventListener('pointerdown', activate, true)
  container.addEventListener('paste', activate, true)
  let measureFrame: number | null = null
  const observer = new ResizeObserver(() => {
    if (disposed || !measurable() || measureFrame !== null) return
    measureFrame = requestAnimationFrame(() => {
      measureFrame = null
      if (!disposed && measurable()) input.onResize(measure())
    })
  })
  observer.observe(container.parentElement ?? container)
  const appearance = new MutationObserver(refreshAppearance)
  appearance.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-display-size']
  })
  refreshAppearance()

  return {
    measure,
    async restore(snapshot): Promise<void> {
      if (disposed) return
      restoring = true
      await lastWrite
      if (disposed) return
      terminal.reset()
      terminal.resize(snapshot.cols, snapshot.rows)
      gridSize()
      await write(snapshot.data)
      restoring = false
    },
    write,
    resize(dimensions): void {
      if (disposed) return
      terminal.resize(dimensions.cols, dimensions.rows)
      gridSize()
    },
    focus(): void {
      if (!measurable()) return
      activate()
      terminal.focus()
    },
    key(key): void {
      if (!measurable()) return
      activate()
      const arrows = terminal.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b['
      const keys = {
        escape: '\x1b',
        tab: '\t',
        up: `${arrows}A`,
        down: `${arrows}B`,
        right: `${arrows}C`,
        left: `${arrows}D`
      }
      emitInput(keys[key])
    },
    setControl(pressed): void {
      control = pressed
    },
    setVisible(next): void {
      if (disposed || visible === next) return
      visible = next
      if (!visible) {
        terminal.blur()
        if (measureFrame !== null) cancelAnimationFrame(measureFrame)
        measureFrame = null
        return
      }
      refreshAppearance()
      terminal.refresh(0, terminal.rows - 1)
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      if (measureFrame !== null) cancelAnimationFrame(measureFrame)
      observer.disconnect()
      appearance.disconnect()
      container.removeEventListener('pointerdown', activate, true)
      container.removeEventListener('paste', activate, true)
      for (const disposable of disposables) disposable.dispose()
      const element = terminal.element
      terminal.dispose()
      for (const done of pendingWrites) done()
      element?.remove()
    }
  }
}
