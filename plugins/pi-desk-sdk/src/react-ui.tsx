import { ContextMenu as ContextMenuPrimitive } from '@base-ui/react/context-menu'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { ScrollArea as ScrollAreaPrimitive } from '@base-ui/react/scroll-area'
import { Select as SelectPrimitive } from '@base-ui/react/select'
import { EyeIcon, EyeOffIcon } from 'lucide-react'
import {
  cloneElement,
  isValidElement,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  type UIEventHandler
} from 'react'

const PLUGIN_UI_STYLES = `
[data-pi-desk-ui-root]{box-sizing:border-box;min-width:0;max-width:100%;container-type:inline-size;color:var(--pi-desk-plugin-foreground,var(--foreground));font:inherit;font-size:.875rem;line-height:1.5}
[data-pi-desk-ui-root] *,[data-pi-desk-ui-root] *::before,[data-pi-desk-ui-root] *::after{box-sizing:border-box}
.pi-desk-ui-panel-header{display:grid;gap:.35rem;min-width:0;border-bottom:1px solid var(--pi-desk-plugin-border,var(--border));padding:1rem}
.pi-desk-ui-panel-header-main{display:flex;min-width:0;align-items:flex-start;justify-content:space-between;gap:.75rem}.pi-desk-ui-panel-header-copy{display:grid;min-width:0;gap:.2rem}.pi-desk-ui-panel-header-title{margin:0;font-size:1.25rem;font-weight:600;line-height:1.4;color:inherit}.pi-desk-ui-panel-header-description{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.875rem;line-height:1.5;overflow-wrap:anywhere}.pi-desk-ui-panel-header-actions{display:flex;flex:none;align-items:center;gap:.4rem}.pi-desk-ui-panel-header-meta{display:flex;min-width:0;align-items:center;gap:.4rem;flex-wrap:wrap}
.pi-desk-ui-panel-header-compact{gap:.25rem;padding:.75rem}.pi-desk-ui-panel-header-compact .pi-desk-ui-panel-header-title{font-size:.875rem}
.pi-desk-ui-section{display:grid;min-width:0;gap:.6rem}.pi-desk-ui-section-header{display:flex;min-width:0;align-items:flex-start;justify-content:space-between;gap:.75rem}.pi-desk-ui-section-copy{display:grid;min-width:0;gap:.2rem}.pi-desk-ui-section-title{margin:0;font-size:.875rem;font-weight:600;line-height:1.5;color:var(--pi-desk-plugin-foreground,var(--foreground))}.pi-desk-ui-section-description{font-size:.875rem;line-height:1.5;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.pi-desk-ui-section-action{display:flex;flex:none;align-items:center}.pi-desk-ui-section-content{min-width:0}.pi-desk-ui-section-compact{gap:.5rem}
.pi-desk-ui-action-row{display:flex;min-width:0;align-items:center;gap:.5rem;flex-wrap:wrap}.pi-desk-ui-action-row-end{justify-content:flex-end}.pi-desk-ui-action-row-between{justify-content:space-between}
.pi-desk-ui-tabs{display:flex;min-width:0;align-items:center;gap:.5rem;flex-wrap:wrap;border-bottom:1px solid var(--pi-desk-plugin-border,var(--border))}
.pi-desk-ui-tab{display:inline-flex;min-height:2rem;align-items:center;justify-content:center;border:0;border-bottom:2px solid transparent;padding:.25rem .5rem;background:transparent;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font:inherit;font-size:.875rem;font-weight:500;cursor:pointer;outline:none;transition:background-color 150ms ease-out,color 150ms ease-out}
.pi-desk-ui-tab:hover{background:color-mix(in oklab,var(--foreground) 8%,transparent);color:var(--foreground)}
.pi-desk-ui-tab[data-active="true"]{border-bottom-color:var(--foreground);color:var(--foreground)}.pi-desk-ui-tab:focus-visible{outline:2px solid var(--pi-desk-plugin-ring,var(--ring));outline-offset:2px}.pi-desk-ui-tab:disabled{cursor:not-allowed;opacity:.5}
.pi-desk-ui-key-values{display:grid;min-width:0;gap:.5rem;margin:0}.pi-desk-ui-key-value{display:grid;min-width:0;grid-template-columns:minmax(5rem,auto) minmax(0,1fr) auto;align-items:start;gap:.3rem .65rem}.pi-desk-ui-key-value-label{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.75rem;line-height:1.45}.pi-desk-ui-key-value-value{min-width:0;margin:0;font-size:.875rem;line-height:1.5;overflow-wrap:anywhere}.pi-desk-ui-key-value-action{display:flex;align-items:center}.pi-desk-ui-key-values-compact{gap:.35rem}.pi-desk-ui-key-values-compact .pi-desk-ui-key-value{grid-template-columns:minmax(3.5rem,auto) minmax(0,1fr) auto;gap:.2rem .5rem}.pi-desk-ui-key-values-compact .pi-desk-ui-key-value-label{font-size:.75rem}.pi-desk-ui-key-values-stacked .pi-desk-ui-key-value{grid-template-columns:minmax(0,1fr);gap:.1rem}.pi-desk-ui-key-values-stacked .pi-desk-ui-key-value-action{justify-self:start}
.pi-desk-ui-loading{display:flex;min-height:6rem;align-items:center;justify-content:center;gap:.5rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.875rem;text-align:center}.pi-desk-ui-loading-error{display:grid;gap:.6rem}.pi-desk-ui-spinner{width:1rem;height:1rem;animation:pi-desk-ui-spin .8s linear infinite;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round}@keyframes pi-desk-ui-spin{to{transform:rotate(360deg)}}
.pi-desk-ui-split{display:grid;grid-template-columns:minmax(11rem,13.5rem) minmax(0,1fr);gap:1rem;align-items:start}
.pi-desk-ui-navigation,.pi-desk-ui-content{min-width:0;min-height:0}.pi-desk-ui-navigation{overflow:hidden}
.pi-desk-ui-list{display:grid;gap:.375rem;min-width:0}.pi-desk-ui-list-compact{gap:.25rem}
.pi-desk-ui-list-item{display:flex;width:100%;min-width:0;align-items:flex-start;gap:.625rem;border:1px solid transparent;border-radius:calc(var(--pi-desk-plugin-radius,var(--radius,.45rem)) + .25rem);padding:.7rem .75rem;background:transparent;color:inherit;text-align:left;font:inherit;cursor:pointer;outline:none;transition:background-color .15s,border-color .15s,color .15s}.pi-desk-ui-list-item-compact{gap:.45rem;border-radius:var(--pi-desk-plugin-radius,var(--radius,.45rem));padding:.5rem .55rem}
.pi-desk-ui-list-item:hover{background:var(--pi-desk-plugin-muted,var(--muted))}
.pi-desk-ui-list-item[aria-pressed="true"]{background:var(--accent);color:var(--accent-foreground)}
.pi-desk-ui-list-item[aria-pressed="true"]:hover{background:color-mix(in oklab,var(--accent),var(--foreground) 5%)}
.pi-desk-ui-list-item:focus-visible,.pi-desk-ui-button:focus-visible,.pi-desk-ui-control:focus-visible{outline:2px solid var(--pi-desk-plugin-ring,var(--ring));outline-offset:2px}
.pi-desk-ui-list-item:disabled,.pi-desk-ui-button:disabled,.pi-desk-ui-control:disabled{cursor:not-allowed;opacity:.5}
.pi-desk-ui-card{min-width:0;border:1px solid var(--pi-desk-plugin-border,var(--border));border-radius:.75rem;padding:1rem;background:var(--pi-desk-plugin-surface,var(--card));color:var(--pi-desk-plugin-surface-foreground,var(--card-foreground,var(--foreground)))}.pi-desk-ui-card-compact{border-radius:.5rem;padding:.75rem}
.pi-desk-ui-markdown{min-width:0;font-size:var(--chat-body-font-size,1rem);line-height:1.7;color:inherit}
.pi-desk-ui-markdown>*{margin-block:0}
.pi-desk-ui-markdown :where(p){margin-block:0;line-height:1.7}
.pi-desk-ui-markdown>:is(h1,h2,h3,h4,h5,h6){margin-block:0;font-weight:600;letter-spacing:-.015em}
.pi-desk-ui-markdown>h1{font-size:1.5rem;line-height:1.3}
.pi-desk-ui-markdown>h2{font-size:1.25rem;line-height:1.35}
.pi-desk-ui-markdown>h3{font-size:1.125rem;line-height:1.4}
.pi-desk-ui-markdown>h4{font-size:1rem;line-height:1.45}
.pi-desk-ui-markdown>h5{font-size:.9375rem;line-height:1.5}
.pi-desk-ui-markdown>h6{font-size:.875rem;line-height:1.5}
.pi-desk-ui-markdown>h1:not(:first-child){margin-block-start:1rem}
.pi-desk-ui-markdown>h2:not(:first-child){margin-block-start:.875rem}
.pi-desk-ui-markdown>h3:not(:first-child){margin-block-start:.75rem}
.pi-desk-ui-markdown>:is(h4,h5,h6):not(:first-child){margin-block-start:.625rem}
.pi-desk-ui-markdown>:is(h1,h2,h3,h4,h5,h6)+*{margin-block-start:.375rem}
.pi-desk-ui-markdown :where([data-streamdown="ordered-list"],[data-streamdown="unordered-list"]){margin-block:0}
.pi-desk-ui-markdown [data-streamdown="list-item"]{padding-block:.125rem;line-height:1.625}
.pi-desk-ui-markdown :where([data-streamdown="blockquote"]){margin-block:0;border-left-width:2px;padding-left:.75rem;line-height:1.6}
.pi-desk-ui-markdown>*+*{margin-block-start:.5rem}
.pi-desk-ui-markdown [data-streamdown="horizontal-rule"]{margin-block:.875rem}
.pi-desk-ui-markdown a{color:inherit;text-decoration:underline;text-underline-offset:3px}
/* Streamdown 的 200px 虚拟高度会在代码块首次可见时改变内容总高度。 */
.pi-desk-ui-markdown [data-streamdown="code-block"]{position:relative;display:block;margin-block:.375rem;overflow:hidden;content-visibility:visible!important;contain-intrinsic-size:none!important;gap:0;padding:0;border:0;border-radius:var(--pi-desk-plugin-radius,var(--radius));background:var(--pi-desk-plugin-muted,var(--muted))}
.pi-desk-ui-markdown>[data-streamdown="code-block"]+*{margin-block-start:.375rem}
.pi-desk-ui-markdown>[data-streamdown="code-block"]+[data-streamdown="horizontal-rule"]{margin-block-start:.875rem}
.pi-desk-ui-markdown [data-streamdown="code-block-header"]{display:none}
.pi-desk-ui-markdown [data-streamdown="code-block-body"]{max-width:100%;overflow-x:auto;border:0;border-radius:0;background:transparent;padding:.5rem 2.5rem .5rem .875rem;font-size:var(--chat-code-font-size,.875rem);line-height:var(--chat-code-line-height,1.6)}
.pi-desk-ui-markdown [data-streamdown="code-block-body"] pre,.pi-desk-ui-markdown [data-streamdown="code-block-body"] code{background:transparent;font-size:inherit;line-height:inherit;white-space:var(--pi-desk-code-white-space,pre-wrap);overflow-wrap:var(--pi-desk-code-overflow-wrap,anywhere)}
.pi-desk-ui-markdown [data-streamdown="code-block-body"] code>span{display:block}
.pi-desk-ui-markdown [data-streamdown="code-block-body"] code>span::before{display:none;content:none}
.pi-desk-ui-markdown [data-streamdown="code-block"]>div:has(>[data-streamdown="code-block-actions"]){position:absolute;top:.25rem;right:.375rem;z-index:10;display:block;height:auto;margin:0;pointer-events:none}
.pi-desk-ui-markdown [data-streamdown="code-block-actions"]{pointer-events:auto;gap:0;border:0;background:var(--pi-desk-plugin-muted,var(--muted));padding:0;opacity:0;box-shadow:none;backdrop-filter:none;transition:opacity 120ms ease}
.pi-desk-ui-markdown [data-streamdown="code-block-actions"]>button{display:flex;width:1.75rem;height:1.75rem;align-items:center;justify-content:center;border-radius:.375rem;padding:0}
.pi-desk-ui-markdown [data-streamdown="code-block-actions"]>button:hover{background:var(--accent);color:var(--accent-foreground)}
.pi-desk-ui-markdown [data-streamdown="code-block"]:hover [data-streamdown="code-block-actions"],.pi-desk-ui-markdown [data-streamdown="code-block"]:focus-within [data-streamdown="code-block-actions"]{opacity:1}
@media(hover:none),(max-width:640px){.pi-desk-ui-markdown [data-streamdown="code-block-actions"]{opacity:1}}
.pi-desk-ui-markdown table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}.pi-desk-ui-markdown :where(th,td){border:1px solid var(--pi-desk-plugin-border,var(--border));padding:.4rem .55rem;text-align:left}
.pi-desk-ui-markdown hr{border:0;border-top:1px solid var(--pi-desk-plugin-border,var(--border))}
.pi-desk-ui-markdown img{max-width:100%;height:auto}
.pi-desk-ui-button {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  justify-content: center;
  gap: .5rem;
  border: 1px solid transparent;
  border-radius: .5rem;
  padding: .25rem .5rem;
  font: inherit;
  font-size: .875rem;
  font-weight: 500;
  line-height: 1.5;
  white-space: nowrap;
  cursor: pointer;
  outline: none;
  transition: background-color 150ms ease-out, color 150ms ease-out, border-color 150ms ease-out;
}
.pi-desk-ui-button-sm, .pi-desk-ui-button-xs {
  min-height: 1.75rem;
  border-radius: .375rem;
  padding: .125rem .5rem;
}
.pi-desk-ui-button svg { width: 1rem; height: 1rem; flex: none; }
.pi-desk-ui-button-primary{background:var(--pi-desk-plugin-primary,var(--primary));color:var(--pi-desk-plugin-primary-foreground,var(--primary-foreground))}
.pi-desk-ui-button-primary:hover{background:color-mix(in oklab,var(--pi-desk-plugin-primary,var(--primary)),var(--pi-desk-plugin-primary-foreground,var(--primary-foreground)) 8%)}
.pi-desk-ui-button-primary:active{background:color-mix(in oklab,var(--pi-desk-plugin-primary,var(--primary)),var(--pi-desk-plugin-primary-foreground,var(--primary-foreground)) 14%)}
.pi-desk-ui-button-secondary{background:var(--secondary);color:var(--secondary-foreground)}
.pi-desk-ui-button-secondary:hover{background:color-mix(in oklab,var(--secondary),var(--foreground) 8%)}
.pi-desk-ui-button-secondary:active{background:color-mix(in oklab,var(--secondary),var(--foreground) 14%)}
.pi-desk-ui-button-ghost:hover{background:color-mix(in oklab,var(--foreground) 8%,transparent);color:var(--foreground)}
.pi-desk-ui-button-ghost:active{background:color-mix(in oklab,var(--foreground) 14%,transparent)}
.pi-desk-ui-button-danger{border-color:color-mix(in srgb,var(--pi-desk-plugin-destructive,var(--destructive)) 45%,transparent);background:color-mix(in srgb,var(--pi-desk-plugin-destructive,var(--destructive)) 12%,transparent);color:var(--pi-desk-plugin-destructive,var(--destructive))}
.pi-desk-ui-button-danger:hover{background:color-mix(in srgb,var(--pi-desk-plugin-destructive,var(--destructive)) 20%,transparent)}
.pi-desk-ui-button-ghost{background:transparent;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.pi-desk-ui-button[aria-pressed="true"]{background:var(--accent);color:var(--accent-foreground)}
.pi-desk-ui-button[aria-pressed="true"]:hover{background:color-mix(in oklab,var(--accent),var(--foreground) 5%)}
.pi-desk-ui-context-menu-positioner{z-index:1020;outline:none}.pi-desk-ui-context-menu{max-height:min(20rem,var(--available-height));min-width:10rem;overflow:auto;border:1px solid var(--pi-desk-plugin-border,var(--border));border-radius:calc(var(--pi-desk-plugin-radius,var(--radius,.45rem)) + .2rem);padding:.25rem;background:var(--pi-desk-plugin-popover,var(--popover,var(--card)));color:var(--pi-desk-plugin-popover-foreground,var(--popover-foreground,var(--foreground)));box-shadow:0 .6rem 1.6rem color-mix(in srgb,#000 22%,transparent);transform-origin:var(--transform-origin);outline:none;transition:transform .1s ease-out,opacity .1s ease-out}.pi-desk-ui-context-menu[data-starting-style],.pi-desk-ui-context-menu[data-ending-style]{opacity:0;transform:scale(.98)}.pi-desk-ui-context-menu-item{display:flex;min-height:1.75rem;align-items:center;gap:.5rem;border-radius:.375rem;padding:.25rem .5rem;font:inherit;font-size:.875rem;line-height:1.5;cursor:pointer;outline:none;user-select:none}.pi-desk-ui-context-menu-item[data-highlighted]{background:var(--accent);color:var(--accent-foreground)}.pi-desk-ui-context-menu-item[data-disabled]{pointer-events:none;opacity:.5}
.pi-desk-ui-badge{display:inline-flex;min-height:1.25rem;align-items:center;border-radius:.375rem;padding:.0625rem .375rem;font-size:.75rem;line-height:1.5;font-weight:500;white-space:nowrap}
.pi-desk-ui-badge-neutral{background:var(--pi-desk-plugin-muted,var(--muted));color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.pi-desk-ui-badge-info{background:var(--muted);color:var(--foreground)}
.pi-desk-ui-badge-success{background:var(--muted);color:var(--status-success,var(--foreground))}
.pi-desk-ui-badge-warning{background:var(--muted);color:var(--status-warning,var(--foreground))}
.pi-desk-ui-badge-error{background:var(--muted);color:var(--pi-desk-plugin-destructive,var(--destructive))}
.pi-desk-ui-alert{border:1px solid var(--pi-desk-plugin-border,var(--border));border-radius:calc(var(--pi-desk-plugin-radius,var(--radius,.45rem)) + .25rem);padding:.75rem .85rem;background:color-mix(in srgb,var(--pi-desk-plugin-muted,var(--muted)) 70%,transparent);color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));line-height:1.5}.pi-desk-ui-alert-compact{border-radius:.5rem;padding:.75rem;font-size:.875rem}
.pi-desk-ui-alert-info{border-color:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 35%,var(--pi-desk-plugin-border,var(--border)))}
.pi-desk-ui-alert-warning{border-color:color-mix(in oklab,var(--status-warning,var(--foreground)) 45%,var(--border));color:var(--pi-desk-plugin-foreground,var(--foreground))}
.pi-desk-ui-alert-error{border-color:color-mix(in srgb,var(--pi-desk-plugin-destructive,var(--destructive)) 42%,var(--pi-desk-plugin-border,var(--border)));color:var(--pi-desk-plugin-destructive,var(--destructive))}
.pi-desk-ui-dialog-backdrop{position:fixed;inset:0;z-index:1000;background:rgb(0 0 0 / .35)}.pi-desk-ui-dialog{position:fixed;top:50%;left:50%;z-index:1010;display:flex;max-height:calc(100dvh - 2rem);width:calc(100vw - 2rem);max-width:27.5rem;transform:translate(-50%,-50%);flex-direction:column;overflow:hidden;container-type:inline-size;border:1px solid var(--pi-desk-plugin-border,var(--border));border-radius:.75rem;font-size:.875rem;line-height:1.5;background:var(--pi-desk-plugin-popover,var(--popover,var(--card)));color:var(--pi-desk-plugin-popover-foreground,var(--popover-foreground,var(--foreground)));box-shadow:0 .5rem 1.5rem rgb(0 0 0 / .18);outline:none}.pi-desk-ui-dialog-sm{max-width:20rem}.pi-desk-ui-dialog-lg{max-width:45rem}.pi-desk-ui-dialog-header{display:grid;flex:none;gap:.2rem;border-bottom:1px solid var(--pi-desk-plugin-border,var(--border));padding:1rem 3.5rem 1rem 1rem}.pi-desk-ui-dialog-title{margin:0;font-size:1.125rem;font-weight:600;line-height:1.4}.pi-desk-ui-dialog-description{font-size:.875rem;line-height:1.5;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));overflow-wrap:anywhere}.pi-desk-ui-dialog-close{position:absolute;top:.5rem;right:.5rem;display:inline-flex;width:2rem;height:2rem;align-items:center;justify-content:center;border:0;border-radius:var(--pi-desk-plugin-radius,var(--radius,.45rem));background:transparent;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font:inherit;font-size:1.25rem;cursor:pointer;outline:none}.pi-desk-ui-dialog-close:hover{background:var(--pi-desk-plugin-muted,var(--muted));color:var(--pi-desk-plugin-foreground,var(--foreground))}.pi-desk-ui-dialog-close:focus-visible{outline:2px solid var(--pi-desk-plugin-ring,var(--ring));outline-offset:2px}.pi-desk-ui-dialog-scroll{min-height:0;flex:1}.pi-desk-ui-dialog-body{min-height:0;padding:1rem}.pi-desk-ui-dialog-footer{display:flex;flex:none;flex-wrap:wrap;justify-content:flex-end;gap:.5rem;border-top:1px solid var(--pi-desk-plugin-border,var(--border));padding:.75rem 1rem}.pi-desk-ui-empty{display:flex;align-items:center;justify-content:center;padding:1.5rem 1rem;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));font-size:.875rem;text-align:center;line-height:1.5}
.pi-desk-ui-field{display:grid;gap:.25rem;min-width:0}
.pi-desk-ui-field-label{font-size:.875rem;font-weight:500;color:var(--pi-desk-plugin-foreground,var(--foreground))}
.pi-desk-ui-field-description,.pi-desk-ui-field-error{font-size:.875rem;line-height:1.5;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.pi-desk-ui-field-error{color:var(--pi-desk-plugin-destructive,var(--destructive))}
.pi-desk-ui-control {
  width: 100%;
  min-height: 2rem;
  border: 1px solid var(--pi-desk-plugin-input,var(--input));
  border-radius: .5rem;
  padding: .25rem .625rem;
  background: var(--pi-desk-plugin-surface,var(--card));
  color: var(--pi-desk-plugin-foreground,var(--foreground));
  font: inherit;
  font-size: .875rem;
  line-height: 1.5;
  outline: none;
}
.pi-desk-ui-control-sm{min-height:1.75rem;border-radius:.375rem;padding:.125rem .625rem}
.pi-desk-ui-control:focus-visible{outline-offset:-2px}
.pi-desk-ui-control[aria-invalid="true"]{border-color:var(--destructive);outline-color:var(--destructive)}
.pi-desk-ui-checkbox{appearance:none;display:inline-grid;width:1rem;height:1rem;flex:none;place-content:center;border:1px solid var(--pi-desk-plugin-input,var(--input,var(--border)));border-radius:.25rem;background:var(--pi-desk-plugin-background,var(--background));color:var(--pi-desk-plugin-primary-foreground,var(--primary-foreground));cursor:pointer;outline:none;transition:background-color .15s,border-color .15s,box-shadow .15s}.pi-desk-ui-checkbox::before{content:"";width:.68rem;height:.68rem;transform:scale(0);transform-origin:center;clip-path:polygon(14% 44%,0 59%,38% 100%,100% 22%,84% 8%,37% 70%);background:currentColor;transition:transform .12s ease}.pi-desk-ui-checkbox:checked{border-color:var(--pi-desk-plugin-primary,var(--primary));background:var(--pi-desk-plugin-primary,var(--primary))}.pi-desk-ui-checkbox:checked::before{transform:scale(1)}.pi-desk-ui-checkbox:hover:not(:disabled){border-color:color-mix(in srgb,var(--pi-desk-plugin-primary,var(--primary)) 65%,var(--pi-desk-plugin-input,var(--input,var(--border))))}.pi-desk-ui-checkbox:focus-visible{outline:2px solid var(--pi-desk-plugin-ring,var(--ring));outline-offset:2px}.pi-desk-ui-checkbox:disabled{cursor:not-allowed;opacity:.5}
.pi-desk-ui-secret{position:relative;min-width:0}
.pi-desk-ui-secret .pi-desk-ui-control{padding-right:2.25rem}
.pi-desk-ui-secret-control{-webkit-text-security:disc}
.pi-desk-ui-secret-toggle{position:absolute;top:50%;right:.25rem;display:inline-flex;width:1.5rem;height:1.5rem;align-items:center;justify-content:center;transform:translateY(-50%);border:0;border-radius:.375rem;background:transparent;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground));cursor:pointer;outline:none}
.pi-desk-ui-secret-toggle:hover{background:var(--pi-desk-plugin-muted,var(--muted));color:var(--pi-desk-plugin-foreground,var(--foreground))}
.pi-desk-ui-secret-toggle:focus-visible{box-shadow:0 0 0 2px var(--pi-desk-plugin-ring,var(--ring))}
.pi-desk-ui-secret-toggle:disabled{pointer-events:none;opacity:.5}
.pi-desk-ui-secret-toggle svg{width:.875rem;height:.875rem}
textarea.pi-desk-ui-control{min-height:13rem;resize:vertical;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;line-height:1.5}textarea.pi-desk-ui-control-sm{min-height:7rem}
.pi-desk-ui-control::placeholder{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}
.pi-desk-ui-select-trigger{display:flex;width:100%;min-width:0;max-width:100%;min-height:2rem;align-items:center;justify-content:space-between;gap:.5rem;border:1px solid var(--pi-desk-plugin-input,var(--input));border-radius:.5rem;padding:.25rem .625rem;background:var(--pi-desk-plugin-surface,var(--card));color:var(--pi-desk-plugin-foreground,var(--foreground));font:inherit;font-size:.875rem;line-height:1.5;text-align:left;outline:none;cursor:pointer}.pi-desk-ui-select-trigger:hover{background:var(--accent)}.pi-desk-ui-select-trigger:focus-visible{outline:2px solid var(--pi-desk-plugin-ring,var(--ring));outline-offset:-2px}.pi-desk-ui-select-trigger[data-disabled]{cursor:not-allowed;opacity:.5}.pi-desk-ui-select-trigger-sm{min-height:1.75rem;border-radius:.375rem;padding:.125rem .625rem}.pi-desk-ui-select-value{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pi-desk-ui-select-value[data-placeholder]{color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.pi-desk-ui-select-icon{display:inline-flex;width:1rem;height:1rem;flex:none;color:var(--pi-desk-plugin-muted-foreground,var(--muted-foreground))}.pi-desk-ui-select-icon svg,.pi-desk-ui-select-indicator svg{width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.pi-desk-ui-select-positioner{z-index:1020}.pi-desk-ui-select-popup{max-height:min(20rem,var(--available-height));min-width:max(9rem,var(--anchor-width));overflow:auto;border:1px solid var(--pi-desk-plugin-border,var(--border));border-radius:calc(var(--pi-desk-plugin-radius,var(--radius,.45rem)) + .2rem);padding:.25rem;background:var(--pi-desk-plugin-popover,var(--popover,var(--card)));color:var(--pi-desk-plugin-popover-foreground,var(--popover-foreground,var(--foreground)));box-shadow:0 .6rem 1.6rem color-mix(in srgb,#000 22%,transparent);outline:none}.pi-desk-ui-select-item{position:relative;display:flex;min-height:2rem;align-items:center;gap:.5rem;border-radius:var(--pi-desk-plugin-radius,var(--radius,.45rem));padding:.35rem 2rem .35rem .55rem;font-size:.875rem;line-height:1.5;cursor:pointer;outline:none}.pi-desk-ui-select-item[data-highlighted]{background:var(--accent);color:var(--accent-foreground)}.pi-desk-ui-select-item[data-disabled]{pointer-events:none;opacity:.5}.pi-desk-ui-select-indicator{position:absolute;right:.55rem;display:inline-flex;width:.9rem;height:.9rem;align-items:center;justify-content:center;color:var(--pi-desk-plugin-primary,var(--primary))}
@container (max-width:40rem){.pi-desk-ui-split{grid-template-columns:minmax(0,1fr)}.pi-desk-ui-split-navigation-scroll{height:auto;max-height:11rem}}
@media(prefers-reduced-motion:reduce){.pi-desk-ui-button,.pi-desk-ui-list-item,.pi-desk-ui-context-menu{transition:none}}
@container (max-width:28rem){.pi-desk-ui-action-row-mobile-stack{align-items:flex-start;flex-direction:column}.pi-desk-ui-key-value{grid-template-columns:minmax(0,1fr)}.pi-desk-ui-key-value-action{justify-self:start}}
`

