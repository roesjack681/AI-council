import type { CouncilDB } from '../database/db';
import type { Claim, DiscussionMessage, ModelResponse } from '../protocols/domain';
import { normalize, newId } from '../utils/id';
export class ClaimManager {
  constructor(private readonly db: CouncilDB) {}
  async apply(message: DiscussionMessage, inputs: ModelResponse['claims']): Promise<string[]> {
    const ids: string[] = [];
    for (const input of inputs) {
      const id = `${message.discussionId}:${message.participantId}:${input.key}`;
      const old = await this.db.claims.get(id);
      const now = Date.now();
      ids.push(id);
      if (
        old &&
        normalize(old.description) === normalize(input.description) &&
        old.category === input.category &&
        old.critical === input.critical
      )
        continue;
      const claim: Claim = {
        ...input,
        id,
        discussionId: message.discussionId,
        ownerId: message.participantId,
        sourceMessageId: message.id,
        version: (old?.version ?? 0) + 1,
        status: 'active',
        createdAt: old?.createdAt ?? now,
        updatedAt: now,
      };
      await this.db.claims.put(claim);
      await this.db.claim_revisions.add({
        id: newId(),
        claimId: id,
        discussionId: message.discussionId,
        version: claim.version,
        description: claim.description,
        sourceMessageId: message.id,
        createdAt: now,
      });
      // Old positions and evidence remain auditable but are invalid for the new version.
    }
    return ids;
  }
}
