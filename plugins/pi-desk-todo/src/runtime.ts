import type { SessionPluginFacade } from '@jetcrab/pi-desk-sdk/session'
import { parseTodoInput, type TodoSnapshot } from './contract.js'

export class TodoRuntime {
  private snapshot: TodoSnapshot = { todo: null, hidden: false }

  constructor(private readonly plugin: SessionPluginFacade) {}

  replace(input: unknown): TodoSnapshot {
    const todo = parseTodoInput(input)
    this.snapshot = { todo, hidden: false }
    this.plugin.push('changed', {})
    return this.get()
  }

  get(): TodoSnapshot {
    return JSON.parse(JSON.stringify(this.snapshot)) as TodoSnapshot
  }

  hide(): TodoSnapshot {
    this.snapshot.hidden = true
    this.plugin.push('changed', {})
    return this.get()
  }

  clear(): void {
    this.snapshot = { todo: null, hidden: false }
    this.plugin.push('changed', {})
  }
}
