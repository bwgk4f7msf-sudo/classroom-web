import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: process.env.CLASSROOM_DEMO === '1' ? '0.0.0.0' : undefined,
    strictPort: process.env.CLASSROOM_DEMO === '1',
    proxy: {
      '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:3001',
    },
  },
  preview: {
    proxy: { '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:3001' },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
})
