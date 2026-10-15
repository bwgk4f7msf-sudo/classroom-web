import { Router } from 'express'
import db from './db/db.js'
import { hasNumberConflict, reservePersonnelNumber } from './db/personnel-numbers.js'
import { revokeUserSessions } from './auth.js'
import { authenticate, roles, id, string, fail, audit, now } from './http.js'
import { notifyClass } from './requests.js'

export const users = Router()
users.use(['/students', '/teachers', '/users'], authenticate, roles('admin'))

for (const table of ['students', 'teachers']) {
  const field = table === 'students' ? 'student_no' : 'teacher_no'
  const otherTable = table === 'students' ? 'teachers' : 'students'
  const otherField = table === 'students' ? 'teacher_no' : 'student_no'

  users.get(`/${table}`, async (_req, res) => {
    const items = await db.all(`SELECT p.*,u.username,u.status,
      EXISTS (SELECT 1 FROM ${otherTable} o WHERE o.${otherField}=p.${field}) AS number_conflict,
      EXISTS (SELECT 1 FROM change_requests r WHERE r.user_id=p.user_id
        AND r.kind='password_reset' AND r.status='pending') AS reset_requested
      FROM ${table} p JOIN users u ON u.id=p.user_id
      WHERE u.status<>'deleted' ORDER BY p.id`)
    res.json({ items })
  })

  users.patch(`/${table}/:id`, async (req, res) => {
    await db.transaction(async () => {
      const row = await db.get(`SELECT p.*,u.status FROM ${table} p
        JOIN users u ON u.id=p.user_id WHERE p.id=?` + db.lock, [id(req.params.id)])
      if (!row || row.status === 'deleted') fail(404, '人员资料不存在')
      const number = string(req.body[field] ?? row[field], '学号 / 工号', 64)
      if (number !== row[field]) {
        if (!await hasNumberConflict(db, row[field])) {
          fail(400, '学号 / 工号注册后不可修改，仅允许修正历史重复编号')
        }
        await reservePersonnelNumber(db, number)
      }
      await db.run(`UPDATE ${table} SET ${field}=?,name=? WHERE id=?`, [
        number, string(req.body.name ?? row.name, '姓名', 80), row.id,
      ])
      if (table === 'students' && req.body.class_name !== undefined) {
        const className = req.body.class_name === '' ? '' : string(req.body.class_name, '班级')
        await db.run('UPDATE students SET class_name=? WHERE id=?', [className, row.id])
      }
      await audit(req, 'update', table, row.id)
    })
    res.json({ success: true })
  })
}

users.delete('/users/:id', async (req, res) => {
  await db.transaction(async () => {
    const target = await db.get('SELECT * FROM users WHERE id=?' + db.lock, [id(req.params.id)])
    if (!target || target.status === 'deleted') fail(404, '账号不存在')
    if (target.role === 'admin') fail(403, '不能移除管理员账号')

    // Keep referenced profiles and attendance history, but permanently remove access.
    await db.run("UPDATE users SET status='deleted' WHERE id=?", [target.id])
    await revokeUserSessions(target.id)
    await db.run(`UPDATE change_requests SET status='rejected',review_note=?,reviewer_id=?,reviewed_at=?
      WHERE user_id=? AND status='pending'`, ['用户已移除', req.user.id, now(), target.id])

    if (target.role === 'student') {
      await db.run(`UPDATE enrollments SET status='withdrawn'
        WHERE student_id IN (SELECT id FROM students WHERE user_id=?)`, [target.id])
    } else {
      const classes = await db.all(`SELECT c.id FROM teaching_classes c
        JOIN teachers t ON t.id=c.teacher_id WHERE t.user_id=? AND c.status='active'`, [target.id])
      for (const classroom of classes) {
        await db.run("UPDATE teaching_classes SET status='archived' WHERE id=?", [classroom.id])
        await db.run("UPDATE attendance_tasks SET status='ended' WHERE teaching_class_id=?", [classroom.id])
        await notifyClass(classroom.id, '任课教师已移除，教学班已归档，请联系管理员')
      }
    }
    await audit(req, 'user.remove', 'users', target.id)
  })
  res.json({ success: true })
})
