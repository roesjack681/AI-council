import { afterEach, expect, it, vi } from 'vitest';
import { browserPort } from '../../src/background/browser-port';
import { domProfiles } from '../../src/adapters/dom/profiles';

afterEach(() => vi.unstubAllGlobals());

it('foregrounds task preparation and refuses to create a website tab without host permission', async () => {
  const create = vi.fn(async () => ({ id: 1 }));
  const update = vi.fn(async () => undefined);
  const contains = vi.fn(async () => false);
  vi.stubGlobal('chrome', {
    tabs: {
      create,
      get: async () => ({ id: 1, url: 'https://gemini.google.com/app', windowId: 3 }),
      query: async () => [{ id: 9 }],
      update,
    },
    permissions: { contains },
    scripting: { executeScript: async () => [{ result: {} }] },
  });
  await expect(browserPort.create!('https://gemini.google.com/app')).rejects.toMatchObject({
    code: 'SITE_PERMISSION_REQUIRED',
  });
  expect(create).not.toHaveBeenCalled();
  contains.mockResolvedValue(true);
  await browserPort.page!(1, {
    operation: 'inspect',
    activate: true,
    profile: domProfiles.find((p) => p.id === 'gemini')!,
  });
  expect(update.mock.calls).toEqual([[1, { active: true }]]);
});

it.each(['new_conversation', 'submit', 'inspect', 'observe'] as const)(
  'keeps asynchronous new-chat visible, restores submission focus, and leaves inspect passive: %s',
  async (operation) => {
    let active = 9;
    const update = vi.fn(async (id: number) => {
      active = id;
    });
    vi.stubGlobal('chrome', {
      tabs: {
        get: async () => ({ id: 1, url: 'https://gemini.google.com/app', windowId: 3 }),
        query: async () => [{ id: active }],
        update,
      },
      permissions: { contains: async () => true },
      scripting: { executeScript: async () => [{ result: { newConversationState: 'requested' } }] },
    });
    await browserPort.page!(1, { operation, profile: domProfiles.find((p) => p.id === 'gemini')! });
    expect(active).toBe(['new_conversation', 'observe'].includes(operation) ? 1 : 9);
    expect(update.mock.calls.map(([id]) => id)).toEqual(
      operation === 'submit' ? [1, 9] : operation === 'inspect' ? [] : [1],
    );
  },
);
