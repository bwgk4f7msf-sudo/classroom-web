import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { client, db, createUser } from './helpers/account-api.js'
import Store from '../server/session-store.js'

const sid = browser => decodeURIComponent(browser.cookie.split('=')[1]).slice(2).split('.')[0]

test('a new Web login replaces the old Web login without allowing refresh or stale saves', async () => {
  const userId = await createUser('one_web', 'Password123', 'student')
  const first = client(), second = client()
  await first.login('one_web')
  const oldSid = sid(first)
  const saved = JSON.parse((await db.get('SELECT data FROM sessions WHERE sid=?', [oldSid])).data)
  await second.login('one_web')
  await first.request('/auth/me', 'GET', undefined, 401)
  await first.request('/auth/refresh', 'POST', {}, 401)
  await second.request('/auth/me')
  const store = new Store()
  await promisify(store.set).call(store, oldSid, saved)
  assert.equal(await db.get('SELECT sid FROM sessions WHERE sid=?', [oldSid]), undefined)
  assert.equal((await db.all('SELECT sid FROM sessions WHERE user_id=?', [userId])).length, 1)
  await first.request('/auth/logout', 'POST', {})
  await second.request('/auth/me')
  await first.login('one_web', 'Wrong-password123', 401)
  await second.request('/auth/me')
})

test('simultaneous Web logins leave exactly one usable session', async () => {
  const userId = await createUser('concurrent_web', 'Password123', 'student')
  const browsers = [client(), client()]
  await Promise.all(browsers.map(browser => browser.login('concurrent_web')))
  const sessions = await db.all('SELECT sid FROM sessions WHERE user_id=?', [userId])
  assert.equal(sessions.length, 1)
  for (const browser of browsers) {
    await browser.request('/auth/me', 'GET', undefined, sid(browser) === sessions[0].sid ? 200 : 401)
  }
})

test('Web sessions occupy only their platform slot; Android cannot be self-selected at login', async () => {
  const userId = await createUser('future_platform', 'Password123', 'student')
  const store = new Store()
  await promisify(store.set).call(store, 'trusted-android-session', {
    userId, clientType: 'android', createdAt: Date.now(), cookie: { expires: new Date(Date.now() + 60000) },
  })
  const browser = client()
  await browser.login('future_platform')
  await client().login('future_platform')
  const sessions = await db.all('SELECT sid,client_type FROM sessions WHERE user_id=?', [userId])
  assert.deepEqual(sessions.map(row => row.client_type).sort(), ['android', 'web'])
  const forged = client()
  await forged.request('/auth/login', 'POST', {
    username: 'future_platform', password: 'Password123', client_type: 'android', code: await forged.captcha(),
  }, 400)
})

test('pending password resets block login, refresh and re-enabling until a new password is set', async () => {
  const userId = await createUser('locked_reset', 'Password123', 'student')
  const browser = client(), anonymous = client(), admin = client()
  await browser.login('locked_reset')
  await admin.login('admin', process.env.ADMIN_PASSWORD)
  await anonymous.request('/auth/reset-request', 'POST', {
    username: 'locked_reset', role: 'student', number: 'locked_reset', name: 'locked_reset',
    code: await anonymous.captcha(),
  }, 202)
  await browser.request('/auth/me', 'GET', undefined, 401)
  await browser.request('/auth/refresh', 'POST', {}, 401)
  await browser.login('locked_reset', 'Password123', 403)
  await admin.request(`/users/${userId}`, 'PATCH', { status: 'active' })
  await browser.login('locked_reset', 'Password123', 403)
  assert.equal((await db.all('SELECT sid FROM sessions WHERE user_id=?', [userId])).length, 0)
  await admin.request(`/users/${userId}/reset-password`, 'POST', { password: 'New-password123' })
  await browser.login('locked_reset', 'Password123', 401)
  await browser.login('locked_reset', 'New-password123')
})
