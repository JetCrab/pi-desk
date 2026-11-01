export const QUOTA_STYLES = `
.quota-application {
  display: flex;
  flex-direction: column;
  width: min(960px, calc(100dvw - 2rem));
  max-height: min(820px, calc(100dvh - 7rem));
  min-height: 0;
  gap: .75rem;
  padding: 1rem;
  overflow: hidden;
  container: quota-panel / inline-size;
}
.quota-actions, .quota-toolbar, .quota-pagination, .quota-settings-head, .quota-editor-head {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: .5rem;
}
.quota-actions { flex-wrap: wrap; flex-shrink: 0; }
.quota-toolbar { flex-wrap: wrap; justify-content: space-between; }
.quota-search { flex: 1; min-width: min(220px, 100%); }
.quota-filters { display: grid; min-width: 0; gap: .5rem; flex: none; }
.quota-channel-tabs { min-width: 0; }
.quota-tabs { flex-wrap: nowrap; width: max-content; min-width: 100%; }
.quota-tabs > button { flex: none; white-space: nowrap; }
.quota-filters .quota-channel-select { display: none; }
.quota-meta {
  color: var(--pi-desk-plugin-muted-foreground, var(--muted-foreground));
  font-size: .75rem;
  line-height: 1.5;
}
.quota-warning { color: var(--status-warning, var(--foreground)); font-size: .75rem; line-height: 1.5; }
.quota-truncate { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.quota-section-title, .quota-channel-heading {
  margin: 0;
  font-size: .875rem;
  line-height: 1.5;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.quota-channel-heading {
  padding: .5rem .75rem;
  background: var(--pi-desk-plugin-muted, var(--muted));
}
.quota-record + .quota-channel-heading { margin-top: 1rem; }
.quota-record-scroll { flex: 1 1 auto; min-height: 0; }
.quota-record-viewport { min-width: 0; }
.quota-record { min-width: 0; border-bottom: 1px solid var(--border); }
.quota-record-summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
  gap: 1rem;
  align-items: center;
  min-height: 3.5rem;
  padding: .5rem .75rem;
}
.quota-record-identity, .quota-editor-title { display: grid; min-width: 0; gap: .25rem; }
.quota-record-name { min-width: 0; overflow-wrap: anywhere; font-size: .875rem; font-weight: 500; line-height: 1.5; }
.quota-record-tags { display: flex; flex-wrap: wrap; min-width: 0; align-items: center; gap: .25rem; }
.quota-tag { padding: 0 .375rem; border-radius: 4px; background: var(--muted); color: var(--muted-foreground); font-size: .75rem; line-height: 1.5; overflow-wrap: anywhere; }
.quota-record-tags .quota-detail-toggle { min-height: 1.75rem; padding: 0 .375rem; font-size: .75rem; }
.quota-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); min-width: 0; align-items: start; gap: .25rem .5rem; }
.quota-metrics > .quota-metric:last-child:nth-child(odd), .quota-metrics-empty { grid-column: 1 / -1; }
.quota-metric { position: relative; min-width: 0; min-height: 1.5rem; padding: .125rem .375rem .25rem; border-radius: 4px; background: var(--muted); overflow-wrap: anywhere; }
.quota-metric-reading { display: flex; min-width: 0; align-items: baseline; gap: .375rem; font-size: .75rem; line-height: 1.5; }
.quota-metric-label { flex: 1; min-width: 0; }
.quota-metric-reset { flex: none; color: var(--muted-foreground); white-space: nowrap; font-variant-numeric: tabular-nums; }
.quota-metric-value { flex: none; font-size: .75rem; font-weight: 600; white-space: nowrap; font-variant-numeric: tabular-nums; }
.quota-progress { position: absolute; inset: auto .375rem 0; height: 2px; overflow: hidden; border-radius: 999px; background: var(--border); }
.quota-progress > span { display: block; height: 100%; border-radius: inherit; background: var(--primary); transition: width 150ms ease-out; }
.quota-metric[data-quota-tone="warning"] .quota-progress > span { background: var(--status-warning, var(--foreground)); }
.quota-metric[data-quota-tone="error"] .quota-progress > span { background: var(--destructive); }
.quota-record-detail { display: grid; gap: .375rem; padding: .5rem .75rem .75rem; background: var(--muted); font-size: .75rem; line-height: 1.5; overflow-wrap: anywhere; }
.quota-detail-metadata { display: flex; flex-wrap: wrap; gap: .25rem 1rem; margin: 0; }
.quota-detail-metadata > div { display: flex; min-width: 0; gap: .375rem; }
.quota-detail-metadata dt { flex: none; color: var(--muted-foreground); }
.quota-detail-metadata dd { min-width: 0; margin: 0; font-variant-numeric: tabular-nums; }
.quota-detail-error { width: 100%; }
.quota-resource-detail, .quota-resource-supplement { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: .5rem; padding-top: .375rem; border-top: 1px solid var(--border); }
.quota-resource-detail > div, .quota-resource-supplement > div { display: flex; flex-wrap: wrap; min-width: 0; gap: .25rem .75rem; font-variant-numeric: tabular-nums; }
.quota-resource-detail strong { font-weight: 500; }
.quota-error-text { overflow-wrap: anywhere; }
.quota-pagination { flex: none; justify-content: space-between; flex-wrap: wrap; padding-top: .5rem; border-top: 1px solid var(--border); }
.quota-empty-actions { justify-content: center; margin-top: .75rem; }
.quota-source-notices { padding: .5rem .75rem; border-bottom: 1px solid var(--border); }
.quota-source-notices summary { cursor: pointer; min-height: 1.75rem; line-height: 1.75rem; }
.quota-source-notices summary:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.quota-source-errors { display: grid; gap: .75rem; padding: .5rem 0; }
.quota-error-text { margin-top: .25rem; }
.quota-visibility { display: grid; min-width: 0; gap: .5rem; container: quota-panel / inline-size; }
.quota-visibility-filters { display: grid; grid-template-columns: minmax(140px, 1fr) minmax(0, 2fr); align-items: end; gap: .75rem; margin-bottom: .5rem; }
.quota-visibility-channel + .quota-visibility-channel { border-top: 1px solid var(--border); padding-top: .75rem; }
.quota-visibility-heading { display: flex; align-items: center; justify-content: space-between; gap: .5rem; min-height: 1.75rem; }
.quota-selection { display: flex; min-width: 0; min-height: 1.75rem; align-items: center; gap: .5rem; cursor: pointer; }
.quota-selection > input { flex: none; }
.quota-visibility-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .5rem .75rem; padding: .5rem 0; }
.quota-visibility-options .quota-selection { align-items: flex-start; overflow-wrap: anywhere; }
.quota-settings {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  max-height: 100%;
  min-height: 0;
  overflow: hidden;
  container-name: quota-settings;
}
.quota-settings-head { justify-content: space-between; padding: 1rem; flex-wrap: wrap; }
.quota-display-settings { display: grid; align-content: start; gap: .75rem; padding: 0 1rem 1rem; }
.quota-display-settings > * { max-width: 640px; }
.quota-settings-body { display: grid; grid-template-columns: 224px minmax(0, 1fr); min-height: 0; min-width: 0; overflow: hidden; }
.quota-settings-navigation { display: flex; flex-direction: column; gap: .75rem; min-height: 0; min-width: 0; padding: 0 .75rem 1rem 1rem; border-right: 1px solid var(--border); }
.quota-source-navigation-scroll { min-height: 0; flex: 1; }
.quota-source-navigation-viewport { min-width: 0; }
.quota-source-group + .quota-source-group { margin-top: .75rem; }
.quota-source-group-title { margin: 0; padding: .25rem .5rem; color: var(--muted-foreground); font-size: .75rem; font-weight: 500; overflow-wrap: anywhere; }
.quota-settings .quota-source-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; width: 100%; min-height: 2.25rem; }
.quota-source-item-state { white-space: nowrap; }
.quota-editor-scroll { min-height: 0; min-width: 0; }
.quota-editor-viewport { padding: 0 1rem 1rem; scroll-padding-block: .5rem; container: quota-editor / inline-size; }
.quota-editor-head { justify-content: space-between; align-items: flex-start; max-width: 640px; margin-bottom: 1rem; }
.quota-editor-head .quota-section-title { font-size: .875rem; }
.quota-source-form { display: grid; max-width: 640px; gap: .75rem; grid-template-columns: minmax(0, 1fr); }
.quota-field-wide { grid-column: 1 / -1; }
.quota-source-enabled { display: flex; min-height: 2rem; align-items: center; align-self: end; gap: .5rem; cursor: pointer; }
.quota-add-source { max-width: 640px; }
.quota-settings-footer {
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: .5rem;
  padding: .75rem 1rem;
  border-top: 1px solid var(--border);
  background: var(--popover);
}
.quota-settings-footer > .quota-actions { margin-left: auto; }
.quota-settings .quota-back { display: none; margin-bottom: .75rem; }
.quota-settings-body[data-empty="true"] { grid-template-columns: minmax(0, 1fr); }
.quota-settings-body[data-empty="true"] .quota-settings-navigation { display: none; }
@container quota-panel (max-width: 44rem) {
  .quota-filters .quota-channel-tabs { display: none; }
  .quota-filters .quota-channel-select { display: block; }
  .quota-record-summary { grid-template-columns: minmax(0, 1fr); gap: .375rem; }
  .quota-record-identity { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .5rem; }
  .quota-record-tags { margin-left: auto; }
  .quota-resource-detail, .quota-resource-supplement { grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr); }
  .quota-visibility-options, .quota-visibility-filters { grid-template-columns: minmax(0, 1fr); }
}
@container quota-settings (max-width: 51.999rem) {
  .quota-settings-body { grid-template-columns: minmax(0, 1fr); }
  .quota-settings-navigation { border-right: 0; padding-right: 1rem; }
  .quota-settings[data-editing="true"] .quota-settings-navigation { display: none; }
  .quota-settings[data-editing="false"] .quota-editor-scroll { display: none; }
  .quota-settings .quota-back { display: inline-flex; }
}
@container quota-editor (min-width: 32rem) {
  .quota-source-form { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .quota-progress > span { transition: none; }
}
`
