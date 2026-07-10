import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5273,
    allowedHosts: true,
    proxy: {
      '/api': { target: 'http://localhost:3100', changeOrigin: true },
      '/login': { target: 'http://localhost:3100', changeOrigin: true },
      '/logout': { target: 'http://localhost:3100', changeOrigin: true },
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
})
