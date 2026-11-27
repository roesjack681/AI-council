import { test, expect, chromium, type BrowserContext, type Page } from '@playwright/test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
let context: BrowserContext;
let profile: string;
let extensionId: string;
let page: Page;
async function launch() {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
    viewport: { width: 460, height: 1000 },
    acceptDownloads: true,
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  extensionId = new URL(worker.url()).host;
  page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await expect(page.getByRole('heading', { name: 'AI Council', exact: true })).toBeVisible();
}
async function command<T>(input: unknown): Promise<T> {
  const result = await page.evaluate(
    async (c) =>
      (await chrome.runtime.sendMessage(c)) as { ok: boolean; data: unknown; error?: string },
    input,
  );
  if (!result.ok) throw new Error(result.error);
  return result.data as T;
}
test.beforeAll(async () => {
  await mkdir('.tmp', { recursive: true });
  profile = await mkdtemp(resolve('.tmp', 'extension-profile-'));
  await launch();
});
test.afterAll(async () => {
  await context?.close();
  if (profile) {
    const full = resolve(profile);
    if (!full.startsWith(resolve('.tmp') + '\\') && !full.startsWith(resolve('.tmp') + '/'))
      throw new Error('Profile outside test workspace');
    await rm(full, { recursive: true, force: true });
  }
});
test('chat-first UI, settings prep, missing-page pause, restart persistence, deletion', async () => {
  // Only the interactive permission request is stubbed. Real host permission stays absent,
  // so the production background must refuse navigation and persist SITE_PERMISSION_REQUIRED.
  await page.evaluate(() =>
    Object.defineProperty(chrome.permissions, 'request', { value: async () => true }),
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));

  await expect(page.getByLabel('提问', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '聊天室成员', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /我已了解/ }).check();
  await page.getByRole('button', { name: '加入聊天室', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DeepSeek', exact: true })).toBeVisible();
  await page.getByLabel('平台', { exact: true }).click();
  await page.getByText('豆包', { exact: true }).click();
  await page.getByRole('button', { name: '加入聊天室', exact: true }).click();
  await expect(page.getByRole('heading', { name: '豆包', exact: true })).toBeVisible();
  const before = await command<{ participants: { id: string }[] }>({ type: 'snapshot' });
  expect(before.participants).toHaveLength(2);
  await command({ type: 'participant.check', id: before.participants[0]!.id });
  await page.getByRole('button', { name: '返回聊天室', exact: true }).click();

  await expect(page.getByLabel('提问', { exact: true })).toBeEnabled();
  await expect(page.getByText('可点名向成员提问；共识讨论需要两个就绪成员')).toBeVisible();

  const created = await command<{ id: string }>({
    type: 'discussion.create',
    input: {
      title: 'E2E 持久化验收',
      originalQuestion: '请评审一个本地方案，不要编造已完成的模型回复。',
      context: '',
      constraints: [],
      expectedOutput: '',
      participantIds: before.participants.map((p) => p.id),
      maxRounds: 10,
      stableRoundsRequired: 2,
      timeoutMs: 180_000,
      maxRetries: 2,
      privacyAcknowledged: true,
    },
  });
  await command({ type: 'discussion.start', id: created.id });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'AI Council', exact: true })).toBeVisible();
  await expect(page.getByText('请评审一个本地方案，不要编造已完成的模型回复。')).toBeVisible();
  await expect(page.getByText(/已暂停：/)).toBeVisible();
  await expect(page.getByText(/已暂停：SITE_PERMISSION_REQUIRED/)).toBeVisible();
  await expect(page.getByLabel('提问', { exact: true })).toBeEnabled();

  const after = await command<{
    discussions: { id: string; status: string }[];
    messages: unknown[];
  }>({ type: 'snapshot' });
  expect(after.discussions[0]?.status).toBe('PAUSED');
  expect(after.messages).toHaveLength(0);

  const report = await command<{ markdown: string; json: string }>({
    type: 'report.generate',
    id: created.id,
  });
  expect(report.markdown).toContain('E2E 持久化验收');
  expect(JSON.parse(report.json).messages).toHaveLength(0);

  await mkdir('docs/results', { recursive: true });
  await page.screenshot({ path: 'docs/results/chat-sidepanel.png', fullPage: true });
  await page.getByRole('button', { name: '打开设置', exact: true }).click();
  await page.screenshot({ path: 'docs/results/settings-sidepanel.png', fullPage: true });

  await context.close();
  await launch();
  const restored = await command<{
    discussions: { id: string; status: string }[];
    participants: unknown[];
    reports: unknown[];
  }>({ type: 'snapshot' });
  expect(restored.discussions[0]?.id).toBe(after.discussions[0]?.id);
  expect(restored.discussions[0]?.status).toBe('PAUSED');
  expect(restored.participants).toHaveLength(2);
  expect(restored.reports).toHaveLength(1);
  await expect(page.getByText('请评审一个本地方案，不要编造已完成的模型回复。')).toBeVisible();
  await page.screenshot({ path: 'docs/results/dashboard-sidepanel.png', fullPage: true });
  expect(pageErrors).toEqual([]);

  await page.getByRole('button', { name: '清除讨论数据', exact: true }).click();
  await page.getByRole('button', { name: '确认', exact: true }).click();
  await expect
    .poll(async () => {
      const snapshot = await command<{ participants: unknown[]; discussions: unknown[] }>({
        type: 'snapshot',
      });
      return snapshot.discussions.length === 0 && snapshot.participants.length === 2;
    })
    .toBe(true);

  await writeFile(
    'docs/results/e2e.json',
    JSON.stringify(
      {
        passed: true,
        checkedAt: new Date().toISOString(),
        browser: context.browser()?.version(),
        extensionId,
        scenarios: [
          '实际加载 MV3 产物',
          '聊天首页 + 设置配置 DeepSeek 与豆包',
          '允许新问题输入，网页未就绪时由后台暂停并保存原因',
          '网页未就绪时持久化暂停',
          '不伪造模型回复',
          '报告命令生成',
          '完整浏览器重启恢复',
          '本地数据删除',
        ],
        liveModelAutomation:
          'NOT_RUN_ON_PERSONAL_ACCOUNTS; THIS_TEST_VERIFIES_MISSING_PAGE_HANDLING',
      },
      null,
      2,
    ) + '\n',
  );
});
