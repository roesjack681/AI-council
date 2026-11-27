import { test, expect, chromium } from '@playwright/test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

test('sidepanel resizing and keyboard popup use preserve visible focus without suppressed runtime errors', async () => {
  test.setTimeout(60_000);
  await mkdir('.tmp', { recursive: true });
  const profile = await mkdtemp(resolve('.tmp', 'ui-runtime-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${resolve('dist')}`, `--load-extension=${resolve('dist')}`],
    viewport: { width: 360, height: 720 },
  });
  const warnings: string[] = [];
  try {
    await context.addInitScript(() => {
      const state = window as unknown as Window & {
        uiErrors: string[];
        hiddenFocus: string[];
        uiObservers: ResizeObserver[];
      };
      state.uiErrors = [];
      state.hiddenFocus = [];
      state.uiObservers = [];
      const NativeObserver = window.ResizeObserver;
      window.ResizeObserver = class extends NativeObserver {
        constructor(callback: ResizeObserverCallback) {
          super(callback);
          state.uiObservers.push(this);
        }
      };
      window.addEventListener('error', (e) => {
        if (!e.message.endsWith('[TEST_TRANSPARENCY]')) state.uiErrors.push(e.message);
      });
      document.addEventListener('focusin', (e) => {
        if (e.target instanceof Element && e.target.closest('[aria-hidden="true"], [inert]'))
          state.hiddenFocus.push(e.target.outerHTML.slice(0, 300));
      });
    });
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Log.enable');
    cdp.on('Log.entryAdded', ({ entry }) => {
      if (/aria-hidden|ResizeObserver/.test(entry.text)) warnings.push(entry.text);
    });
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
    // UI-only test: do not open Chrome's permission prompt or navigate any model website.
    await page.evaluate(() =>
      Object.defineProperty(chrome.permissions, 'request', { value: async () => true }),
    );
    const command = async <T>(input: unknown): Promise<T> => {
      const result = await page.evaluate(
        async (c) =>
          (await chrome.runtime.sendMessage(c)) as { ok: boolean; data: unknown; error?: string },
        input,
      );
      if (!result.ok) throw new Error(result.error);
      return result.data as T;
    };
    await page.getByRole('button', { name: '打开设置', exact: true }).click();
    await page.getByRole('checkbox', { name: /我已了解/ }).check();
    await page.getByRole('button', { name: '加入聊天室', exact: true }).click();
    for (const width of [320, 460, 700, 340]) {
      await page.setViewportSize({ width, height: 720 });
      await page.getByLabel('平台', { exact: true }).click();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await page.getByLabel('共识要求', { exact: true }).click();
      await page.keyboard.press('Escape');
    }
    await page.getByRole('button', { name: '返回聊天室', exact: true }).click();
    const participant = (await command<{ participants: { id: string }[] }>({ type: 'snapshot' }))
      .participants[0]!;
    const discussion = await command<{ id: string }>({
      type: 'discussion.create',
      input: {
        title: 'TEST UI REPORT',
        originalQuestion: 'TEST UI ONLY',
        context: '',
        constraints: [],
        expectedOutput: '',
        participantIds: [participant.id],
        mode: 'direct',
        maxRounds: 2,
        stableRoundsRequired: 1,
        timeoutMs: 180_000,
        maxRetries: 2,
        privacyAcknowledged: true,
      },
    });
    // Local UI fixture only: never injected into a model website or shipped in the extension.
    await page.evaluate(
      async ({ id, participantId }) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open('ai-council');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(['discussions', 'messages', 'rounds'], 'readwrite');
            const request = tx.objectStore('discussions').get(id);
            request.onsuccess = () =>
              tx
                .objectStore('discussions')
                .put({ ...request.result, status: 'COMPLETED', finishedAt: Date.now() });
            tx.objectStore('rounds').put({
              id: 'ui-round',
              discussionId: id,
              roundNumber: 0,
              kind: 'initial',
              status: 'completed',
              summary: '',
              startedAt: 1,
            });
            tx.objectStore('messages').put({
              id: 'ui-message',
              dedupeKey: 'ui-only-message',
              discussionId: id,
              participantId,
              roundId: 'ui-round',
              direction: 'inbound',
              type: 'RESPONSE',
              content: 'TEST UI FIXTURE ONLY',
              parseStatus: 'not_applicable',
              relatedClaimIds: [],
              relatedObjectionIds: [],
              status: 'received',
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
      { id: discussion.id, participantId: participant.id },
    );
    await command({ type: 'report.generate', id: discussion.id });
    await page.reload();
    for (const close of ['Escape', 'button', 'backdrop']) {
      await page.getByRole('button', { name: '查看详情', exact: true }).click();
      await expect(page.getByText('讨论详情', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: '关闭讨论详情', exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Shift+Tab');
      if (close === 'Escape') await page.keyboard.press('Escape');
      else if (close === 'button')
        await page.getByRole('button', { name: '关闭讨论详情', exact: true }).click();
      else await page.mouse.click(1, 1);
      await expect(page.getByText('讨论详情', { exact: true })).not.toBeVisible();
      await expect(page.getByRole('button', { name: '查看详情', exact: true })).toBeFocused();
    }
    await page.getByRole('button', { name: '清除讨论数据', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '清除讨论数据', exact: true }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    const state = await page.evaluate(() => {
      const state = window as unknown as Window & {
        uiErrors: string[];
        hiddenFocus: string[];
        uiObservers: ResizeObserver[];
      };
      const diagnostic = new ErrorEvent('error', {
        message:
          'ResizeObserver loop completed with undelivered notifications. [TEST_TRANSPARENCY]',
        cancelable: true,
      });
      const delivered = window.dispatchEvent(diagnostic);
      return {
        errors: state.uiErrors,
        hiddenFocus: state.hiddenFocus,
        activeHidden: document.activeElement?.closest('[aria-hidden="true"], [inert]')?.outerHTML,
        observerCount: state.uiObservers.length,
        allObserversBatched: state.uiObservers.every(
          (observer) => observer instanceof window.ResizeObserver,
        ),
        errorsNotSuppressed: delivered && !diagnostic.defaultPrevented,
      };
    });
    await writeFile(
      'docs/results/ui-runtime.json',
      JSON.stringify({ warnings, ...state, fixtureOnly: true }, null, 2),
    );
    expect(warnings).toEqual([]);
    expect(state.errors).toEqual([]);
    expect(state.hiddenFocus).toEqual([]);
    expect(state.activeHidden).toBeUndefined();
    expect(state.observerCount).toBeGreaterThan(0);
    expect(state.allObserversBatched).toBe(true);
    expect(state.errorsNotSuppressed).toBe(true);
  } finally {
    await context.close();
    if (!resolve(profile).startsWith(resolve('.tmp') + '\\'))
      throw new Error('Unsafe test profile');
    await rm(profile, { recursive: true, force: true });
  }
});
