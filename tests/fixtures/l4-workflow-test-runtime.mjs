import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'

export async function readWorkflow(name) {
  return parse(
    await readFile(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
  )
}

export function evaluateWorkflowCondition(condition, context) {
  const expression = condition
    .trim()
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(
      /needs\.\*\.([\w-]+)/g,
      (_, key) => `Object.values(needs).map(job => job[${JSON.stringify(key)}])`
    )
    .replace(/needs\.([\w-]+)/g, (_, name) => `needs[${JSON.stringify(name)}]`)
  return runInNewContext(expression, {
    always: () => true,
    cancelled: () => false,
    contains: (values, value) => values.includes(value),
    fromJSON: JSON.parse,
    ...context
  })
}
