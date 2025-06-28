import { defineConfig } from 'vite'
import { resolve } from 'path'
import { fileURLToPath, URL } from 'node:url'
import { globSync } from 'node:fs'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

const processorFiles = globSync('src/webaudio/processors/*processor.ts');
const input = {
  main: resolve(__dirname, 'demo/index.html'),
  ...Object.fromEntries(
    processorFiles.map(f => [
      f.replace(/\.ts$/, ''), // 拡張子なしでエントリ名
      resolve(__dirname, f)
    ])
  ),
};
console.log(input);

export default defineConfig({
  root: '.',
  base: '',
  publicDir: 'demo/assets',
  
  build: {
    rollupOptions: {
      input,
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
      '@': resolve(__dirname, 'src'),
      'vue': 'vue/dist/vue.esm-bundler.js'
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
