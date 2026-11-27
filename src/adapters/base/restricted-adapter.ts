import type {
  PlatformAdapter,
  BrowserPort,
  Receipt,
  PollResult,
  Reconciliation,
} from './adapter.interface';
import type { Participant, CapabilityCheck } from '../../protocols/domain';
import { noCapabilities } from './capability';
import { CouncilError } from '../../utils/errors';
export interface Policy {
  id: string;
  origins: readonly string[];
  policy: 'restricted' | 'unverified';
  reason: string;
  sources: string[];
}
export class RestrictedAdapter implements PlatformAdapter {
  readonly version = '1.0.0';
  readonly id: string;
  readonly origins: readonly string[];
  constructor(private readonly policy: Policy) {
    this.id = policy.id;
    this.origins = policy.origins;
  }
  async inspect(participant: Participant, browser: BrowserPort): Promise<CapabilityCheck> {
    const origin = new URL(participant.websiteUrl).origin;
    const tabs = (await browser.tabs()).filter((t) => {
      try {
        return new URL(t.url).origin === origin;
      } catch {
        return false;
      }
    });
    return {
      checkedAt: Date.now(),
      adapterVersion: this.version,
      tabIds: tabs.map((t) => t.id),
      pageOpen: tabs.length > 0,
      pageReachable: 'unknown',
      login: 'unknown',
      policy: this.policy.policy,
      technicalVerified: false,
      capabilities: noCapabilities(),
      reasons: [
        this.policy.reason,
        ...(tabs.length
          ? ['已找到网页标签；未读取页面内容，不能据此确认登录、网络可用或回答完成。']
          : ['未找到对应网页标签。']),
      ],
      sources: this.policy.sources,
    };
  }
  async submit(): Promise<Receipt> {
    throw new CouncilError('AUTOMATION_BLOCKED', this.policy.reason);
  }
  async reconcile(): Promise<Reconciliation> {
    throw new CouncilError('AUTOMATION_BLOCKED', this.policy.reason);
  }
  async poll(): Promise<PollResult> {
    throw new CouncilError('AUTOMATION_BLOCKED', this.policy.reason);
  }
}
