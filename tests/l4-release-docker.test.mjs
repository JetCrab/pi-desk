import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  dockerAssets,
  dockerInstallManifests,
  prepareDockerContext,
  restoreDockerArtifacts,
  restoreDockerImage,
  runDockerInputCommand,
  stageDockerImage,
  publishDockerImage
} from '../.github/scripts/release-docker.mjs'
import { sha256 } from '../.github/scripts/release-github.mjs'
import { selectCiChecks } from '../.github/scripts/select-ci-checks.mjs'
import { evaluateWorkflowCondition, readWorkflow } from './fixtures/l4-workflow-test-runtime.mjs'
import { dockerInstallFixture } from './fixtures/l4-docker-install-fixture.mjs'

const source = 'a'.repeat(40)
const version = '1.2.3'
const imageId = `sha256:${'b'.repeat(64)}`
const digest = `sha256:${'c'.repeat(64)}`
const repository = 'ghcr.io/jetcrab/pi-desk'

async function fixture(t) {
  const parent = resolve('temp/tests/release-docker/image-regression')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'batch-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory }
}

function inspection(id = imageId) {
  return {
    Id: id,
    Config: {
      Labels: {
        'org.opencontainers.image.revision': source,
        'org.opencontainers.image.version': version
      }
    }
  }
}

test('镜像使用同批主包和SDK，Pi单独安装并拒绝开发版本', () => {
  const host = {
    name: '@jetcrab/pi-desk',
    version,
    devDependencies: {
      '@earendil-works/pi-coding-agent': '1.0.1'
    }
  }
  const sdk = { name: '@jetcrab/pi-desk-sdk', version: '1.1.0' }
  const manifests = dockerInstallManifests(host, sdk)
  assert.deepEqual(manifests.host.dependencies, {
    '@jetcrab/pi-desk': 'file:host.tgz',
    '@jetcrab/pi-desk-sdk': 'file:sdk.tgz'
  })
  assert.deepEqual(manifests.pi.dependencies, { '@earendil-works/pi-coding-agent': '1.0.1' })
  assert.throws(() => dockerInstallManifests({ ...host, version: '1.2.3-dev.1' }, sdk))
  assert.throws(() => dockerInstallManifests(host, { ...sdk, version: '1.1.0-dev.1' }))
})

test('两套安装锁在构建前固定，同run下载原输入后不重解析，npm ci不跟随范围更新', async (t) => {
  const { directory } = await fixture(t)
  const f = await dockerInstallFixture(t, directory)
  await prepareDockerContext(f.root, f.archives, f.context, version, { source, lock: f.lock })
  const locks = await Promise.all(
    ['host', 'pi'].map((name) => readFile(join(f.context, name, 'package-lock.json')))
  )
  for (const bytes of locks) {
    assert.equal(JSON.parse(bytes).packages['node_modules/docker-fixture-leaf'].version, '1.0.0')
  }
  f.advanceRegistry()
  const retry = join(directory, 'retry')
  const downloads = []
  const result = await restoreDockerArtifacts({
    directory: retry,
    source,
    version,
    runId: '123',
    github: {
      request: async (path) => {
        assert.equal(path, '/actions/runs/123/artifacts?per_page=100&page=1')
        return { artifacts: [{ name: 'docker-inputs-123', expired: false }] }
      }
    },
    download: async (name, target) => {
      downloads.push(name)
      await cp(f.context, target, { recursive: true })
    }
  })
  assert.deepEqual(result, { reused: false, inputsReused: true })
  assert.deepEqual(downloads, ['docker-inputs-123'])
  const context = join(retry, 'context')
  const before = f.requests.length
  await prepareDockerContext(f.root, f.archives, context, version, {
    source,
    lock: () => assert.fail('恢复本批输入不能重新解析依赖')
  })
  assert.equal(f.requests.length, before)
  for (const [index, name] of ['host', 'pi'].entries()) {
    const install = join(context, name)
    await f.npm(install, ['ci', '--omit=dev', ...(name === 'pi' ? ['--ignore-scripts'] : [])])
    assert.deepEqual(await readFile(join(install, 'package-lock.json')), locks[index])
    const leaf = JSON.parse(
      await readFile(join(install, 'node_modules/docker-fixture-leaf/package.json'))
    )
    assert.equal(leaf.version, '1.0.0')
  }
})

