<script setup>
import { onUnmounted, watch } from 'vue'
import { loadUser, user } from './auth.js'

let timer
let checking = false
watch(() => user.value?.id, (userId) => {
  clearInterval(timer)
  if (!userId) return
  timer = setInterval(async () => {
    if (checking || document.visibilityState !== 'visible') return
    checking = true
    try { await loadUser() } finally { checking = false }
  }, 15000)
}, { immediate: true })
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <router-view />
</template>
