import express from 'express'
import session from 'express-session'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import DatabaseSessionStore, { sessionAge } from './session-store.js'
import { auth, cookieOptions } from './auth.js'
import { business } from './business.js'
import { scheduling } from './scheduling.js'
import { workflows } from './workflows.js'
import { faces } from './faces.js'
import { fail } from './http.js'
import { checkRequestSource, configureProxy, securityHeaders } from './security.js'

if (process.env.NODE_ENV === 'production' && (process.env.SESSION_SECRET || '').length < 32) throw new Error('生产环境 SESSION_SECRET 至少 32 字符')
const app = express()
app.disable('x-powered-by')
configureProxy(app)
app.use(securityHeaders)
app.use('/api', checkRequestSource)
app.use(express.json({ limit: '1mb' }))
app.use('/api', (req, _res, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('multipart/form-data')) {
    if (req.body == null && Number(req.headers['content-length'] || 0) === 0 && !req.headers['transfer-encoding']) req.body = {}
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) fail(400, '请求数据格式错误')
  }
  next()
})
app.use(session({
  secret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
  store: new DatabaseSessionStore(), resave: false, saveUninitialized: false,
  cookie: { ...cookieOptions, maxAge: sessionAge },
}))
app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.use('/api', auth, business, scheduling, workflows, faces)
app.use('/api', (_req, res) => res.status(404).json({ message: '接口不存在' }))
app.use(express.static(fileURLToPath(new URL('../dist', import.meta.url))))
app.use((error, _req, res, _next) => {
  let status = error.status || 500
  let message = error.message
  if (['SQLITE_CONSTRAINT_UNIQUE', 'ER_DUP_ENTRY'].includes(error.code)) { status = 409; message = '数据已存在，请勿重复提交' }
  if (['SQLITE_CONSTRAINT_FOREIGNKEY', 'ER_NO_REFERENCED_ROW_2', 'ER_ROW_IS_REFERENCED_2'].includes(error.code)) { status = 400; message = '关联数据不存在或仍被使用' }
  if (error.type === 'entity.too.large' || error.code === 'LIMIT_FILE_SIZE') { status = 413; message = '上传内容过大' }
  if (error.name === 'MulterError') { status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400; message = '仅允许上传一张不超过 5MB 的图片，字段名为 file' }
  if (status >= 500) { console.error('API error:', error.code || error.name); message = status === 503 ? '人脸服务暂不可用，请联系教师采用人工登记' : '服务器处理失败' }
  const code = error.status && /^[A-Z][A-Z_]+$/.test(error.code || '') ? error.code : undefined
  res.status(status).json({ success: false, message, code })
})
export default app
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.API_PORT || 3001)
  app.listen(port, process.env.API_HOST || '127.0.0.1', () => console.log(`Classroom API listening on port ${port}`))
}
