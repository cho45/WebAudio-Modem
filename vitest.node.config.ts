import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.node.test.ts'],
    setupFiles: ['tests/setup.node.ts']
  },
  
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
})