import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true
        }
      ]
    }
  },
  {
    // 原生 Node 启动早于 Next/tsx，继续使用 CommonJS，不放开其他源码。
    files: [
      'bin/**/*.js',
      'src/server/l1_entry/node/*.js',
      'src/server/l2_biz/service-process/*.js',
      'src/server/l4_foundation/process/*.js',
      'src/server/l4_foundation/pi/l4-pi-global-runtime.js'
    ],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    files: ['src/client/l2_biz/plugin-host/**/*.tsx'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'JSXOpeningElement[name.name=/^(select|option)$/]',
          message: '插件宿主业务请选择 shadcn/select 入口的 Select、SelectItem 等统一组件。'
        },
        {
          selector: 'JSXOpeningElement[name.name=/^(details|summary)$/]',
          message:
            '插件宿主业务请使用 shadcn/collapsible 入口的 Collapsible、CollapsibleTrigger、CollapsibleContent。'
        },
        {
          selector: 'JSXOpeningElement[name.name="input"]',
          message:
            '插件宿主业务请根据输入用途使用 shadcn/input、shadcn/checkbox 或 shadcn/switch 入口的统一组件。'
        },
        {
          selector: 'JSXOpeningElement[name.name="textarea"]',
          message: '插件宿主业务请使用 shadcn/textarea 入口的 Textarea 统一组件。'
        },
        {
          selector: 'JSXOpeningElement[name.name="button"]',
          message:
            '插件宿主业务请使用 shadcn/button 入口的 Button；折叠、选择等操作请使用对应统一组件的 Trigger。'
        }
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@base-ui/react', '@base-ui/react/**'],
              message:
                '插件宿主业务禁止直接导入 Base UI，请使用 @client/l4_foundation/ui/shadcn 下对应用途的统一组件入口。'
            }
          ]
        }
      ]
    }
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    '.next/**',
    'out/**',
    'build/**',
    'plugins/*/dist/**',
    'apps/website/**',
    'apps/desktop/web-dist/**',
    'apps/desktop/src-tauri/target/**',
    'temp/**',
    'next-env.d.ts'
  ])
])

export default eslintConfig
