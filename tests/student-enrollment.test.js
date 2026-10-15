import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { client, db, createUser } from './helpers/account-api.js'

const admin = client()
const teacher = client()
const other = client()
const learner = client()
const students = []
let teacherId
let sequence = 0

before(async () => {
  await createUser('batch_teacher', 'Password123', 'teacher')
  await createUser('batch_other', 'Password123', 'teacher')
  const userId = await createUser('batch_learner', 'Password123', 'student')
  await admin.login('admin', process.env.ADMIN_PASSWORD)
  await teacher.login('batch_teacher')
  await other.login('batch_other')
  await learner.login('batch_learner')
  teacherId = (await teacher.request('/profile')).profile.id
  // Share a password hash to keep the multi-page fixture fast and isolated.
  for (let index = 1; index <= 25; index++) {
    const number = `2026-${String(index).padStart(3, '0')}`
    const result = await db.run(`INSERT INTO users(username,password_hash,role,status)
      SELECT ?,password_hash,'student','active' FROM users WHERE id=?`, [`candidate_${index}`, userId])
    const profile = await db.run('INSERT INTO students(user_id,student_no,name,class_name) VALUES (?,?,?,?)', [
      result.insertId, number, `测试学生${index}`, '计算机一班',
    ])
    students.push({ id: profile.insertId, userId: result.insertId, number })
  }
})

async function classroom() {
  const course = await admin.request('/courses', 'POST', {
    course_code: `BATCH-${++sequence}`, course_name: '批量选课测试',
  }, 201)
  return admin.request('/teaching-classes', 'POST', {
    course_id: course.id, teacher_id: teacherId, term: '2090', name: '批量选课班',
  }, 201)
}

const listPath = id => `/teaching-classes/${id}/student-candidates`
const batchPath = id => `/teaching-classes/${id}/enrollments/batch`

test('full candidate list covers every page, supports search and marks membership', async () => {
  const course = await classroom()
  await teacher.request(`/scheduled-courses/${course.id}/students`, 'POST', {
    student_no: students[0].number,
  }, 201)
  const first = await teacher.request(listPath(course.id))
  assert.equal(first.total, 26)
  assert.equal(first.items.length, 20)
  assert.equal(first.items[0].enrolled, true)
  assert.equal(first.items[0].class_name, '计算机一班')
  assert.equal(first.items[1].enrolled, false)
  assert.deepEqual(Object.keys(first.items[0]).sort(), ['class_name', 'enrolled', 'id', 'name', 'student_no'])
  const second = await teacher.request(listPath(course.id) + '?page=2')
  assert.equal(second.items.length, 6)
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 26)
  assert.equal((await teacher.request(listPath(course.id) + '?q=2026-025')).items[0].id, students[24].id)
  const byName = await teacher.request(listPath(course.id) + '?q=' + encodeURIComponent('测试学生25'))
  assert.equal(byName.total, 1)
  assert.equal(byName.items[0].id, students[24].id)
  for (const query of ['%', '2026_', '!']) {
    assert.equal((await teacher.request(listPath(course.id) + '?q=' + encodeURIComponent(query))).total, 0)
  }
  assert.equal((await admin.request(listPath(course.id) + '?page_size=100')).items.length, 26)
})

test('batch enrollment adds multiple students and safely handles duplicate submissions', async () => {
  const course = await classroom()
  const ids = [students[0].id, students[1].id, students[24].id]
  const first = await teacher.request(batchPath(course.id), 'POST', { student_ids: [...ids, ids[0]] })
  assert.deepEqual(first, { success: true, added: 3, skipped: 0 })
  const retry = await teacher.request(batchPath(course.id), 'POST', { student_ids: ids })
  assert.deepEqual(retry, { success: true, added: 0, skipped: 3 })
  const mixed = await admin.request(batchPath(course.id), 'POST', {
    student_ids: [ids[0], students[2].id],
  })
  assert.deepEqual(mixed, { success: true, added: 1, skipped: 1 })
  const roster = await teacher.request(`/teaching-classes/${course.id}/enrollments`)
  assert.equal(roster.items.length, 4)
  assert.ok(await db.get("SELECT id FROM audit_logs WHERE action='enroll.batch' AND resource_id=?", [String(course.id)]))
})

