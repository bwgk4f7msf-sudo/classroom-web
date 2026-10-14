import { captchaDigest } from '../server/captcha.js'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { generateSessions } from '../shared/schedule.js'

process.env.DATABASE_PATH = ':memory:'
process.env.ADMIN_PASSWORD = 'Schedule-admin123'
process.env.SESSION_SECRET = 'schedule-test-session-secret-32-characters'
delete process.env.DB_DRIVER
delete process.env.NODE_ENV
delete process.env.COOKIE_SECURE
const { default: app } = await import('../server/app.js')
const { default: db } = await import('../server/db/db.js')
const { createUser } = await import('../server/auth.js')
const server = app.listen(0, '127.0.0.1')
await once(server, 'listening')
const base = `http://127.0.0.1:${server.address().port}/api`
after(async () => { await new Promise((r) => server.close(r)); await db.close() })
async function client(username, role) {
  await createUser(username, 'Schedule-test123', role)
  let cookie = ''
  const request = async (path, method = 'GET', body, status = 200) => {
    const response = await fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    if (response.headers.getSetCookie().length) cookie = response.headers.getSetCookie()[0].split(';')[0]
    const result = await response.json()
    assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`)
    return result
  }
  await request('/captcha')
  const sid = decodeURIComponent(cookie.split('=')[1]).slice(2).split('.')[0]
  const code = 'ABCDE'
  await db.run('UPDATE captchas SET text=? WHERE session_id=?', [captchaDigest(code), sid])
  await request('/auth/login', 'POST', { username, password: 'Schedule-test123', code })
  return request
}
const schedule = { date: '2090-10-02', start: '13:30', end: '15:00', repeat: 'weekly', interval: 1, weekdays: [1, 3], until: '2090-10-30', location: '教学楼 1001' }
const body = { course_name: 'C 程序设计', english_name: 'C Programming', name: '计算机一班', term: '2090 秋', schedule }

test('recurrence calendar, timezone, bounds and empty rules', () => {
  const once = generateSessions({ ...schedule, repeat: 'once' })
  assert.equal(once[0].start_at, '2090-10-02T05:30:00.000Z')
  const weekly = generateSessions(schedule)
  assert.ok(weekly.length > 3)
  assert.ok(weekly.every((s) => [1, 3].includes(new Date(s.start_at).getUTCDay())))
  const alternate = generateSessions({ ...schedule, interval: 2 })
  assert.ok(alternate.length < weekly.length)
  assert.equal(generateSessions({ ...schedule, repeat: 'daily', interval: 2, until: '2090-10-06' }).length, 3)
  for (const changes of [{ date: '2090-02-30' }, { start: '15:30' }, { weekdays: [] }, { until: '2090-09-01' }, { until: '2092-10-01' }, { interval: 0 }, { start: '25:00' }]) assert.throws(() => generateSessions({ ...schedule, ...changes }))
})

test('persisted teacher scheduling, role isolation, collisions, rescheduling and rollback', async () => {
  const admin = await client('schedule_admin', 'admin')
  const approve = (request, status = 200) => admin(`/requests/${request.requestId}`, 'PATCH', { status: 'approved', note: '核实通过' }, status)
  const teacher = await client('schedule_teacher', 'teacher')
  const other = await client('schedule_other', 'teacher')
  const student = await client('schedule_student', 'student')
  await student('/scheduled-courses', 'POST', body, 403)
  await teacher('/scheduled-courses', 'POST', { ...body, english_name: '' }, 400)
  const pending = await teacher('/scheduled-courses', 'POST', body, 202)
  assert.equal((await teacher('/schedule')).classes.length, 0)
  await teacher('/scheduled-courses', 'POST', body, 409)
  const separate = await teacher('/scheduled-courses', 'POST', { ...body, course_name: '另一门课程' }, 202)
  await admin(`/requests/${separate.requestId}`, 'PATCH', { status: 'rejected', note: '测试拒绝独立申请' })
  assert.equal((await teacher('/schedule')).classes.length, 0)
  await student(`/requests/${pending.requestId}`, 'PATCH', { status: 'approved', note: '越权' }, 403)
  const created = await approve(pending)
  await approve(pending, 409)
  const initial = await teacher('/schedule')
  assert.equal(initial.classes[0].english_name, 'C Programming')
  assert.equal(initial.sessions.length, generateSessions(schedule).length)
  assert.equal((await other('/schedule')).classes.length, 0)
  assert.equal((await student('/schedule')).sessions.length, 0)
  const conflict = await teacher('/scheduled-courses', 'POST', body, 202)
  await approve(conflict, 409)
  await admin(`/requests/${conflict.requestId}`, 'PATCH', { status: 'rejected', note: '时间冲突' })
  assert.equal((await teacher('/schedule')).classes.length, 1, 'conflicting creation rolls back the class too')
  await teacher(`/scheduled-courses/${created.id}/students`, 'POST', { student_no: 'schedule_student' }, 201)
  assert.equal((await student('/schedule')).sessions.length, initial.sessions.length)
  await teacher(`/scheduled-courses/${created.id}/students`, 'POST', { student_no: 'schedule_student' }, 409)
  await other(`/scheduled-courses/${created.id}/students`, 'POST', { student_no: 'schedule_student' }, 403)
  const first = initial.sessions[0]
  const single = { date: '2090-11-01', start: '10:00', end: '11:30', location: '实验楼 201', reason: '节假日调课' }
  await other(`/course-sessions/${first.id}`, 'PATCH', single, 403)
  await student(`/course-sessions/${first.id}`, 'PATCH', single, 403)
  await teacher(`/course-sessions/${first.id}`, 'PATCH', { ...single, reason: '' }, 400)
  const change = await teacher(`/course-sessions/${first.id}`, 'PATCH', single, 202)
  assert.equal((await student('/schedule')).sessions[0].start_at, first.start_at)
  await approve(change)
  const updated = await student('/schedule')
  const moved = updated.sessions.find((s) => s.id === first.id)
  assert.equal(moved.original_start, first.start_at)
  assert.equal(moved.start_at, '2090-11-01T02:00:00.000Z')
  assert.equal(moved.change_reason, single.reason)
  assert.deepEqual(updated.sessions.filter((s) => s.id !== first.id), initial.sessions.filter((s) => s.id !== first.id))
  const next = initial.sessions[1]
  const collision = await teacher(`/course-sessions/${first.id}`, 'PATCH', { ...single, date: next.start_at.slice(0, 10), start: '13:45', end: '14:00' }, 202)
  await approve(collision, 409)
  await admin(`/requests/${collision.requestId}`, 'PATCH', { status: 'rejected', note: '冲突' })
  assert.equal((await teacher('/schedule')).sessions.find((s) => s.id === first.id).start_at, moved.start_at)
  await other(`/scheduled-courses/${created.id}`, 'PUT', { ...body, reason: '改课' }, 403)
  await db.run('INSERT INTO course_sessions(teaching_class_id,start_at,end_at,location,original_start) VALUES (?,?,?,?,?)', [created.id, '2020-01-01T01:00:00.000Z', '2020-01-01T02:00:00.000Z', '旧教室', '2020-01-01T01:00:00.000Z'])
  const replacement = { ...body, reason: '新课表', schedule: { ...schedule, repeat: 'daily', interval: 1, date: '2090-12-01', until: '2090-12-03' } }
  await approve(await teacher(`/scheduled-courses/${created.id}`, 'PUT', replacement, 202))
  const after = await teacher('/schedule')
  assert.equal(after.sessions.length, 4)
  assert.equal(after.sessions[0].location, '旧教室')
  await teacher(`/course-sessions/${after.sessions[0].id}`, 'PATCH', single, 409)
  assert.equal((await db.all("SELECT * FROM audit_logs WHERE action LIKE 'schedule.%'")).length, 3)
  const notices = (await student('/notifications')).items
  assert.equal(notices.length, 2)
  assert.equal((await other('/requests')).items.length, 0)
  const outsider = await client('unrelated_student', 'student')
  await outsider(`/notifications/${notices[0].id}/close`, 'PATCH', {}, 404)
  await student(`/notifications/${notices[0].id}/close`, 'PATCH', {})
  assert.equal((await student('/notifications')).items.length, 1)
  await admin(`/scheduled-courses/${created.id}/students`, 'POST', { student_no: 'unrelated_student' }, 201)
  for (const query of ['unrelated', '%', '_', 'unrelated%']) {
    assert.equal((await teacher('/student-candidates?q=' + encodeURIComponent(query))).items.length, 0)
  }
  assert.equal((await admin('/student-candidates?q=unrelated')).items[0].student_no, 'unrelated_student')
  assert.equal((await teacher('/student-candidates?q=unrelated_student')).items[0].student_no, 'unrelated_student')
  const cancellation = await teacher(`/scheduled-courses/${created.id}/cancel`, 'POST', { reason: '停开' }, 202)
  assert.equal((await student('/schedule')).classes[0].status, 'active')
  await approve(cancellation)
  assert.equal((await student('/schedule')).classes[0].status, 'archived')
  assert.equal((await outsider('/notifications')).items.length, 1)
  await teacher(`/scheduled-courses/${created.id}/cancel`, 'POST', { reason: '重复' }, 409)
})

test('administrator directly edits schedules and course metadata, notifying only enrolled students', async () => {
  const admin = await client('edit_admin', 'admin')
  const teacher = await client('edit_teacher', 'teacher')
  const student = await client('edit_student', 'student')
  const request = await teacher('/scheduled-courses', 'POST', body, 202)
  const created = await admin(`/requests/${request.requestId}`, 'PATCH', { status: 'approved', note: '通过' })
  await admin(`/scheduled-courses/${created.id}/students`, 'POST', { student_no: 'edit_student' }, 201)
  const first = (await admin('/schedule')).sessions.find(s => s.teaching_class_id === created.id)
  await admin(`/course-sessions/${first.id}`, 'PATCH', { date: '2091-01-01', start: '09:00', end: '10:00', location: '新教室', reason: '管理员调整' })
  assert.equal((await student('/notifications')).items.length, 1)
  const c = (await student('/schedule')).classes[0]
  await admin(`/courses/${c.course_id}`, 'PATCH', { course_name: '新的课程名称' })
  assert.equal((await student('/schedule')).classes[0].course_name, '新的课程名称')
  assert.equal((await student('/notifications')).items.length, 2)
  await admin(`/scheduled-courses/${c.id}`, 'PUT', { ...body, reason: '管理调整', schedule: { ...schedule, date: '2091-02-01', repeat: 'once' } })
  assert.equal((await student('/notifications')).items.length, 3)
  const profile = (await teacher('/profile')).profile
  await admin(`/teachers/${profile.id}`, 'PATCH', { teacher_no: 'changed' }, 400)
  const change = await teacher('/profile/name-request', 'POST', { name: '教师新姓名' }, 202)
  await admin(`/requests/${change.requestId}`, 'PATCH', { status: 'approved', note: '姓名核实' })
  assert.equal((await teacher('/profile')).profile.name, '教师新姓名')
})
