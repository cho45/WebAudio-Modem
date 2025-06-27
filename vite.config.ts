import { defineConfig } from 'vite'
import { resolve } from 'path'
import { fileURLToPath, URL } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: '.',
  base: '',
  publicDir: 'demo/assets',
  
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'demo/index.html'),
      }
    },
    outDir: 'dist'
  },
  
  worker: {
    format: 'es'  // AudioWorklet用ES Modules
  },
  
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  
  server: {
    port: 3000,
    open: '/demo/'
  },
  
  define: {
    __DEV__: JSON.stringify(process.env.NODE_ENV === 'development')
  }
})
