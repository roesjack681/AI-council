import { test, expect, chromium } from '@playwright/test';
import { pageOperation } from '../../src/adapters/dom/page-operation';
import { domProfiles } from '../../src/adapters/dom/profiles';
import { providerPage } from '../fixtures/dom-page';

test('paragraph-normalizing editor preserves blank lines and indentation when native insertion is unavailable', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles.find((p) => p.id === 'chatgpt')!;
    const marker = '[AI_COUNCIL_REQUEST:paragraphs]';
    const prompt = `TEST\n\n  INDENTED CODE\nNEXT\n\n${marker}`;
    await page.route('https://chatgpt.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `
      <main><section id="messages"></section><div id="prompt-textarea" contenteditable="true" style="white-space:pre-wrap"><p><br></p></div><button aria-label="Send">send</button></main>
      <script>document.execCommand=()=>false;const input=document.querySelector('#prompt-textarea');
      input.addEventListener('input',()=>{if(input.firstChild?.nodeType===3){const p=document.createElement('p');p.textContent=input.textContent.replace(/\\s+/g,' ');input.replaceChildren(p);}});
      document.querySelector('button').onclick=()=>{const raw=Array.from(input.children).map(p=>p.innerText.replace(/\\n$/,'')).join('\\n');input.dataset.submitted=raw;const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=raw;document.querySelector('#messages').append(user);input.textContent='';};</script>`,
      }),
    );
    await page.goto('https://chatgpt.com/');
    const sent = await page.evaluate(pageOperation, {
      operation: 'submit' as const,
      profile,
      marker,
      prompt,
    });
    expect(sent.markerFound).toBe(true);
    expect(await page.locator('#prompt-textarea').getAttribute('data-submitted')).toBe(prompt);
  } finally {
    await browser.close();
  }
});

test('rich editor accepts exact multiline textContent and resumes only its own unchanged full draft', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles.find((p) => p.id === 'chatgpt')!;
    const marker = '[AI_COUNCIL_REQUEST:rich-draft]';
    const prompt = `TEST QUESTION\n\nTEST CONSTRAINT\n\n${marker}\nTEST TRACKING`;
    await page.route('https://chatgpt.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `
      <main><section id="messages"></section><div id="prompt-textarea" contenteditable="true" style="white-space:normal"></div><button aria-label="Send">send</button></main>
      <script>document.querySelector('button').onclick=()=>{const input=document.querySelector('#prompt-textarea');const user=document.createElement('div');user.dataset.messageAuthorRole='user';user.textContent=input.textContent;document.querySelector('#messages').append(user);input.textContent='';};</script>`,
      }),
    );
    for (const draft of [
      prompt,
      prompt.replace('TEST CONSTRAINT', 'CHANGED CONSTRAINT'),
      prompt.replace(marker, '[AI_COUNCIL_REQUEST:other]'),
      'UNRELATED PRIVATE DRAFT',
    ]) {
      await page.goto('https://chatgpt.com/');
      await page.evaluate((draft) => {
        document.querySelector('#prompt-textarea')!.textContent = draft;
      }, draft);
      const before = await page.evaluate(pageOperation, {
        operation: 'inspect' as const,
        profile,
        marker,
        prompt,
      });
      expect(before.draftMatchesRequest).toBe(draft === prompt);
      const sent = await page.evaluate(pageOperation, {
        operation: 'submit' as const,
        profile,
        marker,
        prompt,
      });
      expect(sent.markerFound).toBe(draft === prompt);
      expect(sent.dispatched).toBe(draft === prompt);
      expect(await page.locator('#prompt-textarea').textContent()).toBe(
        draft === prompt ? '' : draft,
      );
    }
  } finally {
    await browser.close();
  }
});
test('four page profiles fill editors, confirm actual user markers, and read only subsequent output', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    for (const profile of domProfiles) {
      const context = await browser.newContext();
      await context.route(`${profile.origins[0]}/**`, (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: providerPage(profile.id as 'deepseek' | 'gemini' | 'doubao' | 'chatgpt'),
        }),
      );
      const page = await context.newPage();
      await page.goto(profile.newConversationUrl);
      const inspection = await page.evaluate(pageOperation, {
        operation: 'inspect' as const,
        profile,
      });
      expect(inspection.editorFound).toBe(true);
      expect(inspection.completionControlFound).toBe(true);
      const marker = `[AI_COUNCIL_REQUEST:${profile.id}-test]`;
      const sent = await page.evaluate(pageOperation, {
        operation: 'submit' as const,
        profile,
        marker,
        prompt: `TEST DOM FIXTURE PROMPT\n${marker}`,
      });
      expect(sent.markerFound, profile.id + JSON.stringify(sent)).toBe(true);
      expect(sent.dispatched).toBe(true);
      expect(sent.raw).toContain('TEST DOM FIXTURE ONLY');
      expect(sent.raw).not.toContain('TEST STRUCTURAL SAMPLE');
      const again = await page.evaluate(pageOperation, {
        operation: 'submit' as const,
        profile,
        marker,
        prompt: 'should not send',
      });
      expect(again.markerFound).toBe(true);
      expect(again.dispatched).toBe(false);
      expect(await page.locator('[data-message-author-role="user"]').count()).toBe(1);
      await context.close();
    }
  } finally {
    await browser.close();
  }
});
test('a visible login or verification screen is reported rather than bypassed', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles[0]!;
    await page.route(`${profile.origins[0]}/**`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: providerPage('deepseek', { loggedOut: true, challenge: true }),
      }),
    );
    await page.goto(profile.newConversationUrl);
    const result = await page.evaluate(pageOperation, {
      operation: 'submit' as const,
      profile,
      marker: '[AI_COUNCIL_REQUEST:test]',
      prompt: 'TEST',
    });
    expect(result.login).toBe('logged_out');
    expect(result.blocked).toBe(true);
    expect(result.dispatched).toBe(false);
  } finally {
    await browser.close();
  }
});

test('split request markers are reconciled from user DOM without accepting quoted assistant or draft markers', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles[0]!;
    const marker = '[AI_COUNCIL_REQUEST:split-confirmation]';
    for (const genuine of [true, false]) {
      await page.route('https://chat.deepseek.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<meta charset="utf-8"><main>${genuine ? '<div><span>[AI_COUNCIL_REQUEST:</span><span>split-confirmation</span><span>]</span></div>' : ''}<div class="ds-markdown">TEST RESPONSE <span>[AI_COUNCIL_REQUEST:</span><span>split-confirmation</span><span>]</span></div><button aria-label="复制">Copy</button><textarea placeholder="给 DeepSeek 发送消息">${marker}</textarea></main>`,
        }),
      );
      await page.goto('https://chat.deepseek.com/');
      const result = await page.evaluate(pageOperation, {
        operation: 'observe' as const,
        profile,
        marker,
      });
      expect(result.markerFound).toBe(genuine);
      expect(result.raw).toBe(
        genuine ? 'TEST RESPONSE [AI_COUNCIL_REQUEST:split-confirmation]' : '',
      );
      await page.unrouteAll();
    }
  } finally {
    await browser.close();
  }
});
