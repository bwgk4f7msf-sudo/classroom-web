import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'

const port = 5173
const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((entry) => entry && !entry.internal && entry.family === 'IPv4')
  .map((entry) => entry.address)
const origins = [...new Set(addresses)].map((address) => `http://${address}:${port}`)
const configuredOrigins = (process.env.APP_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

if (process.env.NODE_ENV === 'production') {
  throw new Error('demo:full 用于开发演示，请移除 NODE_ENV=production 后重试')
}

console.log('局域网演示地址：')
for (const origin of origins) {
  console.log(`  ${origin}`)
}

const child = spawn(process.execPath, [process.env.npm_execpath, 'run', 'dev'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CLASSROOM_DEMO: '1',
    APP_ORIGINS: [...new Set([
      ...configuredOrigins,
      `http://localhost:${port}`,
      ...origins,
    ])].join(','),
  },
})

child.on('error', (error) => {
  console.error('演示服务启动失败：', error.message)
  process.exitCode = 1
})
child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
