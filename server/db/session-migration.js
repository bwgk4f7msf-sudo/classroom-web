export async function initializeSessions(db) {
  const columns = db.mysql ? await db.all('SHOW COLUMNS FROM sessions') : await db.all('PRAGMA table_info(sessions)')
  const has = name => columns.some(column => (column.name || column.Field) === name)
  if (!has('user_id')) await db.run('ALTER TABLE sessions ADD COLUMN user_id INTEGER')
  if (!has('client_type')) {
    await db.run("ALTER TABLE sessions ADD COLUMN client_type VARCHAR(16) NOT NULL DEFAULT 'web'")
  }

  const sessions = []
  for (const row of await db.all('SELECT sid,data,expires FROM sessions')) {
    let data
    try { data = JSON.parse(row.data) } catch { continue }
    if (!Number.isSafeInteger(data?.userId) || data.userId < 1) continue
    sessions.push({ ...row, data, platform: data.clientType === 'android' ? 'android' : 'web' })
  }
  sessions.sort((a, b) => (b.data.createdAt || 0) - (a.data.createdAt || 0) || b.expires - a.expires)
  const seen = new Set()
  const retained = []
  for (const row of sessions) {
    const key = `${row.data.userId}:${row.platform}`
    if (seen.has(key) || row.expires <= Date.now()) {
      await db.run('DELETE FROM sessions WHERE sid=?', [row.sid])
      if (!await db.get('SELECT sid FROM revoked_sessions WHERE sid=?', [row.sid])) {
        await db.run('INSERT INTO revoked_sessions(sid,expires) VALUES (?,?)', [row.sid, Date.now() + 604800000])
      }
    } else {
      seen.add(key)
      retained.push(row)
    }
  }
  for (const row of retained) {
    await db.run('UPDATE sessions SET user_id=?,client_type=? WHERE sid=?', [row.data.userId, row.platform, row.sid])
  }
  const indexes = db.mysql
    ? await db.all('SHOW INDEX FROM sessions')
    : await db.all('PRAGMA index_list(sessions)')
  if (!indexes.some(index => (index.name || index.Key_name) === 'sessions_user_client')) {
    await db.run('CREATE UNIQUE INDEX sessions_user_client ON sessions(user_id,client_type)')
  }
}