test('固定旧配方不支持锁时准备阶段阻断，不修改原配方且成功镜像仍直接复用', async (t) => {
  const { directory } = await fixture(t)
  const f = await dockerInstallFixture(t, directory)
  const recipe = join(f.root, 'apps/docker/Dockerfile')
  const ignore = join(f.root, 'apps/docker/.dockerignore')
  const originalRecipe = await readFile(recipe, 'utf8')
  const originalIgnore = await readFile(ignore, 'utf8')
  for (const [path, original, unsupported] of [
    [
      recipe,
      originalRecipe,
      originalRecipe.replaceAll('npm ci --omit=dev', 'npm install --omit=dev')
    ],
    [recipe, originalRecipe, originalRecipe.replace('pi/package-lock.json ', '')],
    [ignore, originalIgnore, originalIgnore.replace('!host/package-lock.json', '')],
    [ignore, originalIgnore, originalIgnore.replace('!pi/package-lock.json', '')]
  ]) {
    await writeFile(path, unsupported)
    await assert.rejects(
      prepareDockerContext(f.root, f.archives, f.context, version, {
        source,
        lock: () => assert.fail('旧配方不能开始解析安装锁')
      }),
      /固定源码.*不支持.*请发布.*新版本/
    )
    assert.equal(await readFile(path, 'utf8'), unsupported)
    await assert.rejects(readFile(join(f.context, dockerAssets.inputs)), /ENOENT/)
    await writeFile(path, original)
  }
  await writeFile(recipe, originalRecipe.replaceAll('npm ci --omit=dev', 'npm install --omit=dev'))
  await writeFile(join(directory, dockerAssets.archive), 'original verified image')
  await stageDockerImage({ directory, source, version, imageId })
  const result = await restoreDockerArtifacts({
    directory,
    source,
    version,
    runId: '123',
    github: {
      request: async () => ({ artifacts: [{ name: 'docker-image-123', expired: false }] })
    },
    download: async (name) => assert.equal(name, 'docker-image-123')
  })
  assert.deepEqual(result, { reused: true, inputsReused: false })
})

test(
  '安装锁和归档下载命令超时保留阶段与stderr，释放父子进程及端口',
  { timeout: 60000 },
  async (t) => {
    const { directory } = await fixture(t)
    for (const phase of ['lock-host', 'download-docker-inputs']) {
      const stateFile = join(directory, `${phase}.json`)
      const descendant = `
      const server = require('node:net').createServer()
      server.listen(0, '127.0.0.1', () => {
        require('node:fs').writeFileSync(process.argv[1], JSON.stringify({
          rootPid: Number(process.argv[2]), pid: process.pid, port: server.address().port
        }))
      })
    `
      const root = `
      require('node:fs').writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({ rootPid: process.pid }))
      require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}, ${JSON.stringify(stateFile)}, String(process.pid)], {
        stdio: 'ignore', windowsHide: true
      })
      process.stderr.write('fixture registry stalled\\n')
      setInterval(() => {}, 1000)
    `
      let state
      t.after(async () => {
        if (!state) return
        const running = [state.rootPid, state.pid].filter(Boolean).some((pid) => {
          try {
            process.kill(pid, 0)
            return true
          } catch (error) {
            if (error.code !== 'ESRCH') throw error
            return false
          }
        })
        if (running) {
          const { terminateManagedTree } =
            await import('../src/server/l4_foundation/process/l4-process-tree.js')
          await terminateManagedTree({ pid: state.rootPid, exitCode: null, signalCode: null })
        }
      })
      const started = performance.now()
      try {
        await assert.rejects(
          runDockerInputCommand(process.execPath, ['-e', root], {
            cwd: directory,
            phase,
            timeout: 2000
          }),
          (error) => {
            assert.equal(error.code, 'ETIMEDOUT')
            assert.ok(error.message.includes(`[docker:${phase}]`))
            assert.match(error.message, /fixture registry stalled/)
            return true
          }
        )
      } finally {
        state = JSON.parse(await readFile(stateFile))
      }
      assert.ok(performance.now() - started < 40000, '命令与进程释放均须有限截止')
      assert.ok(state.pid && state.port, '超时前必须实际启动后代与监听端口')
      for (const pid of [state.rootPid, state.pid]) {
        try {
          process.kill(pid, 0)
          assert.notEqual(process.platform, 'win32', `Windows 进程 ${pid} 未释放`)
          const status = execFileSync('ps', ['-p', String(pid), '-o', 'stat='], {
            encoding: 'utf8',
            timeout: 1000
          })
          assert.match(status.trim(), /^Z/, `Linux 进程 ${pid} 必须已停止执行`)
        } catch (error) {
          if (error.code !== 'ESRCH' && error.status !== 1) throw error
        }
      }
      const probe = createServer()
      probe.listen(state.port, '127.0.0.1')
      await once(probe, 'listening')
      await new Promise((resolveClose, reject) =>
        probe.close((error) => (error ? reject(error) : resolveClose()))
      )
    }
  }
)