const PLUGIN_SCROLL_STYLES = `
.pi-desk-ui-scroll{display:flex;position:relative;min-width:0;min-height:0;flex-direction:column;overflow:hidden}
.pi-desk-ui-scroll-viewport{width:100%;height:auto;min-width:0;min-height:0;flex:1 1 auto;outline:none}
.pi-desk-ui-scrollbar{display:flex;touch-action:none;padding:.1rem;user-select:none}
.pi-desk-ui-scrollbar[data-orientation="vertical"]{height:100%;width:.625rem;border-left:1px solid transparent}
.pi-desk-ui-scrollbar[data-orientation="horizontal"]{height:.625rem;flex-direction:column;border-top:1px solid transparent}
.pi-desk-ui-scrollbar-thumb{position:relative;flex:1;border-radius:999px;background:color-mix(in srgb,var(--pi-desk-plugin-muted-foreground,var(--muted-foreground)) 45%,transparent)}
.pi-desk-ui-scrollbar-thumb:hover{background:color-mix(in srgb,var(--pi-desk-plugin-muted-foreground,var(--muted-foreground)) 70%,transparent)}
`

function classNames(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ')
}

export function PluginSurface({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return (
    <div {...props} data-pi-desk-ui-root="" className={classNames('pi-desk-ui-root', className)}>
      {/* 公共样式由页面持有，始终先于插件局部样式参与层叠。 */}
      <style href="pi-desk-ui" precedence="pi-desk-ui">
        {PLUGIN_UI_STYLES}
      </style>
      {children}
    </div>
  )
}

export type PluginScrollOrientation = 'vertical' | 'horizontal' | 'both'

export type PluginScrollProps = Omit<HTMLAttributes<HTMLDivElement>, 'onScroll'> & {
  orientation?: PluginScrollOrientation
  viewportClassName?: string
  viewportRef?: Ref<HTMLDivElement>
  onScroll?: UIEventHandler<HTMLDivElement>
}

function PluginScrollBar({
  orientation
}: {
  orientation: Exclude<PluginScrollOrientation, 'both'>
}): React.JSX.Element {
  return (
    <ScrollAreaPrimitive.Scrollbar
      data-slot="plugin-scrollbar"
      data-orientation={orientation}
      orientation={orientation}
      className="pi-desk-ui-scrollbar"
    >
      <ScrollAreaPrimitive.Thumb
        data-slot="plugin-scrollbar-thumb"
        className="pi-desk-ui-scrollbar-thumb"
      />
    </ScrollAreaPrimitive.Scrollbar>
  )
}

export function PluginScroll({
  orientation = 'vertical',
  viewportClassName,
  viewportRef,
  onScroll,
  role,
  className,
  children,
  ...props
}: PluginScrollProps): React.JSX.Element {
  return (
    <>
      <style href="pi-desk-scroll" precedence="pi-desk-ui">
        {PLUGIN_SCROLL_STYLES}
      </style>
      <ScrollAreaPrimitive.Root
        {...props}
        data-pi-desk-scroll=""
        role={role ?? 'region'}
        className={classNames('pi-desk-ui-scroll', className)}
      >
        <ScrollAreaPrimitive.Viewport
          ref={viewportRef}
          data-slot="plugin-scroll-viewport"
          className={classNames('pi-desk-ui-scroll-viewport', viewportClassName)}
          onScroll={onScroll}
        >
          {children}
        </ScrollAreaPrimitive.Viewport>
        {orientation !== 'horizontal' ? <PluginScrollBar orientation="vertical" /> : null}
        {orientation !== 'vertical' ? <PluginScrollBar orientation="horizontal" /> : null}
        <ScrollAreaPrimitive.Corner />
      </ScrollAreaPrimitive.Root>
    </>
  )
}

export type PluginDensity = 'regular' | 'compact'
export type PluginControlSize = 'default' | 'sm'

type PluginHeadingLevel = 1 | 2 | 3 | 4

function PluginHeading({
  level,
  className,
  children
}: {
  level: PluginHeadingLevel
  className: string
  children: ReactNode
}): React.JSX.Element {
  if (level === 1) return <h1 className={className}>{children}</h1>
  if (level === 2) return <h2 className={className}>{children}</h2>
  if (level === 3) return <h3 className={className}>{children}</h3>
  return <h4 className={className}>{children}</h4>
}

export interface PluginPanelHeaderProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
  density?: PluginDensity
  headingLevel?: PluginHeadingLevel
}

