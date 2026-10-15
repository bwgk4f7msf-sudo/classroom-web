import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { client, db, createUser } from './helpers/account-api.js'
import Store from '../server/session-store.js'
import { submitRequest } from '../server/requests.js'

const admin = client()
await admin.login('admin', process.env.ADMIN_PASSWORD)

test('public registration rejects numbers used by either role with the same accepted response', async () => {
  const person = client()
  for (const role of ['student', 'teacher']) {
    const number = `SHARED-${role}`
    const original = await person.register(`original_${role}`, role, number)
    const duplicate = await person.register(`duplicate_${role}`, role, number)
    assert.deepEqual(duplicate, original)
    const otherRole = role === 'student' ? 'teacher' : 'student'
    const crossRole = await person.register(`cross_${role}`, otherRole, number)
    assert.equal(crossRole.message, original.message)
    assert.equal(crossRole.requiresApproval, otherRole === 'teacher')
    assert.equal(await db.get('SELECT id FROM users WHERE username=?', [`cross_${role}`]), undefined)
  }
})

test('only pending password-reset applicants can be reset; rejected requests hide the action', async () => {
  const userId = await createUser('reset_applicant', 'Password123', 'student')
  const listing = async () => (await admin.request('/students')).items.find(p => p.user_id === userId)
  assert.equal((await listing()).reset_requested, 0)
  await admin.request(`/users/${userId}/reset-password`, 'POST', { password: 'New-password123' }, 409)
  const anonymous = client()
  await anonymous.request('/auth/reset-request', 'POST', {
    username: 'reset_applicant', role: 'student', number: 'reset_applicant',
    name: 'reset_applicant', code: await anonymous.captcha(),
  }, 202)
  assert.equal((await listing()).reset_requested, 1)
  const request = (await admin.request('/requests')).items.find(r => r.user_id === userId)
  await admin.request(`/requests/${request.id}`, 'PATCH', { status: 'rejected', note: '本人未申请' })
  assert.equal((await listing()).reset_requested, 0)
  await admin.request(`/users/${userId}/reset-password`, 'POST', { password: 'New-password123' }, 409)
  await client().login('reset_applicant')
})

test('teachers find students by partial number or name and cannot query disabled users', async () => {
  await createUser('search_teacher', 'Password123', 'teacher')
  const studentId = await createUser('search_student', 'Password123', 'student', 'active', {
    number: '2026-1101', name: '张同学',
  })
  const teacher = client()
  await teacher.login('search_teacher')
  assert.equal((await teacher.request('/student-candidates?q=2026-11')).items[0].student_no, '2026-1101')
  assert.equal((await teacher.request('/student-candidates?q=' + encodeURIComponent('张同'))).items[0].name, '张同学')
  assert.equal((await teacher.request('/student-candidates?q=')).items.length, 0)
  assert.equal((await teacher.request('/student-candidates?q=%25')).items.length, 0)
  await admin.request(`/users/${studentId}`, 'PATCH', { status: 'disabled' })
  assert.equal((await teacher.request('/student-candidates?q=2026-11')).items.length, 0)
  await client().request('/student-candidates?q=2026', 'GET', undefined, 401)
})

test('historical cross-role duplicates are flagged and only conflicted numbers can be corrected', async () => {
  const studentUser = await createUser('legacy_student', 'Password123', 'student')
  const teacherUser = await createUser('legacy_teacher', 'Password123', 'teacher')
  await db.run('UPDATE teachers SET teacher_no=? WHERE user_id=?', ['legacy_student', teacherUser])
  const student = (await admin.request('/students')).items.find(p => p.user_id === studentUser)
  const teacher = (await admin.request('/teachers')).items.find(p => p.user_id === teacherUser)
  assert.equal(student.number_conflict, 1)
  assert.equal(teacher.number_conflict, 1)
  await admin.request(`/teachers/${teacher.id}`, 'PATCH', {
    teacher_no: 'reset_applicant', name: '必须回滚',
  }, 409)
  assert.equal((await db.get('SELECT name FROM teachers WHERE id=?', [teacher.id])).name, 'legacy_teacher')
  await admin.request(`/teachers/${teacher.id}`, 'PATCH', { teacher_no: 'CORRECTED-T001' })
  assert.equal((await admin.request('/students')).items.find(p => p.id === student.id).number_conflict, 0)
  assert.equal((await admin.request('/teachers')).items.find(p => p.id === teacher.id).number_conflict, 0)
  await admin.request(`/teachers/${teacher.id}`, 'PATCH', { teacher_no: 'CHANGE-AGAIN' }, 400)
  await client().register('reuse_corrected', 'student', 'CORRECTED-T001')
  assert.equal(await db.get("SELECT id FROM users WHERE username='reuse_corrected'"), undefined)
})

