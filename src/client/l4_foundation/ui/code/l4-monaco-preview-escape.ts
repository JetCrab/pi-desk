import type { editor } from 'monaco-editor'

export function bindL4MonacoPreviewEscape(
  codeEditor: editor.IStandaloneCodeEditor,
  escapeKeyCode: number,
  onEscape: () => void
): void {
  // Monaco 消费正文键盘事件，只有所有局部交互都关闭时才交还文件容器。
  codeEditor.addCommand(
    escapeKeyCode,
    onEscape,
    'editorTextFocus && !findWidgetVisible && !suggestWidgetVisible && !renameInputVisible && !parameterHintsVisible && !referenceSearchVisible && !editorHoverVisible && !editorHoverFocused'
  )
}
