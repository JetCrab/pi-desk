import 'server-only'

import { L4TerminalError } from './l4-terminal-pty'

const MAX_CONTROL_BYTES = 1024 * 1024

// 快照只在完整 VT 指令之间形成，不能把 headless 未完成的解析器状态留给新观察者。
export class L4TerminalOutput {
  private pending = ''
  private state: 'ground' | 'escape' | 'csi' | 'string' | 'string-escape' = 'ground'
  private osc = false

  frame(data: string): string {
    const text = this.pending + data
    let complete = 0
    for (let i = this.pending.length; i < text.length; i += 1) {
      const code = text.charCodeAt(i)
      if (code === 0x18 || code === 0x1a) this.state = 'ground'
      else if (this.state === 'ground') {
        if (code === 0x1b) this.state = 'escape'
        else if (code === 0x9b) this.state = 'csi'
        else if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
          this.osc = code === 0x9d
          this.state = 'string'
        }
      } else if (this.state === 'escape') {
        if (code === 0x5b) this.state = 'csi'
        else if ([0x50, 0x58, 0x5d, 0x5e, 0x5f].includes(code)) {
          this.osc = code === 0x5d
          this.state = 'string'
        } else if (code >= 0x30 && code <= 0x7e) this.state = 'ground'
      } else if (this.state === 'csi') {
        if (code === 0x1b) this.state = 'escape'
        else if (code >= 0x40 && code <= 0x7e) this.state = 'ground'
      } else if (this.state === 'string') {
        if (code === 0x9c || (this.osc && code === 7)) this.state = 'ground'
        else if (code === 0x1b) this.state = 'string-escape'
      } else if (this.state === 'string-escape') {
        if (code === 0x5c) this.state = 'ground'
        else if (code !== 0x1b) this.state = 'string'
      }
      if (this.state === 'ground') complete = i + 1
    }
    this.pending = text.slice(complete)
    if (Buffer.byteLength(this.pending) > MAX_CONTROL_BYTES)
      throw new L4TerminalError(429, '终端控制序列超出缓冲上限')
    return text.slice(0, complete)
  }

  dispose(): void {
    this.pending = ''
  }
}

export function splitL4TerminalOutput(data: string, maxBytes = 16 * 1024): string[] {
  const chunks: string[] = []
  let start = 0
  let bytes = 0
  for (let i = 0; i < data.length;) {
    const code = data.codePointAt(i)!
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
    if (bytes + size > maxBytes) {
      chunks.push(data.slice(start, i))
      start = i
      bytes = 0
    }
    bytes += size
    i += code > 0xffff ? 2 : 1
  }
  if (start < data.length) chunks.push(data.slice(start))
  return chunks
}
