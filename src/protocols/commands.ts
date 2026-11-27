import { z } from 'zod';
import {
  participantInputSchema,
  participantProfileSchema,
  discussionInputSchema,
  factInputSchema,
  idSchema,
  verificationPolicySchema,
} from './domain';
import { calculationSchema } from '../core/fact-check-manager';
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot') }).strict(),
  z.object({ type: z.literal('participant.add'), input: participantInputSchema }).strict(),
  z.object({ type: z.literal('participant.enable'), id: idSchema, enabled: z.boolean() }).strict(),
  z
    .object({
      type: z.literal('participant.update'),
      id: idSchema,
      input: participantProfileSchema,
    })
    .strict(),
  z.object({ type: z.literal('participant.remove'), id: idSchema }).strict(),
  z.object({ type: z.literal('participant.check'), id: idSchema }).strict(),
  z.object({ type: z.literal('participant.open'), id: idSchema }).strict(),
  z.object({ type: z.literal('discussion.create'), input: discussionInputSchema }).strict(),
  z.object({ type: z.literal('discussion.start'), id: idSchema }).strict(),
  z.object({ type: z.literal('discussion.pause'), id: idSchema }).strict(),
  z.object({ type: z.literal('discussion.stop'), id: idSchema }).strict(),
  z.object({ type: z.literal('discussion.delete'), id: idSchema }).strict(),
  z.object({ type: z.literal('report.generate'), id: idSchema }).strict(),
  z.object({ type: z.literal('draft.restore'), id: idSchema }).strict(),
  z.object({ type: z.literal('fact.record'), input: factInputSchema }).strict(),
  z.object({ type: z.literal('fact.calculate'), input: calculationSchema }).strict(),
  z.object({ type: z.literal('data.clear'), confirm: z.literal('DELETE_LOCAL_DATA') }).strict(),
  z
    .object({
      type: z.literal('chat.ask'),
      question: z.string().trim().min(1).max(200_000),
      verificationPolicy: verificationPolicySchema.optional(),
    })
    .strict(),
  z.object({ type: z.literal('tick') }).strict(),
  z.object({ type: z.literal('brain.resume'), id: idSchema }).strict(),
  z.object({ type: z.literal('brain.cancel'), id: idSchema }).strict(),
]);
export type Command = z.input<typeof commandSchema>;
export type CommandResult = { ok: true; data: unknown } | { ok: false; error: string };
export function trustedSender(sender: chrome.runtime.MessageSender, extensionId: string): boolean {
  if (sender.id !== extensionId) return false;
  return sender.url === `chrome-extension://${extensionId}/sidepanel.html`;
}
