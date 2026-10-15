import { Router } from 'express'
import bcrypt from 'bcryptjs'
import svgCaptcha from 'svg-captcha'
import { promisify } from 'node:util'
import db from './db/db.js'
import { reservePersonnelNumber } from './db/personnel-numbers.js'
import { submitRequest } from './requests.js'
import { authenticate, audit, fail, string, roles, choice, id } from './http.js'
import { createAuthLimiter } from './auth-limits.js'
import { captchaDigest, verifyCaptcha } from './captcha.js'
import { login, refreshSession } from './login.js'
import { revokeUserSessions } from './session-policy.js'

export { revokeUserSessions }
export const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' }
const publicUser = ({ id, username, role, avatar }) => ({ id, username, role, avatar })
export function validatePassword(password, min = 8) {
  if (typeof password !== 'string' || password.length < min || Buffer.byteLength(password) > 72 || !/\d/.test(password) || !/[^0-9]/.test(password)) {
    fail(400, `密码须至少 ${min} 位，最多 72 字节，并包含数字和非数字字符`)
  }
}
export async function createUser(username, password, role, status = 'active', profile = {}) {
  const hash = await bcrypt.hash(password, 12)
  return db.transaction(async () => {
    if (['student', 'teacher'].includes(role)) {
      await reservePersonnelNumber(db, profile.number || username)
    }
    const result = db.legacyPassword
      ? await db.run('INSERT INTO users(username,password,password_hash,role,status) VALUES (?,?,?,?,?)', [username, hash, hash, role, status])
      : await db.run('INSERT INTO users(username,password_hash,role,status) VALUES (?,?,?,?)', [username, hash, role, status])
    if (role === 'student') await db.run('INSERT INTO students(user_id,student_no,name) VALUES (?,?,?)', [result.insertId, profile.number || username, profile.name || username])
    if (role === 'teacher') await db.run('INSERT INTO teachers(user_id,teacher_no,name) VALUES (?,?,?)', [result.insertId, profile.number || username, profile.name || username])
    return result.insertId
  })
}
if (!await db.get("SELECT id FROM users WHERE role='admin' LIMIT 1")) {
  const password = process.env.ADMIN_PASSWORD
  if (!password) throw new Error('首次启动须设置 ADMIN_PASSWORD，系统不再生成明文凭据文件')
  validatePassword(password, 12)
  await createUser('admin', password, 'admin')
}

