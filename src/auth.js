import { ref } from 'vue'
import api, { setUnauthorizedHandler } from './api.js'

export const user = ref(null)
export const loggingOut = ref(false)
let revision = 0

export function setUser(value) {
  revision++
  user.value = value
}

setUnauthorizedHandler(() => {
  const requestRevision = revision
  return () => {
    if (requestRevision === revision) setUser(null)
  }
})

export async function loadUser() {
  const requestRevision = revision
  try {
    const result = await api('/auth/me', { cache: 'no-store' })
    if (requestRevision === revision && !loggingOut.value) user.value = result.user
  } catch (error) {
    if (error.status === 401 && requestRevision === revision) setUser(null)
  }
}

export async function logout() {
  if (loggingOut.value) return
  loggingOut.value = true
  revision++ // Ignore /me responses started before logout.
  try {
    await api('/auth/logout', { method: 'POST', body: '{}' })
    setUser(null)
    try { localStorage.setItem('classroom:logout', String(Date.now())) } catch { /* Storage can be disabled by browser policy. */ }
  } finally {
    loggingOut.value = false
  }
}

window.addEventListener('storage', (event) => {
  if (event.key === 'classroom:logout') setUser(null)
})
window.addEventListener('pageshow', () => { void loadUser() })
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void loadUser()
})
