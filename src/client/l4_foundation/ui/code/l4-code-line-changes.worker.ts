import { computeL4LineChanges, type L4LineChange } from './l4-code-line-changes'

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<{ original: string; modified: string }>) => void) | null
  postMessage: (changes: L4LineChange[] | null) => void
}

scope.onmessage = (event): void => {
  scope.postMessage(computeL4LineChanges(event.data.original, event.data.modified))
}
