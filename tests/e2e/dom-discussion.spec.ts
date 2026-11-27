import { test, expect, chromium, type Page } from '@playwright/test';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { providerPage } from '../fixtures/dom-page';
for (const mode of ['seeded', 'blank', 'restored'] as const)
  test(`installed engine automatically discusses through real DOM injection and generates a persisted consensus report (fixture sites; ${mode})`, async () => {
    const startBlank = mode === 'blank';
    const restoreOldChats = mode === 'restored';
    test.setTimeout(120_000);
    await mkdir('.tmp', { recursive: true });
    const work = await mkdtemp(resolve('.tmp', 'dom-flow-'));
    const extension = resolve(work, 'extension');
    const profile = resolve(work, 'profile');
    await cp('dist', extension, { recursive: true });
    const manifest = JSON.parse(await readFile(resolve(extension, 'manifest.json'), 'utf8')) as {
      host_permissions?: string[];
      optional_host_permissions: string[];
    };
    // Only this disposable test copy receives host access without an interactive permission prompt.
    // Production retains optional permissions and always asks through the user's browser UI.
    manifest.host_permissions = [...manifest.optional_host_permissions];
    delete (manifest as { optional_host_permissions?: string[] }).optional_host_permissions;
    await writeFile(resolve(extension, 'manifest.json'), JSON.stringify(manifest));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    try {
      await context.route('https://chat.deepseek.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: providerPage('deepseek', {
            seed:
              !startBlank &&
              (restoreOldChats || !route.request().url().includes('fixture-isolated=1')),
            resetDelayMs: restoreOldChats ? 2500 : 0,
            unlabeledNewChat: restoreOldChats,
          }),
        }),
      );
      await context.route('https://gemini.google.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: providerPage('gemini', {
            seed: restoreOldChats || !route.request().url().includes('fixture-isolated=1'),
            resetDelayMs: restoreOldChats ? 2500 : 0,
          }),
        }),
      );
      const a = await context.newPage();
      await a.goto('https://chat.deepseek.com/');
      const b = await context.newPage();
      await b.goto('https://gemini.google.com/app');
      const isolatedA = await context.newPage();
      await isolatedA.goto('https://chat.deepseek.com/?fixture-isolated=1');
      const isolatedB = await context.newPage();
      await isolatedB.goto('https://gemini.google.com/app?fixture-isolated=1');
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const id = new URL(worker.url()).host;
      const panel = await context.newPage();
      await panel.goto(`chrome-extension://${id}/sidepanel.html`);
      // Navigation initiated by extension workers can precede Playwright's routing attachment.
      // Supply precreated isolated fixture tabs at the public tabs.create boundary. The production
      // adapter, persistence, scripting injection, send/poll and consensus pipeline remain unchanged.
      const bindings = await panel.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        return Object.fromEntries(
          tabs
            .filter((t) => t.url?.includes('fixture-isolated=1'))
            .map((t) => [new URL(t.url!).origin, t.id!]),
        );
      });
      await worker.evaluate(
        ({ bindings, loseFirstAck }) => {
          let lostAck = false;
          const execute = chrome.scripting.executeScript.bind(chrome.scripting);
          Object.defineProperty(chrome.scripting, 'executeScript', {
            value: async (details: chrome.scripting.ScriptInjection<unknown[], unknown>) => {
              const result = await execute(details);
              Object.defineProperty(globalThis, '__lastDomResult', {
                configurable: true,
                value: result[0]?.result,
              });
              const request = ('args' in details ? details.args?.[0] : undefined) as
                | { operation?: string; profile?: { id?: string } }
                | undefined;
              if (
                loseFirstAck &&
                !lostAck &&
                request?.operation === 'submit' &&
                request.profile?.id === 'deepseek'
              ) {
                lostAck = true;
                throw new Error('TEST ACK LOST AFTER ACTUAL DOM SUBMISSION');
              }
              return result;
            },
          });
          const original = chrome.tabs.create.bind(chrome.tabs);
          Object.defineProperty(chrome.tabs, 'create', {
            configurable: true,
            value: async (properties: chrome.tabs.CreateProperties) => {
              const origin = new URL(properties.url ?? 'about:blank').origin;
              const tabId = bindings[origin];
              if (tabId !== undefined) {
                delete bindings[origin];
                return chrome.tabs.get(tabId);
              }
              return original(properties);
            },
          });
        },
        { bindings, loseFirstAck: startBlank },
      );
      const command = async <T>(page: Page, input: unknown): Promise<T> => {
        const result = await page.evaluate(
          async (c) =>
            (await chrome.runtime.sendMessage(c)) as { ok: boolean; data: unknown; error?: string },
          input,
        );
        if (!result.ok) throw new Error(result.error);
        return result.data as T;
      };
      const p = await command<{ id: string }>(panel, {
        type: 'participant.add',
        input: {
          name: 'TEST DeepSeek DOM',
          platform: 'deepseek',
          websiteUrl: 'https://chat.deepseek.com/',
          enabled: true,
        },
      });
      const q = await command<{ id: string }>(panel, {
        type: 'participant.add',
        input: {
          name: 'TEST Gemini DOM',
          platform: 'gemini',
          websiteUrl: 'https://gemini.google.com/app',
          enabled: true,
        },
      });
      for (const participant of [p, q]) {
        const check = await command<{
          technicalVerified: boolean;
          interactionMode: string;
          firstMessageAllowed?: boolean;
          capabilities: {
            canReadOutput: boolean;
            canDetectCompletion: boolean;
            unattendedAllowed: boolean;
          };
        }>(panel, {
          type: 'participant.check',
          id: participant.id,
        });
        if (startBlank && participant.id === p.id) {
          expect(check.technicalVerified).toBe(false);
          expect(check.firstMessageAllowed).toBe(true);
          expect(check.capabilities.canReadOutput).toBe(false);
          expect(check.capabilities.canDetectCompletion).toBe(false);
          expect(check.capabilities.unattendedAllowed).toBe(false);
        } else expect(check.technicalVerified).toBe(true);
        expect(check.interactionMode).toBe('browser_dom');
      }
      const discussion = await command<{ id: string }>(panel, {
        type: 'discussion.create',
        input: {
          title: 'TEST DOM FLOW',
          originalQuestion: 'TEST DOM FIXTURE ONLY: compare two test proposals',
          context: '',
          constraints: [],
          expectedOutput: '',
          participantIds: [p.id, q.id],
          maxRounds: 5,
          stableRoundsRequired: 2,
          timeoutMs: 60000,
          maxRetries: 5,
          privacyAcknowledged: true,
        },
      });
      await command(panel, { type: 'discussion.start', id: discussion.id });
      if (restoreOldChats) {
        expect(await a.locator('[data-message-author-role="user"]').count()).toBe(0);
        expect(await b.locator('[data-message-author-role="user"]').count()).toBe(0);
        await a.close();
        await b.close();
      }
      let snapshot:
        | {
            discussions: { id: string; status: string; reason?: string }[];
            messages: { direction: string; content: string }[];
            reports: { json: string }[];
            browserSessions: unknown[];
            browserDeliveries: { phase: string }[];
          }
        | undefined;
      await expect
        .poll(
          async () => {
            await command(panel, { type: 'tick' });
            snapshot = await command(panel, { type: 'snapshot' });
            const d = snapshot!.discussions.find((d) => d.id === discussion.id);
            if (d?.status === 'PAUSED' || d?.status === 'FAILED')
              throw new Error(
                `Unexpected ${d.status}: ${d.reason}; ${JSON.stringify(await worker.evaluate(() => (globalThis as unknown as { __lastDomResult: unknown }).__lastDomResult))}`,
              );
            return d?.status;
          },
          { timeout: 95000, intervals: [250, 500, 1000] },
        )
        .toBe('COMPLETED');
      expect(snapshot!.browserSessions).toHaveLength(2);
      expect(snapshot!.browserDeliveries).toHaveLength(6);
      expect(snapshot!.browserDeliveries.every((d) => d.phase === 'complete')).toBe(true);
      expect(snapshot!.messages.filter((m) => m.direction === 'inbound')).toHaveLength(6);
      expect(snapshot!.reports).toHaveLength(1);
      expect(JSON.parse(snapshot!.reports[0]!.json).discussion.status).toBe('COMPLETED');
      if (!restoreOldChats) {
        expect(await a.locator('[data-message-author-role="user"]').count()).toBe(0);
        expect(await b.locator('[data-message-author-role="user"]').count()).toBe(0);
      }
      expect(await isolatedA.locator('[data-message-author-role="user"]').count()).toBe(3);
      if (restoreOldChats) {
        expect(await isolatedA.locator('#new-chat').getAttribute('data-clicks')).toBe('1');
        expect(await isolatedB.locator('#new-chat').getAttribute('data-clicks')).toBe('1');
        const prepared = await command<{
          queue: { retryCount: number }[];
          browserSessions: { preparation?: { phase: string } }[];
        }>(panel, { type: 'snapshot' });
        expect(prepared.queue.every((q) => q.retryCount === 0)).toBe(true);
        expect(prepared.browserSessions.every((s) => s.preparation?.phase === 'ready')).toBe(true);
      }
      if (startBlank) {
        const logs = await command<{ logs: { code: string }[] }>(panel, { type: 'snapshot' });
        expect(logs.logs.some((l) => l.code === 'DELIVERY_RECONCILED')).toBe(true);
      }
      const finalCheck = await command<{ technicalVerified: boolean }>(panel, {
        type: 'participant.check',
        id: p.id,
      });
      expect(finalCheck.technicalVerified).toBe(true);
      await mkdir('docs/results', { recursive: true });
      await writeFile(
        restoreOldChats
          ? 'docs/results/dom-restored-session-flow.json'
          : startBlank
            ? 'docs/results/dom-blank-start-flow.json'
            : 'docs/results/dom-flow.json',
        JSON.stringify(
          {
            passed: true,
            checkedAt: new Date().toISOString(),
            mode: 'CONTROLLED_DOM_FIXTURE_NOT_REAL_MODELS',
            sessionProvisioning: 'precreated isolated fixture tabs at public tabs.create boundary',
            transport: 'production BrowserDomAdapter + chrome.scripting.executeScript ISOLATED',
            rounds: 2,
            receivedReplies: 6,
            separateSessionTabs: 2,
            realModelAcceptance: false,
            startedWithoutDeepSeekReplySample: startBlank,
            lostFirstAcknowledgmentAfterRealDomSubmission: startBlank,
            restoredOldConversations: restoreOldChats,
            sampleTabsClosedAfterInitialization: restoreOldChats,
            newConversationDelayMs: restoreOldChats ? 2500 : 0,
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      await context.close();
      const target = resolve(work);
      if (!target.startsWith(resolve('.tmp') + '\\') && !target.startsWith(resolve('.tmp') + '/'))
        throw new Error('Unsafe test directory');
      await rm(target, { recursive: true, force: true });
    }
  });
