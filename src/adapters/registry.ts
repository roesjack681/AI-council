import type { PlatformAdapter } from './base/adapter.interface';
import { RestrictedAdapter } from './base/restricted-adapter';
import { CouncilError } from '../utils/errors';
import type { CouncilDB } from '../database/db';
import type { BrowserPort } from './base/adapter.interface';
import { BrowserDomAdapter } from './dom/browser-dom-adapter';
import { domProfiles } from './dom/profiles';
export const platformCatalog = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    url: 'https://chat.deepseek.com',
    origins: ['https://chat.deepseek.com'],
    policy: 'restricted',
    reason:
      '官方用户协议 3.5(3) 限制使用机器人、爬虫或其他自动设置抓取、复制服务内容；当前无本项目适用的明确授权机制。',
    sources: ['https://cdn.deepseek.com/policies/zh-CN/deepseek-terms-of-use.html'],
  },
  {
    id: 'doubao',
    name: '豆包',
    url: 'https://www.doubao.com/chat/',
    origins: ['https://www.doubao.com'],
    policy: 'restricted',
    reason:
      '官方协议第 6 节限制未经书面许可的内容读取、整理及对外展示等行为；未取得涵盖自动读取和转发的许可。',
    sources: ['https://www.doubao.com/legal/terms'],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    origins: ['https://chatgpt.com'],
    policy: 'restricted',
    reason: '官方使用条款限制自动或程序化提取输出；当前无本项目适用的网页自动化许可。',
    sources: ['https://openai.com/policies/terms-of-use/'],
  },
  {
    id: 'gemini',
    name: 'Gemini',
    url: 'https://gemini.google.com',
    origins: ['https://gemini.google.com'],
    policy: 'unverified',
    reason:
      '尚未验证允许本项目自动读取、提交及转发的网页机制；Google 条款要求遵守机器可读访问指令。待验证不等于已获授权。',
    sources: ['https://policies.google.com/terms?hl=en'],
  },
  {
    id: 'claude',
    name: 'Claude（可选）',
    url: 'https://claude.ai',
    origins: ['https://claude.ai'],
    policy: 'restricted',
    reason: '官方消费者条款 3.7 限制未经明确许可的自动或非人工访问；用户未配置 Claude 账号。',
    sources: ['https://www.anthropic.com/legal/consumer-terms'],
  },
] as const;
export class AdapterRegistry {
  private readonly adapters = new Map<string, PlatformAdapter>();
  constructor(
    adapters?: readonly PlatformAdapter[],
    context?: { db: CouncilDB; browser: BrowserPort },
  ) {
    const selected =
      adapters ??
      platformCatalog.map((p) => {
        const profile = domProfiles.find((item) => item.id === p.id);
        return context && profile
          ? new BrowserDomAdapter(context.db, context.browser, profile, p)
          : new RestrictedAdapter({ ...p, sources: [...p.sources] });
      });
    for (const adapter of selected) {
      if (this.adapters.has(adapter.id))
        throw new CouncilError('DUPLICATE_ADAPTER', '适配器 ID 重复');
      this.adapters.set(adapter.id, adapter);
    }
  }
  get(id: string): PlatformAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new CouncilError('UNSUPPORTED_ADAPTER', '未安装经过审核的适配器');
    return adapter;
  }
  find(id: string): PlatformAdapter | undefined {
    return this.adapters.get(id);
  }
  list(): PlatformAdapter[] {
    return [...this.adapters.values()];
  }
}
