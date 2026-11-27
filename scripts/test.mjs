import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const temp = resolve('.tmp');
mkdirSync(temp, { recursive: true });
const args = process.argv.slice(2);
mkdirSync('docs/results', { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--reporter=default',
    '--reporter=json',
    '--outputFile=docs/results/unit-tests.json',
    ...args,
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, TMP: temp, TEMP: temp, TMPDIR: temp },
  },
);
if (result.error) throw result.error;
if (
  result.status === 0 &&
  args.includes('--coverage') &&
  existsSync('coverage/coverage-summary.json')
) {
  const coverage = JSON.parse(readFileSync('coverage/coverage-summary.json', 'utf8'));
  writeFileSync(
    'docs/results/coverage.json',
    JSON.stringify({ checkedAt: new Date().toISOString(), total: coverage.total }, null, 2) + '\n',
  );
}
process.exit(result.status ?? 1);
