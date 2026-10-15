import { test } from 'node:test'
import assert from 'node:assert/strict'
import { personRow } from '../src/user-management.js'

test('resolved conflict flags remain false for numeric and string API values', () => {
  for (const value of [0, '0', false, undefined, null]) {
    const row = personRow({ student_no: 'S001', number_conflict: value, reset_requested: value }, 'students')
    assert.equal(row.number_conflict, false)
    assert.equal(row.reset_requested, false)
  }
  const before = personRow({ teacher_no: 'T001', number_conflict: '1' }, 'teachers')
  const after = personRow({ teacher_no: 'T002', number_conflict: '0' }, 'teachers')
  assert.equal(before.number_conflict, true)
  assert.equal(after.number_conflict, false)
  assert.equal(after.number, 'T002')
})
