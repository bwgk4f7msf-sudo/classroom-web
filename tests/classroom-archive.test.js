import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { client, db, createUser } from './helpers/account-api.js'

const admin = client()
const teacher = client()
const learner = client()
let teacherId
let studentId
let sequence = 0

before(async () => {
  await createUser('archive_teacher', 'Password123', 'teacher')
  await createUser('archive_student', 'Password123', 'student')
  await admin.login('admin', process.env.ADMIN_PASSWORD)
  await teacher.login('archive_teacher')
  await learner.login('archive_student')
  teacherId = (await teacher.request('/profile')).profile.id
  studentId = (await learner.request('/profile')).profile.id
})

async function fixture() {
  const course = await admin.request('/courses', 'POST', {
    course_code: `ARCHIVE-${++sequence}`, course_name: '归档测试',
  }, 201)
  const classroom = await admin.request('/teaching-classes', 'POST', {
    course_id: course.id, teacher_id: teacherId, term: '2090', name: '归档测试班',
  }, 201)
  await teacher.request(`/teaching-classes/${classroom.id}/enrollments`, 'POST', {
    student_id: studentId,
  }, 201)
  const tasks = []
  for (const status of ['active', 'paused', 'ended']) {
    const task = await teacher.request('/attendance-tasks', 'POST', {
      teaching_class_id: classroom.id,
      start_at: new Date(Date.now() - 60000).toISOString(),
      late_at: new Date(Date.now() + 60000).toISOString(),
      end_at: new Date(Date.now() + 600000).toISOString(),
    }, 201)
    await db.run('UPDATE attendance_tasks SET status=? WHERE id=?', [status, task.id])
    tasks.push(task.id)
  }
  const record = await teacher.request(`/attendance-tasks/${tasks[0]}/manual`, 'POST', {
    student_id: studentId, status: 'manual', reason: '保留历史',
  }, 201)
  return { id: classroom.id, tasks, recordId: record.id }
}

async function assertArchived(classroom) {
  const row = await db.get('SELECT status FROM teaching_classes WHERE id=?', [classroom.id])
  assert.equal(row.status, 'archived')
  const tasks = (await teacher.request('/attendance-tasks')).items
    .filter(task => task.teaching_class_id === classroom.id)
  assert.equal(tasks.length, 3)
  assert.ok(tasks.every(task => task.status === 'ended'))
  const records = await db.all(`SELECT r.* FROM attendance_records r
    JOIN attendance_tasks t ON t.id=r.task_id WHERE t.teaching_class_id=?`, [classroom.id])
  assert.equal(records.length, 1, 'archiving must not create absences')
  assert.equal(records[0].id, classroom.recordId)
  assert.equal(records[0].status, 'manual')
  const available = (await learner.request('/attendance-tasks/available')).items
  assert.ok(available.every(task => task.teaching_class_id !== classroom.id))
  await teacher.request(`/attendance-tasks/${classroom.tasks[0]}`, 'PATCH', {
    status: 'active',
  }, 409)
}

test('admin archive closes active and paused tasks and preserves history', async () => {
  const classroom = await fixture()
  const other = await fixture()
  await teacher.request(`/teaching-classes/${classroom.id}`, 'DELETE', undefined, 403)
  await admin.request(`/teaching-classes/${classroom.id}`, 'DELETE')
  await admin.request(`/teaching-classes/${classroom.id}`, 'DELETE')
  await assertArchived(classroom)
  const unaffected = await db.get('SELECT status FROM attendance_tasks WHERE id=?', [other.tasks[0]])
  assert.equal(unaffected.status, 'active')
  const notices = (await learner.request('/notifications')).items
  assert.ok(notices.some(notice => notice.message.includes('归档')))
})

test('PATCH archive closes tasks and reactivation leaves them ended', async () => {
  const classroom = await fixture()
  await admin.request(`/teaching-classes/${classroom.id}`, 'PATCH', { status: 'archived' })
  await assertArchived(classroom)
  await admin.request(`/teaching-classes/${classroom.id}`, 'PATCH', { status: 'active' })
  const task = await db.get('SELECT status FROM attendance_tasks WHERE id=?', [classroom.tasks[0]])
  assert.equal(task.status, 'ended')
})

test('approved cancellation uses the same archive behavior', async () => {
  const classroom = await fixture()
  const pending = await teacher.request(`/scheduled-courses/${classroom.id}/cancel`, 'POST', {
    reason: '取消课程',
  }, 202)
  const task = await db.get('SELECT status FROM attendance_tasks WHERE id=?', [classroom.tasks[0]])
  assert.equal(task.status, 'active', 'pending approval must leave tasks open')
  await admin.request(`/requests/${pending.requestId}`, 'PATCH', {
    status: 'approved', note: '同意取消',
  })
  await assertArchived(classroom)
})

test('archive rolls back class, task, notification and audit changes on failure', async () => {
  const classroom = await fixture()
  const notifications = await db.all('SELECT * FROM notifications')
  const audits = await db.all('SELECT * FROM audit_logs')
  await db.run(`CREATE TRIGGER reject_archive_notification BEFORE INSERT ON notifications
    BEGIN SELECT RAISE(ABORT, 'simulated notification failure'); END`)
  try {
    await admin.request(`/teaching-classes/${classroom.id}`, 'DELETE', undefined, 500)
  } finally {
    await db.run('DROP TRIGGER reject_archive_notification')
  }
  const row = await db.get('SELECT status FROM teaching_classes WHERE id=?', [classroom.id])
  assert.equal(row.status, 'active')
  const tasks = await db.all('SELECT status FROM attendance_tasks WHERE teaching_class_id=? ORDER BY id', [classroom.id])
  assert.deepEqual(tasks.map(task => task.status), ['active', 'paused', 'ended'])
  assert.deepEqual(await db.all('SELECT * FROM notifications'), notifications)
  assert.deepEqual(await db.all('SELECT * FROM audit_logs'), audits)
})
