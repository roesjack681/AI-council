import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 45000,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'docs/results/playwright-results.json' }],
  ],
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
