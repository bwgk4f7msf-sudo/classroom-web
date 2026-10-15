import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schema } from '../server/db/schema.js'
import { initializePersonnelNumbers } from '../server/db/personnel-numbers.js'

test('number registry upgrades historical duplicates and arbitrates concurrent cross-role registrations', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'classroom-numbers-'))
  const databasePath = join(folder, 'legacy.db')
  process.env.DATABASE_PATH = databasePath
  process.env.ADMIN_PASSWORD = 'Number-tests123'
  delete process.env.DB_DRIVER
  const old = new Database(databasePath)
  for (const sql of schema(false)) old.exec(sql)
  for (const role of ['student', 'teacher']) {
    const user = old.prepare('INSERT INTO users(username,password_hash,role) VALUES (?,?,?)')
      .run(`legacy_${role}`, 'preserved-hash', role)
    const table = role === 'student' ? 'students' : 'teachers'
    const field = role === 'student' ? 'student_no' : 'teacher_no'
    old.prepare(`INSERT INTO ${table}(user_id,${field},name) VALUES (?,?,?)`)
      .run(user.lastInsertRowid, 'LEGACY-001', `原${role}`)
  }
  old.close()

  const { default: db } = await import('../server/db/db.js')
  try {
    const { createUser } = await import('../server/auth.js')
    await initializePersonnelNumbers(db)
    assert.equal((await db.all('SELECT * FROM personnel_numbers')).length, 1)
    assert.equal((await db.get('SELECT student_no FROM students')).student_no, 'LEGACY-001')
    assert.equal((await db.get('SELECT teacher_no FROM teachers')).teacher_no, 'LEGACY-001')
    assert.equal((await db.get("SELECT password_hash FROM users WHERE username='legacy_student'")).password_hash, 'preserved-hash')
    await assert.rejects(createUser('duplicate_legacy', 'Password123', 'student', 'active', {
      number: 'LEGACY-001',
    }), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' })
    assert.equal(await db.get("SELECT id FROM users WHERE username='duplicate_legacy'"), undefined)

    const results = await Promise.allSettled(['student', 'teacher'].map(role =>
      createUser(`concurrent_${role}`, 'Password123', role, 'active', { number: 'SHARED-NEW' }),
    ))
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    assert.equal((await db.get("SELECT COUNT(*) AS total FROM users WHERE username LIKE 'concurrent_%'")).total, 1)

    await assert.rejects(createUser('legacy_student', 'Password123', 'student', 'active', {
      number: 'ROLLBACK-NEW',
    }), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
    assert.equal(await db.get("SELECT number FROM personnel_numbers WHERE number='ROLLBACK-NEW'"), undefined)
    await createUser('valid_after_rollback', 'Password123', 'teacher', 'active', { number: 'ROLLBACK-NEW' })
  } finally {
    await db.close()
    unlinkSync(databasePath)
    rmdirSync(folder)
  }
})
