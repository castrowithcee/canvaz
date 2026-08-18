import { defineConfig } from 'vitest/config'

// Die Spezifikationen unter spike/e2e gehoeren zu Playwright und duerfen nicht von Vitest gestartet werden.
export default defineConfig({
  test: {
    include: ['spike/tests/**/*.test.ts'],
    environment: 'node',
  },
})
