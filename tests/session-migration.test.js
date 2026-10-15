import { test } from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { mkdtempSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { schema } from '../server/db/schema.js'
import { initializeSessions } from '../server/db/session-migration.js'

test('session migration keeps the newest session per client type and revokes older Web cookies', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'classroom-sessions-'))
  const path = join(folder, 'legacy.db')
  process.env.DATABASE_PATH = path
  delete process.env.DB_DRIVER
  const old = new Database(path)
  for (const sql of schema(false)) old.exec(sql)
  old.prepare('INSERT INTO users(username,password_hash) VALUES (?,?)').run('legacy_session', 'unused')
  const createdAt = Date.now()
  const insert = old.prepare('INSERT INTO sessions(sid,data,expires) VALUES (?,?,?)')
  insert.run('older-web', JSON.stringify({ userId: 1, createdAt: createdAt - 1000 }), createdAt + 60000)
  insert.run('newer-web', JSON.stringify({ userId: 1, createdAt }), createdAt + 60000)
  insert.run('future-android', JSON.stringify({ userId: 1, clientType: 'android', createdAt }), createdAt + 60000)
  insert.run('anonymous', JSON.stringify({ createdAt }), createdAt + 60000)
  old.close()

  const { default: db } = await import('../server/db/db.js')
  try {
    await initializeSessions(db)
    assert.deepEqual((await db.all('SELECT sid FROM sessions ORDER BY sid')).map(row => row.sid), [
      'anonymous', 'future-android', 'newer-web',
    ])
    assert.ok(await db.get("SELECT sid FROM revoked_sessions WHERE sid='older-web'"))
    await assert.rejects(db.run(`INSERT INTO sessions(sid,data,expires,user_id,client_type)
      VALUES (?,?,?,1,'web')`, ['extra-web', '{}', createdAt + 60000]), { code: 'SQLITE_CONSTRAINT_UNIQUE' })
    assert.equal((await db.get('SELECT revision FROM enrollments LIMIT 1'))?.revision, undefined)
    assert.ok((await db.all('PRAGMA table_info(enrollments)')).some(column => column.name === 'revision'))
  } finally {
    await db.close()
    unlinkSync(path)
    rmdirSync(folder)
  }
})
