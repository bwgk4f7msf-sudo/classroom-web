import { Router } from 'express'
import multer from 'multer'
import { randomUUID } from 'node:crypto'
import db from './db/db.js'
import { authenticate, roles, student, id, string, choice, fail, audit, now } from './http.js'
import { faceRequest, recognize } from './compreface.js'

export const faces = Router()
faces.use(authenticate)
const learner = roles('student')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  fileFilter: (_req, file, cb) => cb(null, ['image/jpeg', 'image/png'].includes(file.mimetype)),
}).single('file')
function image(req, _res, next) {
  const file = req.file
  if (!file) fail(400, '请上传 JPEG 或 PNG 图片，字段名为 file')
  const png = file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = file.buffer[0] === 255 && file.buffer[1] === 216 && file.buffer[2] === 255
  if (!(png && file.mimetype === 'image/png') && !(jpeg && file.mimetype === 'image/jpeg')) fail(400, '图片内容与文件类型不一致')
  next()
}
async function hasConsent(studentId) {
  const row = await db.get("SELECT decision FROM consent_records WHERE student_id=? AND consent_type='face' ORDER BY id DESC LIMIT 1", [studentId])
  return row?.decision === 'agree'
}
async function removeProfile(req, studentId) {
  return db.transaction(async () => {
    await db.get('SELECT id FROM students WHERE id=?' + db.lock, [studentId])
    const profile = await db.get('SELECT * FROM face_profiles WHERE student_id=?', [studentId])
    if (!profile || profile.status === 'deleted') return null
    await db.run("UPDATE face_profiles SET status='pending_delete' WHERE id=?", [profile.id])
    try {
      await faceRequest(`/subjects/${encodeURIComponent(profile.subject_key)}`, null, 'DELETE')
      await db.run("UPDATE face_profiles SET status='deleted',deleted_at=? WHERE id=?", [now(), profile.id])
      await audit(req, 'face.delete', 'face_profiles', profile.id)
      return null
    } catch (error) {
      await audit(req, 'face.delete', 'face_profiles', profile.id, 'pending')
      return error // Commit disabled status even when the external service is down.
    }
  })
}
faces.post('/faces/consent', learner, async (req, res) => {
  const s = await student(req), decision = choice(req.body.decision, ['agree', 'withdraw'], '同意决定')
  const policy = string(req.body.policy_version, '告知版本', 64)
  await db.transaction(async () => {
    await db.get('SELECT id FROM students WHERE id=?' + db.lock, [s.id])
    await db.run("INSERT INTO consent_records(student_id,policy_version,consent_type,decision,decided_at) VALUES (?,?,'face',?,?)", [s.id, policy, decision, now()])
    if (decision === 'withdraw') await db.run("UPDATE face_profiles SET status='pending_delete' WHERE student_id=? AND status<>'deleted'", [s.id])
    await audit(req, `consent.${decision}`, 'students', s.id)
  })
  const error = decision === 'withdraw' ? await removeProfile(req, s.id) : null
  res.status(error ? 202 : 200).json({ success: true, decision, deletionPending: !!error })
})
faces.get('/faces/me', learner, async (req, res) => {
  const s = await student(req)
  const profile = await db.get('SELECT status,registered_at,deleted_at FROM face_profiles WHERE student_id=?', [s.id])
  res.json({ consent: await hasConsent(s.id), profile: profile || null })
})
faces.delete('/faces/me', learner, async (req, res) => {
  const s = await student(req)
  const error = await removeProfile(req, s.id)
  res.status(error ? 202 : 200).json({ success: true, deletionPending: !!error })
})
faces.post('/faces/register', learner, upload, image, async (req, res) => {
  const s = await student(req)
  const result = await db.transaction(async () => {
    await db.get('SELECT id FROM students WHERE id=?' + db.lock, [s.id])
    if (!await hasConsent(s.id)) fail(403, '请先单独同意人脸信息处理', 'CONSENT_REQUIRED')
    let profile = await db.get('SELECT * FROM face_profiles WHERE student_id=?', [s.id])
    const subject = profile?.subject_key || randomUUID()
    if (!profile) {
      const row = await db.run("INSERT INTO face_profiles(student_id,subject_key,status) VALUES (?,?,'pending_delete')", [s.id, subject])
      profile = { id: row.insertId }
    } else await db.run("UPDATE face_profiles SET status='pending_delete' WHERE id=?", [profile.id])
    try {
      // Stable opaque subject permits safe cleanup/retry after uncertain network outcomes.
      await faceRequest(`/subjects/${encodeURIComponent(subject)}`, null, 'DELETE')
      const registered = await faceRequest(`/faces?subject=${encodeURIComponent(subject)}`, req.file)
      if (registered.subject !== subject || !registered.image_id) fail(503, '人脸服务响应无效', 'FACE_UNAVAILABLE')
      await db.run("UPDATE face_profiles SET status='active',registered_at=?,deleted_at=NULL WHERE id=?", [now(), profile.id])
      await audit(req, 'face.register', 'face_profiles', profile.id)
      return {}
    } catch (error) {
      await audit(req, 'face.register', 'face_profiles', profile.id, 'failed')
      return { error }
    }
  })
  if (result.error) throw result.error
  res.status(201).json({ success: true })
})
async function eligible(taskId, studentId, lock = false) {
  const task = await db.get('SELECT * FROM attendance_tasks WHERE id=?' + (lock ? db.lock : ''), [taskId])
  if (!task) fail(404, '考勤任务不存在', 'TASK_NOT_FOUND')
  const time = now()
  if (task.status !== 'active' || time < task.start_at || time >= task.end_at) fail(409, '不在有效签到时段', 'TASK_INACTIVE')
  const classroom = await db.get('SELECT status FROM teaching_classes WHERE id=?', [task.teaching_class_id])
  if (classroom.status !== 'active') fail(409, '教学班已归档', 'TASK_INACTIVE')
  if (!await db.get("SELECT id FROM enrollments WHERE teaching_class_id=? AND student_id=? AND status='active'", [task.teaching_class_id, studentId])) fail(403, '不是本教学班成员', 'NOT_ENROLLED')
  if (await db.get('SELECT id FROM attendance_records WHERE task_id=? AND student_id=?', [taskId, studentId])) fail(409, '已提交签到，请勿重复签到；异常记录请联系教师复核', 'DUPLICATE_CHECK_IN')
  return task
}
faces.post('/attendance-tasks/:id/check-in', learner, upload, image, async (req, res) => {
  const s = await student(req), taskId = id(req.params.id)
  await eligible(taskId, s.id)
  if (!await hasConsent(s.id)) fail(403, '尚未同意或已撤回人脸信息处理', 'CONSENT_REQUIRED')
  const profile = await db.get("SELECT * FROM face_profiles WHERE student_id=? AND status='active'", [s.id])
  if (!profile) fail(409, '请先登记人脸或联系教师人工登记', 'FACE_NOT_REGISTERED')
  let result, failure
  try { result = await recognize(req.file, profile.subject_key) } catch (error) {
    if (error.status !== 422) throw error // Outages must not consume a student's attempt.
    failure = error
  }
  const record = await db.transaction(async () => {
    const task = await eligible(taskId, s.id, true)
    await db.get('SELECT id FROM students WHERE id=?' + db.lock, [s.id])
    const current = await db.get("SELECT id,registered_at FROM face_profiles WHERE id=? AND status='active'", [profile.id])
    if (!await hasConsent(s.id) || !current || current.registered_at !== profile.registered_at) fail(409, '人脸授权或资料已变更，请重新提交')
    const checkedAt = now()
    const status = failure || !result.matched ? 'exception' : checkedAt >= task.late_at ? 'late' : 'present'
    const row = await db.run("INSERT INTO attendance_records(task_id,student_id,status,similarity,source,checked_at) VALUES (?,?,?,?,'face',?)", [taskId, s.id, status, result?.similarity ?? null, checkedAt])
    await audit(req, 'check-in', 'attendance_records', row.insertId, status)
    return { id: row.insertId, status, similarity: result?.similarity ?? null }
  })
  res.status(record.status === 'exception' ? 202 : 201).json({ ...record, code: failure?.code || (record.status === 'exception' ? 'LOW_SIMILARITY' : undefined), message: failure?.message || (record.status === 'exception' ? '相似度不足，已记录异常，请联系教师复核' : '签到成功') })
})
