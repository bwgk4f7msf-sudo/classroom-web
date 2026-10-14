import db from './db/db.js'

export function fail(status, message, code) {
  const error = new Error(message)
  error.status = status
  error.code = code
  throw error
}
export function string(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `${label}不能为空且不能超过 ${max} 字符`)
  return value.trim()
}
export function id(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+$/.test(String(value))) fail(400, '无效的资源 ID')
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1) fail(400, '无效的资源 ID')
  return result
}
export function choice(value, values, label = '状态') {
  if (!values.includes(value)) fail(400, `${label}不合法`)
  return value
}
export const now = () => new Date().toISOString()
export async function audit(req, action, type, resource, result = 'success') {
  await db.run('INSERT INTO audit_logs(actor_id,action,resource_type,resource_id,result,created_at) VALUES (?,?,?,?,?,?)',
    [req.user?.id || null, action, type, resource == null ? null : String(resource), result, now()])
}
export async function authenticate(req, _res, next) {
  const active = await db.get('SELECT sid FROM sessions WHERE sid=? AND expires>?', [req.sessionID, Date.now()])
  req.user = active && req.session.userId ? await db.get('SELECT id,username,role,status,avatar FROM users WHERE id=?', [req.session.userId]) : null
  if (!req.user || req.user.status !== 'active') fail(401, '请先登录', 'UNAUTHENTICATED')
  next()
}
export const roles = (...allowed) => (req, _res, next) => {
  if (!req.user) fail(401, '请先登录', 'UNAUTHENTICATED')
  if (!allowed.includes(req.user.role)) fail(403, '没有操作权限', 'FORBIDDEN')
  next()
}
export async function student(req) {
  const row = await db.get('SELECT * FROM students WHERE user_id=?', [req.user.id])
  if (!row) fail(403, '学生资料不存在')
  return row
}
export async function ownedClass(req, classId) {
  const row = await db.get('SELECT c.*,t.user_id AS teacher_user_id FROM teaching_classes c JOIN teachers t ON t.id=c.teacher_id WHERE c.id=?', [id(classId)])
  if (!row) fail(404, '教学班不存在')
  if (req.user.role !== 'admin' && row.teacher_user_id !== req.user.id) fail(403, '只能操作本人教学班')
  return row
}
