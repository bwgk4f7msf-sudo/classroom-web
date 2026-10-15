import bcrypt from 'bcryptjs'
import { scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import db from './db/db.js'
import { audit, fail } from './http.js'
import { clientType, resetPending, revokeUserSessions } from './session-policy.js'

const scrypt = promisify(scryptCallback)
async function allowedUser(userId) {
  const user = await db.get('SELECT * FROM users WHERE id=?' + db.lock, [userId])
  if (!user || user.status !== 'active') {
    fail(403, user?.status === 'pending' ? '教师账号等待审核' : '账号不可用')
  }
  if (await resetPending(userId)) fail(403, '密码重置处理中，请联系管理员', 'PASSWORD_RESET_PENDING')
  return user
}

async function saveSession(req, user, platform, createdAt) {
  await promisify(req.session.regenerate).call(req.session)
  req.session.userId = user.id
  req.session.clientType = platform
  req.session.createdAt = createdAt
  await promisify(req.session.save).call(req.session)
}

export async function login(req, username, password) {
  // The public endpoint currently accepts Web only. Android requires its own entrypoint.
  if (req.body.client_type !== undefined && req.body.client_type !== 'web') {
    fail(400, '暂不支持该登录端类型')
  }
  const user = await db.get('SELECT * FROM users WHERE username=?', [username])
  let valid = false
  const legacy = user?.password_hash.startsWith('legacy-scrypt$')
  if (legacy) {
    const [, salt, oldHash] = user.password_hash.split('$')
    const actual = await scrypt(password, salt, 64)
    const expected = Buffer.from(oldHash, 'hex')
    valid = actual.length === expected.length && timingSafeEqual(actual, expected)
  } else if (user) valid = await bcrypt.compare(password, user.password_hash)
  if (!valid || !user) fail(401, '账号或密码错误')

  return db.transaction(async () => {
    const current = await allowedUser(user.id)
    if (current.password_hash !== user.password_hash) fail(401, '账号或密码错误')
    if (legacy) {
      const hash = await bcrypt.hash(password, 12)
      await db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, user.id])
      if (db.legacyPassword) await db.run('UPDATE users SET password=? WHERE id=?', [hash, user.id])
    }
    await revokeUserSessions(user.id, 'web')
    await saveSession(req, current, 'web', Date.now())
    req.user = current
    await audit(req, 'login', 'users', current.id)
    return current
  })
}

export async function refreshSession(req) {
  return db.transaction(async () => {
    const user = await allowedUser(req.user.id)
    const active = await db.get('SELECT sid FROM sessions WHERE sid=? AND expires>?', [req.sessionID, Date.now()])
    if (!active) fail(401, '请重新登录', 'UNAUTHENTICATED')
    await saveSession(req, user, clientType(req.session), req.session.createdAt)
    return user
  })
}
