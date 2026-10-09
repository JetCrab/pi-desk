import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseDocument } from 'yaml'

function access(permissions, scope) {
  if (permissions === 'write-all') return 2
  if (permissions === 'read-all') return scope === 'id-token' ? 0 : 1
  return { none: 0, read: 1, write: 2 }[permissions?.[scope] ?? 'none']
}

export function checkWorkflowContracts(workflows) {
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const [jobName, caller] of Object.entries(workflow.jobs ?? {})) {
      if (!caller.uses?.startsWith('./.github/workflows/')) continue
      const target = caller.uses.slice('./.github/workflows/'.length)
      const callee = workflows[target]
      assert.ok(callee, `${name}/${jobName} 调用了不存在的 ${target}`)
      assert.ok(Object.hasOwn(callee.on ?? {}, 'workflow_call'), `${target} 不是可复用工作流`)
      const contract = callee.on.workflow_call ?? {}
      for (const [input, definition] of Object.entries(contract.inputs ?? {})) {
        assert.ok(
          !definition.required || Object.hasOwn(caller.with ?? {}, input),
          `${name}/${jobName} 缺少参数 ${input}`
        )
      }
      for (const input of Object.keys(caller.with ?? {})) {
        assert.ok(
          Object.hasOwn(contract.inputs ?? {}, input),
          `${name}/${jobName} 提供了未知参数 ${input}`
        )
      }
      const granted = caller.permissions ?? workflow.permissions ?? { contents: 'read' }
      for (const [taskName, task] of Object.entries(callee.jobs ?? {})) {
        const requested = task.permissions ?? callee.permissions
        if (requested === undefined) continue
        const scopes =
          typeof requested === 'string'
            ? [
                'actions',
                'checks',
                'contents',
                'deployments',
                'discussions',
                'id-token',
                'issues',
                'packages',
                'pages',
                'pull-requests',
                'security-events',
                'statuses',
                'attestations',
                'models'
              ]
            : Object.keys(requested)
        for (const scope of scopes) {
          assert.ok(
            access(granted, scope) >= access(requested, scope),
            `${name}/${jobName} 未授予 ${target}/${taskName} 所需的 ${scope} 权限`
          )
        }
      }
    }
  }
}

export async function checkWorkflows(root) {
  const directory = resolve(root, '.github/workflows')
  const workflows = {}
  for (const name of await readdir(directory)) {
    if (!/\.ya?ml$/.test(name)) continue
    const document = parseDocument(await readFile(resolve(directory, name), 'utf8'), {
      uniqueKeys: true
    })
    assert.equal(
      document.errors.length,
      0,
      `${name} YAML 无效：${document.errors.map((error) => error.message).join('；')}`
    )
    workflows[name] = document.toJSON()
  }
  checkWorkflowContracts(workflows)
  console.info(`工作流调用参数与权限检查通过：${Object.keys(workflows).length} 个入口。`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  checkWorkflows(resolve(import.meta.dirname, '../..')).catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
