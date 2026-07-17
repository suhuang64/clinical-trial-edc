import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    rolldownOptions: {
      output: {
        manualChunks(id) {
          const elementComponent = id.match(
            /\/node_modules\/element-plus\/es\/components\/([^/]+)\//,
          )?.[1]
          if (elementComponent) {
            if (elementComponent.localeCompare('c') < 0) return 'element-components-a-b'
            if (elementComponent.startsWith('c')) return 'element-components-c'
            if (elementComponent.startsWith('d')) return 'element-components-d'
            if (elementComponent.localeCompare('h') < 0) return 'element-components-e-g'
            if (elementComponent.localeCompare('n') < 0) return 'element-components-h-m'
            return 'element-components-n-z'
          }
          if (id.includes('/node_modules/element-plus/')) return 'element-plus-core'
          if (id.includes('/node_modules/vant/')) return 'vant'
          if (
            id.includes('/node_modules/vue/') ||
            id.includes('/node_modules/vue-router/') ||
            id.includes('/node_modules/vue-i18n/') ||
            id.includes('/node_modules/pinia/')
          )
            return 'vue-vendor'
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
})
