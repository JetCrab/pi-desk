import { cjk } from '@streamdown/cjk'
import { Streamdown } from 'streamdown'
const PLUGIN_MARKDOWN_PLUGINS = { cjk }
const COMPACT_CODE_CONTROLS = {
  code: {
    copy: true,
    download: false
  }
} as const

function classNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ')
}

export interface PluginMarkdownProps {
  content: string
  className?: string
}

export function PluginMarkdown({ content, className }: PluginMarkdownProps): React.JSX.Element {
  return (
    <Streamdown
      className={classNames('pi-desk-ui-markdown space-y-0', className)}
      controls={COMPACT_CODE_CONTROLS}
      lineNumbers={false}
      plugins={PLUGIN_MARKDOWN_PLUGINS}
    >
      {content}
    </Streamdown>
  )
}
