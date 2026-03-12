import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['tests/vitest.setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { maxForks: 1, minForks: 1 } },
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: ['tests/**/*.test.ts'],
    exclude: ['src/**', 'dist/**', 'node_modules/**'],
  },
})
