import type { BrowserPort } from '../adapters/base/adapter.interface';
import { pageOperation } from '../adapters/dom/page-operation';
import { CouncilError } from '../utils/errors';
export const browserPort: BrowserPort = {
  async tabs() {
    return (await chrome.tabs.query({})).flatMap((tab) =>
      tab.id !== undefined && (tab.pendingUrl ?? tab.url)
        ? [{ id: tab.id, url: (tab.pendingUrl ?? tab.url)!, status: tab.status }]
        : [],
    );
  },
  async open(url) {
    await chrome.tabs.create({ url });
  },
  async create(url) {
    const origin = new URL(url).origin;
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] })))
      throw new CouncilError('SITE_PERMISSION_REQUIRED', '首次运行需要允许该模型网站访问权限');
    const tab = await chrome.tabs.create({ url, active: false });
    if (tab.id === undefined) throw new CouncilError('TAB_CREATE_FAILED', '无法创建讨论标签页');
    return { id: tab.id, url: tab.url ?? url, status: tab.status };
  },
  async page(tabId, request) {
    const tab = await chrome.tabs.get(tabId);
    const origin = new URL(tab.url ?? 'about:blank').origin;
    if (
      !request.profile.origins.includes(origin) &&
      tab.pendingUrl &&
      request.profile.origins.includes(new URL(tab.pendingUrl).origin)
    )
      throw new CouncilError('PAGE_LOADING', '讨论网页正在加载', true, true);
    if (!request.profile.origins.includes(origin))
      throw new CouncilError('ORIGIN_MISMATCH', '网页地址与适配器不一致');
    if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] })))
      throw new CouncilError('SITE_PERMISSION_REQUIRED', '需要授予该网站访问权限');
    const needsActiveTab =
      request.activate === true ||
      request.operation === 'submit' ||
      request.operation === 'clear_draft' ||
      request.operation === 'restore_draft' ||
      request.operation === 'new_conversation' ||
      request.operation === 'observe';
    const previous = needsActiveTab
      ? (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id
      : undefined;
    if (needsActiveTab) await chrome.tabs.update(tabId, { active: true });
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'ISOLATED',
        func: pageOperation,
        args: [request],
      });
      const result = results[0]?.result;
      if (!result) throw new CouncilError('PAGE_PROBE_FAILED', '网页检查没有返回结果');
      return result;
    } finally {
      // SPA new-chat and response rendering may be deferred in background tabs. Keep them visible;
      // restoring immediately can strand the reset while the durable queue waits for an empty page.
      if (request.operation === 'submit' && previous !== undefined && previous !== tabId) {
        const active = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0]?.id;
        if (active === tabId)
          await chrome.tabs
            .update(previous, { active: true })
            .catch(() => console.warn('AI Council: TAB_RESTORE_FAILED'));
      }
    }
  },
};
