import { test } from 'node:test'
import assert from 'node:assert/strict'
import { client, db, createUser } from './helpers/account-api.js'
import { generateSessions } from '../shared/schedule.js'

const admin = client()
await admin.login('admin', process.env.ADMIN_PASSWORD)
const schedule = {
  date: '2090-10-02', start: '13:30', end: '15:00',
  repeat: 'daily', interval: 7, until: '2090-10-16', location: '原教室',
}
const body = {
  course_name: '调课历史测试', english_name: 'Schedule History',
  name: '测试班', term: '2090 秋', schedule,
}
const approve = request => admin.request(`/requests/${request.requestId}`, 'PATCH', {
  status: 'approved', note: '核实通过',
})

for (const role of ['admin', 'teacher']) {
  test(`${role} bulk rescheduling preserves original lesson times across repeated changes`, async () => {
    const teacherName = `history_teacher_${role}`
    const studentName = `history_student_${role}`
    await createUser(teacherName, 'Password123', 'teacher')
    await createUser(studentName, 'Password123', 'student')
    const teacher = client(), student = client()
    await teacher.login(teacherName)
    await student.login(studentName)
    const created = await approve(await teacher.request('/scheduled-courses', 'POST', body, 202))
    const path = `/scheduled-courses/${created.id}`
    await admin.request(`${path}/students`, 'POST', { student_no: studentName }, 201)
    const sessions = async () => (await student.request('/schedule')).sessions
    const initial = await sessions()
    const originals = initial.map(session => session.start_at)

    // Moving the first lesson past the others must not reorder its original identity.
    await admin.request(`/course-sessions/${initial[0].id}`, 'PATCH', {
      date: '2090-10-30', start: '09:00', end: '10:00', location: '临时教室', reason: '单次调课',
    })
    const beforeReplacement = await sessions()
    assert.equal(beforeReplacement.at(-1).original_start, originals[0])
    await db.run(`INSERT INTO course_sessions(
      teaching_class_id,start_at,end_at,location,original_start,change_reason
    ) VALUES (?,?,?,?,?,?)`, [
      created.id, '2020-01-01T01:00:00.000Z', '2020-01-01T02:00:00.000Z',
      '历史教室', '2019-12-31T01:00:00.000Z', '历史调课',
    ])
    const historical = (await sessions())[0]

    async function replace(plan, reason) {
      const requestBody = { ...body, schedule: plan, reason }
      if (role === 'teacher') {
        const before = await sessions()
        const request = await teacher.request(path, 'PUT', requestBody, 202)
        assert.deepEqual(await sessions(), before, 'pending approval must not alter history')
        await approve(request)
      } else {
        await admin.request(path, 'PUT', requestBody)
      }
      const all = await sessions()
      assert.deepEqual(all[0], historical, 'past lessons must be preserved')
      return all.slice(1)
    }

    const firstPlan = { ...schedule, date: '2090-11-01', until: '2090-11-15', start: '10:00', end: '11:00' }
    const first = await replace(firstPlan, '整体调整')
    assert.deepEqual(first.map(session => session.start_at), generateSessions(firstPlan).map(session => session.start_at))
    assert.deepEqual(first.map(session => session.original_start), originals)
    assert.ok(first.every(session => session.change_reason === '整体调整'))
    assert.ok(first.every(session => session.original_start !== session.start_at))

    const secondPlan = { ...firstPlan, date: '2090-12-01', until: '2090-12-29' }
    const second = await replace(secondPlan, '再次整体调整并增加课次')
    assert.equal(second.length, 5)
    assert.deepEqual(second.slice(0, 3).map(session => session.original_start), originals)
    assert.ok(second.slice(3).every(session => session.change_reason === null), 'new lessons have no earlier arrangement')
    assert.ok(second.slice(3).every(session => session.original_start === session.start_at))

    const shortened = await replace({ ...secondPlan, date: '2091-01-01', until: '2091-01-08' }, '减少课次')
    assert.equal(shortened.length, 2)
    assert.deepEqual(shortened.map(session => session.original_start), originals.slice(0, 2))

    // A conflict must roll back both the replacement and its preserved history.
    const conflicting = { ...firstPlan, date: '2091-02-01', repeat: 'once' }
    const conflict = generateSessions(conflicting)[0]
    // A different class of the same teacher must still participate in conflict checks.
    const teacherId = (await teacher.request('/profile')).profile.id
    const otherClass = await admin.request('/teaching-classes', 'POST', {
      course_id: (await admin.request('/schedule')).classes.find(row => row.id === created.id).course_id,
      teacher_id: teacherId, term: '2091 春', name: '冲突班',
    }, 201)
    await db.run(`INSERT INTO course_sessions(teaching_class_id,start_at,end_at,location,original_start)
      VALUES (?,?,?,?,?)`, [otherClass.id, conflict.start_at, conflict.end_at, '冲突课次', conflict.start_at])
    const beforeConflict = await sessions()
    await admin.request(path, 'PUT', { ...body, schedule: conflicting, reason: '应回滚' }, 409)
    assert.deepEqual(await sessions(), beforeConflict)
  })
}