export function PluginPanelHeader({
  title,
  description,
  actions,
  meta,
  density = 'regular',
  headingLevel = 2,
  className,
  ...props
}: PluginPanelHeaderProps): React.JSX.Element {
  return (
    <header
      {...props}
      className={classNames(
        'pi-desk-ui-panel-header',
        density === 'compact' && 'pi-desk-ui-panel-header-compact',
        className
      )}
    >
      <div className="pi-desk-ui-panel-header-main">
        <div className="pi-desk-ui-panel-header-copy">
          <PluginHeading level={headingLevel} className="pi-desk-ui-panel-header-title">
            {title}
          </PluginHeading>
          {description ? (
            <div className="pi-desk-ui-panel-header-description">{description}</div>
          ) : null}
        </div>
        {actions ? <div className="pi-desk-ui-panel-header-actions">{actions}</div> : null}
      </div>
      {meta ? <div className="pi-desk-ui-panel-header-meta">{meta}</div> : null}
    </header>
  )
}

export interface PluginSectionProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  density?: PluginDensity
  headingLevel?: PluginHeadingLevel
}

export function PluginSection({
  title,
  description,
  action,
  density = 'regular',
  headingLevel = 3,
  className,
  children,
  ...props
}: PluginSectionProps): React.JSX.Element {
  return (
    <section
      {...props}
      className={classNames(
        'pi-desk-ui-section',
        density === 'compact' && 'pi-desk-ui-section-compact',
        className
      )}
    >
      <div className="pi-desk-ui-section-header">
        <div className="pi-desk-ui-section-copy">
          <PluginHeading level={headingLevel} className="pi-desk-ui-section-title">
            {title}
          </PluginHeading>
          {description ? <div className="pi-desk-ui-section-description">{description}</div> : null}
        </div>
        {action ? <div className="pi-desk-ui-section-action">{action}</div> : null}
      </div>
      <div className="pi-desk-ui-section-content">{children}</div>
    </section>
  )
}

