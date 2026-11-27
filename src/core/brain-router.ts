import { brainRouteSchema, type BrainRoute, type Participant } from '../protocols/domain';
import { CouncilError } from '../utils/errors';

export function buildBrainRoutePrompt(question: string, roster: Participant[]): string {
  const members = roster
    .filter((p) => (p.role ?? 'council') !== 'brain' && p.enabled)
    .map((p) => `- id:${p.id}; name:${p.name}; platform:${p.platform}; status:${p.status}`)
    .join('\n');
  return `你是 AI Council 的路由大脑，不参与实质讨论，只负责理解用户意图并决定下一步。
只返回一个 JSON 对象，不要 Markdown 代码围栏，不要其他文字。字段：
intent: check_ready | direct_ask | council_discuss
targets: 字符串数组，填成员显示名或 id；check_ready/council_discuss 可为空数组表示全体讨论成员
task: 发给目标成员的精简任务文本（direct_ask/council_discuss 必填有意义内容；check_ready 可空）
brief: 8-120 字，给用户看的路由说明
reason: 为何这样路由

规则：
- 用户点名某个成员（含「熊二在吗」「熊大准备好了吗」「问问豆包在不在」）→ 必须 direct_ask，targets 含该成员名；task 要把用户原意转述给该成员（例如「用户在问你是否在线并准备好参与，请简短回应」）。不要用 check_ready 代替——check_ready 不会把话发给成员。
- 用户未点名、只对全体打招呼/问「你们在吗」「准备好了吗」→ check_ready（程序本地检查能力，不向成员发消息）。
- 用户点名某个成员做事（例如「熊大你去查…」）→ direct_ask，targets 含该成员名，task 为具体任务。
- 需要多人交叉核对、争论直到同意 → council_discuss。
- 禁止代替成员回答实质问题；禁止编造不存在的成员；大脑自己也不要回答「在不在」。

当前讨论成员名册：
${members || '（暂无讨论成员）'}

用户原话：
${question}`;
}

export function parseBrainRoute(raw: string): BrainRoute {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start)
      throw new CouncilError('BRAIN_PARSE_FAILED', '大脑回复不是 JSON');
    try {
      parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      throw new CouncilError('BRAIN_PARSE_FAILED', '大脑回复无法解析为 JSON');
    }
  }
  const result = brainRouteSchema.safeParse(parsed);
  if (!result.success) throw new CouncilError('BRAIN_ROUTE_INVALID', '大脑路由 JSON 字段不合规');
  return result.data;
}

/** Longest name first so「熊大二」不会误匹配「熊大」。 */
export function resolveRouteTargets(
  targets: string[],
  roster: Participant[],
): { matched: Participant[]; unresolved: string[] } {
  const council = roster.filter((p) => (p.role ?? 'council') !== 'brain' && p.enabled);
  const byId = new Map(council.map((p) => [p.id, p]));
  const byName = [...council].sort((a, b) => b.name.length - a.name.length);
  const matched: Participant[] = [];
  const seen = new Set<string>();
  const unresolved: string[] = [];
  for (const raw of targets) {
    const key = raw.trim();
    if (!key) continue;
    const idHit = byId.get(key);
    if (idHit) {
      if (!seen.has(idHit.id)) {
        seen.add(idHit.id);
        matched.push(idHit);
      }
      continue;
    }
    const sameName = council.filter((p) => p.name === key);
    if (sameName.length > 1) {
      unresolved.push(key);
      continue;
    }
    const exactName = sameName[0];
    if (exactName) {
      if (!seen.has(exactName.id)) {
        seen.add(exactName.id);
        matched.push(exactName);
      }
      continue;
    }
    // Phrase targets: longest display name first so「熊大二」wins over「熊大」。
    const hits = byName.filter((p) => key.includes(p.name));
    const longest = hits[0];
    const ambiguous =
      longest &&
      hits.some(
        (p) => p.id !== longest.id && (p.name === longest.name || !longest.name.includes(p.name)),
      );
    const nameHit = ambiguous ? undefined : longest;
    if (nameHit) {
      if (!seen.has(nameHit.id)) {
        seen.add(nameHit.id);
        matched.push(nameHit);
      }
      continue;
    }
    unresolved.push(key);
  }
  return { matched, unresolved };
}

export function repairBrainPrompt(previous: string, raw: string): string {
  return `${previous}

上一条回复无法解析为路由 JSON。请只输出合规 JSON，保持原意图，不要回答用户问题本身。
原始回复：
${raw}`;
}

/** Names mentioned in the user question; longest match first so「熊大二」wins over「熊大」。 */
export function namesMentionedInQuestion(question: string, roster: Participant[]): string[] {
  const council = roster.filter((p) => (p.role ?? 'council') !== 'brain' && p.enabled);
  let rest = question;
  const found: string[] = [];
  for (const p of [...council].sort((a, b) => b.name.length - a.name.length)) {
    if (!p.name || !rest.includes(p.name)) continue;
    found.push(p.name);
    rest = rest.split(p.name).join('\0');
  }
  return found;
}

/**
 * Named “在吗 / 准备好了吗” must reach the member. Local check_ready never delivers a message.
 * If the brain still returns check_ready with concrete targets (or the question names a member),
 * upgrade to direct_ask.
 */
export function normalizeBrainRoute(
  route: BrainRoute,
  question: string,
  roster: Participant[],
): BrainRoute {
  if (route.intent !== 'check_ready') return route;
  let { matched } = resolveRouteTargets(route.targets, roster);
  const personalPing = /在吗|在不在|在线吗|准备好了吗|准备好了没|就绪吗|你好吗/.test(question);
  if (!matched.length && personalPing) {
    matched = resolveRouteTargets(namesMentionedInQuestion(question, roster), roster).matched;
  }
  if (!matched.length) return route;
  const names = matched.map((p) => p.name).join('、');
  const task =
    route.task.trim() ||
    `用户在确认你是否在线并准备好参与讨论。原话：「${question.trim()}」。请简短回应是否就绪，不要展开无关话题。`;
  const brief =
    route.brief.includes('转给') || route.brief.includes('点名')
      ? route.brief
      : `点名确认：已转给${names}，请本人回应是否在线。`;
  return {
    intent: 'direct_ask',
    targets: matched.map((p) => p.id),
    task,
    brief: brief.slice(0, 120),
    reason: `${route.reason}；点名就绪改由成员本人回复，不用本地检查代替。`.slice(0, 2000),
  };
}
