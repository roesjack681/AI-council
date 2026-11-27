import { describe, expect, it } from 'vitest';
import { selectHistory } from '../../src/core/history-window';
import { generatePrompt } from '../../src/core/prompt-generator';
import type { PublicContext } from '../../src/core/context-manager';
import {
  responseSchema,
  type Discussion,
  type DiscussionMessage,
} from '../../src/protocols/domain';
import { envelope } from '../fixtures/council';

const task: Discussion = {
  id: 'd',
  title: 'TEST',
  originalQuestion: 'LOCKED QUESTION',
  context: 'LOCKED CONTEXT',
  constraints: ['LOCKED CONSTRAINT'],
  expectedOutput: '',
  mode: 'free',
  participantIds: ['a', 'b'],
  maxRounds: 10,
  stableRoundsRequired: 2,
  timeoutMs: 1000,
  maxRetries: 2,
  privacyAcknowledged: true,
  currentRound: 1,
  noProgressRounds: 0,
  lastProgressFingerprint: '',
  status: 'FREE_DISCUSSION',
  createdAt: 1,
  updatedAt: 1,
};
const message = (n: number, content: string): DiscussionMessage => ({
  id: `m${n}`,
  dedupeKey: `in:${n}`,
  discussionId: 'd',
  roundId: 'r',
  participantId: n % 2 ? 'a' : 'b',
  direction: 'inbound',
  type: 'REVIEW',
  content,
  parseStatus: 'valid',
  relatedClaimIds: [],
  relatedObjectionIds: [],
  status: 'received',
  createdAt: n,
});
const context = (): PublicContext => ({
  task,
  claims: [
    {
      id: 'd:a:current',
      key: 'current',
      ownerId: 'a',
      discussionId: 'd',
      description: 'CURRENT CLAIM',
      category: 'recommendation',
      critical: true,
      version: 3,
      status: 'active',
      sourceMessageId: 'm1',
      createdAt: 1,
      updatedAt: 2,
    },
  ],
  positions: [],
  objections: [],
  facts: [],
  messages: Array.from({ length: 80 }, (_, n) =>
    message(n, `TEST MESSAGE ${n} ` + 'body'.repeat(1500)),
  ),
  summary: 'SUMMARY'.repeat(10_000),
});

describe('bounded prompts and protocol compatibility', () => {
  it('direct messages contain only this question even when old routing context and protocol history exist', () => {
    const direct = {
      ...task,
      mode: 'direct' as const,
      originalQuestion: '光头强在吗',
      context: '旧问题：1+1等于几',
    };
    expect(generatePrompt(direct, 'initial', context(), 'OLD EVENT')).toBe('光头强在吗');
    expect(() => generatePrompt(direct, 'initial', undefined, '', { maxChars: 1 })).toThrow(
      '本次问题超过发送上限',
    );
  });
  it('keeps current task, recipient and entities while bounding the history without changing stored inputs', () => {
    const input = context();
    const before = structuredClone(input);
    const prompt = generatePrompt(task, 'review', input, 'TEST EVENT', {
      participantId: 'b',
      maxChars: 8000,
      historyChars: 2500,
    });
    expect(prompt.length).toBeLessThanOrEqual(8000);
    for (const text of [
      'LOCKED QUESTION',
      'LOCKED CONTEXT',
      'LOCKED CONSTRAINT',
      'd:a:current',
      'CURRENT CLAIM',
      '你的参与者 ID：b',
      '历史窗口',
      'TEST MESSAGE 79',
    ])
      expect(prompt).toContain(text);
    expect(input).toEqual(before);
  });
  it('uses explicit excerpts and obeys JSON-escaped size limits', () => {
    const input = [message(1, 'old'), message(2, '"\\\n'.repeat(10000))];
    const window = selectHistory(input, 700);
    expect(JSON.stringify(window.messages).length).toBeLessThanOrEqual(700);
    expect(window.messages.find((item) => item.id === 'm2')?.excerpt).toBe(true);
    expect(input[1]!.content.length).toBe(30000);
  });
  it('refuses to truncate mandatory original questions or current entities', () => {
    expect(() =>
      generatePrompt({ ...task, originalQuestion: 'x'.repeat(5000) }, 'review', context(), '', {
        maxChars: 3000,
      }),
    ).toThrow('必需内容超过发送上限');
  });
  it('repairs with exact current claim IDs, versions, and participant identity', () => {
    const prompt = generatePrompt(task, 'repair', context(), 'INVALID ORIGINAL REPLY', {
      participantId: 'a',
    });
    expect(prompt).toContain('d:a:current');
    expect(prompt).toContain('"version":3');
    expect(prompt).toContain('你的参与者 ID：a');
    expect(prompt).toContain('INVALID ORIGINAL REPLY');
  });
  it('accepts legacy valid replies without a UI brief instead of forcing another model turn', () => {
    const legacy = { ...envelope(), brief: undefined };
    expect(responseSchema.safeParse(legacy).success).toBe(true);
  });
});
