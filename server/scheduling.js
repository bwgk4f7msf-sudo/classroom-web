import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import db from './db/db.js'
import { authenticate, roles, ownedClass, id, string, fail, audit, now } from './http.js'
import { submitRequest, notifyClass } from './requests.js'
import { archiveTeachingClass } from './classroom-lifecycle.js'
import { generateSessions } from '../shared/schedule.js'

export const scheduling = Router()
scheduling.use(authenticate)
const teacher = roles('teacher', 'admin')
export const scheduleActions = {}
function action(kind, handler) { scheduleActions[kind] = handler; return handler }
scheduling.post('/scheduled-courses/:id/cancel', teacher, action('course_cancel', async (req, res) => {
  const reason = string(req.body.reason, '取消原因', 500)
  const result = await db.transaction(async () => {
    const c = await ownedClass(req, req.params.id)
    await db.get('SELECT id FROM teachers WHERE id=?' + db.lock, [c.teacher_id])
    if (c.status !== 'active') fail(409, '课程已经取消 / 归档')
    if (req.user.role === 'teacher' && !req.approved) return submitRequest(req, 'course_cancel', c.id, { reason })
    await archiveTeachingClass(c.id)
    await notifyClass(c.id, `课程已取消。原因：${reason}`)
    await audit(req, 'schedule.cancel', 'teaching_classes', c.id)
    return { success: true }
  })
  res.status(result.requiresApproval ? 202 : 200).json(result)
}))
function validated(body) {
  const name = string(body.course_name, '中文课程名称')
  const english = string(body.english_name, '英文课程名称')
  if (!/[\u3400-\u9fff]/.test(name)) fail(400, '中文课程名称须包含中文')
  if (!/[a-z]/i.test(english) || /[\u3400-\u9fff]/.test(english)) fail(400, '英文课程名称须使用英文')
  let sessions
  try { sessions = generateSessions(body.schedule) } catch (error) { fail(400, error.message) }
  if (sessions.some((s) => s.start_at <= now())) fail(400, '排课时间必须晚于当前时间')
  return { name, english, sessions, term: string(body.term, '学期', 64), className: string(body.name, '教学班名称') }
}
async function saveSessions(classId, sessions, teacherId, excludeId) {
  for (const s of sessions) {
    const conflicts = await db.all(`SELECT s.* FROM course_sessions s JOIN teaching_classes c ON c.id=s.teaching_class_id WHERE c.teacher_id=? AND c.status='active' AND s.start_at<? AND s.end_at>?`, [teacherId, s.end_at, s.start_at])
    if (conflicts.some((c) => c.id !== excludeId)) fail(409, '该教师在所选时间已有课程，请调整上课时间')
    if (excludeId) await db.run('UPDATE course_sessions SET start_at=?,end_at=?,location=?,change_reason=? WHERE id=?', [s.start_at, s.end_at, s.location, s.reason, excludeId])
    else await db.run(`INSERT INTO course_sessions(
      teaching_class_id,start_at,end_at,location,original_start,change_reason
    ) VALUES (?,?,?,?,?,?)`, [
      classId, s.start_at, s.end_at, s.location,
      s.original_start ?? s.start_at, s.reason || null,
    ])
  }
}
scheduling.get('/schedule', async (req, res) => {
  let filter = '', params = []
  if (req.user.role === 'teacher') { filter = ' WHERE t.user_id=?'; params = [req.user.id] }
  if (req.user.role === 'student') { filter = " WHERE EXISTS (SELECT 1 FROM enrollments e JOIN students st ON st.id=e.student_id WHERE e.teaching_class_id=c.id AND e.status='active' AND st.user_id=?)"; params = [req.user.id] }
  const classes = await db.all(`SELECT c.*,co.course_name,t.name AS teacher_name,p.english_name,p.schedule FROM teaching_classes c JOIN courses co ON co.id=c.course_id JOIN teachers t ON t.id=c.teacher_id LEFT JOIN course_plans p ON p.teaching_class_id=c.id${filter} ORDER BY c.id DESC`, params)
  const sessions = await db.all(`SELECT s.* FROM course_sessions s JOIN teaching_classes c ON c.id=s.teaching_class_id JOIN teachers t ON t.id=c.teacher_id${filter} ORDER BY s.start_at`, params)
  res.json({ classes: classes.map((c) => ({ ...c, schedule: c.schedule ? JSON.parse(c.schedule) : null })), sessions })
})
scheduling.post('/scheduled-courses/:id/students', teacher, async (req, res) => {
  const c = await ownedClass(req, req.params.id)
  if (c.status !== 'active') fail(409, '教学班已归档')
  const number = string(req.body.student_no, '学号', 64)
  await db.transaction(async () => {
    const s = await db.get(`SELECT s.id FROM students s JOIN users u ON u.id=s.user_id
      WHERE s.student_no=? AND u.status='active'` + db.lock, [number])
    if (!s) fail(404, '未找到该学号的有效学生账号')
    const enrollment = await db.get('SELECT * FROM enrollments WHERE teaching_class_id=? AND student_id=?', [c.id, s.id])
    if (enrollment?.status === 'active') fail(409, '该学生已在教学班中')
    if (enrollment) await db.run("UPDATE enrollments SET status='active',revision=revision+1 WHERE id=?", [enrollment.id])
    else await db.run('INSERT INTO enrollments(teaching_class_id,student_id) VALUES (?,?)', [c.id, s.id])
    await audit(req, 'enroll', 'teaching_classes', c.id)
  })
  res.status(201).json({ success: true })
})
scheduling.post('/scheduled-courses', roles('teacher'), action('course_create', async (req, res) => {
  const data = validated(req.body)
  if (req.user.role === 'teacher' && !req.approved) return res.status(202).json(await submitRequest(req, 'course_create', 0, req.body))
  const result = await db.transaction(async () => {
    const t = await db.get('SELECT id FROM teachers WHERE user_id=?' + db.lock, [req.user.id])
    if (!t) fail(403, '教师资料不存在')
    const course = await db.run('INSERT INTO courses(course_code,course_name) VALUES (?,?)', [randomUUID(), data.name])
    const c = await db.run('INSERT INTO teaching_classes(course_id,teacher_id,term,name) VALUES (?,?,?,?)', [course.insertId, t.id, data.term, data.className])
    await db.run('INSERT INTO course_plans(teaching_class_id,english_name,schedule) VALUES (?,?,?)', [c.insertId, data.english, JSON.stringify(req.body.schedule)])
    await saveSessions(c.insertId, data.sessions, t.id)
    await audit(req, 'schedule.create', 'teaching_classes', c.insertId)
    return c.insertId
  })
  res.status(201).json({ id: result })
}))
scheduling.put('/scheduled-courses/:id', teacher, action('course_update', async (req, res) => {
  const data = validated(req.body)
  const reason = string(req.body.reason, '调课原因', 500)
  const result = await db.transaction(async () => {
    const c = await ownedClass(req, req.params.id)
    if (c.status !== 'active') fail(409, '教学班已归档')
    if (req.user.role === 'teacher' && !req.approved) return submitRequest(req, 'course_update', c.id, req.body)
    await db.get('SELECT id FROM teachers WHERE id=?' + db.lock, [c.teacher_id])
    const cutoff = now()
    const previous = await db.all(`SELECT original_start FROM course_sessions
      WHERE teaching_class_id=? AND start_at>?
      ORDER BY original_start,id` + db.lock, [c.id, cutoff])
    await db.run('DELETE FROM course_sessions WHERE teaching_class_id=? AND start_at>?', [c.id, cutoff])
    // Match lessons in their original order, even if a single lesson was moved later.
    const replacement = data.sessions.map((session, index) => ({
      ...session,
      original_start: previous[index]?.original_start ?? session.start_at,
      reason: previous[index] ? reason : null,
    }))
    await saveSessions(c.id, replacement, c.teacher_id)
    const shared = await db.get('SELECT COUNT(*) AS total FROM teaching_classes WHERE course_id=?', [c.course_id])
    if (shared.total > 1) {
      // A teacher editing their class must not rename another teacher's course.
      const copy = await db.run('INSERT INTO courses(course_code,course_name,credit) SELECT ?,?,credit FROM courses WHERE id=?', [randomUUID(), data.name, c.course_id])
      await db.run('UPDATE teaching_classes SET course_id=? WHERE id=?', [copy.insertId, c.id])
    } else await db.run('UPDATE courses SET course_name=? WHERE id=?', [data.name, c.course_id])
    await db.run('UPDATE teaching_classes SET name=?,term=? WHERE id=?', [data.className, data.term, c.id])
    await db.run('DELETE FROM course_plans WHERE teaching_class_id=?', [c.id])
    await db.run('INSERT INTO course_plans(teaching_class_id,english_name,schedule) VALUES (?,?,?)', [c.id, data.english, JSON.stringify(req.body.schedule)])
    await notifyClass(c.id, `后续课程安排已变更。原因：${reason}`)
    await audit(req, 'schedule.replace', 'teaching_classes', c.id)
  })
  res.status(result?.requiresApproval ? 202 : 200).json(result || { success: true })
}))
scheduling.patch('/course-sessions/:id', teacher, action('session_update', async (req, res) => {
  let sessions
  try { sessions = generateSessions({ ...req.body, repeat: 'once' }) } catch (error) { fail(400, error.message) }
  const reason = string(req.body.reason, '调课原因', 500)
  const result = await db.transaction(async () => {
    const s = await db.get('SELECT * FROM course_sessions WHERE id=?', [id(req.params.id)])
    if (!s) fail(404, '课次不存在')
    const c = await ownedClass(req, s.teaching_class_id)
    await db.get('SELECT id FROM teachers WHERE id=?' + db.lock, [c.teacher_id])
    if (c.status !== 'active' || s.start_at <= now() || sessions[0].start_at <= now()) fail(409, '只能调整尚未开始的有效课程')
    if (req.user.role === 'teacher' && !req.approved) return submitRequest(req, 'session_update', s.id, req.body)
    await saveSessions(c.id, sessions.map((v) => ({ ...v, reason })), c.teacher_id, s.id)
    await notifyClass(c.id, `课次已调整至 ${new Date(Date.parse(sessions[0].start_at) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')}（北京时间），地点：${sessions[0].location}。原因：${reason}`)
    await audit(req, 'schedule.reschedule', 'course_sessions', s.id)
  })
  res.status(result?.requiresApproval ? 202 : 200).json(result || { success: true })
}))