test('命令非零退出保留阶段、退出码与stderr', async (t) => {
  const { directory } = await fixture(t)
  await assert.rejects(
    runDockerInputCommand(
      process.execPath,
      ['-e', "process.stderr.write('registry unavailable');process.exit(9)"],
      {
        cwd: directory,
        phase: 'lock-pi',
        timeout: 2000
      }
    ),
    /docker:lock-pi.*退出码=9[\s\S]*registry unavailable/
  )
})

test('安装输入拒绝错源码、版本、原包摘要、锁与构建文件，不覆盖归档', async (t) => {
  const { directory } = await fixture(t)
  const f = await dockerInstallFixture(t, directory)
  await prepareDockerContext(f.root, f.archives, f.context, version, { source, lock: f.lock })
  const record = await readFile(join(f.context, dockerAssets.inputs))
  const prepare = (sha = source, v = version) =>
    prepareDockerContext(f.root, f.archives, f.context, v, {
      source: sha,
      lock: () => assert.fail('错误输入不能重新解析依赖')
    })
  await assert.rejects(prepare('d'.repeat(40)), /源码批次/)
  await assert.rejects(prepare(source, '1.2.4'))
  for (const file of [
    join(f.archives, 'jetcrab-pi-desk-1.2.3.tgz'),
    join(f.archives, 'jetcrab-pi-desk-sdk-1.1.0.tgz'),
    join(f.context, 'host/package-lock.json'),
    join(f.context, 'pi/package-lock.json'),
    join(f.context, 'Dockerfile')
  ]) {
    const original = await readFile(file)
    await writeFile(file, 'changed')
    await assert.rejects(prepare(), /不同|摘要/)
    await writeFile(file, original)
  }
  const sourcePath = join(f.root, 'package.json')
  const sourceHost = JSON.parse(await readFile(sourcePath))
  sourceHost.devDependencies['@earendil-works/pi-coding-agent'] = '1.0.2'
  await writeFile(sourcePath, JSON.stringify(sourceHost))
  await assert.rejects(prepare(), /Pi 版本与源码不同/)
  assert.deepEqual(await readFile(join(f.context, dockerAssets.inputs)), record)
})

test('同run恢复优先使用已验证镜像，旧批次无锁不触发安装输入下载', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.directory, dockerAssets.archive), 'verified original image')
  await stageDockerImage({ ...f, source, version, imageId })
  const downloads = []
  const result = await restoreDockerArtifacts({
    ...f,
    source,
    version,
    runId: '123',
    github: {
      request: async () => ({
        artifacts: [
          { name: 'docker-inputs-123', expired: true },
          { name: 'docker-image-123', expired: false }
        ]
      })
    },
    download: async (name) => {
      downloads.push(name)
    }
  })
  assert.deepEqual(result, { reused: true, inputsReused: false })
  assert.deepEqual(downloads, ['docker-image-123'])
})

test('没有历史镜像和锁才允许首次解析；锁归档过期或不完整时停止', async (t) => {
  const f = await fixture(t)
  const options = {
    ...f,
    source,
    version,
    runId: '123',
    github: { request: async () => ({ artifacts: [] }) },
    download: async () => assert.fail('没有归档时不能下载')
  }
  assert.deepEqual(await restoreDockerArtifacts(options), { reused: false, inputsReused: false })
  await assert.rejects(
    restoreDockerArtifacts({
      ...options,
      github: {
        request: async () => ({ artifacts: [{ name: 'docker-inputs-123', expired: true }] })
      }
    }),
    /已过期/
  )
  await assert.rejects(
    restoreDockerArtifacts({
      ...options,
      github: {
        request: async () => ({ artifacts: [{ name: 'docker-inputs-123', expired: false }] })
      },
      download: async () => {}
    }),
    /归档不完整/
  )
})

