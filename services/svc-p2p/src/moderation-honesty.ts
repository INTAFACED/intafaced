import type { z } from 'zod';
import type { P2P_MODERATION } from '@intafaced/contracts/p2p-procedures';

/**
 * Health / open / backlog never probe a human moderator.
 *
 * `moderationReachable: allowlist.length > 0` sold `P2P_MODERATOR_USER_IDS`
 * as a live queue. Configured is not reachable. Process liveness stays
 * `ok: true`. Named ids are `configured` + `p2p.moderation_unprobed`.
 * An empty list is `absent` + `p2p.moderation_unreachable`.
 */
export const P2P_MODERATION_UNREACHABLE = 'p2p.moderation_unreachable' as const;
export const P2P_MODERATION_UNPROBED = 'p2p.moderation_unprobed' as const;

/** The shape is the record's (`P2P_MODERATION`), which health, a dispute and the backlog answer with. */
export type ModerationHonesty = z.infer<typeof P2P_MODERATION>;

export function moderationHonesty(configured: boolean): ModerationHonesty {
  if (!configured) {
    return { status: 'absent', code: P2P_MODERATION_UNREACHABLE };
  }
  return { status: 'configured', code: P2P_MODERATION_UNPROBED };
}

/** Public pair: env allowlist vs the thing this process does not probe. */
export function moderationOnPublicDoor(configured: boolean): {
  moderationConfigured: boolean;
  moderation: ModerationHonesty;
} {
  return {
    moderationConfigured: configured,
    moderation: moderationHonesty(configured),
  };
}
