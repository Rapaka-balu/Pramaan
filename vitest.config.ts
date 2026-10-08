import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
    env: { PRAMAAN_LLM_MODE: 'replay-or-off' },
    testTimeout: 20_000,
  },
});
