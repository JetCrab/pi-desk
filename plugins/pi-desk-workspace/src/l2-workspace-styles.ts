export const WORKSPACE_STYLES = `
.workspace-panel { display: flex; height: 100%; min-height: 0; flex-direction: column; background: var(--background); }
.workspace-panel .pi-desk-ui-panel-header-copy { flex: 1; grid-template-columns: minmax(0, 1fr); overflow: hidden; }
.workspace-project-title { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.workspace-body { min-height: 0; flex: 1; }
.workspace-body-viewport { display: grid; align-content: start; gap: .75rem; padding: .5rem; }
.workspace-list-groups { display: grid; min-width: 0; gap: .5rem; }
.workspace-group-label { padding: .25rem .5rem; color: var(--muted-foreground); font-size: .75rem; }
.workspace-available-toggle { width: 100%; justify-content: space-between; color: var(--muted-foreground); }
.workspace-list-subtitle { display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted-foreground); font-size: .75rem; line-height: 1.5; }
.workspace-status, .workspace-dialog-meta { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: .5rem; }
.workspace-dialog-description { display: grid; gap: .75rem; }
.workspace-occupation-time { display: flex; flex-wrap: wrap; gap: .25rem 1rem; font-size: .75rem; line-height: 1.5; }
.workspace-occupation-time time { color: var(--foreground); font-variant-numeric: tabular-nums; }
.workspace-list-copy { display: grid; min-width: 0; flex: 1; gap: .375rem; }
.workspace-list-meta { display: flex; min-width: 0; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; }
.workspace-list-name, .workspace-dialog-title, .workspace-command-description { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; overflow-wrap: anywhere; }
.workspace-list-name { font-size: .875rem; line-height: 1.5; font-weight: 500; }
.workspace-dialog-title { outline: none; }
.workspace-list-arrow { flex: none; align-self: center; color: var(--muted-foreground); }
.workspace-list-usage { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted-foreground); font-size: .75rem; line-height: 1.5; }
.workspace-list-usage[data-error=true], .workspace-danger { color: var(--destructive); }
.workspace-detail, .workspace-information, .workspace-command-form { display: grid; min-width: 0; gap: 1rem; }
.workspace-detail { container-type: inline-size; }
.workspace-detail [hidden] { display: none; }
.workspace-quick-actions { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; }
.workspace-quick-actions > :last-child { margin-left: auto; }
.workspace-tabs { width: 100%; gap: 1.25rem; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; padding: 0; }
.workspace-tabs > button { min-width: 0; padding: .5rem 0; background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0; color: var(--muted-foreground); box-shadow: none; }
.workspace-tabs > button[aria-selected=true] { background: transparent; border-bottom-color: var(--foreground); color: var(--foreground); box-shadow: none; }
.workspace-command-copy { display: grid; min-width: 0; flex: 1; gap: .25rem; }
.workspace-command-name { min-width: 0; font-size: .875rem; font-weight: 500; overflow-wrap: anywhere; }
.workspace-command-description, .workspace-description { margin: 0; color: var(--muted-foreground); font-size: .875rem; line-height: 1.5; overflow-wrap: anywhere; }
.workspace-requirement, .workspace-preserve-text { color: var(--foreground); white-space: pre-wrap; }
.workspace-caption { font-size: .75rem; line-height: 1.5; color: var(--muted-foreground); overflow-wrap: anywhere; }
.workspace-path { display: block; min-width: 0; font-size: .875rem; line-height: 1.5; overflow-wrap: anywhere; }
.workspace-fields { display: grid; min-width: 0; gap: .75rem; }
.workspace-fields:empty { display: none; }
.workspace-records { display: grid; min-width: 0; gap: .75rem; }
.workspace-records-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .5rem; }
.workspace-operations { min-width: 0; }
.workspace-operation { min-width: 0; border-bottom: 1px solid var(--border); }
.workspace-operation:last-child { border-bottom: 0; }
.workspace-operation-head { display: grid; grid-template-columns: minmax(0, 1fr) auto .75rem; align-items: center; gap: .75rem; padding: .875rem .25rem; cursor: pointer; list-style: none; border-radius: .375rem; }
.workspace-operation-head::-webkit-details-marker { display: none; }
.workspace-operation-head:hover { background: var(--muted); }
.workspace-operation-head:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.workspace-operation-state { display: flex; align-items: center; gap: .75rem; }
.workspace-operation-state time { font-variant-numeric: tabular-nums; white-space: nowrap; }
.workspace-operation-arrow { color: var(--muted-foreground); text-align: center; transition: transform 150ms ease-out; }
.workspace-operation[open] .workspace-operation-arrow { transform: rotate(90deg); }
.workspace-operation-body { display: grid; min-width: 0; gap: .75rem; padding: 0 .25rem 1rem; }
.workspace-operation-times { display: flex; flex-wrap: wrap; gap: .25rem 1rem; }
.workspace-operation-summary { max-height: 15rem; overflow: auto; padding: .75rem; border-radius: .5rem; background: var(--muted); }
.workspace-log { min-width: 0; overflow: hidden; }
.workspace-error { margin-bottom: .75rem; outline: none; }
.workspace-confirm { display: grid; min-width: 0; gap: .75rem; }
.workspace-management { padding: .75rem; border-radius: .5rem; background: var(--muted); }
@container (max-width: 30rem) {
  .workspace-quick-actions { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; }
  .workspace-quick-actions > :first-child { grid-column: 1 / -1; }
  .workspace-quick-actions > :last-child { margin-left: 0; }
  .workspace-quick-actions > button { min-height: 2.5rem; }
  .workspace-tabs { gap: 1rem; }
  .workspace-operation-state { flex-direction: column; align-items: flex-end; gap: .25rem; }
}
@media (prefers-reduced-motion: reduce) {
  .workspace-operation-arrow { transition: none; }
}
`
