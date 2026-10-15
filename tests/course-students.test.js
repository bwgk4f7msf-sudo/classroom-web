import { test } from 'node:test'
import assert from 'node:assert/strict'
import { client, db, createUser } from './helpers/account-api.js'

const admin = client(), teacher = client(), other = client(), learner = client()
await createUser('roster_teacher', 'Password123', 'teacher')
await createUser('roster_other', 'Password123', 'teacher')
await createUser('roster_student', 'Password123', 'student')
await admin.login('admin', process.env.ADMIN_PASSWORD)
await teacher.login('roster_teacher')
await other.login('roster_other')
await learner.login('roster_student')
const teacherId = (await teacher.request('/profile')).profile.id
const student = (await learner.request('/profile')).profile
const course = await admin.request('/courses', 'POST', { course_code: 'ROSTER', course_name: '名单测试' }, 201)
const classroom = await admin.request('/teaching-classes', 'POST', {
  course_id: course.id, teacher_id: teacherId, term: '2090', name: '名单测试班',
}, 201)
await teacher.request(`/teaching-classes/${classroom.id}/enrollments`, 'POST', { student_id: student.id }, 201)
const rosterPath = `/teaching-classes/${classroom.id}/enrollments`
const roster = async () => (await teacher.request(rosterPath)).items
const enrollmentId = (await roster())[0].id

test('only administrators and the owning teacher can see the roster and request removal', async () => {
  assert.equal((await admin.request(rosterPath)).items[0].student_no, 'roster_student')
  await other.request(rosterPath, 'GET', undefined, 403)
  await learner.request(rosterPath, 'GET', undefined, 403)
  await other.request(`/enrollments/${enrollmentId}`, 'DELETE', { reason: '越权' }, 403)
  await learner.request(`/enrollments/${enrollmentId}`, 'DELETE', { reason: '越权' }, 403)
  await teacher.request(`/enrollments/${enrollmentId}`, 'DELETE', { reason: '' }, 400)
})

test('teacher removal waits for admin approval and rejected requests leave membership intact', async () => {
  const request = await teacher.request(`/enrollments/${enrollmentId}`, 'DELETE', { reason: '调整班级' }, 202)
  assert.equal((await roster())[0].removal_pending, true)
  assert.equal((await learner.request('/schedule')).classes.length, 1)
  await teacher.request(`/enrollments/${enrollmentId}`, 'DELETE', { reason: '重复' }, 409)
  await teacher.request(`/requests/${request.requestId}`, 'PATCH', { status: 'approved', note: '越权' }, 403)
  await admin.request(`/requests/${request.requestId}`, 'PATCH', { status: 'rejected', note: '仍需上课' })
  assert.equal((await roster())[0].removal_pending, false)

  const approved = await teacher.request(`/enrollments/${enrollmentId}`, 'PATCH', {
    status: 'withdrawn', reason: '核实转班',
  }, 202)
  assert.equal((await roster()).length, 1, 'legacy PATCH cannot bypass approval')
  await admin.request(`/requests/${approved.requestId}`, 'PATCH', { status: 'approved', note: '核实通过' })
  assert.equal((await roster()).length, 0)
  assert.equal((await learner.request('/schedule')).classes.length, 0)
  assert.equal((await learner.request('/notifications')).items.length, 1)
  assert.ok(await db.get("SELECT id FROM audit_logs WHERE action='enrollment.remove'"))
})

test('administrators can remove directly; stale approval cannot remove a re-enrolled student', async () => {
  await admin.request(`/scheduled-courses/${classroom.id}/students`, 'POST', { student_no: student.student_no }, 201)
  const stale = await teacher.request(`/enrollments/${enrollmentId}`, 'DELETE', { reason: '旧申请' }, 202)
  const task = await teacher.request('/attendance-tasks', 'POST', {
    teaching_class_id: classroom.id,
    start_at: new Date(Date.now() - 60000).toISOString(),
    late_at: new Date(Date.now() + 60000).toISOString(),
    end_at: new Date(Date.now() + 600000).toISOString(),
  }, 201)
  const record = await teacher.request(`/attendance-tasks/${task.id}/manual`, 'POST', {
    student_id: student.id, status: 'manual', reason: '保留历史',
  }, 201)
  await admin.request(`/enrollments/${enrollmentId}`, 'DELETE', { reason: '管理员核实移除' })
  assert.equal((await roster()).length, 0)
  assert.ok(await db.get('SELECT id FROM attendance_records WHERE id=?', [record.id]))
  await admin.request(`/scheduled-courses/${classroom.id}/students`, 'POST', { student_no: student.student_no }, 201)
  await admin.request(`/requests/${stale.requestId}`, 'PATCH', { status: 'approved', note: '不能使用过期申请' }, 409)
  assert.equal((await roster()).length, 1)
  await admin.request(`/requests/${stale.requestId}`, 'PATCH', { status: 'rejected', note: '选课已变更' })
})
