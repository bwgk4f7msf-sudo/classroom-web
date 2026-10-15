import db from './db/db.js'
import { ownedClass, id, string, fail, audit, now } from './http.js'
import { submitRequest } from './requests.js'

export async function listEnrollments(req, res) {
  const classroom = await ownedClass(req, req.params.id)
  const items = await db.all(`SELECT e.*,s.student_no,s.name,s.class_name,u.status AS user_status
    FROM enrollments e JOIN students s ON s.id=e.student_id JOIN users u ON u.id=s.user_id
    WHERE e.teaching_class_id=? AND e.status='active' AND u.status<>'deleted'
    ORDER BY s.student_no`, [classroom.id])
  const requests = await db.all(`SELECT r.target_id,r.payload FROM change_requests r
    JOIN enrollments e ON e.id=r.target_id
    WHERE r.kind='enrollment_remove' AND r.status='pending' AND e.teaching_class_id=?`, [classroom.id])
  res.json({ items: items.map(row => ({
    ...row,
    removal_pending: requests.some(request => request.target_id === row.id
      && JSON.parse(request.payload).revision === row.revision),
  })) })
}

export async function removeEnrollment(req, res) {
  const reason = string(req.body.reason, '移除原因', 500)
  const result = await db.transaction(async () => {
    const row = await db.get('SELECT * FROM enrollments WHERE id=?' + db.lock, [id(req.params.id)])
    if (!row) fail(404, '选课关系不存在')
    const classroom = await ownedClass(req, row.teaching_class_id)
    if (classroom.status !== 'active') fail(409, '教学班已归档')
    if (row.status !== 'active') fail(409, '学生已不在教学班中')
    if (req.approved && row.revision !== req.body.revision) fail(409, '选课关系已变更，请重新申请')
    const person = await db.get('SELECT * FROM students WHERE id=?', [row.student_id])
    if (req.user.role === 'teacher' && !req.approved) {
      return submitRequest(req, 'enrollment_remove', row.id, {
        reason, revision: row.revision,
        student_no: person.student_no, student_name: person.name, class_name: classroom.name,
      })
    }
    await db.run("UPDATE enrollments SET status='withdrawn',revision=revision+1 WHERE id=?", [row.id])
    await db.run('INSERT INTO notifications(user_id,message,created_at) VALUES (?,?,?)', [
      person.user_id, `你已从「${classroom.name}」移除。原因：${reason}`, now(),
    ])
    await audit(req, 'enrollment.remove', 'enrollments', row.id)
    return { success: true }
  })
  res.status(result.requiresApproval ? 202 : 200).json(result)
}
