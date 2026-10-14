import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { promisify } from 'node:util'
import express from 'express'
import session from 'express-session'

process.env.DATABASE_PATH = ':memory:'
process.env.ADMIN_PASSWORD = 'Security-tests123'
process.env.SESSION_SECRET = 'security-test-secret-at-least-32-characters'
delete process.env.DB_DRIVER
delete process.env.NODE_ENV
delete process.env.COOKIE_SECURE
delete process.env.APP_ORIGINS
delete process.env.TRUST_PROXY

const { default: app } = await import('../server/app.js')
const { default: db } = await import('../server/db/db.js')
const { default: Store, absoluteSessionAge } = await import('../server/session-store.js')
const { revokeUserSessions, createUser } = await import('../server/auth.js')
const { createAuthLimiter } = await import('../server/auth-limits.js')
const { configureProxy, securityHeaders } = await import('../server/security.js')
const { captchaDigest, verifyCaptcha } = await import('../server/captcha.js')
const { faces } = await import('../server/faces.js')

const servers = []
async function listen(application) {
  const server = application.listen(0, '127.0.0.1')
  servers.push(server)
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}
const base = await listen(app)
after(async () => {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))))
  await db.close()
})

test('API and HTML receive security headers; HTTPS alone enables HSTS', async () => {
  for (const path of ['/api/health', '/']) {
    const response = await fetch(base + path)
    assert.equal(response.headers.get('x-frame-options'), 'DENY')
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/)
    assert.equal(response.headers.get('referrer-policy'), 'strict-origin-when-cross-origin')
    assert.equal(response.headers.get('strict-transport-security'), null)
  }
  const proxyApp = express()
  configureProxy(proxyApp, { TRUST_PROXY: '1', TRUSTED_PROXIES: 'loopback' })
  proxyApp.use(securityHeaders)
  proxyApp.get('/', (_req, res) => res.send('ok'))
  const url = await listen(proxyApp)
  const response = await fetch(url, { headers: { 'X-Forwarded-Proto': 'https' } })
  assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000')
})

test('mutation checks Referer and Fetch Metadata when Origin is missing', async () => {
  for (const headers of [
    { Referer: 'https://evil.example/form' },
    { Referer: 'invalid' },
    { Origin: 'null', Referer: `${base}/login` },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers })
    assert.equal(response.status, 403)
  }
  for (const headers of [{ Referer: `${base}/login?next=home` }, {}]) {
    const response = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers })
    assert.equal(response.status, 200)
  }
})

test('proxy configuration requires an address allowlist and ignores untrusted peers', async () => {
  assert.throws(() => configureProxy(express(), { TRUST_PROXY: '1' }), /TRUSTED_PROXIES/)
  const proxyApp = express()
  configureProxy(proxyApp, { TRUST_PROXY: '1', TRUSTED_PROXIES: '192.0.2.1' })
  proxyApp.get('/', (req, res) => res.json({ ip: req.ip, secure: req.secure }))
  const url = await listen(proxyApp)
  const response = await fetch(url, { headers: {
    'X-Forwarded-For': '203.0.113.1', 'X-Forwarded-Proto': 'https',
  } })
  assert.deepEqual(await response.json(), { ip: '127.0.0.1', secure: false })
})

test('account limits survive IP rotation and aliases; IP limits survive account rotation', () => {
  let time = 1000
  const limiter = createAuthLimiter({ clock: () => time })
  const res = { set() {} }
  const attempt = (username, ip, path = '/api/auth/login') => limiter({
    method: 'POST', body: { username }, ip, originalUrl: path,
  }, res, () => {})
  for (let i = 0; i < 10; i++) attempt(' Victim ', `ip-${i}`)
  assert.throws(() => attempt('victim', 'new-ip', '/api/user/login'), { status: 429 })
  time += 60_000
  assert.doesNotThrow(() => attempt('victim', 'new-ip'))
  for (let i = 0; i < 120; i++) attempt(`user-${i}`, 'shared-ip')
  assert.throws(() => attempt('another', 'shared-ip'), { status: 429 })
})

test('captcha answers use keyed digests and reject plaintext from old deployments', () => {
  const digest = captchaDigest('ABCDE')
  assert.match(digest, /^[a-f0-9]{64}$/)
  assert.equal(verifyCaptcha(digest, ' abcde '), true)
  assert.equal(verifyCaptcha(digest, 'OTHER'), false)
  assert.equal(verifyCaptcha('ABCDE', 'ABCDE'), false)
})

test('face router authenticates independently of other business routers', async () => {
  const faceApp = express()
  faceApp.use(session({ secret: 'face-test', resave: false, saveUninitialized: false }))
  faceApp.use('/api', faces)
  faceApp.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }))
  const response = await fetch(`${await listen(faceApp)}/api/faces/me`)
  assert.equal(response.status, 401)
  assert.equal((await response.json()).code, 'UNAUTHENTICATED')
})

test('corrupt session data does not interrupt revocation or retrieval', async () => {
  const userId = await createUser('session_victim', 'Password123', 'student')
  const expiry = Date.now() + 60_000
  await db.run('INSERT INTO sessions(sid,data,expires) VALUES (?,?,?)', ['broken', '{bad', expiry])
  await db.run('INSERT INTO sessions(sid,data,expires) VALUES (?,?,?)', ['victim', JSON.stringify({ userId }), expiry])
  await revokeUserSessions(userId)
  assert.equal(await db.get('SELECT sid FROM sessions WHERE sid=?', ['victim']), undefined)
  assert.equal(await db.get('SELECT sid FROM sessions WHERE sid=?', ['broken']), undefined)
  await db.run('INSERT INTO sessions(sid,data,expires) VALUES (?,?,?)', ['broken-read', 'null', expiry])
  const store = new Store()
  assert.equal(await promisify(store.get).call(store, 'broken-read'), null)
})

test('session sliding expiry is capped and cleanup runs without captcha requests', async () => {
  const store = new Store()
  const createdAt = Date.now() - absoluteSessionAge + 60_000
  const value = { createdAt, cookie: { expires: new Date(Date.now() + 604800000) } }
  await promisify(store.set).call(store, 'capped', value)
  assert.equal((await db.get('SELECT expires FROM sessions WHERE sid=?', ['capped'])).expires, createdAt + absoluteSessionAge)
  await promisify(store.touch).call(store, 'capped', value)
  assert.equal((await db.get('SELECT expires FROM sessions WHERE sid=?', ['capped'])).expires, createdAt + absoluteSessionAge)
  await db.run('UPDATE sessions SET data=? WHERE sid=?', [JSON.stringify({ ...value, createdAt: 1 }), 'capped'])
  assert.equal(await promisify(store.get).call(store, 'capped'), null)
  await db.run('INSERT INTO captchas(session_id,text,expires) VALUES (?,?,?)', ['expired', 'old', 1])
  store.lastCleanup = 0
  await promisify(store.get).call(store, 'missing')
  assert.equal(await db.get('SELECT session_id FROM captchas WHERE session_id=?', ['expired']), undefined)
})
