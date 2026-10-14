import { isAllowedOrigin } from './origin.js'
import { fail } from './http.js'

export function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
      "form-action 'self'",
    ].join('; '),
  })
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000')
  next()
}

export function checkRequestSource(req, res, next) {
  res.set('Cache-Control', 'no-store')
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  let source = req.headers.origin
  if (source === undefined && req.headers.referer !== undefined) {
    try { source = new URL(req.headers.referer).origin }
    catch { fail(403, '不允许跨站请求') }
  }
  // Fetch Metadata also covers cross-site requests with both source headers stripped.
  if (req.headers['sec-fetch-site'] === 'cross-site' && source === undefined) {
    fail(403, '不允许跨站请求')
  }
  if (source !== undefined && !isAllowedOrigin(source, `${req.protocol}://${req.get('host')}`)) {
    fail(403, '不允许跨站请求')
  }
  next()
}

export function configureProxy(app, env = process.env) {
  // Trust explicit proxy addresses/subnets, never an arbitrary hop count.
  if (env.TRUST_PROXY === '1' && !env.TRUSTED_PROXIES?.trim()) {
    throw new Error('TRUST_PROXY=1 须同时设置 TRUSTED_PROXIES 为可信代理 IP / 网段')
  }
  if (env.TRUST_PROXY === '1') {
    app.set('trust proxy', env.TRUSTED_PROXIES.split(',').map(value => value.trim()).filter(Boolean))
  }
}
