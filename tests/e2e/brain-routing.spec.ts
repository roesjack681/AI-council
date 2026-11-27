import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { providerPage } from '../fixtures/dom-page';
import type { Snapshot, BrainRequest } from '../../src/protocols/domain';

test('durable brain routing survives panel reload and completes two routed questions and a verbatim named message through production DOM adapters (fixture sites)', async () => {
  test.setTimeout(120_000);
  await mkdir('.tmp', { recursive: true });
  const work = await mkdtemp(resolve('.tmp', 'brain-flow-'));
  const extension = resolve(work, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')) as {
    optional_host_permissions?: string[];
    host_permissions?: string[];
  };
  manifest.host_permissions = manifest.optional_host_permissions;
  delete manifest.optional_host_permissions;
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(resolve(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await context.route('https://chat.deepseek.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: providerPage('deepseek', {
          seed: !route.request().url().includes('fixture-isolated=1'),
          router: true,
        }),
      }),
    );
    await context.route('https://gemini.google.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: providerPage('gemini', {
          seed: !route.request().url().includes('fixture-isolated=1'),
          plainReply: 'TEST NATURAL DIRECT REPLY',
        }),
      }),
    );
    const brainSample = await context.newPage();
    await brainSample.goto('https://chat.deepseek.com/');
    const memberSample = await context.newPage();
    await memberSample.goto('https://gemini.google.com/app');
    const brainPage = await context.newPage();
    await brainPage.goto('https://chat.deepseek.com/?fixture-isolated=1');
    const memberPage = await context.newPage();
    await memberPage.goto('https://gemini.google.com/app?fixture-isolated=1');
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
      const original = chrome.tabs.create.bind(chrome.tabs);
      Object.defineProperty(chrome.tabs, 'create', {
        value: async (properties: chrome.tabs.CreateProperties) => {
          const origin = new URL(properties.url ?? 'about:blank').origin;
          if (bindings[origin] !== undefined) {
            const id = bindings[origin];
            delete bindings[origin];
            return chrome.tabs.get(id);
          }
          return original(properties);
        },
      });
    }, bindings);
    const brain = await command<{ id: string }>({
      type: 'participant.add',
      input: {
        name: 'TEST BRAIN',
        role: 'brain',
        platform: 'deepseek',
        websiteUrl: 'https://chat.deepseek.com/',
        enabled: true,
      },
    });
    const member = await command<{ id: string }>({
      type: 'participant.add',
      input: {
        name: 'TEST MEMBER',
        platform: 'gemini',
        websiteUrl: 'https://gemini.google.com/app',
        enabled: true,
      },
    });
    for (const page of [brainPage, brainSample])
      await page.evaluate((target) => {
        document.body.dataset.routeTarget = target;
      }, member.id);
    const results: BrainRequest[] = [];
    for (const question of ['TEST FIRST ORIGINAL QUESTION', 'TEST SECOND INDEPENDENT QUESTION']) {
      const queued = await command<{ intent: string; requestId: string }>({
        type: 'chat.ask',
        question,
      });
      expect(queued.intent).toBe('routing');
      await panel.reload();
      await expect(panel.getByText(question, { exact: true })).toBeVisible();
      let snapshot: Snapshot | undefined;
      await expect
        .poll(
          async () => {
            await command({ type: 'tick' });
            snapshot = await command<Snapshot>({ type: 'snapshot' });
            const job = snapshot.brainRequests.find((job) => job.id === queued.requestId)!;
            if (job.phase === 'paused')
              throw new Error(`Routing paused: ${job.error?.code}: ${job.error?.detail}`);
            const discussion = snapshot.discussions.find(
              (discussion) => discussion.id === job.discussionId,
            );
            if (discussion?.status === 'PAUSED')
              throw new Error(
                `Discussion paused: ${discussion.reason}: ${discussion.reasonDetail}`,
              );
            return discussion?.status;
          },
          { timeout: 55_000, intervals: [250, 500, 1000] },
        )
        .toBe('COMPLETED');
      const job = snapshot!.brainRequests.find((job) => job.id === queued.requestId)!;
      results.push(job);
      const discussion = snapshot!.discussions.find(
        (discussion) => discussion.id === job.discussionId,
      )!;
      expect(discussion.originalQuestion).toBe(question);
      const outgoing = snapshot!.messages.find(
        (message) => message.discussionId === discussion.id && message.direction === 'outbound',
      );
      expect(outgoing?.content).toBe(question);
      const incoming = snapshot!.messages.find(
        (message) => message.discussionId === discussion.id && message.direction === 'inbound',
      );
      expect(incoming?.content).toBe('TEST NATURAL DIRECT REPLY');
      expect(incoming?.parseStatus).toBe('not_applicable');
      expect(incoming?.structuredData).toBeUndefined();
      await expect(memberPage.locator('[data-message-author-role="user"]').last()).toContainText(
        question,
      );
      await expect(
        memberPage.locator('[data-message-author-role="user"]').last(),
      ).not.toContainText('独立评审成员');
      expect(discussion.participantIds).toEqual([member.id]);
      expect(discussion.participantIds).not.toContain(brain.id);
      expect(
        snapshot!.reports.find((report) => report.discussionId === discussion.id)?.markdown,
      ).toContain('未进行多成员共识判断');
    }
    expect(results[0]!.task.discussionId).not.toBe(results[1]!.task.discussionId);
    await command({ type: 'participant.update', id: member.id, input: { name: '光头强' } });
    const direct = await command<{ discussionId: string; usedBrain: boolean }>({
      type: 'chat.ask',
      question: '光头强在吗',
    });
    expect(direct.usedBrain).toBe(false);
    await expect
      .poll(
        async () => {
          await command({ type: 'tick' });
          const current = await command<Snapshot>({ type: 'snapshot' });
          return current.discussions.find((discussion) => discussion.id === direct.discussionId)
            ?.status;
        },
        { timeout: 25_000, intervals: [250, 500, 1000] },
      )
      .toBe('COMPLETED');
    await expect(memberPage.locator('[data-message-author-role="user"]').last()).toContainText(
      '光头强在吗',
    );
    await expect(memberPage.locator('[data-message-author-role="user"]').last()).not.toContainText(
      '独立评审成员',
    );
    const final = await command<Snapshot>({ type: 'snapshot' });
    expect(final.brainRequests).toHaveLength(2);
    expect(
      final.messages.find(
        (message) =>
          message.discussionId === direct.discussionId && message.direction === 'outbound',
      )?.content,
    ).toBe('光头强在吗');
    expect(await brainPage.locator('#new-chat').getAttribute('data-clicks')).toBe('1');
    expect(await memberPage.locator('#new-chat').getAttribute('data-clicks')).toBe('2');
    await mkdir('docs/results', { recursive: true });
    await writeFile(
      'docs/results/brain-dom-flow.json',
      JSON.stringify(
        {
          passed: true,
          checkedAt: new Date().toISOString(),
          mode: 'CONTROLLED_DOM_FIXTURE_NOT_REAL_MODELS',
          questions: 3,
          namedDirectVerbatim: true,
          naturalReplies: true,
          persistedRouting: true,
          isolatedBrainContexts: true,
          reusedCompletedTabs: true,
          realModelAcceptance: false,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await context.close();
    const full = resolve(work);
    if (!full.startsWith(resolve('.tmp') + '\\') && !full.startsWith(resolve('.tmp') + '/'))
      throw new Error('Unsafe test directory');
    await rm(full, { recursive: true, force: true });
  }
});
