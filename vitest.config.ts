import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: [
        'src/core/**/*.ts',
        'src/adapters/**/*.ts',
        'src/database/**/*.ts',
        'src/reports/**/*.ts',
        'src/background/scheduler.ts',
        'src/background/recovery.ts',
        'src/services/**/*.ts',
      ],
      // The DOM executor runs in Chromium and is covered by browser scenarios, not Node V8.
      exclude: ['src/adapters/dom/page-operation.ts'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { statements: 85, branches: 75, functions: 85, lines: 85 },
    },
  },
});
