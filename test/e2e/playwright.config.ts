import { defineConfig } from '@playwright/test';

// e2e against the local demo app. Global setup starts it on a free port and exports DEMO_PORT,
// which apps/demo/app.yaml interpolates — so the target guard sees the same origin.
process.env['PRAMAAN_LLM_MODE'] = 'replay-or-off';

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '../../test-results/e2e',
  use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure' },
});
