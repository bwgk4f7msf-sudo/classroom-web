import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

// A database snapshot alone cannot recover the low-entropy challenge answer.
const secret = randomBytes(32)
export function captchaDigest(code) {
  return createHmac('sha256', secret).update(code.trim().toUpperCase()).digest('hex')
}

export function verifyCaptcha(stored, code) {
  if (typeof code !== 'string' || code.length > 32 || !/^[a-f0-9]{64}$/.test(stored)) return false
  return timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(captchaDigest(code), 'hex'))
}
