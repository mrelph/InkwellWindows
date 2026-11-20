import { defineConfig } from 'vitest/config'

/* Unit tests for DOM-free logic: src/lib/* and the main process's pure
   helpers. Node environment; nothing here launches Electron. */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src-electron/**/*.test.ts']
  }
})
