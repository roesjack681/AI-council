import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
const failures = [];
const manifest = JSON.parse(readFileSync('dist/manifest.json', 'utf8'));
const permitted = ['sidePanel', 'tabs', 'alarms', 'scripting'];
if (manifest.manifest_version !== 3) failures.push('Manifest 必须为 MV3');
if ((manifest.permissions ?? []).some((p) => !permitted.includes(p)))
  failures.push('存在未批准的扩展权限');
for (const field of ['host_permissions', 'content_scripts', 'externally_connectable'])
  if (manifest[field]?.length || (manifest[field] && !Array.isArray(manifest[field])))
    failures.push(`当前受限版本不得包含 ${field}`);
const sites = [
  'https://chat.deepseek.com/*',
  'https://www.doubao.com/*',
  'https://chatgpt.com/*',
  'https://gemini.google.com/*',
];
if ((manifest.optional_host_permissions ?? []).some((origin) => !sites.includes(origin)))
  failures.push('可选网站权限超出四个参与平台');
if (!manifest.content_security_policy.extension_pages.includes("connect-src 'self'"))
  failures.push('缺少网络连接限制');
function files(root) {
  return readdirSync(root).flatMap((name) => {
    const p = join(root, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}
let count = 0;
for (const path of files('src')) {
  if (!/\.(ts|vue)$/.test(path)) continue;
  count++;
  const source = readFileSync(path, 'utf8');
  const script = path.endsWith('.vue')
    ? (source.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? '')
    : source;
  const ast = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true);
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) failures.push(`${path}: 禁止显式 any`);
    if (
      ts.isCallExpression(node) &&
      /^(fetch|eval|importScripts|axios(?:\..*)?|chrome\.(cookies|debugger|webRequest)\..*)$/.test(
        node.expression.getText(ast),
      )
    )
      failures.push(`${path}: 禁止网络或高权限调用 ${node.expression.getText(ast)}`);
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(ast).startsWith('chrome.scripting.') &&
      !path.replaceAll('\\', '/').endsWith('background/browser-port.ts')
    )
      failures.push(`${path}: 网页注入只能经过受控浏览器端口`);
    if (ts.isPropertyAccessExpression(node) && node.getText(ast) === 'document.cookie')
      failures.push(`${path}: 禁止读取 Cookie`);
    if (
      ts.isNewExpression(node) &&
      /^(XMLHttpRequest|WebSocket|EventSource|Function)$/.test(node.expression.getText(ast))
    )
      failures.push(`${path}: 禁止未授权交互构造器`);
    if (
      ts.isImportDeclaration(node) &&
      /openai|anthropic|generative-ai|google-genai|deepseek-sdk|axios/i.test(
        node.moduleSpecifier.getText(ast),
      )
    )
      failures.push(`${path}: 禁止模型 API SDK`);
    ts.forEachChild(node, visit);
  }
  visit(ast);
}
for (const path of files('dist'))
  if (
    /\.(js|html|json)$/.test(path) &&
    /TEST FIXTURE ONLY|TEST TRANSPORT; NO REAL MODEL|TEST ORIGINAL QUESTION|TEST PROPOSAL|TEST DOM FIXTURE|TEST STRUCTURAL SAMPLE/.test(
      readFileSync(path, 'utf8'),
    )
  )
    failures.push(`${path}: 测试数据被打包`);
const report = {
  checkedAt: new Date().toISOString(),
  passed: failures.length === 0,
  sourceFiles: count,
  checks: [
    'MV3 与最小权限',
    '无默认主机访问；仅四个平台可选网站权限',
    '隔离世界 DOM 注入仅经过受控端口',
    '禁止模型 API SDK 与网络调用',
    '禁止账号与 Cookie 能力',
    '无显式 any',
    '产物不含测试回复',
  ],
  failures,
  livePlatforms: {
    deepseek: 'DOM_ADAPTER_IMPLEMENTED_LIVE_FLOW_NOT_YET_VERIFIED',
    doubao: 'DOM_ADAPTER_IMPLEMENTED_LOGIN_REQUIRED_IN_OBSERVED_BROWSER',
    chatgpt: 'DOM_ADAPTER_IMPLEMENTED_LIVE_FLOW_NOT_YET_VERIFIED',
    gemini: 'DOM_ADAPTER_IMPLEMENTED_LIVE_FLOW_NOT_YET_VERIFIED',
    claude: 'NO_DOM_ADAPTER',
  },
};
mkdirSync('docs/results', { recursive: true });
writeFileSync('docs/results/compliance.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
