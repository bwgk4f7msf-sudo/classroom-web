import { fail } from './http.js'

export function createAuthLimiter({ clock = Date.now } = {}) {
  const attempts = new Map()
  return (req, res, next) => {
    const time = clock()
    for (const [key, value] of attempts) {
      if (value.expires <= time) attempts.delete(key)
    }
    const keys = [{ key: `ip:${req.ip}`, limit: 120 }]
    if (req.method === 'POST' && typeof req.body?.username === 'string') {
      const username = req.body.username.trim().toLowerCase().slice(0, 24)
      const path = req.originalUrl.split('?')[0].replace(/\/$/, '')
      const action = path.endsWith('reset-request') ? 'reset' : path.endsWith('register') ? 'register' : 'login'
      keys.push({ key: `${action}:${username}`, limit: 10 })
    }
    for (const { key, limit } of keys) {
      const attempt = attempts.get(key) || { count: 0, expires: time + 60_000 }
      attempts.set(key, attempt)
      if (++attempt.count > limit) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((attempt.expires - time) / 1000))))
        fail(429, '操作频繁，请稍后重试', 'AUTH_RATE_LIMITED')
      }
    }
    next()
  }
}
