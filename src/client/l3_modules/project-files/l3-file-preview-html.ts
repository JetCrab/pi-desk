const HTML_SHORTCUT_SCRIPT = `<script>
window.addEventListener('keydown', function (event) {
  if (event.defaultPrevented || event.isComposing || event.repeat) return;
  if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
    event.preventDefault();
    window.parent.postMessage('pi-desk:file-escape', '*');
  } else if (event.key === 'Tab' && event.ctrlKey && !event.altKey && !event.metaKey) {
    event.preventDefault();
    window.parent.postMessage('pi-desk:file-switch-pane', '*');
  }
});
</script>`

export function buildL3FilePreviewHtml(content: string): string {
  // sandbox iframe 是独立文档，键盘事件不会冒泡到宿主。父级只接受当前 iframe Window 的信号。
  return `${content}\n${HTML_SHORTCUT_SCRIPT}`
}
