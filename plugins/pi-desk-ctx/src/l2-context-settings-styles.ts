export const CONTEXT_SETTINGS_STYLES = `
.pi-desk-ctx-settings {
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}
.pi-desk-ctx-settings [hidden] { display: none; }
.pi-desk-ctx-settings h3, .pi-desk-ctx-settings p { margin: 0; }
.pi-desk-ctx-settings h3 { font-size: .875rem; font-weight: 600; }
.pi-desk-ctx-settings .pi-desk-ctx-header { padding: 1.25rem 1.5rem .75rem; border-bottom: 0; }
.pi-desk-ctx-settings .pi-desk-ctx-pages { margin: 0 1.5rem; gap: 1.5rem; flex: none; }
.pi-desk-ctx-pages > button { gap: .5rem; padding: .25rem 0 .75rem; }
.pi-desk-ctx-icon { width: 1rem; height: 1rem; flex: none; }
.pi-desk-ctx-scroll { min-height: 0; flex: 1; }
.pi-desk-ctx-viewport { padding: 1rem 1.5rem; }
.pi-desk-ctx-form, .pi-desk-ctx-panel { min-width: 0; }
.pi-desk-ctx-form > [role=alert] { margin-bottom: 1rem; }
.pi-desk-ctx-note { color: var(--muted-foreground); font-size: .75rem; line-height: 1.5; }
.pi-desk-ctx-heading, .pi-desk-ctx-heading-copy, .pi-desk-ctx-range, .pi-desk-ctx-activation,
.pi-desk-ctx-checkpoint, .pi-desk-ctx-checkpoint-controls {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .75rem;
}
.pi-desk-ctx-heading, .pi-desk-ctx-range, .pi-desk-ctx-activation, .pi-desk-ctx-checkpoint { justify-content: space-between; }
.pi-desk-ctx-heading-copy { flex-wrap: wrap; gap: .25rem .75rem; }
.pi-desk-ctx-heading { margin-bottom: .75rem; }
.pi-desk-ctx-check { display: inline-flex; min-height: 2rem; align-items: center; gap: .5rem; cursor: pointer; }
.pi-desk-ctx-toggle { display: inline-flex; min-height: 2rem; align-items: center; gap: .625rem; cursor: pointer; }
.pi-desk-ctx-toggle-label { font-size: .8125rem; color: var(--muted-foreground); }
.pi-desk-ctx-settings .pi-desk-ctx-switch {
  position: relative;
  width: 2.25rem;
  height: 1.25rem;
  border: 0;
  border-radius: 2rem;
  background: var(--input);
}
.pi-desk-ctx-settings .pi-desk-ctx-switch::before {
  position: absolute;
  top: .1875rem;
  left: .1875rem;
  width: .875rem;
  height: .875rem;
  clip-path: none;
  border-radius: 50%;
  background: var(--background);
  transform: none;
  transition: transform 150ms ease-out;
}
.pi-desk-ctx-settings .pi-desk-ctx-switch:checked { background: var(--primary); }
.pi-desk-ctx-settings .pi-desk-ctx-switch:checked::before { transform: translateX(1rem); background: var(--primary-foreground); }
.pi-desk-ctx-switch::after { content: ''; position: absolute; inset: -.375rem -.125rem; }
.pi-desk-ctx-model-scroll { overflow-x: auto; padding: .125rem 0 .5rem; border-bottom: 1px solid var(--border); scrollbar-width: thin; }
.pi-desk-ctx-model-row { display: flex; width: max-content; align-items: center; gap: .375rem; }
.pi-desk-ctx-settings .pi-desk-ctx-model-tabs { flex-wrap: nowrap; gap: .25rem; border: 0; }
.pi-desk-ctx-settings .pi-desk-ctx-model-tab { flex: none; border: 0; border-radius: .375rem; padding: .375rem .75rem; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pi-desk-ctx-settings .pi-desk-ctx-model-tab[aria-selected=true] { background: var(--accent); color: var(--accent-foreground); }
.pi-desk-ctx-tab-error, .pi-desk-ctx-error { color: var(--destructive); }
.pi-desk-ctx-error { grid-column: 1/-1; font-size: .8125rem; }
.pi-desk-ctx-settings .pi-desk-ctx-icon-button { width: 2rem; min-height: 2rem; flex: none; padding: .375rem; }
.pi-desk-ctx-range { min-height: 2.25rem; margin-top: .75rem; }
.pi-desk-ctx-range-expression { display: flex; align-items: center; gap: .625rem; color: var(--muted-foreground); font-size: .8125rem; font-variant-numeric: tabular-nums; }
.pi-desk-ctx-range-field { width: 7rem; }
.pi-desk-ctx-range .pi-desk-ctx-delete { font-size: .75rem; }
.pi-desk-ctx-delete:hover { color: var(--destructive); }
.pi-desk-ctx-section { margin-top: 1.5rem; }
.pi-desk-ctx-rules { border: 1px solid var(--border); border-radius: .5rem; background: var(--muted); }
.pi-desk-ctx-rule-wrap { position: relative; }
.pi-desk-ctx-rule-wrap + .pi-desk-ctx-rule-wrap { border-top: 1px solid var(--border); }
.pi-desk-ctx-rule {
  display: grid;
  grid-template-columns: 1.5rem minmax(0,1fr) 1.25rem minmax(0,1fr) 2rem;
  align-items: center;
  gap: .75rem;
  min-width: 0;
  margin: 0;
  padding: .75rem 1rem;
  border: 0;
}
.pi-desk-ctx-rule:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.pi-desk-ctx-rule-number, .pi-desk-ctx-and { color: var(--muted-foreground); font-size: .75rem; }
.pi-desk-ctx-and { text-align: center; }
.pi-desk-ctx-or { position: absolute; left: 1rem; top: -.625rem; padding: 0 .25rem; background: var(--muted); color: var(--muted-foreground); font-size: .75rem; }
.pi-desk-ctx-field { display: grid; min-width: 0; align-items: center; gap: .375rem .75rem; }
.pi-desk-ctx-label { display: flex; min-height: 2rem; align-items: center; }
.pi-desk-ctx-rule .pi-desk-ctx-field, .pi-desk-ctx-retain .pi-desk-ctx-field { grid-template-columns: minmax(0,1fr) minmax(5rem,8.5rem); }
.pi-desk-ctx-rule .pi-desk-ctx-check { color: var(--muted-foreground); }
.pi-desk-ctx-amount { display: flex; align-items: center; gap: .5rem; min-width: 0; min-height: 2.25rem; border: 1px solid var(--input); border-radius: .375rem; padding: 0 .625rem; background: var(--card); }
.pi-desk-ctx-amount:focus-within { outline: 2px solid var(--ring); outline-offset: -2px; }
.pi-desk-ctx-amount:has([aria-invalid=true]) { border-color: var(--destructive); }
.pi-desk-ctx-amount:has(input:disabled) { opacity: .5; }
.pi-desk-ctx-settings .pi-desk-ctx-input { min-width: 0; min-height: 2rem; border: 0; border-radius: 0; padding: .25rem 0; background: transparent; outline: none; font-variant-numeric: tabular-nums; appearance: textfield; }
.pi-desk-ctx-input::-webkit-inner-spin-button, .pi-desk-ctx-input::-webkit-outer-spin-button { appearance: none; margin: 0; }
.pi-desk-ctx-operator, .pi-desk-ctx-unit { color: var(--muted-foreground); flex: none; font-size: .75rem; }
.pi-desk-ctx-retain { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 1.75rem; }
.pi-desk-ctx-retain .pi-desk-ctx-field { grid-template-columns: minmax(0,1fr) 7rem; }
.pi-desk-ctx-empty { padding: 1.5rem 1rem; color: var(--muted-foreground); }
.pi-desk-ctx-checkpoint { margin-top: 1.25rem; padding-top: 1rem; border-top: 1px solid var(--border); }
.pi-desk-ctx-checkpoint p, .pi-desk-ctx-activation p { margin-top: .25rem; }
.pi-desk-ctx-checkpoint-amount { width: 8.5rem; }
.pi-desk-ctx-hidden, .pi-desk-ctx-range-field .pi-desk-ctx-label, .pi-desk-ctx-checkpoint-amount .pi-desk-ctx-label {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.pi-desk-ctx-paused { margin: 0 0 .75rem !important; padding: .625rem .75rem; border-left: 2px solid var(--input); background: var(--muted); color: var(--muted-foreground); font-size: .8125rem; }
.pi-desk-ctx-image-budget { display: grid; grid-template-columns: minmax(0,1fr) 2rem minmax(0,1fr); align-items: center; gap: 1.25rem; margin-top: 1rem; padding: 1rem 1.5rem; border: 1px solid var(--border); border-radius: .5rem; background: var(--muted); }
.pi-desk-ctx-image-budget .pi-desk-ctx-label { min-height: 0; color: var(--muted-foreground); }
.pi-desk-ctx-image-budget .pi-desk-ctx-amount { min-height: 3.25rem; padding-inline: .875rem; }
.pi-desk-ctx-image-budget .pi-desk-ctx-input { font-size: 1.375rem; }
.pi-desk-ctx-image-arrow { justify-self: center; margin-top: 2.25rem; color: var(--muted-foreground); }
.pi-desk-ctx-image-retain { margin-top: .5rem; }
.pi-desk-ctx-image-retain > .pi-desk-ctx-field { grid-template-columns: minmax(0,1fr) 8rem; gap: .25rem 1rem; padding: .75rem 0; border-bottom: 1px solid var(--border); }
.pi-desk-ctx-image-retain .pi-desk-ctx-label { min-height: 0; }
.pi-desk-ctx-image-retain .pi-desk-ctx-amount { grid-column: 2; grid-row: 1/3; }
.pi-desk-ctx-field-description { color: var(--muted-foreground); font-size: .75rem; }
.pi-desk-ctx-image-retain + .pi-desk-ctx-note { margin-top: .75rem; }
.pi-desk-ctx-image-notice { margin-top: 1.25rem; padding: .75rem; border: 1px solid var(--border); border-radius: .5rem; }
.pi-desk-ctx-image-notice p { margin-top: .25rem; }
.pi-desk-ctx-footer { flex: none; border-top: 1px solid var(--border); padding: .75rem 1rem; }
.pi-desk-ctx-footer-end { margin-left: auto; }
.pi-desk-ctx-unsaved { color: var(--muted-foreground); font-size: .75rem; }
@container (max-width:48rem) {
  .pi-desk-ctx-rule .pi-desk-ctx-field, .pi-desk-ctx-retain .pi-desk-ctx-field { grid-template-columns: minmax(0,1fr); }
  .pi-desk-ctx-and, .pi-desk-ctx-rule .pi-desk-ctx-delete { align-self: end; margin-bottom: .125rem; min-height: 2rem; }
  .pi-desk-ctx-and { display: grid; align-items: center; }
}
@container (max-width:32rem) {
  .pi-desk-ctx-settings .pi-desk-ctx-header { padding: 1rem; }
  .pi-desk-ctx-settings .pi-desk-ctx-pages { margin-inline: 1rem; }
  .pi-desk-ctx-viewport { padding: 1rem; }
  .pi-desk-ctx-heading-copy { flex-direction: column; align-items: flex-start; gap: .25rem; }
  .pi-desk-ctx-heading { align-items: flex-start; }
  .pi-desk-ctx-rule { grid-template-columns: minmax(0,1fr) 1rem minmax(0,1fr) 1.75rem; gap: .375rem; padding: .75rem; }
  .pi-desk-ctx-rule-number { display: none; }
  .pi-desk-ctx-rule .pi-desk-ctx-check { font-size: .75rem; gap: .25rem; }
  .pi-desk-ctx-rule .pi-desk-ctx-icon-button { width: 1.75rem; min-height: 2rem; }
  .pi-desk-ctx-retain { gap: 1rem; }
  .pi-desk-ctx-retain-heading { flex-direction: column; align-items: flex-start; gap: .25rem; }
  .pi-desk-ctx-range { flex-wrap: wrap; gap: .25rem; }
  .pi-desk-ctx-range-expression { gap: .375rem; }
  .pi-desk-ctx-range-field { width: 6rem; }
  .pi-desk-ctx-checkpoint { flex-wrap: wrap; gap: 1rem; }
  .pi-desk-ctx-checkpoint-controls { margin-left: auto; }
  .pi-desk-ctx-image-budget { gap: .75rem; grid-template-columns: minmax(0,1fr) 1rem minmax(0,1fr); padding: 1rem; }
  .pi-desk-ctx-image-budget .pi-desk-ctx-amount { padding-inline: .5rem; }
  .pi-desk-ctx-image-retain > .pi-desk-ctx-field { grid-template-columns: minmax(0,1fr) 6rem; }
  .pi-desk-ctx-settings .pi-desk-ctx-input { font-size: 1rem; }
  .pi-desk-ctx-image-budget .pi-desk-ctx-input { font-size: 1.25rem; }
  .pi-desk-ctx-unsaved { display: none; }
}
@media (prefers-reduced-motion:reduce) { .pi-desk-ctx-settings .pi-desk-ctx-switch::before { transition: none; } }
`
