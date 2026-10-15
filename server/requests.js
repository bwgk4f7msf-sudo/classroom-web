import db from './db/db.js'
import { audit, fail, now } from './http.js'

export async function submitRequest(req, kind, targetId, payload) {
  return db.transaction(async () => {
    const user = await db.get('SELECT id,status FROM users WHERE id=?' + db.lock, [req.user.id])
    if (!user || user.status === 'deleted') fail(401, '请先登录', 'UNAUTHENTICATED')
    const pending = await db.all("SELECT payload FROM change_requests WHERE user_id=? AND kind=? AND target_id=? AND status='pending'", [req.user.id, kind, targetId || 0])
    if (pending.some(row => kind !== 'course_create' || row.payload === JSON.stringify(payload))) fail(409, '已有同类申请待审核，请勿重复提交')
    const result = await db.run('INSERT INTO change_requests(user_id,kind,target_id,payload,created_at) VALUES (?,?,?,?,?)', [req.user.id, kind, targetId || 0, JSON.stringify(payload), now()])
    await audit(req, 'request.submit', 'change_requests', result.insertId)
    return { requestId: result.insertId, requiresApproval: true }
  })
}

export async function notifyClass(classId, message) {
  const c = await db.get('SELECT co.course_name,c.name FROM teaching_classes c JOIN courses co ON co.id=c.course_id WHERE c.id=?', [classId])
  await db.run(`INSERT INTO notifications(user_id,message,created_at)
    SELECT s.user_id,?,? FROM enrollments e JOIN students s ON s.id=e.student_id
    WHERE e.teaching_class_id=? AND e.status='active'`, [`${c.course_name}（${c.name}）：${message}`, now(), classId])
}
