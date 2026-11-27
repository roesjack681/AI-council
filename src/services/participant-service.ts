import type { CouncilDB } from '../database/db';
import {
  participantInputSchema,
  participantProfileSchema,
  type Participant,
  type Platform,
} from '../protocols/domain';
import { AdapterRegistry } from '../adapters/registry';
import type { BrowserPort } from '../adapters/base/adapter.interface';
import { noCapabilities } from '../adapters/base/capability';
import { newId } from '../utils/id';
import { CouncilError, requireValue } from '../utils/errors';
import { log } from '../utils/logger';
import { terminal } from '../core/task-manager';

const defaultAvatars: Record<Platform, string> = {
  deepseek: '🌊',
  doubao: '🌱',
  chatgpt: '💬',
  gemini: '✨',
  claude: '🟠',
  custom: '🤖',
};

export class ParticipantService {
  constructor(
    private readonly db: CouncilDB,
    private readonly registry: AdapterRegistry,
    private readonly browser: BrowserPort,
  ) {}
  async add(input: unknown): Promise<Participant> {
    const data = participantInputSchema.parse(input);
    const url = new URL(data.websiteUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
      throw new CouncilError('INVALID_URL', '网址必须是无账号、查询参数和片段的 HTTPS 网页地址');
    const adapter = this.registry.find(data.platform);
    if (data.platform !== 'custom' && !adapter?.origins.includes(url.origin))
      throw new CouncilError('ORIGIN_MISMATCH', '网址与所选平台不一致');
    const now = Date.now();
    const p: Participant = {
      ...data,
      role: data.role ?? 'council',
      avatar: data.avatar || defaultAvatars[data.platform] || '🤖',
      websiteUrl: url.href,
      id: newId(),
      adapterId: adapter?.id ?? 'custom',
      adapterVersion: adapter?.version ?? 'none',
      status: 'unsupported',
      reason: '发送问题时会自动打开、检查并准备模型网页。',
      capabilities: noCapabilities(),
      createdAt: now,
      updatedAt: now,
    };
    await this.db.transaction(
      'rw',
      [this.db.participants, this.db.logs, this.db.brain_requests],
      async () => {
        if (p.role === 'brain') {
          for (const other of await this.db.participants.toArray()) {
            if ((other.role ?? 'council') === 'brain') {
              if (
                (
                  await this.db.brain_requests.where('participantId').equals(other.id).toArray()
                ).some((job) => !['done', 'cancelled'].includes(job.phase))
              )
                throw new CouncilError(
                  'PARTICIPANT_IN_USE',
                  '现有大脑仍有路由请求，完成或取消后才能切换',
                );
              await this.db.participants.update(other.id, { role: 'council', updatedAt: now });
            }
          }
        }
        await this.db.participants.add(p);
        await log(this.db, 'info', 'PARTICIPANT_ADDED', p.id);
      },
    );
    return p;
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    requireValue(await this.db.participants.get(id), '参与者不存在');
    await this.db.participants.update(id, { enabled, updatedAt: Date.now() });
    await log(this.db, 'info', 'PARTICIPANT_ENABLED', `${id}: ${enabled}`);
  }
  async updateProfile(id: string, input: unknown): Promise<Participant> {
    const patch = participantProfileSchema.parse(input);
    const current = requireValue(await this.db.participants.get(id), '参与者不存在');
    const now = Date.now();
    const next: Participant = {
      ...current,
      role: current.role ?? 'council',
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
      ...(patch.role !== undefined ? { role: patch.role } : {}),
      updatedAt: now,
    };
    await this.db.transaction(
      'rw',
      [this.db.participants, this.db.logs, this.db.discussions, this.db.brain_requests],
      async () => {
        if (next.role === 'brain') {
          if (
            (await this.db.discussions.toArray()).some(
              (d) => d.participantIds.includes(id) && !terminal(d.status),
            )
          )
            throw new CouncilError(
              'PARTICIPANT_IN_USE',
              '当前讨论仍在使用该成员，结束任务后才能改为大脑',
            );
          for (const other of await this.db.participants.toArray()) {
            if (other.id !== id && (other.role ?? 'council') === 'brain') {
              if (
                (
                  await this.db.brain_requests.where('participantId').equals(other.id).toArray()
                ).some((job) => !['done', 'cancelled'].includes(job.phase))
              )
                throw new CouncilError(
                  'PARTICIPANT_IN_USE',
                  '现有大脑仍有路由请求，完成或取消后才能切换',
                );
              await this.db.participants.update(other.id, { role: 'council', updatedAt: now });
            }
          }
        }
        if (
          current.role === 'brain' &&
          next.role !== 'brain' &&
          (await this.db.brain_requests.where('participantId').equals(id).toArray()).some(
            (job) => !['done', 'cancelled'].includes(job.phase),
          )
        )
          throw new CouncilError('PARTICIPANT_IN_USE', '请先完成或取消该大脑的路由请求');
        await this.db.participants.put(next);
        await log(this.db, 'info', 'PARTICIPANT_PROFILE_UPDATED', id);
      },
    );
    return next;
  }
  async remove(id: string): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.discussions, this.db.participants, this.db.logs, this.db.brain_requests],
      async () => {
        const referenced = (await this.db.discussions.toArray()).some(
          (d) => d.participantIds.includes(id) && !terminal(d.status),
        );
        if (referenced)
          throw new CouncilError(
            'PARTICIPANT_IN_USE',
            '参与者被未结束的任务引用，请先终止或删除相关任务',
          );
        if (
          (await this.db.brain_requests.where('participantId').equals(id).toArray()).some(
            (job) => !['done', 'cancelled'].includes(job.phase),
          )
        )
          throw new CouncilError(
            'PARTICIPANT_IN_USE',
            '该成员仍有大脑路由请求，请先完成或取消路由',
          );
        await this.db.participants.delete(id);
        await log(this.db, 'info', 'PARTICIPANT_REMOVED', id);
      },
    );
  }
  async open(id: string): Promise<void> {
    const p = requireValue(await this.db.participants.get(id), '参与者不存在');
    await this.browser.open(p.websiteUrl);
    await log(this.db, 'info', 'PARTICIPANT_PAGE_OPENED', id);
  }
}