export interface PluginTabListProps extends HTMLAttributes<HTMLDivElement> {
  label?: string
}

export function PluginTabList({
  label,
  className,
  ...props
}: PluginTabListProps): React.JSX.Element {
  return (
    <div
      {...props}
      role="tablist"
      aria-label={label}
      className={classNames('pi-desk-ui-tabs', className)}
    />
  )
}

export interface PluginTabProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active?: boolean
}

export function PluginTab({
  active = false,
  className,
  type,
  ...props
}: PluginTabProps): React.JSX.Element {
  return (
    <button
      {...props}
      type={type ?? 'button'}
      role="tab"
      aria-selected={active}
      data-active={active}
      className={classNames('pi-desk-ui-tab', className)}
    />
  )
}

export type PluginActionRowAlign = 'start' | 'end' | 'between'

export interface PluginActionRowProps extends HTMLAttributes<HTMLDivElement> {
  align?: PluginActionRowAlign
  mobileStack?: boolean
}

export function PluginActionRow({
  align = 'start',
  mobileStack = false,
  className,
  ...props
}: PluginActionRowProps): React.JSX.Element {
  return (
    <div
      {...props}
      className={classNames(
        'pi-desk-ui-action-row',
        align !== 'start' && `pi-desk-ui-action-row-${align}`,
        mobileStack && 'pi-desk-ui-action-row-mobile-stack',
        className
      )}
    />
  )
}

