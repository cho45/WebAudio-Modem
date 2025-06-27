import { defineConfig } from 'vite'
import { resolve } from 'path'
import { fileURLToPath, URL } from 'node:url'
// import { globSync } from 'node:fs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

// const processorFiles = globSync('src/webaudio/processors/*.ts');
const processorFiles = ['src/webaudio/processors/fsk-processor.js'];
const input = {
  main: resolve(__dirname, 'index.html'),
  ...Object.fromEntries(
    processorFiles.map(f => [
      f.replace(/\\.ts$/, ''), // 拡張子なしでエントリ名
      resolve(__dirname, f)
    ])
  ),
};

export default defineConfig({
  root: '.',
  base: '',
  publicDir: 'demo/assets',
  
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'demo/index.html'),
        'src/webaudio/processors/fsk-processor': resolve(__dirname, 'src/webaudio/processors/fsk-processor.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name.startsWith('src/webaudio/processors/')) {
            return '[name].js';
          }
          return 'assets/[name]-[hash].js';
        },
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
