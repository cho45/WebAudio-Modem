import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import { fileURLToPath, URL } from 'node:url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  test: {
    globals: true,
    browser: {
      enabled: true,
      provider: 'playwright',
      headless: true,
      instances: [
        {
          browser: "chromium",
        }
      ]
    },
    include: [
      'tests/webaudio/*browser*.test.ts',
    ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**'
    ]
  },
  
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  
  worker: {
    format: 'es'
  }
})