export type PluginKeyValueLayout = 'inline' | 'stacked'

export interface PluginKeyValueListProps extends HTMLAttributes<HTMLDListElement> {
  density?: PluginDensity
  layout?: PluginKeyValueLayout
}

export function PluginKeyValueList({
  density = 'regular',
  layout = 'inline',
  className,
  ...props
}: PluginKeyValueListProps): React.JSX.Element {
  return (
    <dl
      {...props}
      className={classNames(
        'pi-desk-ui-key-values',
        density === 'compact' && 'pi-desk-ui-key-values-compact',
        layout === 'stacked' && 'pi-desk-ui-key-values-stacked',
        className
      )}
    />
  )
}

export interface PluginKeyValueItemProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  label: ReactNode
  value: ReactNode
  action?: ReactNode
}

export function PluginKeyValueItem({
  label,
  value,
  action,
  className,
  ...props
}: PluginKeyValueItemProps): React.JSX.Element {
  return (
    <div {...props} className={classNames('pi-desk-ui-key-value', className)}>
      <dt className="pi-desk-ui-key-value-label">{label}</dt>
      <dd className="pi-desk-ui-key-value-value">{value}</dd>
      {action ? <div className="pi-desk-ui-key-value-action">{action}</div> : null}
    </div>
  )
}