test('removing a student revokes every login, hides profiles, preserves history and prevents resurrection', async () => {
  const userId = await createUser('removed_student', 'Password123', 'student')
  const first = client(), second = client()
  await first.login('removed_student')
  await second.login('removed_student')
  const cookies = [first.cookie, second.cookie]
  const sid = decodeURIComponent(second.cookie.split('=')[1]).slice(2).split('.')[0]
  const oldSession = JSON.parse((await db.get('SELECT data FROM sessions WHERE sid=?', [sid])).data)
  const profile = (await second.request('/profile')).profile
  await second.request('/profile/name-request', 'POST', { name: '待审核姓名' }, 202)
  const teacherId = (await db.get('SELECT id FROM teachers LIMIT 1')).id
  const course = await admin.request('/courses', 'POST', { course_code: 'REMOVE', course_name: '移除测试' }, 201)
  const classroom = await admin.request('/teaching-classes', 'POST', {
    course_id: course.id, teacher_id: teacherId, term: '2090', name: '测试班',
  }, 201)
  await admin.request(`/teaching-classes/${classroom.id}/enrollments`, 'POST', { student_id: profile.id }, 201)
  const historyTask = await db.run(`INSERT INTO attendance_tasks(teaching_class_id,start_at,late_at,end_at)
    VALUES (?,?,?,?)`, [classroom.id, '2020-01-01T00:00:00Z', '2020-01-01T00:10:00Z', '2020-01-01T01:00:00Z'])
  const historyRecord = await db.run(`INSERT INTO attendance_records(task_id,student_id,status,source,checked_at)
    VALUES (?,?,'present','manual',?)`, [historyTask.insertId, profile.id, '2020-01-01T00:01:00Z'])
  await second.request(`/users/${userId}`, 'DELETE', undefined, 403)
  await admin.request(`/users/${userId}`, 'DELETE')

  for (const cookie of cookies) {
    first.cookie = cookie
    await first.request('/auth/me', 'GET', undefined, 401)
    first.cookie = cookie
    await first.request('/auth/refresh', 'POST', {}, 401)
  }
  const store = new Store()
  await promisify(store.set).call(store, 'late-save', oldSession)
  assert.equal(await db.get("SELECT sid FROM sessions WHERE sid='late-save'"), undefined)
  assert.equal((await admin.request('/users')).items.some(p => p.id === userId), false)
  assert.equal((await admin.request('/students')).items.some(p => p.user_id === userId), false)
  assert.ok(await db.get('SELECT id FROM students WHERE id=?', [profile.id]))
  assert.ok(await db.get('SELECT id FROM attendance_records WHERE id=?', [historyRecord.insertId]))
  assert.equal((await db.get('SELECT status FROM enrollments WHERE student_id=?', [profile.id])).status, 'withdrawn')
  assert.equal((await db.get('SELECT status FROM change_requests WHERE user_id=?', [userId])).status, 'rejected')
  await admin.request(`/users/${userId}`, 'PATCH', { status: 'active' }, 404)
  await admin.request(`/users/${userId}/reset-password`, 'POST', { password: 'New-password123' }, 404)
  await admin.request(`/students/${profile.id}`, 'PATCH', { name: '恢复' }, 404)
  await admin.request(`/teaching-classes/${classroom.id}/enrollments`, 'POST', { student_id: profile.id }, 404)
  const enrollment = await db.get('SELECT id FROM enrollments WHERE student_id=?', [profile.id])
  await admin.request(`/enrollments/${enrollment.id}`, 'PATCH', { status: 'active' }, 404)
  await admin.request(`/scheduled-courses/${classroom.id}/students`, 'POST', { student_no: profile.student_no }, 404)
  await first.login('removed_student', 'Password123', 403)
  assert.equal((await admin.request('/student-candidates?q=removed')).items.length, 0)
  await admin.request(`/users/${userId}`, 'DELETE', undefined, 404)
  await assert.rejects(submitRequest({ user: { id: userId } }, 'name_change', userId, { name: '过期请求' }), { status: 401 })
  const manager = (await admin.request('/users')).items.find(p => p.role === 'admin')
  await admin.request(`/users/${manager.id}`, 'DELETE', undefined, 403)
})

test('removing a teacher archives their classes and ends tasks without erasing attendance', async () => {
  const userId = await createUser('removed_teacher', 'Password123', 'teacher')
  const teacher = client()
  await teacher.login('removed_teacher')
  const profile = (await teacher.request('/profile')).profile
  const course = await admin.request('/courses', 'POST', { course_code: 'REMOVE-T', course_name: '教师移除测试' }, 201)
  const classroom = await admin.request('/teaching-classes', 'POST', {
    course_id: course.id, teacher_id: profile.id, term: '2090', name: '教师测试班',
  }, 201)
  const task = await teacher.request('/attendance-tasks', 'POST', {
    teaching_class_id: classroom.id,
    start_at: new Date(Date.now() - 60000).toISOString(),
    late_at: new Date(Date.now() + 60000).toISOString(),
    end_at: new Date(Date.now() + 600000).toISOString(),
  }, 201)
  const learner = (await admin.request('/students')).items.find(p => p.status === 'active')
  await admin.request(`/teaching-classes/${classroom.id}/enrollments`, 'POST', { student_id: learner.id }, 201)
  const record = await teacher.request(`/attendance-tasks/${task.id}/manual`, 'POST', {
    student_id: learner.id, status: 'manual', reason: '移除前记录',
  }, 201)
  await admin.request(`/users/${userId}`, 'DELETE')
  await teacher.request('/auth/me', 'GET', undefined, 401)
  assert.equal((await db.get('SELECT status FROM teaching_classes WHERE id=?', [classroom.id])).status, 'archived')
  assert.equal((await db.get('SELECT status FROM attendance_tasks WHERE id=?', [task.id])).status, 'ended')
  assert.equal((await admin.request('/teachers')).items.some(p => p.user_id === userId), false)
  assert.ok(await db.get('SELECT id FROM attendance_records WHERE id=?', [record.id]))
  assert.ok(await db.get('SELECT id FROM notifications WHERE user_id=?', [learner.user_id]))
  assert.ok(await db.get("SELECT id FROM audit_logs WHERE action='user.remove' AND resource_id=?", [String(userId)]))
})
