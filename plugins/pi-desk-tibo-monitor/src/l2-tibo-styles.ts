export const TIBO_STYLES = `
.tibo-page{display:grid;gap:1.5rem;min-width:0;padding:1rem;container-type:inline-size}
.tibo-settings,.tibo-feed{display:grid;gap:1.5rem;min-width:0}
.tibo-form{display:grid;gap:.75rem;max-width:40rem;min-width:0}
.tibo-history,.tibo-advanced,.tibo-status-details{min-width:0}
.tibo-history>summary,.tibo-advanced>summary,.tibo-status-details>summary{width:fit-content;min-height:2rem;align-content:center;font-size:.875rem;cursor:pointer}
.tibo-advanced[open]>.tibo-fields,.tibo-status-details[open]>.tibo-status{margin-top:.75rem}
.tibo-status-details>p,.tibo-status-details>div{margin-top:.5rem}
.tibo-history>summary:focus-visible,.tibo-advanced>summary:focus-visible,.tibo-status-details>summary:focus-visible,.tibo-original>summary:focus-visible,.tibo-analysis>summary:focus-visible,.tibo-time-details>summary:focus-visible{outline:2px solid var(--ring);outline-offset:2px;border-radius:.375rem}
.tibo-toggle{display:flex;align-items:center;gap:.5rem;min-height:2rem;cursor:pointer;width:fit-content}
.tibo-fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.75rem}
.tibo-status,.tibo-record-top,.tibo-meta{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.tibo-note{color:var(--muted-foreground);font-size:.75rem;line-height:1.5;overflow-wrap:anywhere}
.tibo-form>p.tibo-note{font-size:.875rem}
.tibo-page p,.tibo-post p{margin:0}
.tibo-records{display:grid;min-width:0;margin-bottom:.75rem}
.tibo-record{display:grid;gap:.375rem;width:100%;min-width:0;padding:.75rem .5rem;text-align:left;font:inherit;color:inherit;background:transparent;border:0;border-bottom:1px solid var(--border);border-radius:.375rem;cursor:pointer;transition:background-color 150ms ease-out}
.tibo-record:hover,.tibo-record[aria-current=true]{background:var(--accent)}.tibo-record:active{background:var(--muted)}.tibo-record:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
.tibo-preview{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;line-height:1.5}
.tibo-preview-quote{color:var(--muted-foreground);font-size:.875rem;-webkit-line-clamp:1}
.tibo-empty{display:grid;gap:.75rem;justify-items:start;padding:1.5rem 0;color:var(--muted-foreground);line-height:1.5}
.tibo-post{display:grid;gap:1.25rem;min-width:0;overflow-wrap:anywhere}
.tibo-post .tibo-copy{white-space:pre-wrap;line-height:1.8;font-size:1rem;margin:0}
.tibo-post .tibo-meta{font-size:.75rem;color:var(--muted-foreground);justify-content:space-between}
.tibo-post a{color:var(--foreground);text-decoration:underline;text-underline-offset:3px}
.tibo-story{display:grid;gap:1.25rem;max-width:46rem;min-width:0}
.tibo-main-post{display:grid;gap:.5rem}
.tibo-author{font-size:.875rem;font-weight:600;line-height:1.5}
.tibo-author span{font-size:.75rem;color:var(--muted-foreground);font-weight:400;margin-left:.25rem}
.tibo-quote{display:grid;gap:.5rem;min-width:0;margin:0;padding:.25rem 0 .25rem 1rem;border-left:2px solid var(--border)}
.tibo-quote-head{display:flex;gap:.5rem 1rem;flex-wrap:wrap;justify-content:space-between;align-items:baseline;font-size:.875rem}
.tibo-quote-head a,.tibo-original{font-size:.75rem;color:var(--muted-foreground)}
.tibo-original summary,.tibo-analysis summary,.tibo-time-details summary{width:fit-content;min-height:1.75rem;align-content:center;cursor:pointer}
.tibo-analysis summary{display:list-item}
.tibo-time-details{font-size:.875rem;color:var(--muted-foreground)}
.tibo-original .tibo-copy{margin-top:.5rem;font-size:.875rem;line-height:1.6}
.tibo-reason{max-width:46rem;line-height:1.6;margin:.5rem 0}
.tibo-time{display:grid;gap:.25rem;padding:.5rem 0;border-bottom:1px solid var(--border)}
@container(max-width:32rem){.tibo-fields{grid-template-columns:minmax(0,1fr)}}
@media(prefers-reduced-motion:reduce){.tibo-record{transition:none}}
`
