import db from './db/db.js'
import { ownedClass, id, fail, audit } from './http.js'

function pageNumber(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const number = value === undefined ? fallback : id(value)
  if (number > maximum) fail(400, `每页最多 ${maximum} 个学生`)
  return number
}

export async function listStudentCandidates(req, res) {
  const classroom = await ownedClass(req, req.params.id)
  if (classroom.status !== 'active') fail(409, '教学班已归档')
  const page = pageNumber(req.query.page, 1)
  const pageSize = pageNumber(req.query.page_size, 20, 100)
  if (req.query.q !== undefined && typeof req.query.q !== 'string') {
    fail(400, '搜索内容须为文字')
  }
  const query = (req.query.q || '').trim().slice(0, 80)
  const pattern = `%${query.replace(/[!%_]/g, '!$&')}%`
  const filter = `FROM students s JOIN users u ON u.id=s.user_id
    WHERE u.status='active'
      AND (s.student_no LIKE ? ESCAPE '!' OR s.name LIKE ? ESCAPE '!')`
  const { total } = await db.get(`SELECT COUNT(*) AS total ${filter}`, [pattern, pattern])
  const offset = (page - 1) * pageSize
  if (!Number.isSafeInteger(offset)) fail(400, '页码超出范围')
  const items = await db.all(`SELECT s.id,s.student_no,s.name,s.class_name,
    EXISTS (SELECT 1 FROM enrollments e WHERE e.teaching_class_id=?
      AND e.student_id=s.id AND e.status='active') AS enrolled
    ${filter} ORDER BY s.student_no,s.id LIMIT ${pageSize} OFFSET ${offset}`,
  [classroom.id, pattern, pattern])
  res.json({
    items: items.map(row => ({ ...row, enrolled: Boolean(Number(row.enrolled)) })),
    total: Number(total), page, page_size: pageSize,
  })
}

export async function addStudents(req, res) {
  const input = req.body.student_ids
  if (!Array.isArray(input) || input.length === 0 || input.length > 500) {
    fail(400, '请选择 1–500 名学生')
  }
  const studentIds = [...new Set(input.map(id))].sort((a, b) => a - b)
  const result = await db.transaction(async () => {
    // Serialize batches for this class, including retries of the same selection.
    await db.get('SELECT id FROM teaching_classes WHERE id=?' + db.lock, [id(req.params.id)])
    const classroom = await ownedClass(req, req.params.id)
    if (classroom.status !== 'active') fail(409, '教学班已归档')
    const placeholders = studentIds.map(() => '?').join(',')
    const students = await db.all(`SELECT s.id FROM students s JOIN users u ON u.id=s.user_id
      WHERE s.id IN (${placeholders}) AND u.status='active' ORDER BY s.id` + db.lock, studentIds)
    if (students.length !== studentIds.length) {
      fail(409, '所选学生中有账号已停用、已移除或不存在，请刷新名单后重新选择')
    }
    let added = 0
    for (const studentId of studentIds) {
      const enrollment = await db.get(`SELECT id,status FROM enrollments
        WHERE teaching_class_id=? AND student_id=?` + db.lock, [classroom.id, studentId])
      if (enrollment?.status === 'active') continue
      if (enrollment) {
        await db.run("UPDATE enrollments SET status='active',revision=revision+1 WHERE id=?", [enrollment.id])
      } else {
        await db.run('INSERT INTO enrollments(teaching_class_id,student_id) VALUES (?,?)',
          [classroom.id, studentId])
      }
      added++
    }
    if (added) await audit(req, 'enroll.batch', 'teaching_classes', classroom.id)
    return { success: true, added, skipped: studentIds.length - added }
  })
  res.json(result)
}