export function PluginSpinner({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      role="status"
      aria-label="正在加载"
      className={classNames('pi-desk-ui-spinner', className)}
    >
      <path d="M20 12a8 8 0 1 1-5.5-7.6" />
    </svg>
  )
}

export interface PluginLoadingStateProps {
  loading: boolean
  error?: Error | string | null
  loadingLabel?: ReactNode
  retryLabel?: ReactNode
  onRetry?: () => void
  className?: string
  children: ReactNode
}

export function PluginLoadingState({
  loading,
  error,
  loadingLabel = '正在加载…',
  retryLabel = '重新加载',
  onRetry,
  className,
  children
}: PluginLoadingStateProps): React.JSX.Element {
  if (error) {
    const message = error instanceof Error ? error.message : error
    return (
      <div className={classNames('pi-desk-ui-loading-error', className)}>
        <PluginAlert tone="error" density="compact">
          {message}
        </PluginAlert>
        {onRetry ? (
          <PluginActionRow>
            <PluginButton size="sm" variant="primary" onClick={onRetry}>
              {retryLabel}
            </PluginButton>
          </PluginActionRow>
        ) : null}
      </div>
    )
  }
  if (loading) {
    return (
      <div className={classNames('pi-desk-ui-loading', className)} role="status">
        <PluginSpinner />
        <span>{loadingLabel}</span>
      </div>
    )
  }
  return <>{children}</>
}

export interface PluginSplitViewProps extends HTMLAttributes<HTMLDivElement> {
  navigation: ReactNode
  navigationLabel?: string
}

export function PluginSplitView({
  navigation,
  navigationLabel = '插件导航',
  className,
  children,
  ...props
}: PluginSplitViewProps): React.JSX.Element {
  const navigationContent =
    isValidElement(navigation) && navigation.type === PluginScroll ? (
      navigation
    ) : (
      <PluginScroll className="pi-desk-ui-split-navigation-scroll" aria-label={navigationLabel}>
        {navigation}
      </PluginScroll>
    )

  return (
    <div {...props} className={classNames('pi-desk-ui-split', className)}>
      <aside className="pi-desk-ui-navigation" aria-label={navigationLabel}>
        {navigationContent}
      </aside>
      <div className="pi-desk-ui-content">{children}</div>
    </div>
  )
}

export interface PluginListProps extends HTMLAttributes<HTMLDivElement> {
  density?: PluginDensity
}

export function PluginList({
  density = 'regular',
  className,
  ...props
}: PluginListProps): React.JSX.Element {
  return (
    <div
      {...props}
      className={classNames(
        'pi-desk-ui-list',
        density === 'compact' && 'pi-desk-ui-list-compact',
        className
      )}
    />
  )
}

export interface PluginListItemProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  selected?: boolean
  density?: PluginDensity
}

export function PluginListItem({
  selected = false,
  density = 'regular',
  className,
  type,
  ...props
}: PluginListItemProps): React.JSX.Element {
  return (
    <button
      {...props}
      type={type ?? 'button'}
      aria-pressed={selected}
      className={classNames(
        'pi-desk-ui-list-item',
        density === 'compact' && 'pi-desk-ui-list-item-compact',
        className
      )}
    />
  )
}

