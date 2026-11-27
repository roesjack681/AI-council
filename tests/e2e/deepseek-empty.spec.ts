import { test, expect, chromium } from '@playwright/test';
import { pageOperation } from '../../src/adapters/dom/page-operation';
import { domProfiles } from '../../src/adapters/dom/profiles';
import { providerPage } from '../fixtures/dom-page';

test('observed Gemini home welcome allows a first attempt only on the blank app route', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles.find((p) => p.id === 'gemini')!;
    for (const sample of [
      { path: '/app', greeting: '<h1>需要我为你做些什么？</h1>', allowed: true },
      { path: '/app/old-chat', greeting: '<h1>需要我为你做些什么？</h1>', allowed: false },
      { path: '/app', greeting: '<h1 hidden>需要我为你做些什么？</h1>', allowed: false },
      { path: '/app', greeting: '<aside>需要我为你做些什么？</aside>', allowed: false },
      {
        path: '/app',
        greeting: '<h1>需要我为你做些什么？</h1><user-query>OLD QUESTION</user-query>',
        allowed: false,
      },
      {
        path: '/app',
        greeting: '<h1>需要我为你做些什么？</h1><message-content>OLD ANSWER</message-content>',
        allowed: false,
      },
      {
        path: '/app',
        greeting: '<h1>需要我为你做些什么？</h1><button>登录</button>',
        allowed: false,
      },
    ]) {
      await page.route('https://gemini.google.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<meta charset="utf-8"><main>${sample.greeting}<rich-textarea><div role="textbox" contenteditable="true"></div></rich-textarea></main>`,
        }),
      );
      await page.goto('https://gemini.google.com' + sample.path);
      const result = await page.evaluate(pageOperation, { operation: 'inspect' as const, profile });
      expect(result.emptyConversation, JSON.stringify(sample)).toBe(sample.allowed);
      expect(result.dispatched).toBe(false);
      await page.unrouteAll();
    }
  } finally {
    await browser.close();
  }
});

test('DeepSeek observed home welcome permits an empty-state classification without inventing output or completion', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles.find((p) => p.id === 'deepseek')!;
    for (const body of [
      providerPage('deepseek', { seed: false }),
      `<meta charset="utf-8"><main><div class="hero"><svg></svg><div><span>下午好</span>，开始聊天吧</div></div><textarea placeholder="给 DeepSeek 发送消息"></textarea></main>`,
      `<meta charset="utf-8"><main><h1>Into the Unknown</h1><textarea placeholder="给 DeepSeek 发送消息"></textarea></main>`,
      `<meta charset="utf-8"><main><div>使用快速模式开始对话</div><textarea placeholder="给 DeepSeek 发送消息"></textarea></main>`,
    ]) {
      await page.route('https://chat.deepseek.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body }),
      );
      await page.goto('https://chat.deepseek.com/');
      const result = await page.evaluate(pageOperation, { operation: 'inspect' as const, profile });
      expect(result.emptyConversation, body.slice(0, 120)).toBe(true);
      expect(result.outputCount).toBe(0);
      expect(result.completionControlFound).toBe(false);
      expect(result.dispatched).toBe(false);
      await page.unrouteAll();
    }
  } finally {
    await browser.close();
  }
});

test('ChatGPT blank home allows empty conversation without a prior reply sample', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles.find((p) => p.id === 'chatgpt')!;
    for (const sample of [
      {
        path: '/',
        body: `<main><h1>What can I help with?</h1><div id="prompt-textarea" role="textbox" contenteditable="true"></div><button data-testid="send-button">Send</button></main>`,
        allowed: true,
      },
      {
        path: '/',
        body: `<main><div id="prompt-textarea" role="textbox" contenteditable="true"></div><button data-testid="send-button">Send</button></main>`,
        allowed: true,
      },
      {
        path: '/c/old-thread',
        body: `<main><h1>What can I help with?</h1><div id="prompt-textarea" role="textbox" contenteditable="true"></div></main>`,
        allowed: false,
      },
      {
        path: '/',
        body: `<main><h1>What can I help with?</h1><div data-message-author-role="assistant"><div class="markdown">OLD</div></div><div id="prompt-textarea" role="textbox" contenteditable="true"></div></main>`,
        allowed: false,
      },
    ]) {
      await page.route('https://chatgpt.com/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: `<meta charset="utf-8">${sample.body}` }),
      );
      await page.goto('https://chatgpt.com' + sample.path);
      const result = await page.evaluate(pageOperation, { operation: 'inspect' as const, profile });
      expect(result.emptyConversation, JSON.stringify(sample)).toBe(sample.allowed);
      expect(result.dispatched).toBe(false);
      await page.unrouteAll();
    }
  } finally {
    await browser.close();
  }
});

test('missing selectors, old chat URLs, hidden welcomes, drafts, generation and login do not prove an empty conversation', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles.find((p) => p.id === 'deepseek')!;
    const cases = [
      { path: '/a/chat/old', html: '<p>早上好，开始聊天吧</p>' },
      { path: '/', html: '<div class="unknown-reply">EXISTING UNMATCHED RESPONSE</div>' },
      { path: '/', html: '<p hidden>早上好，开始聊天吧</p>' },
      { path: '/', html: '<aside><p>早上好，开始聊天吧</p></aside>' },
      { path: '/', html: '<p>早上好，开始聊天吧</p><button aria-label="复制">Copy</button>' },
      { path: '/', html: '<p>早上好，开始聊天吧</p><button aria-label="停止生成">Stop</button>' },
      { path: '/', html: '<p>早上好，开始聊天吧</p><button>登录</button>' },
      { path: '/', html: '<p>早上好，开始聊天吧</p>', draft: 'UNSENT DRAFT' },
    ];
    for (const sample of cases) {
      await page.route('https://chat.deepseek.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<meta charset="utf-8"><main>${sample.html}<textarea placeholder="给 DeepSeek 发送消息">${sample.draft ?? ''}</textarea></main>`,
        }),
      );
      await page.goto('https://chat.deepseek.com' + sample.path);
      const result = await page.evaluate(pageOperation, { operation: 'inspect' as const, profile });
      expect(result.emptyConversation, JSON.stringify(sample)).toBe(false);
      await page.unrouteAll();
    }
  } finally {
    await browser.close();
  }
});
