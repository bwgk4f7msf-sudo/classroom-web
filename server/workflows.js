import { Router } from 'express'
import bcrypt from 'bcryptjs'
import db from './db/db.js'
import { authenticate, roles, id, string, choice, fail, audit, now } from './http.js'
import { validatePassword, revokeUserSessions } from './auth.js'
import { submitRequest } from './requests.js'
import { scheduleActions } from './scheduling.js'

export const workflows = Router()
workflows.use(authenticate)
workflows.get('/profile', async (req, res) => {
  const table = req.user.role === 'student' ? 'students' : 'teachers'
  res.json({ profile: req.user.role === 'admin' ? null : await db.get(`SELECT * FROM ${table} WHERE user_id=?`, [req.user.id]) })
})
workflows.post('/profile/name-request', roles('student', 'teacher'), async (req, res) => {
  const name = string(req.body.name, '姓名', 80)
  res.status(202).json(await submitRequest(req, 'name_change', req.user.id, { name }))
})
workflows.get('/requests', async (req, res) => {
  const filter = req.user.role === 'admin' ? '' : ' WHERE r.user_id=?'
  const rows = await db.all(`SELECT r.*,u.username,u.role FROM change_requests r JOIN users u ON u.id=r.user_id${filter} ORDER BY r.id DESC`, req.user.role === 'admin' ? [] : [req.user.id])
  res.json({ items: rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) })) })
})
workflows.patch('/requests/:id', roles('admin'), async (req, res) => {
  const status = choice(req.body.status, ['approved', 'rejected'])
  const note = string(req.body.note, '审核说明', 500)
  const result = await db.transaction(async () => {
    const row = await db.get('SELECT * FROM change_requests WHERE id=?' + db.lock, [id(req.params.id)])
    if (!row) fail(404, '申请不存在')
    if (row.status !== 'pending') fail(409, '申请已经处理')
    if (row.kind === 'password_reset' && status === 'approved') fail(409, '密码重置申请请在用户管理中重设密码并解禁')
    const applicant = await db.get('SELECT * FROM users WHERE id=?', [row.user_id])
    let applied = {}
    if (status === 'approved') {
      if (applicant.status !== 'active') fail(409, '申请人账号非正常状态，不能批准')
      const body = JSON.parse(row.payload)
      if (row.kind === 'name_change') {
        const table = applicant.role === 'student' ? 'students' : 'teachers'
        await db.run(`UPDATE ${table} SET name=? WHERE user_id=?`, [string(body.name, '姓名', 80), applicant.id])
      } else {
        const handler = scheduleActions[row.kind]
        if (!handler) fail(400, '不支持的申请类型')
        // Run the same validated mutation within this transaction; approval is never an HTTP replay.
        const response = { headersSent: false, status() { return this }, json(value) { applied = value; this.headersSent = true; return this } }
        await handler({ user: applicant, body, params: { id: row.target_id }, approved: true }, response)
      }
    }
    await db.run('UPDATE change_requests SET status=?,review_note=?,reviewer_id=?,reviewed_at=? WHERE id=?', [status, note, req.user.id, now(), row.id])
    await audit(req, `request.${status}`, 'change_requests', row.id)
    return applied
  })
  res.json({ success: true, ...result })
})
workflows.post('/users/:id/reset-password', roles('admin'), async (req, res) => {
  validatePassword(req.body.password)
  const hash = await bcrypt.hash(req.body.password, 12)
  await db.transaction(async () => {
    const target = await db.get('SELECT * FROM users WHERE id=?' + db.lock, [id(req.params.id)])
    if (!target) fail(404, '账号不存在')
    if (!['teacher', 'student'].includes(target.role)) fail(403, '此接口仅适用于教师和学生')
    await db.run("UPDATE users SET password_hash=?,status='active' WHERE id=?", [hash, target.id])
    if (db.legacyPassword) await db.run('UPDATE users SET password=? WHERE id=?', [hash, target.id])
    await revokeUserSessions(target.id)
    await db.run("UPDATE change_requests SET status='approved',review_note=?,reviewer_id=?,reviewed_at=? WHERE user_id=? AND kind='password_reset' AND status='pending'", ['管理员已核实身份、重设密码并解禁', req.user.id, now(), target.id])
    await audit(req, 'password.admin-reset', 'users', target.id)
  })
  res.json({ success: true })
})
workflows.get('/student-candidates', roles('admin', 'teacher'), async (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 64) : ''
  if (!q) return res.json({ items: [] })
  if (req.user.role === 'teacher') {
    const items = await db.all(`SELECT s.id,s.student_no,s.name
      FROM students s JOIN users u ON u.id=s.user_id
      WHERE u.status='active' AND s.student_no=? LIMIT 1`, [q])
    return res.json({ items })
  }
  res.json({ items: await db.all("SELECT s.id,s.student_no,s.name FROM students s JOIN users u ON u.id=s.user_id WHERE u.status='active' AND (s.student_no LIKE ? OR s.name LIKE ?) ORDER BY s.student_no LIMIT 20", [`%${q}%`, `%${q}%`]) })
})
workflows.get('/notifications', roles('student'), async (req, res) => {
  res.json({ items: await db.all('SELECT * FROM notifications WHERE user_id=? AND closed_at IS NULL ORDER BY id', [req.user.id]) })
})
workflows.patch('/notifications/:id/close', roles('student'), async (req, res) => {
  const result = await db.run('UPDATE notifications SET closed_at=? WHERE id=? AND user_id=?', [now(), id(req.params.id), req.user.id])
  if (!result.affectedRows) fail(404, '通知不存在')
  res.json({ success: true })
})
