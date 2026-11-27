import { webPrompt } from '../../src/adapters/dom/request-wire';

// Historical request fixture only. Never shipped or treated as a model answer.
export const oldRequestKey = '171bd510abb578c73294f0799241108645fafc8b35328833a37de44aa00d88c9';
export const legacyDraft = webPrompt(
  `你现在是 AI Council 的独立评审成员。禁止为了达成一致而无条件认可其他模型；明确区分事实、推测、假设、计算和建议。
原始问题（不可覆盖）：你俩说说1+1等于几
回复协议：返回一个 JSON 对象，不得代替其他成员表态。字段：
claims: []
positions: []
objections: []
resolutions: []`,
  oldRequestKey,
);
