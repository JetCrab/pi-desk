import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { evaluate, screenshot, waitFor } from './l4-browser-cdp-runtime.mjs'

// 仅替换任务运行态输入，实际聊天组件、SDK胶囊和滚动控制链保持不变。
export const taskCapsuleFixture = `
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = class extends OriginalWebSocket {
    constructor(...args) {
      super(...args);
      if (!String(args[0]).includes('/api/ws?')) return;
      window.__capsuleSocket = this;
      this.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.head?.path === 'chat/source-event' && message.body?.source?.workId === 'composer-resize' && message.body?.event?.runtime) {
          window.__capsuleRuntime = message.body.event.runtime;
          window.__capsuleSource = message.body.source;
        }
      });
    }
  };
  window.__setCapsuleTasks = (count, status = 'running', activity = '验证任务胶囊与聊天位置') => {
    const runtime = structuredClone(window.__capsuleRuntime);
    runtime.plugins['task-center'] = { tasks: Array.from({ length: count }, (_, index) => ({
      taskId: 'capsule-task-' + index, taskKind: '测试', taskType: 'fixture',
      title: index === 0 ? '检查界面结构' : '核对移动端布局',
      activity, info: [], status,
      startedAt: Date.now() - 1000, endedAt: status === 'running' ? null : Date.now()
    })) };
    window.__capsuleSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      head: { op: 'push', path: 'chat/source-event' },
      body: { source: window.__capsuleSource, event: { type: 'runtime_update', runtime } }
    }) }));
  };
`

async function click(client, selector) {
  await waitFor(
    client,
    `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && target.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
  })()`,
    '目标操作可点击'
  )
  const point = await evaluate(
    client,
    `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    if (!target.contains(document.elementFromPoint(x, y))) throw new Error('胶囊操作被遮挡');
    return { x, y };
  })()`
  )
  for (const type of ['mousePressed', 'mouseReleased']) {
    await client.send('Input.dispatchMouseEvent', { type, button: 'left', clickCount: 1, ...point })
  }
}

