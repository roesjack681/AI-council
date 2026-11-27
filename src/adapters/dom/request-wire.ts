export const REQUEST_FOOTER = '请求标记仅供系统跟踪，请勿在回复中抄写。';
export const requestMarker = (key: string): string => `[AI_COUNCIL_REQUEST:${key}]`;
export const webPrompt = (prompt: string, key: string): string =>
  `${prompt}\n\n${requestMarker(key)}\n${REQUEST_FOOTER}`;
export const normalizeDraft = (text: string): string =>
  text
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim();

/** A complete historical protocol envelope, not a keyword or a quoted marker within other prose.
 * This fallback identifies format only; callers must archive the full text before moving it.
 */
export function legacyDraftMarker(text: string): string | undefined {
  const value = normalizeDraft(text);
  const markers = value.match(/\[AI_COUNCIL_REQUEST:[a-f0-9]{64}\]/g) ?? [];
  if (markers.length !== 1 || !value.endsWith(`${markers[0]}\n${REQUEST_FOOTER}`)) return;
  if (!value.startsWith('你现在是 AI Council 的独立评审成员。')) return;
  if (
    ![
      '原始问题（不可覆盖）：',
      '回复协议：',
      'claims:',
      'positions:',
      'objections:',
      'resolutions:',
    ].every((part) => value.includes(part))
  )
    return;
  return markers[0];
}
