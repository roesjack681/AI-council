import type { PageRequest, PageObservation } from './page-protocol';

/** Self-contained function serialized by Chrome scripting into the isolated world.
 * Reads rendered conversation DOM only; no cookies, storage, app state or network.
 */
export async function pageOperation(request: PageRequest): Promise<PageObservation> {
  const { profile } = request;
  const visible = (el: Element): el is HTMLElement =>
    el instanceof HTMLElement &&
    el.getClientRects().length > 0 &&
    getComputedStyle(el).display !== 'none' &&
    getComputedStyle(el).visibility !== 'hidden';
  const rendered = (el: Element): el is HTMLElement =>
    visible(el) ||
    (el instanceof HTMLElement &&
      getComputedStyle(el).display === 'contents' &&
      Array.from(el.querySelectorAll('*')).some(visible));
  const list = (selectors: string[]): HTMLElement[] => {
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector)).filter(rendered);
      if (found.length) return found;
    }
    return [];
  };
  const first = (selectors: string[]) => list(selectors)[0];
  const matchedSelector = (selectors: string[]) =>
    selectors.find((selector) => Array.from(document.querySelectorAll(selector)).some(rendered)) ??
    null;
  const enabled = (el: HTMLElement | undefined) =>
    Boolean(el && !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true');
  const text = (el: HTMLElement) => el.innerText?.trim() ?? el.textContent?.trim() ?? '';
  const label = (el: HTMLElement) =>
    [
      el.getAttribute('aria-label'),
      el.getAttribute('title'),
      el
        .getAttribute('aria-labelledby')
        ?.split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
      text(el),
      el.textContent,
    ]
      .find((value) => Boolean(value?.trim()))
      ?.trim() ?? '';
  const speaker = (el: Element) => {
    const name = (el instanceof HTMLElement ? label(el) : (el.textContent ?? '')).replace(
      /[\s\u200b-\u200d\u2060\ufeff]+/g,
      '',
    );
    return /^(?:ChatGPT说|ChatGPTsaid|Assistant)[:：]?$/i.test(name)
      ? 'assistant'
      : /^(?:你说|您说|Yousaid|User)[:：]?$/i.test(name)
        ? 'user'
        : undefined;
  };
  const contentText = (element: HTMLElement | DocumentFragment): string => {
    const clone = element.cloneNode(true) as HTMLElement | DocumentFragment;
    clone
      .querySelectorAll('button,[role="button"],script,style,nav,[hidden],[aria-hidden="true"]')
      .forEach((el) => el.remove());
    clone.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]').forEach((el) => {
      if (speaker(el)) el.remove();
    });
    const parts: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent ?? '');
        return;
      }
      for (const child of node.childNodes) walk(child);
      if (node instanceof Element && /^(?:P|DIV|PRE|LI|SECTION|BR|H[1-6])$/.test(node.tagName))
        parts.push('\n');
    };
    walk(clone);
    return parts.join('').trim();
  };
  const semanticTurns = (kind: 'assistant' | 'user'): HTMLElement[] => {
    if (profile.id !== 'chatgpt') return [];
    const headings = headingElements();
    const regions: HTMLElement[] = [];
    for (const heading of headings.filter((el) => speaker(el) === kind)) {
      let parent = heading.parentElement;
      for (let depth = 0; parent && depth < 7; depth++, parent = parent.parentElement) {
        if (parent === document.body || parent.matches('main,[role="main"],[role="region"]')) break;
        const knownRole =
          parent.getAttribute('data-turn') ?? parent.getAttribute('data-message-author-role');
        if (knownRole && knownRole !== kind) break;
        const labels = Array.from(
          parent.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'),
        ).filter((el) => speaker(el));
        if (labels.length !== 1) break;
        if (rendered(parent) && contentText(parent)) {
          regions.push(parent);
          break;
        }
      }
    }
    return [...new Set(regions)];
  };
  const editor = () => first(profile.editors);
  type OutputRegion = {
    node: HTMLElement;
    source: string;
    read: () => string;
    contains: (node: Node) => boolean;
    end?: Node;
  };
  const headingElements = () =>
    Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement &&
        !el.closest('nav,aside,pre,code') &&
        getComputedStyle(el).display !== 'none' &&
        getComputedStyle(el).visibility !== 'hidden',
    );
  const footerElements = () => {
    const found: HTMLElement[] = [];
    for (const action of Array.from(document.querySelectorAll('button,[role="button"]')).filter(
      visible,
    )) {
      if (
        !/^(复制|复制回复|朗读|Copy|Copy response|Read aloud)$/i.test(label(action)) ||
        action.closest('pre,code')
      )
        continue;
      found.push(action);
      let parent = action.parentElement;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        if (
          parent.matches('main,[role="main"],[role="region"]') ||
          Array.from(parent.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).some((el) =>
            speaker(el),
          )
        )
          break;
        const actions = Array.from(parent.querySelectorAll('button,[role="button"]')).filter(
          visible,
        );
        const related = actions.some((button) =>
          /^(朗读|反馈|更多操作|重新生成|重试|Read aloud|Feedback|Regenerate|More actions)$/i.test(
            label(button),
          ),
        );
        if (actions.length >= 2 && related && !contentText(parent)) {
          found.push(parent);
          break;
        }
      }
    }
    return [...new Set(found)];
  };
  const boundedSpeakerRegions = (): OutputRegion[] => {
    if (profile.id !== 'chatgpt') return [];
    const headings = headingElements();
    const speakers = headings.filter((el) => speaker(el));
    const input = editor();
    const footer = footerElements();
    const boundaryHeadings = headings.filter((el) =>
      /^(?:最新一条回复|最新回复|Latest response|Latest reply)$/i.test(label(el)),
    );
    const regions: OutputRegion[] = [];
    for (const heading of speakers.filter((el) => speaker(el) === 'assistant')) {
      const boundaries: Node[] = [
        ...speakers,
        ...boundaryHeadings,
        ...footer,
        ...(input ? [input] : []),
      ].filter(
        (node) =>
          node !== heading &&
          Boolean(heading.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING),
      );
      boundaries.sort((a, b) =>
        a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
      );
      const end = boundaries[0];
      if (!end) continue;
      const range = document.createRange();
      range.setStartAfter(heading);
      range.setEndBefore(end);
      const read = () => contentText(range.cloneContents());
      if (!read()) continue;
      regions.push({
        node: heading,
        source: '@speaker-range',
        end,
        read,
        contains: (node) => {
          try {
            return range.comparePoint(node, 0) === 0;
          } catch {
            return false;
          }
        },
      });
    }
    return regions;
  };
  const outputRegions = (): OutputRegion[] => {
    const selector = matchedSelector(profile.assistants);
    const selected = list(profile.assistants);
    if (selected.length)
      return selected.map((node) => ({
        node,
        source: selector!,
        read: () => contentText(node),
        contains: (child) => node.contains(child),
      }));
    const turns = semanticTurns('assistant');
    if (turns.length)
      return turns.map((node) => ({
        node,
        source: '@speaker-heading',
        read: () => contentText(node),
        contains: (child) => node.contains(child),
      }));
    return boundedSpeakerRegions();
  };
  const value = (el: HTMLElement | undefined): string => {
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
    if (!el) return '';
    const blocks = Array.from(el.children);
    // ProseMirror empty lines are <p><br></p>; innerText adds paragraph spacing and
    // textContent loses block boundaries. Read one logical line per top-level block.
    if (
      blocks.length &&
      blocks.every((block) => block instanceof HTMLElement && block.matches('p,div')) &&
      Array.from(el.childNodes).every(
        (node) => node instanceof Element || !(node.textContent ?? '').trim(),
      )
    )
      return blocks.map((block) => (block as HTMLElement).innerText.replace(/\n$/, '')).join('\n');
    return el.innerText ?? '';
  };
  const normalizedInput = (s: string) =>
    s
      .replace(/\u00a0/g, ' ')
      .replace(/\r\n?/g, '\n')
      .trim();
  const matchesPrompt = (el: HTMLElement | undefined) =>
    Boolean(
      el &&
      request.prompt &&
      request.marker &&
      request.prompt.includes(request.marker) &&
      (normalizedInput(value(el)) === normalizedInput(request.prompt) ||
        (el.isContentEditable &&
          normalizedInput(el.textContent ?? '') === normalizedInput(request.prompt))),
    );
  const markerNode = (outputs: OutputRegion[]): HTMLElement | undefined => {
    if (!request.marker) return undefined;
    const input = editor();
    const normalizeMarker = (value: string) => value.replace(/[\s\u200b-\u200d\u2060\ufeff]+/g, '');
    const marker = normalizeMarker(request.marker);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const fragment = normalizeMarker(node.textContent ?? '');
      if (
        !fragment ||
        (!fragment.includes(marker) &&
          !fragment.includes('AI_COUNCIL_REQUEST') &&
          !(fragment.length >= 3 && marker.includes(fragment)))
      )
        continue;
      let parent = node.parentElement;
      if (
        !parent ||
        !visible(parent) ||
        parent.closest('script,style,nav,aside') ||
        input?.contains(parent)
      )
        continue;
      if (profile.assistants.some((selector) => parent!.closest(selector))) continue;
      if (outputs.some((output) => output.contains(node!))) continue;
      for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
        if (
          parent === document.body ||
          parent.matches('main,[role="main"],[role="region"]') ||
          input?.contains(parent) ||
          parent.contains(input ?? null)
        )
          break;
        if (
          profile.assistants.some((selector) => parent!.closest(selector)) ||
          outputs.some((output) => parent!.contains(output.node))
        )
          break;
        if (rendered(parent) && normalizeMarker(text(parent)).includes(marker)) return parent;
      }
    }
    return undefined;
  };
  const observe = (dispatched = false): PageObservation => {
    const input = editor();
    const outputs = outputRegions();
    const anchor = markerNode(outputs);
    const candidates = anchor
      ? outputs.filter((el) =>
          Boolean(anchor.compareDocumentPosition(el.node) & Node.DOCUMENT_POSITION_FOLLOWING),
        )
      : [];
    const output = candidates.at(-1);
    const stops = list(profile.stopButtons);
    const stopByLabel = Array.from(document.querySelectorAll('button,[role="button"]'))
      .filter(visible)
      .some((el) =>
        /^(停止|停止生成|停止回答|停止回复|停止流式传输|Stop|Stop generating|Stop response)$/i.test(
          label(el).trim(),
        ),
      );
    const actions = [
      ...new Set([
        ...list(profile.completionButtons),
        ...Array.from(document.querySelectorAll('button,[role="button"]'))
          .filter(visible)
          .filter((el) =>
            /^(复制|复制回复|朗读|Copy|Copy response|Read aloud)$/i.test(label(el).trim()),
          ),
      ]),
    ].filter((el) => !el.closest('pre,code'));
    const completed = output
      ? actions.some((el) =>
          Boolean(output.node.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING),
        )
      : actions.length > 0;
    const pageText = (document.body.innerText ?? '').slice(-30_000);
    // Match blocking UI phrases, never infer a CAPTCHA from an ordinary model discussion of it.
    const challenge =
      Boolean(
        document.querySelector(
          'iframe[src*="challenges.cloudflare.com"],iframe[src*="captcha"],#challenge-running',
        ),
      ) ||
      Array.from(document.querySelectorAll('[role="dialog"],h1,h2'))
        .filter(visible)
        .some((el) =>
          /验证您是人类|验证你是人类|Verify you are human|安全验证|访问过于频繁/.test(text(el)),
        );
    const loginVisible =
      list(profile.loginButtons).length > 0 ||
      Array.from(document.querySelectorAll('button,a'))
        .filter(visible)
        .some((el) => /^(登录|登录 \/ 注册|登录或注册|Log in|Sign in)$/.test(text(el)));
    const loggedOut =
      loginVisible ||
      (!input && /登录后.*(?:使用|提问)|Sign in to (?:continue|chat)/.test(pageText));
    const userCount =
      list(profile.users).length ||
      semanticTurns('user').length ||
      (profile.id === 'chatgpt'
        ? headingElements().filter((el) => speaker(el) === 'user').length
        : 0);
    // Only positively observed home layouts qualify. Zero matches alone never prove emptiness,
    // except ChatGPT `/` when no transcript nodes exist (conversations live under `/c/...`).
    const deepseekWelcomeText = (value: string): boolean => {
      const s = value.trim();
      if (!s || s.length > 80) return false;
      return (
        /^(?:早上好|上午好|中午好|下午好|晚上好)[，,]\s*开始聊天吧[！!。.]?$/.test(s) ||
        /^开始聊天吧[！!。.]?$/.test(s) ||
        /开始聊天吧/.test(s) ||
        /^(?:Into the Unknown|探索未至之境)$/i.test(s) ||
        /^使用(?:快速|专家|识图)模式开始对话$/.test(s) ||
        /今天(?:想|要)(?:聊|问)/.test(s)
      );
    };
    const homeCopy = Array.from(document.querySelectorAll('main *,#root *,[role="main"] *')).some(
      (el) => {
        if (!visible(el) || el.closest('nav,aside,pre,code,textarea,[contenteditable]'))
          return false;
        const label = text(el);
        if (profile.id === 'deepseek') {
          // Nested greeting spans (icon + text wrappers) are common after UI refresh.
          if (el.children.length > 4 || label.length > 80) return false;
          return deepseekWelcomeText(label);
        }
        if (el.children.length !== 0) return false;
        if (profile.id === 'gemini') return /^需要我为你做些什么[？?]$/.test(label);
        if (profile.id === 'chatgpt')
          return /^(?:How can I help(?: you)?(?: today)?\??|What can I help with\??|Ask anything\.?|有什么可以帮忙的[？?]|今天有什么可以帮忙的[？?]|我能帮你什么忙[？?])$/i.test(
            label,
          );
        return false;
      },
    );
    const emptyWelcome =
      (profile.id === 'deepseek' && location.pathname === '/' && homeCopy) ||
      (profile.id === 'gemini' && /^\/app\/?$/.test(location.pathname) && homeCopy) ||
      (profile.id === 'chatgpt' &&
        location.pathname === '/' &&
        (homeCopy ||
          !document.querySelector(
            '[data-message-author-role],[data-turn="assistant"],[data-turn="user"]',
          )));
    const emptyConversation = Boolean(
      emptyWelcome &&
      input &&
      !value(input).trim() &&
      !loggedOut &&
      !challenge &&
      !stops.length &&
      !stopByLabel &&
      outputs.length === 0 &&
      userCount === 0 &&
      actions.length === 0,
    );
    return {
      url: location.href,
      ...(request.captureDraft ? { draftText: value(input) } : {}),
      editorFound: Boolean(input),
      emptyConversation,
      editorEmpty: !value(input).trim(),
      draftMatchesRequest: matchesPrompt(input),
      outputCount: outputs.length,
      userCount,
      submitControlFound: Boolean(first(profile.sendButtons)) || Boolean(input),
      completionControlFound: completed,
      busy: stops.length > 0 || stopByLabel,
      login: loggedOut ? 'logged_out' : input ? 'logged_in' : 'unknown',
      blocked: challenge,
      reason: challenge
        ? '网页出现验证或访问限制'
        : loggedOut
          ? '网页需要登录'
          : !input
            ? '未找到可用的消息输入框'
            : '',
      markerFound: Boolean(anchor),
      raw: output ? output.read() : '',
      outputId: output?.node.id ?? '',
      dispatched,
      structure:
        request.operation === 'inspect'
          ? {
              readerVersion: 'speaker-range-v2',
              headingCount: headingElements().length,
              assistantHeadingCount: headingElements().filter((el) => speaker(el) === 'assistant')
                .length,
              userHeadingCount: headingElements().filter((el) => speaker(el) === 'user').length,
              hiddenTextHeadingCount: headingElements().filter(
                (el) => text(el) !== (el.textContent ?? '').trim(),
              ).length,
              openShadowRootCount: Array.from(document.querySelectorAll('*')).filter(
                (el) => el.shadowRoot !== null,
              ).length,
              iframeCount: document.querySelectorAll('iframe').length,
              headings: headingElements()
                .slice(0, 24)
                .map((el) => ({
                  tag: el.tagName.toLowerCase(),
                  role: el.getAttribute('role'),
                  visibleTextLength: text(el).length,
                  rawTextLength: (el.textContent ?? '').trim().length,
                  speaker: speaker(el) ?? 'unrecognized',
                  display: getComputedStyle(el).display,
                  hasRect: el.getClientRects().length > 0,
                  parentTag: el.parentElement?.tagName.toLowerCase() ?? null,
                })),
            }
          : undefined,
      selectors: {
        editor: matchedSelector(profile.editors),
        assistant: outputs[0]?.source ?? null,
        completion:
          matchedSelector(profile.completionButtons) ?? (actions.length ? '@action-label' : null),
        send: matchedSelector(profile.sendButtons),
      },
    };
  };
  if (!profile.origins.includes(location.origin)) throw new Error('ORIGIN_MISMATCH');
  let result = observe();
  if (request.operation === 'clear_draft' || request.operation === 'restore_draft') {
    if (request.expectedUrl && location.href !== request.expectedUrl)
      return { ...result, draftState: 'blocked' };
    const input = editor();
    if (
      !input ||
      result.blocked ||
      result.busy ||
      result.login !== 'logged_in' ||
      !request.prompt ||
      !request.marker
    )
      return { ...result, draftState: 'blocked' };
    if (request.operation === 'clear_draft' ? !matchesPrompt(input) : !result.editorEmpty)
      return { ...result, draftState: 'changed' };
    const next = request.operation === 'clear_draft' ? '' : request.prompt;
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, next);
    } else {
      const selection = window.getSelection(),
        range = document.createRange();
      range.selectNodeContents(input);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand('insertText', false, next);
      if (normalizedInput(value(input)) !== normalizedInput(next)) {
        const paragraphs = next.split('\n').map((line) => {
          const p = document.createElement('p');
          if (line) p.textContent = line;
          else p.append(document.createElement('br'));
          return p;
        });
        input.replaceChildren(...paragraphs);
      }
    }
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: next ? 'insertText' : 'deleteContentBackward',
        data: next || null,
      }),
    );
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 160));
    result = observe();
    const succeeded = next ? matchesPrompt(editor()) : result.editorEmpty;
    return { ...result, draftState: succeeded ? (next ? 'restored' : 'cleared') : 'changed' };
  }
  if (request.operation === 'new_conversation') {
    const expectedHome = new URL(profile.newConversationUrl);
    const onConfiguredHome =
      location.origin === expectedHome.origin &&
      location.pathname.replace(/\/$/, '') === expectedHome.pathname.replace(/\/$/, '');
    if (
      (result.emptyConversation === true || onConfiguredHome) &&
      result.editorFound &&
      result.editorEmpty &&
      !result.busy &&
      !result.blocked &&
      result.login === 'logged_in' &&
      result.outputCount === 0 &&
      result.userCount === 0
    )
      return { ...result, newConversationState: 'empty' };
    const configured = list(profile.newConversationButtons ?? []);
    const button =
      (configured.length === 1 ? configured[0] : undefined) ??
      Array.from(document.querySelectorAll('button,a,[role="button"]'))
        .filter(visible)
        .find(
          (el) =>
            /^(?:发起新对话|开启新对话|新对话|新聊天|New chat|Start new chat)(?:\s|$)/i.test(
              label(el).trim(),
            ) || el.getAttribute('data-testid') === 'create-new-chat-button',
        );
    if (!button)
      return {
        ...result,
        newConversationState: 'not_found',
        reason:
          configured.length > 1
            ? '新对话图标匹配到多个可见控件，未能唯一确认；没有发送'
            : '新标签页恢复了旧对话，未找到新对话按钮；没有发送',
      };
    button.click();
    return {
      ...observe(),
      newConversationState: 'requested',
      reason: '已点击新对话，等待网页进入空白会话；尚未发送问题',
    };
  }
  if (request.operation !== 'submit') return result;
  if (result.markerFound) return result;
  if (result.blocked || result.login !== 'logged_in' || !result.editorFound || result.busy)
    return result;
  const input = editor();
  if (!input || !request.prompt || !request.marker) return result;
  if (value(input).trim() && !matchesPrompt(input))
    return { ...result, reason: '输入框中有未发送内容，未覆盖草稿' };
  input.focus();
  if (matchesPrompt(input)) {
    // A previous pre-dispatch failure can leave our exact full request in the editor. Reuse it.
  } else if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    const prototype =
      input instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, request.prompt);
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    // Native editing keeps ProseMirror/Quill/React contenteditable state in sync.
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand('insertText', false, request.prompt);
    // Some contenteditable editors normalize paragraphs or reject execCommand in background tabs.
    // Use the rendered editable surface and let the editor's input/mutation handlers synchronize it.
    if (!matchesPrompt(input)) {
      const paragraphs = request.prompt
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .map((line) => {
          const paragraph = document.createElement('p');
          if (line) paragraph.textContent = line;
          else paragraph.append(document.createElement('br'));
          return paragraph;
        });
      input.replaceChildren(...paragraphs);
    }
    input.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertText',
        data: request.prompt,
      }),
    );
  }
  // ChatGPT and similar React editors enable Send only after state catches up.
  let readyToSend = false;
  for (let i = 0; i < 25; i++) {
    await new Promise((resolve) => setTimeout(resolve, 80));
    if (!matchesPrompt(editor())) {
      return { ...observe(), reason: '输入框内容校验失败；没有发送' };
    }
    const send = first(profile.sendButtons);
    if (!send || enabled(send)) {
      readyToSend = true;
      break;
    }
  }
  if (!matchesPrompt(editor())) return { ...observe(), reason: '输入框内容校验失败；没有发送' };
  const send = first(profile.sendButtons);
  if (send) {
    if (!readyToSend || !enabled(send))
      return { ...observe(), reason: '网页发送按钮尚不可用；没有发送' };
    send.click();
  } else
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    );
  for (let i = 0; i < 20; i++) {
    await new Promise((resolve) => setTimeout(resolve, 120));
    result = observe(true);
    if (result.markerFound) return result;
  }
  return {
    ...result,
    dispatched: true,
    reason: '已触发网页发送，尚未确认消息出现；必须核对，不能直接重发',
  };
}
