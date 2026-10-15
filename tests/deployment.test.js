import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))

test('API health responds using only the Docker final-stage runtime files', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'classroom-runtime-'))
  try {
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')
    const finalStage = dockerfile.split(/^FROM .+$/m).at(-1)
    const copies = finalStage.matchAll(/^COPY(?: --from=build)? (\S+) (\S+)\s*$/gm)
    for (const [, source, destination] of copies) {
      const target = resolve(folder, destination)
      if (source === '/app/node_modules') {
        symlinkSync(join(root, 'node_modules'), target, process.platform === 'win32' ? 'junction' : 'dir')
      } else if (source === '/app/dist') {
        // This smoke test checks API startup without requiring a prior frontend build.
        mkdirSync(target, { recursive: true })
      } else {
        const origin = join(root, source.replace(/^\/app\//, ''))
        const output = source === 'package.json' ? join(target, source) : target
        cpSync(origin, output, {
          recursive: true,
          filter: path => statSync(path).isDirectory()
            || path.endsWith('.js') || basename(path) === 'package.json',
        })
      }
    }
    const script = `
      import assert from 'node:assert/strict'
      import { once } from 'node:events'
      const { default: app } = await import('./server/app.js')
      const { default: db } = await import('./server/db/db.js')
      const server = app.listen(0, '127.0.0.1')
      try {
        await once(server, 'listening')
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/health')
        assert.equal(response.status, 200)
        assert.deepEqual(await response.json(), { ok: true })
      } finally {
        await new Promise(resolve => server.close(resolve))
        await db.close()
      }
    `
    await execute(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: folder, timeout: 15000,
      env: {
        ...process.env, NODE_ENV: 'production', DB_DRIVER: 'sqlite', DATABASE_PATH: ':memory:',
        ADMIN_PASSWORD: 'Runtime-test123', SESSION_SECRET: 'runtime-test-secret-at-least-32-characters',
        TRUST_PROXY: '0', APP_ORIGINS: 'https://classroom.example',
      },
    })
  } finally {
    assert.equal(dirname(folder), resolve(tmpdir()))
    assert.ok(basename(folder).startsWith('classroom-runtime-'))
    rmSync(folder, { recursive: true, force: true })
  }
})
