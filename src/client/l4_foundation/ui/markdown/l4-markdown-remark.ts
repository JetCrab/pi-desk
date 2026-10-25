export const L4_MARKDOWN_ALLOWED_TAGS = {
  input: ['dataPiMarkdownProgress'],
  blockquote: ['dataPiMarkdownAlert']
}

// 仅描述本转换读取的 mdast 字段，不引入另一套解析器或运行依赖。
interface MarkdownNode {
  type: string
  value?: string
  children?: MarkdownNode[]
  position?: { start: { offset?: number } }
  data?: {
    hName?: string
    hProperties?: Record<string, string | boolean | string[]>
  }
}

function statusNode(marker: string): MarkdownNode {
  return {
    type: 'paragraph',
    children: [],
    data: {
      hName: 'input',
      hProperties: {
        type: 'checkbox',
        disabled: true,
        checked: marker.toLowerCase() === '[x]',
        ...(marker === '[-]' ? { dataPiMarkdownProgress: 'true' } : {})
      }
    }
  }
}

export function remarkL4Markdown(): (tree: MarkdownNode, file: { value: unknown }) => void {
  return (tree, file): void => {
    const source = String(file.value)
    const isLiteral = (node: MarkdownNode, marker: string): boolean => {
      const start = node.position?.start.offset
      return start !== undefined && source.slice(start, start + marker.length) === marker
    }

    const visit = (node: MarkdownNode): void => {
      const first = node.children?.[0]
      if (node.type === 'tableCell' && node.children?.length === 1 && first?.type === 'text') {
        const marker = first.value ?? ''
        if (/^\[[ xX-]\]$/.test(marker) && isLiteral(first, marker)) {
          node.children = [statusNode(marker)]
        }
      } else if (node.type === 'listItem' && first?.type === 'paragraph') {
        const text = first.children?.[0]
        if (
          text?.type === 'text' &&
          /^\[-\](?:\s|$)/.test(text.value ?? '') &&
          isLiteral(text, '[-]')
        ) {
          text.value = text.value!.slice(3)
          first.children!.unshift(statusNode('[-]'))
          node.data = { ...node.data, hProperties: { className: ['task-list-item'] } }
        }
      } else if (node.type === 'blockquote' && first?.type === 'paragraph') {
        const text = first.children?.[0]
        const match = text?.value?.match(
          /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/
        )
        if (
          text?.type === 'text' &&
          match &&
          isLiteral(text, `[!${match[1]}]`) &&
          (match[0].endsWith('\n') ||
            first.children!.length === 1 ||
            first.children![1]?.type === 'break')
        ) {
          text.value = text.value!.slice(match[0].length)
          if (!text.value) {
            first.children!.shift()
            if (first.children![0]?.type === 'break') first.children!.shift()
          }
          if (first.children!.length === 0) node.children!.shift()
          node.data = {
            ...node.data,
            hProperties: { dataPiMarkdownAlert: match[1]!.toLowerCase() }
          }
        }
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree)
  }
}
