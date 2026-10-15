import { after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { captchaDigest } from '../../server/captcha.js'

process.env.DATABASE_PATH = ':memory:'
process.env.ADMIN_PASSWORD = 'Account-tests123'
process.env.SESSION_SECRET = 'account-tests-secret-at-least-32-characters'
for (const key of ['DB_DRIVER', 'NODE_ENV', 'COOKIE_SECURE', 'APP_ORIGINS', 'TRUST_PROXY']) {
  delete process.env[key]
}

const { default: app } = await import('../../server/app.js')
export const { default: db } = await import('../../server/db/db.js')
export const { createUser } = await import('../../server/auth.js')
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api`
after(async () => {
  await new Promise(resolve => server.close(resolve))
  await db.close()
})

export function client() {
  return {
    cookie: '',
    async request(path, method = 'GET', body, status = 200) {
      const response = await fetch(base + path, {
        method,
        headers: { Cookie: this.cookie, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      if (response.headers.getSetCookie().length) {
        this.cookie = response.headers.getSetCookie()[0].split(';')[0]
      }
      const result = await response.json()
      assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`)
      return result
    },
    async captcha() {
      await this.request('/captcha')
      const sid = decodeURIComponent(this.cookie.split('=')[1]).slice(2).split('.')[0]
      await db.run('UPDATE captchas SET text=? WHERE session_id=?', [captchaDigest('ABCDE'), sid])
      return 'ABCDE'
    },
    async login(username, password = 'Password123', status = 200) {
      return this.request('/auth/login', 'POST', {
        username, password, code: await this.captcha(),
      }, status)
    },
    async register(username, role, number) {
      return this.request('/auth/register', 'POST', {
        username, role, name: username, password: 'Password123',
        [role === 'student' ? 'student_no' : 'teacher_no']: number,
        code: await this.captcha(),
      }, 202)
    },
  }
}
