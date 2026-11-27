import { test, expect, chromium } from '@playwright/test';
import { pageOperation } from '../../src/adapters/dom/page-operation';
import { domProfiles } from '../../src/adapters/dom/profiles';
import { providerPage } from '../fixtures/dom-page';

const chatPlusPath =
  'M9.99994 1.22943C5.15598 1.22943 1.22937 5.15604 1.22937 10Z M9.21913 6.36949V9.22487H6.36943V10.7751H9.21913V13.6305H10.7694V10.7751H13.6304V9.22487H10.7694V6.36949H9.21913Z';
const icon = (path: string) =>
  `<div role="button" class="ds-button" tabindex="0" style="width:44px;height:44px"><svg viewBox="0 0 20 20"><path d="${path}"></path></svg></div>`;
test('observed DeepSeek chat-plus DOM identifies the unlabeled new-chat control, not the adjacent share control', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles.find((p) => p.id === 'deepseek')!;
    await page.route('https://chat.deepseek.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<meta charset="utf-8"><main><div class="the-header">${icon(chatPlusPath)}${icon('M1 1L10 10')}</div><div class="ds-markdown">OLD RESPONSE</div><textarea placeholder="给 DeepSeek 发送消息"></textarea></main><script>document.body.dataset.shareClicks='0';document.querySelectorAll('[role=button]')[0].onclick=()=>{document.body.dataset.chatClicks='1';document.querySelector('.ds-markdown').remove();};document.querySelectorAll('[role=button]')[1].onclick=()=>{document.body.dataset.shareClicks='1';};</script>`,
      }),
    );
    await page.goto('https://chat.deepseek.com/a/chat/s/test');
    const result = await page.evaluate(pageOperation, {
      operation: 'new_conversation' as const,
      profile,
    });
    expect(result.newConversationState).toBe('requested');
    expect(result.outputCount).toBe(0);
    expect(await page.locator('body').getAttribute('data-chat-clicks')).toBe('1');
    expect(await page.locator('body').getAttribute('data-share-clicks')).toBe('0');
  } finally {
    await browser.close();
  }
});

test('ambiguous icons, icons outside the header and another platform cannot activate DeepSeek-specific controls', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    for (const sample of [
      {
        profile: domProfiles.find((p) => p.id === 'deepseek')!,
        html: `<div class="the-header">${icon(chatPlusPath)}${icon(chatPlusPath)}</div>`,
      },
      { profile: domProfiles.find((p) => p.id === 'deepseek')!, html: icon(chatPlusPath) },
      {
        profile: domProfiles.find((p) => p.id === 'gemini')!,
        html: `<div class="the-header">${icon(chatPlusPath)}</div>`,
      },
    ]) {
      const page = await browser.newPage();
      await page.route(sample.profile.origins[0] + '/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<meta charset="utf-8"><main>${sample.html}<div class="ds-markdown" id="model-response-message-content-old">OLD RESPONSE</div><div role="textbox" contenteditable="true"></div><textarea placeholder="给 DeepSeek 发送消息"></textarea></main><script>document.body.dataset.clicked='false';document.querySelectorAll('[role=button]').forEach(button=>button.onclick=()=>document.body.dataset.clicked='true');</script>`,
        }),
      );
      await page.goto(sample.profile.origins[0] + '/');
      const result = await page.evaluate(pageOperation, {
        operation: 'new_conversation' as const,
        profile: sample.profile,
      });
      expect(result.newConversationState).toBe('not_found');
      expect(await page.locator('body').getAttribute('data-clicked')).toBe('false');
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

for (const source of ['title', 'aria-labelledby'] as const)
  test(`new conversation uses ${source} and acknowledges an asynchronous transition`, async () => {
    const browser = await chromium.launch({ channel: 'chromium', headless: true });
    try {
      const page = await browser.newPage();
      const profile = domProfiles.find((p) => p.id === 'gemini')!;
      await page.route('https://gemini.google.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: providerPage('gemini', { resetDelayMs: 1800 }),
        }),
      );
      await page.goto('https://gemini.google.com/app/old');
      if (source === 'aria-labelledby')
        await page.evaluate(() => {
          const label = document.createElement('span');
          label.id = 'new-chat-label';
          label.textContent = '发起新对话';
          document.body.append(label);
          const button = document.querySelector('#new-chat')!;
          button.removeAttribute('title');
          button.setAttribute('aria-labelledby', label.id);
        });
      const result = await page.evaluate(pageOperation, {
        operation: 'new_conversation' as const,
        profile,
      });
      expect(result.newConversationState).toBe('requested');
      expect(result.outputCount).toBe(1);
      expect(result.dispatched).toBe(false);
      await expect(page.locator('#messages')).toBeEmpty();
      const empty = await page.evaluate(pageOperation, {
        // Reset once, then observe. The persisted preparer tracks the transcript that was cleared.
        operation: 'inspect' as const,
        profile,
      });
      expect(empty.outputCount).toBe(0);
      expect(empty.userCount).toBe(0);
      expect(await page.locator('#new-chat').getAttribute('data-clicks')).toBe('1');
    } finally {
      await browser.close();
    }
  });

test('a missing new-conversation control preserves the old messages and reports the real cause', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles.find((p) => p.id === 'gemini')!;
    await page.route('https://gemini.google.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: providerPage('gemini') }),
    );
    await page.goto('https://gemini.google.com/app/old');
    await page.locator('#new-chat').evaluate((el) => el.remove());
    const result = await page.evaluate(pageOperation, {
      operation: 'new_conversation' as const,
      profile,
    });
    expect(result.newConversationState).toBe('not_found');
    expect(result.reason).toContain('未找到新对话按钮');
    expect(result.outputCount).toBe(1);
    expect(await page.locator('#messages').innerText()).toContain('TEST STRUCTURAL SAMPLE');
  } finally {
    await browser.close();
  }
});
