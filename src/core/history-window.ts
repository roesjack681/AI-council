import type { DiscussionMessage } from '../protocols/domain';

export interface HistoryWindow {
  messages: Array<{
    id: string;
    participantId: string;
    content: string;
    excerpt?: true;
    originalLength?: number;
  }>;
  omittedCount: number;
}
/** Deterministic transport window only. Original messages in IndexedDB are never changed. */
export function selectHistory(messages: DiscussionMessage[], maxChars: number): HistoryWindow {
  const selected: HistoryWindow['messages'] = [];
  const budget = Math.max(2, Math.floor(maxChars));
  for (const message of [...messages].reverse()) {
    const item = { id: message.id, participantId: message.participantId, content: message.content };
    if (JSON.stringify([item, ...selected]).length <= budget) {
      selected.unshift(item);
      continue;
    }
    // Keep an explicitly marked excerpt of an oversized newest reply rather than filling the
    // context with older small replies and silently losing the most recent participant.
    if (selected.length === 0) {
      const excerpt = { ...item, excerpt: true as const, originalLength: message.content.length };
      let low = 0,
        high = Math.min(message.content.length, budget),
        fit = 0;
      while (low <= high) {
        const length = Math.floor((low + high) / 2);
        excerpt.content = message.content.slice(0, length);
        if (JSON.stringify([excerpt]).length <= budget) {
          fit = length;
          low = length + 1;
        } else high = length - 1;
      }
      if (fit > 0) selected.push({ ...excerpt, content: message.content.slice(0, fit) });
    }
  }
  return { messages: selected, omittedCount: messages.length - selected.length };
}
