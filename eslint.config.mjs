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
