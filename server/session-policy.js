import db from './db/db.js'

export const sessionAge = 7 * 24 * 60 * 60 * 1000
export const absoluteSessionAge = 30 * 24 * 60 * 60 * 1000
export const clientType = data => data.clientType === 'android' ? 'android' : 'web'

export async function resetPending(userId) {
  return !!await db.get(`SELECT id FROM change_requests
    WHERE user_id=? AND kind='password_reset' AND status='pending' LIMIT 1`, [userId])
}

export async function revokeUserSessions(userId, platform = null) {
  for (const row of await db.all('SELECT sid,data FROM sessions')) {
    let data
    try { data = JSON.parse(row.data) } catch { data = null }
    if (data && (data.userId !== userId || (platform && clientType(data) !== platform))) continue
    await db.run('DELETE FROM sessions WHERE sid=?', [row.sid])
    await db.run('DELETE FROM captchas WHERE session_id=?', [row.sid])
    if (!await db.get('SELECT sid FROM revoked_sessions WHERE sid=?', [row.sid])) {
      await db.run('INSERT INTO revoked_sessions(sid,expires) VALUES (?,?)', [row.sid, Date.now() + sessionAge])
    }
  }
}
