import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { schema } from './schema.js'

const context = new AsyncLocalStorage()
const mysql = process.env.DB_DRIVER === 'mysql'
const databasePath = process.env.DATABASE_PATH || fileURLToPath(new URL('./classroom.db', import.meta.url))
let connection
if (mysql) {
  const { createPool } = await import('mysql2/promise')
  connection = createPool({ host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'classroom', password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'classroom', connectionLimit: 10, timezone: 'Z', decimalNumbers: true })
} else {
  mkdirSync(dirname(resolve(databasePath)), { recursive: true })
  connection = new Database(databasePath)
  connection.pragma('foreign_keys = ON')
  connection.pragma('journal_mode = WAL')
}

// Serialize SQLite operations so async transactions cannot interleave on one connection.
let tail = Promise.resolve()
function exclusive(fn) {
  const result = tail.then(fn)
  tail = result.catch(() => {})
  return result
}
async function execute(sql, params = [], mode = 'all') {
  const run = async () => {
    const conn = context.getStore() || connection
    if (mysql) {
      const [result] = await conn.execute(sql, params)
      return mode === 'get' ? result[0] : result
    }
    const statement = conn.prepare(sql)
    if (mode === 'run') {
      const result = statement.run(...params)
      return { insertId: Number(result.lastInsertRowid), affectedRows: result.changes }
    }
    return statement[mode](...params)
  }
  return mysql || context.getStore() ? run() : exclusive(run)
}
const db = {
  name: databasePath, mysql,
  all: (sql, params) => execute(sql, params),
  get: (sql, params) => execute(sql, params, 'get'),
  run: (sql, params) => execute(sql, params, 'run'),
  async transaction(fn) {
    if (context.getStore()) return fn()
    if (mysql) {
      const conn = await connection.getConnection()
      try {
        await conn.beginTransaction()
        const result = await context.run(conn, fn)
        await conn.commit()
        return result
      } catch (error) { await conn.rollback(); throw error } finally { conn.release() }
    }
    return exclusive(async () => {
      connection.exec('BEGIN IMMEDIATE')
      try {
        const result = await context.run(connection, fn)
        connection.exec('COMMIT')
        return result
      } catch (error) { connection.exec('ROLLBACK'); throw error }
    })
  },
  lock: mysql ? ' FOR UPDATE' : '',
  async close() { if (mysql) await connection.end(); else connection.close() },
}
for (const sql of schema(mysql)) await db.run(sql)
if (mysql) {
  const captchaColumns = await db.all('SHOW COLUMNS FROM captchas')
  if (captchaColumns.find(column => column.Field === 'text')?.Type.toLowerCase() === 'varchar(10)') {
    await db.run('ALTER TABLE captchas MODIFY COLUMN text VARCHAR(64) NOT NULL')
  }
}
// Non-destructive upgrade of the original login database.
const columns = mysql ? await db.all('SHOW COLUMNS FROM users') : await db.all('PRAGMA table_info(users)')
const hasColumn = (name) => columns.some((column) => (column.name || column.Field) === name)
if (!hasColumn('avatar')) await db.run('ALTER TABLE users ADD COLUMN avatar TEXT')
if (!hasColumn('role')) await db.run("ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'student'")
if (!hasColumn('status')) await db.run("ALTER TABLE users ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'active'")
if (!hasColumn('password_hash')) {
  await db.run('ALTER TABLE users ADD COLUMN password_hash VARCHAR(255)')
  await db.run('UPDATE users SET password_hash=password')
}
db.legacyPassword = hasColumn('password')
await db.run("INSERT INTO students(user_id,student_no,name,class_name) SELECT id,username,username,'' FROM users WHERE role='student' AND id NOT IN (SELECT user_id FROM students)")
await db.run("INSERT INTO teachers(user_id,teacher_no,name) SELECT id,username,username FROM users WHERE role='teacher' AND id NOT IN (SELECT user_id FROM teachers)")
export default db
