const baseURL = import.meta.env.VITE_API_BASE_URL || '/api'
let unauthorizedHandler = () => () => {}

export function setUnauthorizedHandler(factory) {
  unauthorizedHandler = factory
}

async function api(path, options = {}) {
  const handleUnauthorized = unauthorizedHandler()
  const response = await fetch(`${baseURL}${path}`, {
    credentials: 'include',
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('后端未正确响应，请使用 npm run dev:full 启动完整服务')
  }
  const result = await response.json()
  if (!response.ok) {
    if (response.status === 401 && result.code === 'UNAUTHENTICATED') {
      handleUnauthorized()
    }
    const error = new Error(result.message || '请求失败')
    error.status = response.status
    throw error
  }
  return result
}

export default api
