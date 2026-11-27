import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
function collect(root) {
  return readdirSync(root).flatMap((name) => {
    const p = join(root, name);
    return statSync(p).isDirectory() ? collect(p) : [p];
  });
}
function zip(paths, base, target) {
  const entries = Object.fromEntries(
    paths.map((p) => [relative(base, p).replaceAll('\\', '/'), new Uint8Array(readFileSync(p))]),
  );
  const bytes = zipSync(entries, { level: 6 });
  writeFileSync(target, bytes);
  return `${createHash('sha256').update(bytes).digest('hex')}  ${target}\n`;
}
mkdirSync('release', { recursive: true });
const extension = `release/ai-council-${version}.zip`,
  source = `release/ai-council-${version}-source.zip`;
let hashes = zip(collect('dist'), 'dist', extension);
const roots = ['src', 'public', 'tests', 'scripts', 'docs'];
const extra = [
  'README.md',
  '文档.txt',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'vite.config.ts',
  'vitest.config.ts',
  'playwright.config.ts',
  'sidepanel.html',
  '.gitignore',
  '.gitattributes',
  '.prettierrc.json',
  '.prettierignore',
];
hashes += zip([...roots.flatMap(collect), ...extra], '.', source);
writeFileSync('release/SHA256SUMS.txt', hashes);
console.log(hashes);