test('镜像构建前归档有限保留的原输入，Docker上下文带入两套npm ci锁', async () => {
  const workflow = await readWorkflow('release-docker')
  const steps = workflow.jobs.build.steps
  const uploadIndex = steps.findIndex(
    (step) => step.with?.name === 'docker-inputs-${{ github.run_id }}'
  )
  const buildIndex = steps.findIndex((step) => step.uses === 'docker/build-push-action@v6')
  assert.ok(uploadIndex > 0 && uploadIndex < buildIndex)
  const checkout = steps.find((step) => step.uses === 'actions/checkout@v4')
  assert.equal(checkout.with.ref, '${{ inputs.source_sha }}')
  const currentScripts = steps.filter((step) => step.run?.includes('git show'))
  assert.equal(currentScripts.length, 1)
  assert.match(currentScripts[0].run, /release-docker\.mjs/)
  assert.doesNotMatch(currentScripts[0].run, /apps\/docker/)
  const upload = steps[uploadIndex]
  assert.equal(upload.with['retention-days'], 7)
  assert.equal(upload.with['include-hidden-files'], true)
  assert.ok(upload.if.includes("steps.image.outputs.inputs_reused != 'true'"))
  assert.ok(upload.if.includes("steps.image.outputs.reused != 'true'"))
  const dockerfile = await readFile('apps/docker/Dockerfile', 'utf8')
  assert.equal((dockerfile.match(/RUN npm ci --omit=dev/g) ?? []).length, 2)
  assert.match(dockerfile, /COPY pi\/package.json pi\/package-lock.json/)
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/)
  const ignore = await readFile('apps/docker/.dockerignore', 'utf8')
  for (const name of ['host', 'pi']) assert.ok(ignore.includes(`!${name}/package-lock.json`))
})

test('工作流制品中的已验证镜像按原摘要复用，损坏或错批次禁止复用', async (t) => {
  const f = await fixture(t)
  const bytes = Buffer.from('same verified image')
  await writeFile(join(f.directory, dockerAssets.archive), bytes)
  await stageDockerImage({ ...f, source, version, imageId })
  assert.equal(await restoreDockerImage({ ...f, source, version }), true)
  assert.deepEqual(await readFile(join(f.directory, dockerAssets.archive)), bytes)
  const record = JSON.parse(await readFile(join(f.directory, dockerAssets.record)))
  assert.equal(record.sha256, sha256(bytes))
  await assert.rejects(restoreDockerImage({ ...f, source: 'd'.repeat(40), version }))
  await writeFile(join(f.directory, dockerAssets.archive), 'tampered')
  await assert.rejects(restoreDockerImage({ ...f, source, version }), /摘要/)
})

test('没有镜像制品时允许构建，但归档不完整时不能冒充可复用镜像', async (t) => {
  const f = await fixture(t)
  assert.equal(await restoreDockerImage({ ...f, source, version }), false)
  await writeFile(join(f.directory, dockerAssets.archive), 'verified image without record')
  await assert.rejects(restoreDockerImage({ ...f, source, version }), /记录|完整/)
})

test('首次发布推固定版本与latest，同摘要重试不覆盖固定版本', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.directory, dockerAssets.archive), 'verified')
  await stageDockerImage({ ...f, source, version, imageId })
  for (const existing of [null, digest]) {
    const calls = []
    const run = (args) => {
      calls.push(args)
      if (args[0] === 'image') return JSON.stringify([inspection()])
      return ''
    }
    await publishDockerImage({
      directory: f.directory,
      source,
      version,
      repository,
      findExisting: async () => existing,
      run
    })
    assert.equal(
      calls.some((args) => args[0] === 'push' && args[1] === `${repository}:${version}`),
      existing === null
    )
    assert.ok(calls.some((args) => args[0] === 'push' && args[1] === `${repository}:latest`))
    if (existing)
      assert.ok(
        calls.some((args) => args[0] === 'pull' && args.includes(`${repository}@${digest}`))
      )
  }
})

