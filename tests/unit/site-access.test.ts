import { afterEach, expect, it, vi } from 'vitest';
import { requestModelSiteAccess } from '../../src/services/site-access';
afterEach(() => vi.unstubAllGlobals());
it('requests supported website origins once from the initiating user action and returns denial honestly', async () => {
  const request = vi.fn(async () => false);
  vi.stubGlobal('chrome', { runtime: { id: 'test' }, permissions: { request } });
  expect(
    await requestModelSiteAccess([
      { platform: 'deepseek', websiteUrl: 'https://chat.deepseek.com/' },
      { platform: 'deepseek', websiteUrl: 'https://chat.deepseek.com/old' },
      { platform: 'custom', websiteUrl: 'https://elsewhere.test/' },
      { platform: 'chatgpt', websiteUrl: 'https://unexpected.test/' },
    ]),
  ).toBe(false);
  expect(request).toHaveBeenCalledExactlyOnceWith({ origins: ['https://chat.deepseek.com/*'] });
});