test('batch re-enrollment invalidates stale removal approvals and preserves history', async () => {
  const course = await classroom()
  const student = students[3]
  await teacher.request(batchPath(course.id), 'POST', { student_ids: [student.id] })
  const row = await db.get('SELECT * FROM enrollments WHERE teaching_class_id=?', [course.id])
  const pending = await teacher.request(`/enrollments/${row.id}`, 'DELETE', { reason: '旧申请' }, 202)
  await admin.request(`/enrollments/${row.id}`, 'DELETE', { reason: '管理员移除' })
  await teacher.request(batchPath(course.id), 'POST', { student_ids: [student.id] })
  const restored = await db.get('SELECT * FROM enrollments WHERE id=?', [row.id])
  assert.equal(restored.status, 'active')
  assert.ok(restored.revision > row.revision)
  await admin.request(`/requests/${pending.requestId}`, 'PATCH', {
    status: 'approved', note: '不能批准旧申请',
  }, 409)
})

test('listing and batch writes enforce roles, class ownership and active status', async () => {
  const course = await classroom()
  for (const user of [other, learner, client()]) {
    const status = user.cookie ? 403 : 401
    await user.request(listPath(course.id), 'GET', undefined, status)
    await user.request(batchPath(course.id), 'POST', { student_ids: [students[0].id] }, status)
  }
  await admin.request(`/teaching-classes/${course.id}`, 'DELETE')
  await teacher.request(listPath(course.id), 'GET', undefined, 409)
  await admin.request(batchPath(course.id), 'POST', { student_ids: [students[0].id] }, 409)
})

test('disabled or removed students stay hidden and invalidate the whole batch', async () => {
  const course = await classroom()
  await admin.request(`/users/${students[23].userId}`, 'PATCH', { status: 'disabled' })
  await admin.request(`/users/${students[24].userId}`, 'DELETE')
  const listing = await teacher.request(listPath(course.id) + '?page_size=100')
  assert.equal(listing.total, 24)
  assert.ok(listing.items.every(row => ![students[23].id, students[24].id].includes(row.id)))
  for (const invalid of [students[23].id, students[24].id, 999999]) {
    await teacher.request(batchPath(course.id), 'POST', {
      student_ids: [students[0].id, invalid],
    }, 409)
    assert.equal((await db.all('SELECT id FROM enrollments WHERE teaching_class_id=?', [course.id])).length, 0)
  }
})

test('invalid request data is rejected without changing enrollments', async () => {
  const course = await classroom()
  for (const value of [undefined, [], '1', [0], ['abc'], Array(501).fill(students[0].id)]) {
    await teacher.request(batchPath(course.id), 'POST', { student_ids: value }, 400)
  }
  for (const query of ['page=0', 'page=abc', 'page_size=101', 'page_size=-1', 'q=one&q=two']) {
    await teacher.request(listPath(course.id) + '?' + query, 'GET', undefined, 400)
  }
  assert.equal((await db.all('SELECT id FROM enrollments WHERE teaching_class_id=?', [course.id])).length, 0)
})

test('a write failure rolls back the entire batch and its audit', async () => {
  const course = await classroom()
  const previous = await db.all('SELECT * FROM audit_logs')
  await db.run(`CREATE TRIGGER reject_second_enrollment BEFORE INSERT ON enrollments
    WHEN NEW.student_id=${students[1].id}
    BEGIN SELECT RAISE(ABORT, 'simulated enrollment failure'); END`)
  try {
    await teacher.request(batchPath(course.id), 'POST', {
      student_ids: [students[0].id, students[1].id],
    }, 500)
  } finally {
    await db.run('DROP TRIGGER reject_second_enrollment')
  }
  assert.equal((await db.all('SELECT id FROM enrollments WHERE teaching_class_id=?', [course.id])).length, 0)
  assert.deepEqual(await db.all('SELECT * FROM audit_logs'), previous)
})