export interface PluginCardProps extends HTMLAttributes<HTMLDivElement> {
  density?: PluginDensity
}

export function PluginCard({
  density = 'regular',
  className,
  ...props
}: PluginCardProps): React.JSX.Element {
  return (
    <div
      {...props}
      className={classNames(
        'pi-desk-ui-card',
        density === 'compact' && 'pi-desk-ui-card-compact',
        className
      )}
    />
  )
}

export type PluginButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost'
export type PluginButtonSize = 'default' | 'sm' | 'xs'

export interface PluginButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: PluginButtonVariant
  size?: PluginButtonSize
}

export function PluginButton({
  variant = 'secondary',
  size = 'default',
  className,
  type,
  ...props
}: PluginButtonProps): React.JSX.Element {
  return (
    <button
      {...props}
      type={type ?? 'button'}
      className={classNames(
        'pi-desk-ui-button',
        `pi-desk-ui-button-${variant}`,
        size !== 'default' && `pi-desk-ui-button-${size}`,
        className
      )}
    />
  )
}

export function PluginContextMenu(props: ContextMenuPrimitive.Root.Props): React.JSX.Element {
  return <ContextMenuPrimitive.Root {...props} />
}

export function PluginContextMenuTrigger(
  props: ContextMenuPrimitive.Trigger.Props
): React.JSX.Element {
  return <ContextMenuPrimitive.Trigger {...props} />
}

export type PluginContextMenuContentProps = Omit<ContextMenuPrimitive.Popup.Props, 'className'> & {
  className?: string
}

export function PluginContextMenuContent({
  className,
  ...props
}: PluginContextMenuContentProps): React.JSX.Element {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="pi-desk-ui-context-menu-positioner">
        <ContextMenuPrimitive.Popup
          {...props}
          className={classNames('pi-desk-ui-context-menu', className)}
        />
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  )
}

export type PluginContextMenuItemProps = Omit<ContextMenuPrimitive.Item.Props, 'className'> & {
  className?: string
}

export function PluginContextMenuItem({
  className,
  ...props
}: PluginContextMenuItemProps): React.JSX.Element {
  return (
    <ContextMenuPrimitive.Item
      {...props}
      className={classNames('pi-desk-ui-context-menu-item', className)}
    />
  )
}

export type PluginBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'error'

export interface PluginBadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: PluginBadgeTone
}

export function PluginBadge({
  tone = 'neutral',
  className,
  ...props
}: PluginBadgeProps): React.JSX.Element {
  return (
    <span
      {...props}
      className={classNames('pi-desk-ui-badge', `pi-desk-ui-badge-${tone}`, className)}
    />
  )
}

export type PluginAlertTone = 'neutral' | 'info' | 'warning' | 'error'

export interface PluginAlertProps extends HTMLAttributes<HTMLDivElement> {
  tone?: PluginAlertTone
  density?: PluginDensity
}

export function PluginAlert({
  tone = 'neutral',
  density = 'regular',
  className,
  ...props
}: PluginAlertProps): React.JSX.Element {
  return (
    <div
      {...props}
      role={props.role ?? (tone === 'error' ? 'alert' : undefined)}
      className={classNames(
        'pi-desk-ui-alert',
        `pi-desk-ui-alert-${tone}`,
        density === 'compact' && 'pi-desk-ui-alert-compact',
        className
      )}
    />
  )
}

export type PluginDialogSize = 'sm' | 'md' | 'lg'

export interface PluginDialogProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  size?: PluginDialogSize
  footer?: ReactNode
  closeLabel?: string
  children: ReactNode
  onOpenChange(open: boolean): void
}

export function PluginDialog({
  open,
  title,
  description,
  size = 'md',
  footer,
  closeLabel = '关闭弹窗',
  children,
  onOpenChange
}: PluginDialogProps): React.JSX.Element {
  // 不锁定文档滚动，避免弹窗改写 body 宽度并触发背景多列工作台重新分栏。
  return (
    <DialogPrimitive.Root open={open} modal="trap-focus" onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="pi-desk-ui-dialog-backdrop" />
        <DialogPrimitive.Popup
          className={classNames('pi-desk-ui-dialog', size !== 'md' && `pi-desk-ui-dialog-${size}`)}
        >
          <div className="pi-desk-ui-dialog-header">
            <DialogPrimitive.Title className="pi-desk-ui-dialog-title">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="pi-desk-ui-dialog-description">
                {description}
              </DialogPrimitive.Description>
            ) : null}
          </div>
          <DialogPrimitive.Close
            className="pi-desk-ui-dialog-close"
            aria-label={closeLabel}
            title={closeLabel}
          >
            ×
          </DialogPrimitive.Close>
          <PluginScroll
            className="pi-desk-ui-dialog-scroll"
            viewportClassName="pi-desk-ui-dialog-body"
          >
            {children}
          </PluginScroll>
          {footer ? <div className="pi-desk-ui-dialog-footer">{footer}</div> : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

export interface PluginConfirmDialogProps {
  open: boolean
  title: ReactNode
  description?: ReactNode
  confirmLabel: ReactNode
  cancelLabel?: ReactNode
  tone?: 'default' | 'danger'
  pending?: boolean
  children?: ReactNode
  onConfirm(): void | Promise<void>
  onOpenChange(open: boolean): void
}

export function PluginConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = '取消',
  tone = 'default',
  pending = false,
  children,
  onConfirm,
  onOpenChange
}: PluginConfirmDialogProps): React.JSX.Element {
  return (
    <PluginDialog
      open={open}
      title={title}
      description={description}
      size="sm"
      closeLabel={typeof cancelLabel === 'string' ? cancelLabel : undefined}
      onOpenChange={onOpenChange}
      footer={
        <>
          <PluginButton disabled={pending} variant="secondary" onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </PluginButton>
          <PluginButton
            disabled={pending}
            variant={tone === 'danger' ? 'danger' : 'primary'}
            onClick={() => void Promise.resolve(onConfirm()).catch(() => undefined)}
          >
            {pending ? '执行中…' : confirmLabel}
          </PluginButton>
        </>
      }
    >
      {children}
    </PluginDialog>
  )
}

export interface PluginEmptyStateProps extends HTMLAttributes<HTMLDivElement> {
  density?: PluginDensity
}

export function PluginEmptyState({
  density = 'regular',
  className,
  ...props
}: PluginEmptyStateProps): React.JSX.Element {
  return (
    <div
      {...props}
      className={classNames(
        'pi-desk-ui-empty',
        density === 'compact' && 'pi-desk-ui-empty-compact',
        className
      )}
    />
  )
}

export interface PluginFieldProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode
  htmlFor?: string
  description?: ReactNode
  error?: ReactNode
  density?: PluginDensity
}

