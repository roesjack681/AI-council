import { test, expect, chromium } from '@playwright/test';
import { pageOperation } from '../../src/adapters/dom/page-operation';
import { domProfiles } from '../../src/adapters/dom/profiles';
test('current ChatGPT layout without legacy editor IDs or author attributes is recognized by composer and speaker turns', async () => {
  const browser = await chromium.launch({ channel: 'chromium', headless: true });
  try {
    const page = await browser.newPage();
    const profile = domProfiles.find((p) => p.id === 'chatgpt')!;
    await page.route('https://chatgpt.com/**', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><head><meta charset="utf-8"></head><body><main><header><button>新聊天</button></header><section role="region" aria-label="对话"><div><h5>你说：</h5><p>1+1 [AI_COUNCIL_REQUEST:layout]</p><button title="复制消息">user-copy</button></div><div><h5>ChatGPT 说：</h5><div><p>2</p></div><div><button title="复制">copy-icon</button><button title="朗读">read-icon</button></div></div></section><div contenteditable="true" role="textbox" aria-label="询问 ChatGPT"></div><div role="status">回答已完成</div></main></body></html>`,
      }),
    );
    await page.goto('https://chatgpt.com/c/test-layout');
    const probe = await page.evaluate(pageOperation, {
      operation: 'observe' as const,
      profile,
      marker: '[AI_COUNCIL_REQUEST:layout]',
    });
    expect(probe.editorFound).toBe(true);
    expect(probe.outputCount).toBe(1);
    expect(probe.userCount).toBe(1);
    expect(probe.completionControlFound).toBe(true);
    expect(probe.markerFound).toBe(true);
    expect(probe.raw).toBe('2');
    expect(probe.selectors?.assistant).toBe('@speaker-heading');
    expect(probe.selectors?.editor).not.toBe('#prompt-textarea');
  } finally {
    await browser.close();
  }
});
const marker = '[AI_COUNCIL_REQUEST:layout]';
const composer = '<div contenteditable="true" role="textbox" aria-label="询问 ChatGPT"></div>';
const cases = [
  {
    name: 'hidden translation text does not corrupt speaker names',
    body: `<section role="region"><h5><span style="display:none">You said:</span>你说：</h5><p>PRIVATE ${marker}</p><h5><span style="display:none">ChatGPT said:</span>ChatGPT 说：</h5><p>ANSWER</p><button title="复制"></button></section>${composer}`,
    raw: 'ANSWER',
    count: 1,
    source: '@speaker-range',
  },
  {
    name: 'zero width separators in localized speaker titles',
    body: `<section role="region"><h5>你\u200b说：</h5><p>PRIVATE ${marker}</p><h5>ChatGPT\u200b 说：</h5><p>ANSWER</p><button title="复制"></button></section>${composer}`,
    raw: 'ANSWER',
    count: 1,
    source: '@speaker-range',
  },
  {
    name: 'unwrapped turns stop at copy control',
    body: `<section role="region"><h5>你说：</h5><p>PRIVATE USER CONTENT ${marker}</p><h5>ChatGPT 说：</h5><p>ANSWER</p><button aria-label="复制"></button><p>DISCLAIMER</p></section>${composer}`,
    raw: 'ANSWER',
    count: 1,
    source: '@speaker-range',
  },
  {
    name: 'display contents wrappers retain their reply',
    body: `<section role="region"><div style="display:contents"><h5>你说：</h5><p>PRIVATE USER CONTENT ${marker}</p></div><div style="display:contents"><h5>ChatGPT 说：</h5><p>ANSWER</p><button aria-label="复制"></button></div></section>${composer}`,
    raw: 'ANSWER',
    count: 1,
    source: '@speaker-heading',
  },
  {
    name: 'accessible speaker names work without heading text',
    body: `<section role="region"><h5 aria-label="你说："></h5><p>PRIVATE USER CONTENT ${marker}</p><h5 aria-label="ChatGPT 说："></h5><p>ANSWER</p><button title="复制"></button></section>${composer}`,
    raw: 'ANSWER',
    count: 1,
    source: '@speaker-range',
  },
  {
    name: 'later user content and fake code headings stay outside the response',
    body: `<section role="region"><h5>You said:</h5><p>PRIVATE ${marker}</p><h5>ChatGPT said:</h5><p>ANSWER</p><pre><code>safe code</code></pre><h5>You said:</h5><p>LATER PRIVATE CONTENT</p><pre><h5>ChatGPT said:</h5></pre></section>${composer}`,
    raw: 'ANSWER\nsafe code',
    count: 1,
    source: '@speaker-range',
  },
  {
    name: 'latest reply heading bounds an unwrapped answer before disclaimer',
    body: `<section role="region"><h5>你说：</h5><p>PRIVATE ${marker}</p><h5>ChatGPT 说：</h5><p>ANSWER</p><h2>最新一条回复</h2><p>DISCLAIMER</p></section>${composer}`,
    raw: 'ANSWER',
    count: 1,
    source: '@speaker-range',
  },
  {
    name: 'empty streaming reply does not count surrounding conversation',
    body: `<section role="region"><h5>你说：</h5><p>PRIVATE ${marker}</p><h5>ChatGPT 说：</h5><button title="复制"></button></section>${composer}`,
    raw: '',
    count: 0,
    source: null,
  },
  {
    name: 'a heading without a closing boundary is not sufficient',
    body: `<section role="region"><h5>你说：</h5><p>PRIVATE ${marker}</p><h5>ChatGPT 说：</h5><p>UNBOUNDED TEXT</p></section>`,
    raw: '',
    count: 0,
    source: null,
  },
];
for (const fixture of cases)
  test(`ChatGPT semantic regions: ${fixture.name}`, async () => {
    const browser = await chromium.launch({ channel: 'chromium', headless: true });
    try {
      const page = await browser.newPage();
      const profile = domProfiles.find((p) => p.id === 'chatgpt')!;
      await page.route('https://chatgpt.com/**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<meta charset="utf-8"><main>${fixture.body}</main>`,
        }),
      );
      await page.goto('https://chatgpt.com/');
      const result = await page.evaluate(pageOperation, {
        operation: 'observe' as const,
        profile,
        marker,
      });
      expect(result.markerFound).toBe(true);
      expect(result.outputCount).toBe(fixture.count);
      expect(result.raw).toBe(fixture.raw);
      expect(result.selectors?.assistant).toBe(fixture.source);
      expect(result.raw).not.toContain('PRIVATE');
      expect(result.raw).not.toContain('DISCLAIMER');
      const diagnostic = await page.evaluate(pageOperation, {
        operation: 'inspect' as const,
        profile,
      });
      expect(diagnostic.structure?.readerVersion).toBe('speaker-range-v2');
      expect(JSON.stringify(diagnostic.structure)).not.toContain('PRIVATE');
      expect(JSON.stringify(diagnostic.structure)).not.toContain('ANSWER');
    } finally {
      await browser.close();
    }
  });
