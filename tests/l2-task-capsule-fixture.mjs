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
        if (message.head?.path === 'chat/source-event' && message.body?.event?.runtime) {
          window.__capsuleRuntime = message.body.event.runtime;
          window.__capsuleSource = message.body.source;
        }
      });
    }
  };
  window.__setCapsuleTasks = (count, status = 'running') => {
    const runtime = structuredClone(window.__capsuleRuntime);
    runtime.plugins['task-center'] = { tasks: Array.from({ length: count }, (_, index) => ({
      taskId: 'capsule-task-' + index, taskKind: '测试', taskType: 'fixture',
      title: index === 0 ? '检查界面结构' : '核对移动端布局',
      activity: '验证任务胶囊与聊天位置', info: [], status,
      startedAt: Date.now() - 1000, endedAt: status === 'running' ? null : Date.now()
    })) };
    window.__capsuleSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      head: { op: 'push', path: 'chat/source-event' },
      body: { source: window.__capsuleSource, event: { type: 'runtime_update', runtime } }
    }) }));
  };
`

async function click(client, selector) {
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
    window.__chatScroll.click();
    window.__chatScroll.scrollTop = window.__chatScroll.scrollHeight;
    document.querySelector('textarea').focus({ preventScroll: true });
    window.__originalChat = window.__chatScroll;
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
  await writeFile(join(runRoot, `capsule-${viewport.width}.png`), await screenshot(client))
  for (const type of ['keyDown', 'keyUp'])
    await client.send('Input.dispatchKeyEvent', {
      type,
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27
    })
  await waitFor(
    client,
    '!document.querySelector("[data-slot=status-capsule-popup]")',
    'Escape关闭胶囊'
  )
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