export function PluginField({
  label,
  htmlFor,
  description,
  error,
  density = 'regular',
  className,
  children,
  ...props
}: PluginFieldProps): React.JSX.Element {
  const generatedId = useId()
  const control =
    isValidElement<{ id?: string }>(children) &&
    (children.type === 'input' ||
      children.type === 'textarea' ||
      children.type === 'select' ||
      children.type === PluginInput ||
      children.type === PluginTextarea ||
      children.type === PluginSelect ||
      children.type === PluginSecretInput)
      ? children
      : null
  const controlId = htmlFor ?? control?.props.id ?? generatedId
  const content =
    control && !htmlFor && !control.props.id ? cloneElement(control, { id: controlId }) : children
  return (
    <div
      {...props}
      className={classNames(
        'pi-desk-ui-field',
        density === 'compact' && 'pi-desk-ui-field-compact',
        className
      )}
    >
      <label className="pi-desk-ui-field-label" htmlFor={control ? controlId : htmlFor}>
        {label}
      </label>
      {content}
      {description ? <div className="pi-desk-ui-field-description">{description}</div> : null}
      {error ? <div className="pi-desk-ui-field-error">{error}</div> : null}
    </div>
  )
}

export interface PluginInputProps extends InputHTMLAttributes<HTMLInputElement> {
  controlSize?: PluginControlSize
}

export function PluginInput({
  controlSize = 'default',
  className,
  ...props
}: PluginInputProps): React.JSX.Element {
  return (
    <input
      {...props}
      className={classNames(
        'pi-desk-ui-control',
        controlSize === 'sm' && 'pi-desk-ui-control-sm',
        className
      )}
    />
  )
}

export type PluginCheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>

export function PluginCheckbox({ className, ...props }: PluginCheckboxProps): React.JSX.Element {
  return (
    <input {...props} type="checkbox" className={classNames('pi-desk-ui-checkbox', className)} />
  )
}

export type PluginSecretInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'autoComplete' | 'autoCapitalize' | 'spellCheck'
> & {
  controlSize?: PluginControlSize
}

export function PluginSecretInput({
  controlSize = 'default',
  className,
  disabled,
  id,
  ...props
}: PluginSecretInputProps): React.JSX.Element {
  const [visible, setVisible] = useState(false)
  const actionLabel = visible ? '隐藏原文' : '显示原文'

  return (
    <div className="pi-desk-ui-secret">
      <input
        {...props}
        id={id}
        disabled={disabled}
        type="text"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className={classNames(
          'pi-desk-ui-control',
          controlSize === 'sm' && 'pi-desk-ui-control-sm',
          !visible && 'pi-desk-ui-secret-control',
          className
        )}
      />
      <button
        type="button"
        className="pi-desk-ui-secret-toggle"
        aria-label={actionLabel}
        aria-controls={id}
        aria-pressed={visible}
        title={actionLabel}
        disabled={disabled}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? <EyeOffIcon aria-hidden="true" /> : <EyeIcon aria-hidden="true" />}
      </button>
    </div>
  )
}

export interface PluginSelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  controlSize?: PluginControlSize
}

export function PluginSelect({
  controlSize = 'default',
  className,
  ...props
}: PluginSelectProps): React.JSX.Element {
  return (
    <select
      {...props}
      className={classNames(
        'pi-desk-ui-control',
        controlSize === 'sm' && 'pi-desk-ui-control-sm',
        className
      )}
    />
  )
}

export interface PluginSelectOption {
  value: string
  label: ReactNode
  disabled?: boolean
  textValue?: string
}

export interface PluginSelectFieldProps {
  id?: string
  name?: string
  label: ReactNode
  description?: ReactNode
  error?: ReactNode
  value?: string | null
  defaultValue?: string | null
  options: readonly PluginSelectOption[]
  placeholder?: ReactNode
  disabled?: boolean
  required?: boolean
  size?: PluginControlSize
  className?: string
  triggerClassName?: string
  popupClassName?: string
  onValueChange?: (value: string | null) => void
}

function PluginSelectChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 9 5 5 5-5" />
    </svg>
  )
}

function PluginSelectCheckIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5 12 4 4L19 6" />
    </svg>
  )
}

export function PluginSelectField({
  id,
  name,
  label,
  description,
  error,
  value,
  defaultValue,
  options,
  placeholder = '请选择',
  disabled = false,
  required = false,
  size = 'default',
  className,
  triggerClassName,
  popupClassName,
  onValueChange
}: PluginSelectFieldProps): React.JSX.Element {
  const generatedId = useId()
  const triggerId = id ?? generatedId
  const items = options.map((option) => ({ value: option.value, label: option.label }))

  return (
    <PluginField
      label={label}
      htmlFor={triggerId}
      description={description}
      error={error}
      density={size === 'sm' ? 'compact' : 'regular'}
      className={className}
    >
      <SelectPrimitive.Root
        name={name}
        value={value}
        defaultValue={defaultValue}
        items={items}
        disabled={disabled}
        required={required}
        onValueChange={(nextValue) => onValueChange?.(nextValue)}
      >
        <SelectPrimitive.Trigger
          id={triggerId}
          aria-invalid={error ? true : undefined}
          className={classNames(
            'pi-desk-ui-select-trigger',
            size === 'sm' && 'pi-desk-ui-select-trigger-sm',
            triggerClassName
          )}
        >
          <SelectPrimitive.Value placeholder={placeholder} className="pi-desk-ui-select-value" />
          <SelectPrimitive.Icon className="pi-desk-ui-select-icon">
            <PluginSelectChevronIcon />
          </SelectPrimitive.Icon>
        </SelectPrimitive.Trigger>
        <SelectPrimitive.Portal>
          <SelectPrimitive.Positioner
            side="bottom"
            sideOffset={4}
            align="start"
            className="pi-desk-ui-select-positioner"
          >
            <SelectPrimitive.Popup
              className={classNames('pi-desk-ui-select-popup', popupClassName)}
            >
              <SelectPrimitive.List>
                {options.map((option) => (
                  <SelectPrimitive.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    label={
                      option.textValue ??
                      (typeof option.label === 'string' ? option.label : undefined)
                    }
                    className="pi-desk-ui-select-item"
                  >
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="pi-desk-ui-select-indicator">
                      <PluginSelectCheckIcon />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.List>
            </SelectPrimitive.Popup>
          </SelectPrimitive.Positioner>
        </SelectPrimitive.Portal>
      </SelectPrimitive.Root>
    </PluginField>
  )
}

export interface PluginTextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  controlSize?: PluginControlSize
}

export function PluginTextarea({
  controlSize = 'default',
  className,
  ...props
}: PluginTextareaProps): React.JSX.Element {
  return (
    <textarea
      {...props}
      className={classNames(
        'pi-desk-ui-control',
        controlSize === 'sm' && 'pi-desk-ui-control-sm',
        className
      )}
    />
  )
}