export async function checkTaskCapsule({ client, viewport, settle, results, runRoot }) {
  const prefix = `${viewport.width}：任务胶囊`
  await evaluate(
    client,
    `(() => {
    localStorage.setItem('pi-super-theme', 'dark');
    window.dispatchEvent(new StorageEvent('storage', { key: 'pi-super-theme', newValue: 'dark' }));
    window.__chatScroll.click();
    window.__chatScroll.scrollTop = window.__chatScroll.scrollHeight;
    document.querySelector('textarea').focus({ preventScroll: true });
    window.__originalChat = window.__chatScroll;
    // 延迟任务中的尺寸读取会推进CSS动画，却早于下一次视口补偿。
    // 在宿主已注册的尺寸观察器之后采样，覆盖每次实际布局变化。
    window.__probeFrames = (count = 24) => {
      const samples = [window.__measureChat()];
      const observer = new ResizeObserver(() => samples.push(window.__measureChat()));
      observer.observe(window.__chatScroll);
      window.__frameSamples = (async () => {
        for (let frame = 0; frame < count; frame++) await new Promise(requestAnimationFrame);
        observer.disconnect();
        samples.push(window.__measureChat());
        return samples;
      })();
    };
  })()`
  )
  await settle(client)
  await evaluate(client, 'window.__probeFrames(); window.__setCapsuleTasks(1)')
  const entering = await evaluate(client, 'window.__frameSamples')
  results.push({ label: `${prefix}出现`, samples: entering })
  assert.ok(entering[0].viewport - entering.at(-1).viewport > 30)
  assert.ok(new Set(entering.map((sample) => sample.viewport)).size > 2, '任务条没有平滑展开')
  assert.ok(
    entering.every((sample) => sample.gap <= 2),
    '任务出现丢失底部跟随'
  )
  assert.equal(
    await evaluate(client, 'document.activeElement === document.querySelector("textarea")'),
    true
  )
  await settle(client)
  const beforeDetails = await evaluate(client, 'window.__measureChat()')
  await click(client, '[data-slot="status-capsule-trigger"]')
  await waitFor(
    client,
    'Boolean(document.querySelector("[data-slot=status-capsule-popup]"))',
    '胶囊展开'
  )
  await settle(client)
  assert.equal((await evaluate(client, 'window.__measureChat()')).viewport, beforeDetails.viewport)
  await evaluate(client, 'window.__probeFrames(); window.__setCapsuleTasks(2)')
  const multiple = await evaluate(client, 'window.__frameSamples')
  assert.ok(
    multiple.every((sample) => sample.viewport === beforeDetails.viewport && sample.gap <= 2)
  )
  await waitFor(
    client,
    'document.querySelector("[data-testid=task-capsule-preview]")?.textContent.includes("核对移动端布局")',
    '浮层任务更新'
  )
  const popup = await evaluate(
    client,
    `(() => {
    const popup = document.querySelector('[data-slot="status-capsule-popup"]');
    const rect = popup.getBoundingClientRect();
    const input = document.querySelector('textarea').getBoundingClientRect();
    const css = getComputedStyle(popup);
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      inputTop: input.top, width: innerWidth, color: css.color, background: css.backgroundColor };
  })()`
  )
  assert.ok(
    popup.left >= 0 &&
      popup.right <= popup.width &&
      popup.top >= 0 &&
      popup.bottom <= popup.inputTop
  )
  assert.notEqual(popup.color, popup.background)
  results.push({ label: `${prefix}展开与并行`, popup })
  await evaluate(client, 'window.__setCapsuleTasks(2, "running", "执行中")')
  await settle(client)
  const presentation = await evaluate(
    client,
    `(() => {
    const preview = document.querySelector('[data-testid=task-capsule-preview]');
    const buttons = [...preview.querySelectorAll('button')];
    const open = buttons.find(button => button.textContent.includes('打开任务中心'));
    const heading = preview.querySelector('h3').getBoundingClientRect();
    const action = open.getBoundingClientRect();
    const probe = document.createElement('span');
    probe.style.background = 'var(--popover)'; document.body.append(probe);
    const expected = getComputedStyle(probe).backgroundColor; probe.remove();
    return { counts: buttons.filter(button => !button.textContent.includes('打开任务中心')).map(button => button.textContent.match(/执行中/g)?.length ?? 0),
      topRight: action.left > heading.right && action.top < heading.bottom,
      background: getComputedStyle(document.querySelector('[data-slot=status-capsule-popup]')).backgroundColor,
      expected, title: document.querySelector('[data-slot=status-capsule-trigger]').getAttribute('title') };
  })()`
  )
  assert.deepEqual(presentation.counts, [1, 1], '任务状态被重复展示')
  assert.equal(presentation.topRight, true, '任务入口不在右上角')
  assert.equal(presentation.background, presentation.expected, '胶囊未采用主题面板色')
  assert.equal(presentation.title, null, '胶囊仍有多余原生悬浮提示')
  results.push({ label: `${prefix}主题与去重`, presentation })
  await writeFile(join(runRoot, `capsule-${viewport.width}.png`), await screenshot(client))
  for (const type of ['keyDown', 'keyUp'])
    await client.send('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
  const closing = await evaluate(
    client,
    `(async () => {
    const popup = document.querySelector('[data-slot=status-capsule-popup]');
    if (!popup) throw new Error('未捕获收起过渡');
    const animations = popup.getAnimations({ subtree: true }).filter(a => Number.isFinite(a.effect.getComputedTiming().endTime));
    for (const animation of animations) { animation.pause(); animation.currentTime = animation.effect.getComputedTiming().duration * .94; }
    const shell = document.querySelector('[data-slot=status-capsule-shell]').getBoundingClientRect();
    const text = popup.querySelector('[data-slot=status-capsule-close] span:not(:has(svg))');
    const range = document.createRange(); range.setStart(text.firstChild, 0); range.setEnd(text.firstChild, 1);
    const rect = range.getBoundingClientRect();
    const originalText = document.querySelector('[data-slot=status-capsule-trigger] .pi-desk-ui-capsule-copy');
    return { left: rect.left, right: rect.right, shellLeft: shell.left, shellRight: shell.right, opacity: getComputedStyle(text).opacity,
      textWidth: text.clientWidth, originalWidth: originalText.clientWidth };
  })()`
  )
  results.push({ label: `${prefix}收起文字`, closing })
  assert.ok(
    closing.left >= closing.shellLeft && closing.right <= closing.shellRight,
    '收起尾帧摘要文字被裁掉'
  )
  assert.equal(closing.opacity, '1')
  assert.ok(closing.textWidth >= closing.originalWidth, '收起摘要比原胶囊更窄，导致文字截断')
  const closingImage = await client.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true
  })
  await writeFile(
    join(runRoot, `capsule-closing-${viewport.width}.png`),
    Buffer.from(closingImage.data, 'base64')
  )
  await evaluate(
    client,
    'document.getAnimations().forEach(animation => { if (animation.playState === "paused") animation.play() })'
  )
  await waitFor(
    client,
    '!document.querySelector("[data-slot=status-capsule-popup]")',
    'Escape关闭胶囊'
  )
  {
    if (viewport.mobile) {
      await click(client, '[aria-label="显示工作会话菜单"]')
      await waitFor(
        client,
        'Boolean(document.querySelector("[data-testid=work-session-row-capsule-other]"))',
        '手机会话菜单'
      )
    }
    await click(client, '[data-testid="work-session-row-capsule-other"]')
    await waitFor(
      client,
      'Boolean(document.querySelector("[data-work-id=capsule-other] textarea"))',
      '切到对照会话'
    )
    await evaluate(
      client,
      `(() => {
      window.__capsuleRestoreAnimations = [];
      const listener = event => {
        if (event.target.closest?.('[data-work-id="composer-resize"] [data-slot="status-capsule"]') && event.animationName !== 'spin') window.__capsuleRestoreAnimations.push({type:event.type, property:event.propertyName, name:event.animationName});
      };
      document.addEventListener('transitionrun', listener, true);
      document.addEventListener('animationstart', listener, true);
      window.__stopCapsuleRestore = () => { document.removeEventListener('transitionrun', listener, true); document.removeEventListener('animationstart', listener, true); };
    })()`
    )
    if (viewport.mobile) {
      await click(client, '[aria-label="显示工作会话菜单"]')
      await waitFor(
        client,
        'Boolean(document.querySelector("[data-testid=work-session-row-composer-resize]"))',
        '手机切回菜单'
      )
    }
    await click(client, '[data-testid="work-session-row-composer-resize"]')
    await waitFor(
      client,
      'document.querySelector("[data-work-id=composer-resize] [data-slot=status-capsule-trigger]")?.textContent.includes("2 个任务")',
      '切回已有任务'
    )
    await settle(client)
    assert.deepEqual(
      await evaluate(client, 'window.__capsuleRestoreAnimations'),
      [],
      '切回会话重放胶囊动效'
    )
    await evaluate(
      client,
      '(() => { window.__stopCapsuleRestore(); window.__chatScroll.click(); window.__chatScroll.scrollTop = Math.max(0, window.__chatScroll.scrollTop - 100); window.__originalChat = window.__chatScroll; })()'
    )
    // 已结束短会话可能已在物理底部但处于首屏阅读态；先上翻再回底建立跟随。
    await waitFor(client, 'window.__measureChat().gap > 50', '切回后退出首屏阅读锚点')
    await evaluate(client, 'window.__chatScroll.scrollTop = window.__chatScroll.scrollHeight')
    await settle(client)
  }
  await evaluate(client, 'window.__probeFrames(140); window.__setCapsuleTasks(2, "completed")')
  const leaving = await evaluate(client, 'window.__frameSamples')
  results.push({ label: `${prefix}完成并退场`, samples: leaving })
  assert.ok(leaving.at(-1).viewport - leaving[0].viewport > 30)
  assert.ok(
    leaving.every((sample) => sample.gap <= 2),
    '任务消失丢失底部跟随'
  )
  assert.ok(new Set(leaving.map((sample) => sample.viewport)).size > 2, '退场没有过渡')
  const point = await evaluate(
    client,
    `(() => { const r = window.__chatScroll.getBoundingClientRect(); return {x:r.left+5,y:r.top+r.height/2}; })()`
  )
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    ...point,
    deltaX: 0,
    deltaY: -250
  })
  await waitFor(client, 'window.__measureChat().gap > 100', '历史阅读')
  await settle(client)
  await evaluate(client, 'window.__probeFrames(); window.__setCapsuleTasks(1)')
  const reading = await evaluate(client, 'window.__frameSamples')
  assert.ok(
    reading.every((sample) => Math.abs(sample.userTop - reading[0].userTop) <= 2),
    '任务提示拉动阅读位置'
  )
  await evaluate(
    client,
    'window.__setCapsuleTasks(1, "completed"); window.__setCapsuleTasks(2); window.__probeFrames(140)'
  )
  const rapid = await evaluate(client, 'window.__frameSamples')
  assert.ok(
    rapid.every((sample) => sample.viewport === rapid[0].viewport),
    '旧完成定时器关闭了新任务'
  )
  results.push({ label: `${prefix}阅读与快速切换`, samples: reading })
  await evaluate(client, 'window.__probeFrames(); window.__setCapsuleTasks(0)')
  const removed = await evaluate(client, 'window.__frameSamples')
  assert.ok(removed.every((sample) => Math.abs(sample.userTop - removed[0].userTop) <= 2))
  assert.equal(await evaluate(client, 'window.__originalChat === window.__chatScroll'), true)
  await client.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
  })
  await evaluate(client, 'window.__setCapsuleTasks(1)')
  await settle(client)
  assert.equal(
    await evaluate(
      client,
      'getComputedStyle(document.querySelector("[data-slot=status-capsule]")).transitionDuration'
    ),
    '0s'
  )
  await click(client, '[data-slot="status-capsule-trigger"]')
  await waitFor(
    client,
    'Boolean(document.querySelector("[data-slot=status-capsule-popup]"))',
    '终态查看前展开'
  )
  await evaluate(client, 'window.__setCapsuleTasks(1, "completed"); window.__probeFrames(140)')
  await evaluate(client, 'window.__frameSamples')
  assert.equal(
    await evaluate(client, 'Boolean(document.querySelector("[data-slot=status-capsule-popup]"))'),
    true,
    '正在查看的终态被自动关闭'
  )
  for (const [status, variable] of [
    ['completed', '--status-success'],
    ['failed', '--destructive'],
    ['interrupted', '--status-warning']
  ]) {
    await evaluate(client, `window.__setCapsuleTasks(1, '${status}')`)
    await settle(client)
    const colors = await evaluate(
      client,
      `(() => {
      const preview = document.querySelector('[data-testid=task-capsule-preview]');
      const icon = [...preview.querySelectorAll('button')].find(button => button.textContent.includes('检查界面结构')).querySelector('svg');
      const probe = document.createElement('span'); probe.style.color = 'var(${variable})'; document.body.append(probe);
      const expected = getComputedStyle(probe).color; probe.remove();
      return {actual:getComputedStyle(icon).color, expected};
    })()`
    )
    assert.equal(colors.actual, colors.expected, `${status} 状态色缺失`)
  }
  await writeFile(
    join(runRoot, `capsule-warning-dark-${viewport.width}.png`),
    await screenshot(client)
  )
  await evaluate(
    client,
    `localStorage.setItem('pi-super-theme','light'); window.dispatchEvent(new StorageEvent('storage',{key:'pi-super-theme',newValue:'light'}))`
  )
  await writeFile(
    join(runRoot, `capsule-warning-light-${viewport.width}.png`),
    await screenshot(client)
  )
  await evaluate(client, 'window.__setCapsuleTasks(0)')
  await waitFor(
    client,
    '!document.querySelector("[data-slot=status-capsule-popup]")',
    '任务移除释放浮层'
  )
  await evaluate(client, 'window.__setCapsuleTasks(1)')
  await settle(client)
  assert.equal(
    await evaluate(client, 'Boolean(document.querySelector("[data-slot=status-capsule-popup]"))'),
    false,
    '新任务继承了旧浮层'
  )
  await evaluate(client, 'window.__setCapsuleTasks(0)')
  await client.send('Emulation.setEmulatedMedia', { features: [] })
  await settle(client)
  console.log(`${prefix}：平滑显隐、跟随、历史阅读、浮层、快速切换、减少动态效果通过。`)
}
