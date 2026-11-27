import type { PageProfile } from './page-protocol';
const loginButtons = [
  'a[href*="/auth/login"]',
  'button[data-testid="login-button"]',
  '[data-testid="login-button"]',
  '[data-testid="login-button"] button',
];
const stopButtons = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop"]',
  'button[aria-label*="停止"]',
  '[role="button"][aria-label*="停止"]',
  'button[data-testid="chat_stop_button"]',
  '[data-testid="chat_input_local_break_button"]',
];
const completionButtons = [
  'button[data-testid="copy-turn-action-button"]',
  'button[aria-label="复制"]',
  'button[aria-label="Copy"]',
  '[role="button"][aria-label="复制"]',
  '[role="button"][aria-label="朗读"]',
  'button[aria-label="朗读"]',
  '[data-testid="chat_message_action_copy"]',
  '[data-testid="message_action_copy"]',
];
export const domProfiles: PageProfile[] = [
  {
    id: 'deepseek',
    origins: ['https://chat.deepseek.com'],
    newConversationUrl: 'https://chat.deepseek.com/',
    // Observed in Chrome Elements: unlabeled chat-plus control, not the adjacent share icon.
    newConversationButtons: [
      '.the-header [role="button"].ds-button:has(svg[viewBox="0 0 20 20"] path[d^="M9.99994 1.22943"][d*="M9.21913 6.36949V9.22487H6.36943"])',
    ],
    editors: ['textarea[placeholder*="DeepSeek"]', 'textarea[placeholder*="发送消息"]', 'textarea'],
    assistants: [
      '.ds-markdown',
      '[data-role="assistant"]',
      '[data-message-author-role="assistant"]',
    ],
    users: ['[data-role="user"]', '[data-message-author-role="user"]'],
    sendButtons: [
      'button[aria-label*="发送"]',
      '[role="button"][aria-label*="发送"]',
      'button[type="submit"]',
    ],
    stopButtons: [...stopButtons, '[data-testid="stop-generating"]'],
    completionButtons,
    loginButtons,
  },
  {
    id: 'doubao',
    origins: ['https://www.doubao.com'],
    newConversationUrl: 'https://www.doubao.com/chat/',
    editors: [
      'textarea[data-testid="chat_input_input"]',
      '#input-engine-container [contenteditable="true"]',
      'textarea[placeholder*="发消息"]',
      'textarea[placeholder*="豆包"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea',
    ],
    assistants: [
      '[data-testid="message_text_content"]',
      '[data-testid="receive_message"] [class*="markdown"]',
      '[data-message-role="assistant"]',
    ],
    users: ['[data-testid="send_message"]', '[data-message-role="user"]'],
    sendButtons: [
      '[data-testid="chat_input_send_button"]',
      '[data-testid="chat_input_local_send_button"]',
      'button[aria-label*="发送"]',
      'button[type="submit"]',
    ],
    stopButtons,
    completionButtons,
    loginButtons,
  },
  {
    id: 'chatgpt',
    origins: ['https://chatgpt.com'],
    newConversationUrl: 'https://chatgpt.com/',
    editors: [
      '#prompt-textarea',
      'textarea[data-testid="prompt-textarea"]',
      '[contenteditable="true"][role="textbox"][aria-label*="ChatGPT"]',
      'textarea[placeholder*="ChatGPT"]',
      'main [contenteditable="true"][role="textbox"]',
      '[role="main"] [contenteditable="true"][role="textbox"]',
      'main [contenteditable="true"]',
    ],
    assistants: [
      '[data-message-author-role="assistant"] .markdown',
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
    ],
    users: ['[data-message-author-role="user"]', '[data-turn="user"]'],
    sendButtons: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="发送提示"]',
      'button[aria-label="发送"]',
      'button[aria-label="发送消息"]',
      'button[aria-label="Send"]',
    ],
    stopButtons,
    completionButtons,
    loginButtons,
  },
  {
    id: 'gemini',
    origins: ['https://gemini.google.com'],
    newConversationUrl: 'https://gemini.google.com/app',
    editors: ['rich-textarea [contenteditable="true"]', '[contenteditable="true"][role="textbox"]'],
    assistants: [
      '[id^="model-response-message-content"]',
      '.model-response-text',
      'message-content',
    ],
    users: ['[id^="user-query-content-"]', 'user-query'],
    sendButtons: [
      'button[aria-label="发送消息"]',
      'button[aria-label="Send message"]',
      'button.send-button',
    ],
    stopButtons: [
      ...stopButtons,
      'button[aria-label="停止回答"]',
      'button[aria-label="Stop response"]',
    ],
    completionButtons,
    loginButtons: ['a[href*="accounts.google.com/ServiceLogin"]'],
  },
];
