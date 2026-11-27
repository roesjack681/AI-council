import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { providerPage } from '../fixtures/dom-page';
import type { Snapshot } from '../../src/protocols/domain';

test('typing in chat automatically prepares and completes a first message on all four blank fixture platforms without manual capability checks', async () => {
  test.setTimeout(90_000);
  await mkdir('.tmp', { recursive: true });
  const work = await mkdtemp(resolve('.tmp', 'automatic-start-'));
  const extension = resolve(work, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')) as {
    host_permissions?: string[];
    optional_host_permissions: string[];
  };
  // Disposable test grant only; this does not verify the real first-use Chrome permission dialog.
  manifest.host_permissions = [...manifest.optional_host_permissions];
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(resolve(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const members = [
      { platform: 'chatgpt', name: '光头强', url: 'https://chatgpt.com/' },
      { platform: 'deepseek', name: '熊大', url: 'https://chat.deepseek.com/' },
      { platform: 'gemini', name: '熊二', url: 'https://gemini.google.com/app' },
      { platform: 'doubao', name: '豆包', url: 'https://www.doubao.com/chat/' },
    ] as const;
    for (const member of members) {
      await context.route(`${new URL(member.url).origin}/**`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: providerPage(member.platform, {
            seed: false,
            plainReply: `TEST NATURAL STARTUP REPLY ${member.platform}`,
          })
            .replace('早上好，开始聊天吧', 'TEST CHANGED WELCOME COPY')
            .replace('What can I help with?', 'TEST CHANGED WELCOME COPY'),
        }),
      );
      const blank = await context.newPage();
      await blank.goto(`${member.url}?fixture-isolated=1`);
    }
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    const command = async <T>(input: unknown): Promise<T> => {
      const result = await panel.evaluate(
        async (input) =>
          (await chrome.runtime.sendMessage(input)) as {
            ok: boolean;
            data: unknown;
            error?: string;
          },
        input,
      );
      if (!result.ok) throw new Error(result.error);
      return result.data as T;
    };
    const bindings = await panel.evaluate(async () =>
      Object.fromEntries(
        (await chrome.tabs.query({}))
          .filter((tab) => tab.url?.includes('fixture-isolated=1'))
          .map((tab) => [new URL(tab.url!).origin, tab.id!]),
      ),
    );
    await worker.evaluate((bindings) => {
      const create = chrome.tabs.create.bind(chrome.tabs);
      Object.defineProperty(chrome.tabs, 'create', {
        value: async (properties: chrome.tabs.CreateProperties) => {
          const origin = new URL(properties.url ?? 'about:blank').origin;
          if (bindings[origin] !== undefined) {
            const id = bindings[origin];
            delete bindings[origin];
            return chrome.tabs.get(id);
          }
          return create(properties);
        },
      });
    }, bindings);
    for (const member of members)
      await command({
        type: 'participant.add',
        input: {
          platform: member.platform,
          name: member.name,
          websiteUrl: member.url,
          enabled: true,
        },
      });
    const initial = await command<Snapshot>({ type: 'snapshot' });
    expect(initial.participants.every((p) => !p.check && !p.capabilities.unattendedAllowed)).toBe(
      true,
    );
    await panel.getByRole('button', { name: '打开设置', exact: true }).click();
    await panel.getByRole('checkbox', { name: /我已了解/ }).check();
    await panel.getByRole('button', { name: '返回聊天室', exact: true }).click();
    for (const member of members) {
      const question = `${member.name}在吗`;
      await panel.getByLabel('提问', { exact: true }).fill(question);
      await panel.getByLabel('提问', { exact: true }).press('Enter');
      await expect
        .poll(
          async () => {
            await command({ type: 'tick' });
            const snapshot = await command<Snapshot>({ type: 'snapshot' });
            const d = snapshot.discussions.find((d) => d.originalQuestion === question);
            if (d?.status === 'PAUSED') throw new Error(`${d.reason}: ${d.reasonDetail}`);
            return d?.status;
          },
          { timeout: 18_000, intervals: [250, 500, 1000] },
        )
        .toBe('COMPLETED');
      await expect(
        panel.getByText(`TEST NATURAL STARTUP REPLY ${member.platform}`, { exact: true }),
      ).toBeVisible();
    }
    const final = await command<Snapshot>({ type: 'snapshot' });
    expect(final.discussions).toHaveLength(4);
    expect(final.browserSessions).toHaveLength(4);
    expect(final.messages.filter((m) => m.direction === 'inbound')).toHaveLength(4);
    await writeFile(
      'docs/results/automatic-start.json',
      JSON.stringify(
        {
          passed: true,
          fixtureOnly: true,
          realModelAcceptance: false,
          platforms: members.map((m) => m.platform),
          manualChecks: 0,
          previousAnswers: 0,
          realUserEntry: 'CHAT_INPUT_ENTER',
          completed: 4,
          permissionDialog: 'PREGRANTED_TEST_MANIFEST_NOT_VERIFIED',
          checkedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    await context.close();
    if (!resolve(work).startsWith(resolve('.tmp') + '\\')) throw new Error('Unsafe test directory');
    await rm(work, { recursive: true, force: true });
  }
});
