import { test, expect, chromium } from '@playwright/test';
import { providerPage } from '../fixtures/dom-page';
import { legacyDraft, oldRequestKey } from '../fixtures/legacy-draft';
import { pageOperation } from '../../src/adapters/dom/page-operation';
import { domProfiles } from '../../src/adapters/dom/profiles';
for (const platform of ['chatgpt', 'deepseek'] as const) {
  test(`draft move compares full ${platform} editor before clearing and restores without submitting`, async () => {
    const browser = await chromium.launch({ channel: 'chromium', headless: true });
    try {
      const page = await browser.newPage();
      const profile = domProfiles.find((p) => p.id === platform)!;
      await page.route(`${profile.origins[0]}/**`, (route) =>
        route.fulfill({ contentType: 'text/html', body: providerPage(platform, { seed: false }) }),
      );
      await page.goto(profile.newConversationUrl);
      const editor = page.locator(platform === 'chatgpt' ? '#prompt-textarea' : 'textarea');
      await editor.fill(legacyDraft);
      const capture = await page.evaluate(pageOperation, {
        operation: 'inspect' as const,
        profile,
        captureDraft: true,
      });
      const capturedText =
        platform === 'chatgpt' ? await editor.innerText() : await editor.inputValue();
      expect(capture.draftText).toBe(capturedText);
      await editor.fill(`${legacyDraft}\nTEST LATER USER EDIT`);
      const changed = await page.evaluate(pageOperation, {
        operation: 'clear_draft' as const,
        profile,
        marker: `[AI_COUNCIL_REQUEST:${oldRequestKey}]`,
        prompt: capture.draftText,
      });
      expect(changed.draftState).toBe('changed');
      await expect(editor).toContainText(platform === 'chatgpt' ? 'TEST LATER USER EDIT' : '');
      if (platform === 'deepseek')
        await expect(editor).toHaveValue(`${legacyDraft}\nTEST LATER USER EDIT`);
      await editor.fill(legacyDraft);
      const cleared = await page.evaluate(pageOperation, {
        operation: 'clear_draft' as const,
        profile,
        marker: `[AI_COUNCIL_REQUEST:${oldRequestKey}]`,
        prompt: capturedText,
      });
      expect(cleared.draftState).toBe('cleared');
      expect(cleared.editorEmpty).toBe(true);
      const wrongPage = await page.evaluate(pageOperation, {
        operation: 'restore_draft' as const,
        profile,
        marker: `[AI_COUNCIL_REQUEST:${oldRequestKey}]`,
        prompt: capturedText,
        expectedUrl: `${profile.origins[0]}/another-chat`,
      });
      expect(wrongPage.draftState).toBe('blocked');
      expect(wrongPage.editorEmpty).toBe(true);
      const restored = await page.evaluate(pageOperation, {
        operation: 'restore_draft' as const,
        profile,
        marker: `[AI_COUNCIL_REQUEST:${oldRequestKey}]`,
        prompt: capturedText,
        captureDraft: true,
      });
      expect(restored.draftState).toBe('restored');
      expect(restored.draftText).toBe(capturedText);
      await expect(page.locator('[data-message-author-role="user"]')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });
}
