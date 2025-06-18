import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    browser: {
      enabled: true,
      name: 'chrome',
      headless: true
    },
    include: ['tests/**/*.browser.test.ts'],
    setupFiles: ['tests/setup.browser.ts']
  },
  
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
})