test('已有固定版本内容不同或无法确认远端状态时不推送', async (t) => {
  const f = await fixture(t)
  await writeFile(join(f.directory, dockerAssets.archive), 'verified')
  await stageDockerImage({ ...f, source, version, imageId })
  const calls = []
  const run = (args) => {
    calls.push(args)
    if (args[0] === 'image')
      return JSON.stringify([
        inspection(args.includes(`${repository}@${digest}`) ? `sha256:${'e'.repeat(64)}` : imageId)
      ])
    return ''
  }
  await assert.rejects(
    publishDockerImage({
      directory: f.directory,
      source,
      version,
      repository,
      findExisting: async () => digest,
      run
    }),
    /不同/
  )
  await assert.rejects(
    publishDockerImage({
      directory: f.directory,
      source,
      version,
      repository,
      findExisting: async () => {
        throw Error('GHCR不可用')
      },
      run
    }),
    /GHCR/
  )
  assert.ok(calls.every((args) => args[0] !== 'push'))
})

test('Docker构建通过Actions恢复制品，不再需要写入Release草稿', async () => {
  const main = await readWorkflow('release-main')
  const workflow = await readWorkflow('release-docker')
  for (const name of ['docker-build', 'docker']) {
    const job = main.jobs[name]
    assert.equal(job.uses, './.github/workflows/release-docker.yml')
    const permissions = job.permissions ?? main.permissions
    assert.equal(permissions.actions, 'read', `${name} 缺少 actions: read`)
    assert.equal(permissions.packages, 'write', `${name} 缺少 packages: write`)
  }
  assert.equal(workflow.jobs.build.permissions.contents, 'read')
  assert.equal(workflow.jobs.build.permissions.actions, 'read')
})

test('无隧道更新的批次仍构建镜像，正式公开要求镜像任务真实成功', async () => {
  const workflow = await readWorkflow('release-main')
  const needs = {
    prepare: {
      result: 'success',
      outputs: { docker: 'true', tunnel: 'false', published: 'false' }
    },
    assemble: { result: 'success' },
    'docker-build': { result: 'success' },
    'npm-publish': { result: 'success' },
    tunnel: { result: 'skipped' },
    docker: { result: 'success' }
  }
  assert.equal(evaluateWorkflowCondition(workflow.jobs['docker-build'].if, { needs }), true)
  assert.equal(evaluateWorkflowCondition(workflow.jobs.docker.if, { needs }), true)
  assert.equal(evaluateWorkflowCondition(workflow.jobs.publish.if, { needs }), true)
  for (const result of ['failure', 'cancelled', 'skipped']) {
    assert.equal(
      evaluateWorkflowCondition(workflow.jobs['docker-build'].if, {
        needs: { ...needs, assemble: { result } }
      }),
      false
    )
    assert.equal(
      evaluateWorkflowCondition(workflow.jobs.docker.if, {
        needs: { ...needs, 'docker-build': { result } }
      }),
      false
    )
    assert.equal(
      evaluateWorkflowCondition(workflow.jobs.publish.if, {
        needs: { ...needs, docker: { result } }
      }),
      false
    )
  }
})

test('Docker仅由main调用且所有公开发布等待镜像验收', async () => {
  const main = await readWorkflow('release-main')
  const docker = await readWorkflow('release-docker')
  const dev = await readWorkflow('release-dev')
  for (const [name, dependencies] of [
    ['docker-build', ['prepare', 'assemble']],
    ['npm-publish', ['prepare', 'assemble', 'docker-build']],
    ['publish', ['prepare', 'assemble', 'npm-publish', 'tunnel', 'docker']]
  ]) {
    for (const dependency of dependencies) assert.ok(main.jobs[name].needs.includes(dependency))
  }
  assert.ok(Object.hasOwn(docker.on, 'workflow_call'))
  assert.equal(Object.hasOwn(docker.on, 'workflow_dispatch'), false)
  assert.equal(Object.hasOwn(docker.on, 'push'), false)
  assert.ok(
    Object.values(docker.jobs).some((job) =>
      job.steps?.some((step) => step.run?.includes('l4-docker-smoke.mjs'))
    )
  )
  assert.ok(
    Object.values(dev.jobs).every((job) => job.uses !== './.github/workflows/release-docker.yml')
  )
  assert.equal(selectCiChecks(['apps/docker/Dockerfile'], false).automation, true)
  assert.equal(selectCiChecks(['apps/docker/Dockerfile'], false).web, false)
})
