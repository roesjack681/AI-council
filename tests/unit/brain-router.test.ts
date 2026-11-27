import { describe, it, expect } from 'vitest';
import {
  parseBrainRoute,
  resolveRouteTargets,
  buildBrainRoutePrompt,
  normalizeBrainRoute,
} from '../../src/core/brain-router';
import { discussionInputSchema, type Participant } from '../../src/protocols/domain';

const member = (partial: Partial<Participant> & Pick<Participant, 'id' | 'name'>): Participant => ({
  avatar: '🤖',
  platform: 'custom',
  websiteUrl: 'https://council.test',
  enabled: true,
  role: 'council',
  adapterId: 'custom',
  adapterVersion: 'test',
  capabilities: {
    canReadOutput: true,
    canSubmitMessage: true,
    canDetectCompletion: true,
    canDetectLogin: true,
    canCaptureUserQuestion: false,
    unattendedAllowed: true,
  },
  status: 'available',
  reason: '',
  createdAt: 1,
  updatedAt: 1,
  ...partial,
});

describe('brain-router', () => {
  it('does not choose arbitrarily among duplicate names or an ambiguous multi-name phrase', () => {
    const roster = [
      member({ id: 'a', name: '熊大' }),
      member({ id: 'b', name: '熊大' }),
      member({ id: 'c', name: '熊二' }),
    ];
    expect(resolveRouteTargets(['熊大'], roster).matched).toEqual([]);
    expect(resolveRouteTargets(['给熊大或熊二'], roster).matched).toEqual([]);
    expect(resolveRouteTargets(['a'], roster).matched.map((p) => p.id)).toEqual(['a']);
  });
  it('parses route JSON and strips fences', () => {
    const route = parseBrainRoute(`\`\`\`json
{"intent":"direct_ask","targets":["熊大"],"task":"查一下内存型号","brief":"点名单办：交给熊大去查。","reason":"用户点名熊大"}
\`\`\``);
    expect(route.intent).toBe('direct_ask');
    expect(route.targets).toEqual(['熊大']);
  });

  it('matches 熊大 by longest name first', () => {
    const roster = [
      member({ id: 'a', name: '熊大' }),
      member({ id: 'b', name: '熊大二' }),
      member({ id: 'brain', name: '路由', role: 'brain' }),
    ];
    expect(resolveRouteTargets(['熊大'], roster).matched.map((p) => p.id)).toEqual(['a']);
    expect(resolveRouteTargets(['熊大二'], roster).matched.map((p) => p.id)).toEqual(['b']);
    expect(resolveRouteTargets(['请熊大二去查'], roster).matched.map((p) => p.id)).toEqual(['b']);
    expect(resolveRouteTargets(['brain'], roster).matched).toEqual([]);
  });

  it('keeps brain out of route roster prompt', () => {
    const prompt = buildBrainRoutePrompt('你们在吗', [
      member({ id: 'a', name: '熊大' }),
      member({ id: 'b', name: '路由', role: 'brain' }),
    ]);
    expect(prompt).toContain('熊大');
    expect(prompt).not.toContain('id:b');
  });

  it('allows direct mode with a single participant', () => {
    const parsed = discussionInputSchema.parse({
      title: 't',
      originalQuestion: 'q',
      context: '',
      constraints: [],
      expectedOutput: '',
      mode: 'direct',
      participantIds: ['only-one'],
      maxRounds: 2,
      stableRoundsRequired: 1,
      timeoutMs: 1000,
      maxRetries: 1,
      privacyAcknowledged: true,
    });
    expect(parsed.mode).toBe('direct');
    expect(parsed.participantIds).toHaveLength(1);
  });

  it('rejects free mode with a single participant', () => {
    expect(() =>
      discussionInputSchema.parse({
        title: 't',
        originalQuestion: 'q',
        context: '',
        constraints: [],
        expectedOutput: '',
        mode: 'free',
        participantIds: ['only-one'],
        maxRounds: 10,
        stableRoundsRequired: 2,
        timeoutMs: 1000,
        maxRetries: 1,
        privacyAcknowledged: true,
      }),
    ).toThrow();
  });

  it('upgrades named check_ready to direct_ask so the member is notified', () => {
    const roster = [
      member({ id: 'b2', name: '熊二' }),
      member({ id: 'brain', name: '路由', role: 'brain' }),
    ];
    const normalized = normalizeBrainRoute(
      {
        intent: 'check_ready',
        targets: ['熊二'],
        task: '',
        brief: '正在确认熊二是否在线并准备好参与讨论。',
        reason: '用户点名熊二',
      },
      '熊二在吗',
      roster,
    );
    expect(normalized.intent).toBe('direct_ask');
    expect(normalized.targets).toEqual(['b2']);
    expect(normalized.task).toContain('熊二在吗');
  });

  it('keeps untargeted check_ready as local readiness', () => {
    const roster = [member({ id: 'b2', name: '熊二' })];
    const normalized = normalizeBrainRoute(
      {
        intent: 'check_ready',
        targets: [],
        task: '',
        brief: '先做全体就绪检查，不开启共识。',
        reason: '用户问你们在吗',
      },
      '你们在吗',
      roster,
    );
    expect(normalized.intent).toBe('check_ready');
  });

  it('infers named ping from the question when brain omits targets', () => {
    const roster = [member({ id: 'b2', name: '熊二' })];
    const normalized = normalizeBrainRoute(
      {
        intent: 'check_ready',
        targets: [],
        task: '',
        brief: '正在确认熊二是否在线并准备好参与讨论。',
        reason: '问候',
      },
      '熊二在吗',
      roster,
    );
    expect(normalized.intent).toBe('direct_ask');
    expect(normalized.targets).toEqual(['b2']);
  });

  it('documents named ping as direct_ask in the route prompt', () => {
    const prompt = buildBrainRoutePrompt('熊二在吗', [member({ id: 'b2', name: '熊二' })]);
    expect(prompt).toContain('熊二在吗');
    expect(prompt).toContain('必须 direct_ask');
  });
});
