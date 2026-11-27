import { CouncilDB } from '../database/db';
import { CouncilService } from './council-service';
import type { Command, CommandResult } from '../protocols/commands';
let preview: CouncilService | undefined;
export const extensionMode = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id);
export async function call(command: Command): Promise<unknown> {
  let result: CommandResult;
  if (extensionMode) result = (await chrome.runtime.sendMessage(command)) as CommandResult;
  else {
    if (!preview) {
      preview = new CouncilService(new CouncilDB('ai-council-preview'), {
        async tabs() {
          return [];
        },
        async open(url) {
          window.open(url, '_blank', 'noopener,noreferrer');
        },
      });
      await preview.initialize();
    }
    result = await preview.execute(command);
  }
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