export const auth = Router()
auth.use(['/captcha', '/auth/login', '/auth/register', '/auth/reset-request', '/user/login', '/user/register'], createAuthLimiter())
auth.get('/captcha', async (req, res) => {
  const captcha = svgCaptcha.create({ size: 5, noise: 3, color: true, background: '#eef2f6', ignoreChars: '0oO1ilI' })
  req.session.captchaExpires = Date.now() + 300_000
  await db.transaction(async () => {
    await db.run('DELETE FROM sessions WHERE expires<?', [Date.now()])
    await db.run('DELETE FROM revoked_sessions WHERE expires<?', [Date.now()])
    await db.run('DELETE FROM captchas WHERE expires < ? OR session_id=?', [Date.now(), req.sessionID])
    await db.run('INSERT INTO captchas(session_id,text,expires) VALUES (?,?,?)', [req.sessionID, captchaDigest(captcha.text), req.session.captchaExpires])
  })
  await promisify(req.session.save).call(req.session)
  res.json({ image: `data:image/svg+xml;base64,${Buffer.from(captcha.data).toString('base64')}` })
})
auth.post(['/auth/register', '/auth/login', '/user/register', '/user/login', '/auth/reset-request'], async (req, res) => {
  const captcha = await db.transaction(async () => {
    const row = await db.get('SELECT text,expires FROM captchas WHERE session_id=?' + db.lock, [req.sessionID])
    await db.run('DELETE FROM captchas WHERE session_id=?', [req.sessionID])
    return row
  })
  const { password, code, role } = req.body
  const expires = req.session.captchaExpires
  delete req.session.captchaExpires
  if (!captcha || captcha.expires < Date.now() || !(expires >= Date.now()) || !verifyCaptcha(captcha.text, code)) {
    fail(400, '验证码错误或已过期，请刷新后重试', 'CAPTCHA_INVALID')
  }
  const username = string(req.body.username, '账号', 24)
  if (!/^[\p{L}\p{N}_-]{3,24}$/u.test(username)) fail(400, '账号须为 3–24 位文字、数字、下划线或短横线')
  if (req.path === '/auth/reset-request') {
    const role = choice(req.body.role, ['teacher', 'student'], '身份')
    const number = string(req.body.number, '学号 / 工号', 64)
    const name = string(req.body.name, '姓名', 80)
    await db.transaction(async () => {
      const target = await db.get('SELECT * FROM users WHERE username=?' + db.lock, [username])
      if (!target || target.role !== role) fail(400, '账号或身份资料不匹配')
      if (target.status === 'deleted') fail(400, '账号或身份资料不匹配')
      const table = role === 'student' ? 'students' : 'teachers'
      const field = role === 'student' ? 'student_no' : 'teacher_no'
      const profile = await db.get(`SELECT * FROM ${table} WHERE user_id=?`, [target.id])
      if (profile?.[field] !== number || profile?.name !== name) fail(400, '账号或身份资料不匹配')
      req.user = target
      const recent = await db.get(`SELECT id FROM change_requests
        WHERE user_id=? AND kind='password_reset' AND created_at>=?`,
      [target.id, new Date(Date.now() - 86_400_000).toISOString()])
      if (recent) fail(429, '该账号 24 小时内已提交过重置申请', 'RESET_RATE_LIMITED')
      await submitRequest(req, 'password_reset', target.id, {})
      await revokeUserSessions(target.id)
    })
    return res.status(202).json({ success: true, message: '申请已提交，请联系管理员重置密码' })
  }
  if (typeof password !== 'string' || Buffer.byteLength(password) > 72) fail(400, '密码长度不合法')
  if (req.path.endsWith('register')) {
    validatePassword(password)
    choice(role, ['teacher', 'student'], '身份')
    const response = {
      success: true,
      requiresApproval: role === 'teacher',
      message: '注册请求已受理，登录异常请联系管理员',
    }
    // Teachers require approval; public registration must not grant staff privileges.
    let userId
    try {
      userId = await createUser(username, password, role, role === 'teacher' ? 'pending' : 'active', {
        number: string(req.body[role === 'student' ? 'student_no' : 'teacher_no'], '学号 / 工号', 64),
        name: string(req.body.name, '姓名', 80),
      })
    } catch (error) {
      if (['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'ER_DUP_ENTRY'].includes(error.code)) {
        return res.status(202).json(response)
      }
      throw error
    }
    await audit(req, 'register', 'users', userId)
    return res.status(202).json(response)
  }
  const user = await login(req, username, password)
  res.json({ success: true, user: publicUser(user) })
})
auth.get(['/auth/me', '/user/me'], authenticate, (req, res) => res.json({ user: publicUser(req.user) }))
auth.post(['/auth/logout', '/user/logout'], async (req, res) => {
  if (req.session.userId) req.user = await db.get('SELECT id FROM users WHERE id=?', [req.session.userId])
  await promisify(req.session.destroy).call(req.session)
  res.clearCookie('connect.sid', cookieOptions)
  await audit(req, 'logout', 'users', req.user?.id)
  res.json({ success: true })
})
auth.post('/auth/refresh', authenticate, async (req, res) => {
  const user = await refreshSession(req)
  res.json({ success: true, user: publicUser(user) })
})
auth.patch('/auth/password', authenticate, async (req, res) => {
  validatePassword(req.body.password)
  const row = await db.get('SELECT password_hash FROM users WHERE id=?', [req.user.id])
  if (typeof req.body.currentPassword !== 'string' || !await bcrypt.compare(req.body.currentPassword, row.password_hash)) fail(400, '原密码错误')
  const hash = await bcrypt.hash(req.body.password, 12)
  await db.transaction(async () => {
    const current = await db.get('SELECT password_hash FROM users WHERE id=?' + db.lock, [req.user.id])
    if (current?.password_hash !== row.password_hash) fail(401, '请重新登录', 'UNAUTHENTICATED')
    await authenticate(req, null, () => {})
    await db.run('UPDATE users SET password_hash=? WHERE id=?', [hash, req.user.id])
    if (db.legacyPassword) await db.run('UPDATE users SET password=? WHERE id=?', [hash, req.user.id])
    await revokeUserSessions(req.user.id)
    await audit(req, 'password.change', 'users', req.user.id)
  })
  await promisify(req.session.destroy).call(req.session)
  res.clearCookie('connect.sid', cookieOptions).json({ success: true })
})
auth.get('/users', authenticate, roles('admin'), async (_req, res) => {
  res.json({ items: await db.all("SELECT id,username,role,status,created_at FROM users WHERE status<>'deleted' ORDER BY id") })
})
auth.patch('/users/:id', authenticate, roles('admin'), async (req, res) => {
  const userId = id(req.params.id)
  const status = choice(req.body.status, ['active', 'disabled'])
  await db.transaction(async () => {
    const target = await db.get('SELECT id,role,status FROM users WHERE id=?' + db.lock, [userId])
    if (!target || target.status === 'deleted') fail(404, '账号不存在')
    if (target.role === 'admin') fail(403, '此接口不能停用管理员')
    await db.run('UPDATE users SET status=? WHERE id=?', [status, userId])
    if (status === 'disabled') await revokeUserSessions(userId)
    await audit(req, 'user.status', 'users', userId)
  })
  res.json({ success: true })
})
