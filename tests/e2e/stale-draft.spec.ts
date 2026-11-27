import { test, expect, chromium } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { providerPage } from '../fixtures/dom-page';
import { legacyDraft, oldRequestKey } from '../fixtures/legacy-draft';
import type { Snapshot } from '../../src/protocols/domain';
import { pageOperation } from '../../src/adapters/dom/page-operation';
import { domProfiles } from '../../src/adapters/dom/profiles';

test('a paused current greeting recovers an orphaned historical math draft without sending it; archive restores without sending', async () => {
  test.setTimeout(60_000);
  await mkdir('.tmp', { recursive: true });
  const work = await mkdtemp(resolve('.tmp', 'stale-draft-'));
  const extension = resolve(work, 'extension');
  await cp('dist', extension, { recursive: true });
  const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')) as {
    host_permissions?: string[];
    optional_host_permissions: string[];
  };
  manifest.host_permissions = [...manifest.optional_host_permissions];
  await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(resolve(work, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    await context.route('https://chatgpt.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: providerPage('chatgpt', { seed: false, plainReply: 'TEST CURRENT GREETING REPLY' }),
      }),
    );
    const model = await context.newPage();
    await model.goto('https://chatgpt.com/');
    await model.locator('#prompt-textarea').fill(legacyDraft);
    const capturedDraft = await model.evaluate(pageOperation, {
      operation: 'inspect' as const,
      profile: domProfiles.find((p) => p.id === 'chatgpt')!,
      captureDraft: true,
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    const command = async <T>(input: unknown): Promise<T> => {
      const result = await panel.evaluate(
        async (c) =>
          (await chrome.runtime.sendMessage(c)) as { ok: boolean; data: unknown; error?: string },
        input,
      );
      if (!result.ok) throw new Error(result.error);
      return result.data as T;
    };
    const p = await command<{ id: string }>({
      type: 'participant.add',
      input: {
        name: '光头强',
        platform: 'chatgpt',
        websiteUrl: 'https://chatgpt.com/',
        enabled: true,
      },
    });
    const input = {
      title: 'CURRENT GREETING',
      originalQuestion: '小光头在吗',
      context: '',
      constraints: [],
      expectedOutput: '',
      participantIds: [p.id],
      mode: 'direct',
      maxRounds: 2,
      stableRoundsRequired: 1,
      timeoutMs: 180_000,
      maxRetries: 2,
      privacyAcknowledged: true,
    };
    const d = await command<{ id: string }>({ type: 'discussion.create', input });
    const old = await command<{ id: string }>({
      type: 'discussion.create',
      input: { ...input, title: 'OLD MATH', originalQuestion: '你俩说说1+1等于几' },
    });
    // Reproduce observed 0.3.4 state: only the current greeting owns the foreground request.
    await panel.evaluate(
      async ({ id, oldId, pid }) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === 'https://chatgpt.com/')!;
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const r = indexedDB.open('ai-council');
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(
              ['discussions', 'runtime_state', 'browser_sessions'],
              'readwrite',
            );
            for (const taskId of [id, oldId]) {
              const r = tx.objectStore('discussions').get(taskId);
              r.onsuccess = () =>
                tx.objectStore('discussions').put({
                  ...r.result,
                  status: 'PAUSED',
                  reason: 'DRAFT_PRESENT',
                  resumeStatus: 'INITIALIZING',
                  userRequestId: taskId === id ? 'current-ui-request' : 'old-ui-request',
                });
            }
            tx.objectStore('runtime_state').put({
              id: 'foreground',
              requestId: 'current-ui-request',
              discussionId: id,
              updatedAt: Date.now(),
            });
            tx.objectStore('browser_sessions').put({
              id: `${id}:${pid}`,
              discussionId: id,
              participantId: pid,
              tabId: tab.id!,
              origin: 'https://chatgpt.com',
              createdAt: Date.now(),
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
          });
        } finally {
          db.close();
        }
      },
      { id: d.id, oldId: old.id, pid: p.id },
    );
    await panel.reload();
    let snapshot: Snapshot | undefined;
    await expect
      .poll(
        async () => {
          await command({ type: 'tick' });
          snapshot = await command<Snapshot>({ type: 'snapshot' });
          return snapshot.discussions.find((task) => task.id === d.id)?.status;
        },
        { timeout: 20_000, intervals: [250, 500, 1000] },
      )
      .toBe('COMPLETED');
    expect(snapshot!.discussions.find((task) => task.id === old.id)?.status).toBe('PAUSED');
    expect(snapshot!.recoveredDrafts).toHaveLength(1);
    expect(snapshot!.recoveredDrafts![0]!.content).toBe(capturedDraft.draftText);
    expect(snapshot!.recoveredDrafts![0]!.phase).toBe('cleared');
    const posted = model.locator('[data-message-author-role="user"]');
    await expect(posted).toHaveCount(1);
    await expect(posted).toContainText('小光头在吗');
    await expect(posted).not.toContainText(oldRequestKey);
    await expect(posted).not.toContainText('1+1');
    await panel.getByRole('button', { name: '打开设置', exact: true }).click();
    await panel.getByText('已保留的网页草稿', { exact: true }).click();
    const archive = panel.getByText('已保留的网页草稿', { exact: true }).locator('..');
    await archive.locator('details > summary').first().click();
    await panel.getByRole('button', { name: '恢复到原输入框（不发送）', exact: true }).click();
    await expect(model.locator('#prompt-textarea')).toContainText(oldRequestKey);
    await expect(model.locator('#prompt-textarea')).toContainText('你俩说说1+1等于几');
    await expect(posted).toHaveCount(1);
    await command({ type: 'tick' });
    await expect(posted).toHaveCount(1);
    await writeFile(
      'docs/results/stale-draft.json',
      JSON.stringify(
        {
          passed: true,
          fixtureOnly: true,
          realModelAcceptance: false,
          archivedBeforeClear: true,
          oldPromptSent: false,
          currentQuestion: '小光头在吗',
          inactiveOldTaskStayedPaused: true,
          archiveRestoredWithoutSending: true,
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
