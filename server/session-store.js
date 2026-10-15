import session from 'express-session'
import db from './db/db.js'
import { sessionAge, absoluteSessionAge, clientType, resetPending } from './session-policy.js'

export { sessionAge, absoluteSessionAge }

function expiresAt(value) {
  return Math.min(
    new Date(value.cookie.expires || Date.now() + sessionAge).getTime(),
    value.createdAt + absoluteSessionAge,
  )
}

export default class DatabaseSessionStore extends session.Store {
  lastCleanup = 0

  async cleanup() {
    const time = Date.now()
    if (time - this.lastCleanup < 60_000) return
    this.lastCleanup = time
    await db.transaction(async () => {
      await db.run('DELETE FROM sessions WHERE expires<=?', [time])
      await db.run('DELETE FROM revoked_sessions WHERE expires<=?', [time])
      await db.run('DELETE FROM captchas WHERE expires<=?', [time])
    })
  }

  get(sid, callback) {
    const read = async () => {
      await this.cleanup()
      const row = await db.get('SELECT data FROM sessions WHERE sid=? AND expires>?', [sid, Date.now()])
      if (!row) return null
      let data
      try { data = JSON.parse(row.data) } catch { data = null }
      if (!data || !Number.isFinite(data.createdAt) || data.createdAt + absoluteSessionAge <= Date.now()) {
        await db.run('DELETE FROM sessions WHERE sid=?', [sid])
        return null
      }
      return data
    }
    read().then(value => callback(null, value), callback)
  }
  set(sid, value, callback = () => {}) {
    db.transaction(async () => {
      if (value.userId) {
        const user = await db.get('SELECT status FROM users WHERE id=?' + db.lock, [value.userId])
        if (user?.status !== 'active' || await resetPending(value.userId)) return
      }
      if (await db.get('SELECT sid FROM revoked_sessions WHERE sid=?' + db.lock, [sid])) return
      value.createdAt ??= Date.now()
      const expires = expiresAt(value)
      if (!Number.isFinite(expires) || expires <= Date.now()) return
      await db.run('DELETE FROM sessions WHERE sid=?', [sid])
      await db.run(`INSERT INTO sessions(sid,data,expires,user_id,client_type) VALUES (?,?,?,?,?)`, [
        sid, JSON.stringify(value), expires, value.userId || null, clientType(value),
      ])
    }).then(() => callback(), callback)
  }
  touch(sid, value, callback = () => {}) {
    db.run('UPDATE sessions SET expires=? WHERE sid=?', [expiresAt(value), sid]).then(() => callback(), callback)
  }
  destroy(sid, callback = () => {}) {
    db.transaction(async () => {
      await db.run('DELETE FROM sessions WHERE sid=?', [sid])
      if (!await db.get('SELECT sid FROM revoked_sessions WHERE sid=?', [sid])) {
        await db.run('INSERT INTO revoked_sessions(sid,expires) VALUES (?,?)', [sid, Date.now() + sessionAge])
      }
      await db.run('DELETE FROM captchas WHERE session_id=?', [sid])
    }).then(() => callback(), callback)
  }
}
