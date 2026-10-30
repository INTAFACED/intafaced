import { z } from 'zod';

/**
 * `own.usageLimits.get` / `own.usageLimits.set`: a soft alert and a monthly hard limit for one of the person's own
 * agents (J-agents-02). Amounts are decimal strings in the fee asset (`assetId`); null is not set, never zero.
 * `spent` is what this agent's runs cost this UTC month (committed only); `alertCrossed` is set once the month's alert
 * was recorded, `alert` is that one record (its business key and the spend that crossed it, written once and never
 * rewritten). The hard limit is strict: a run is admitted only when its worst case fits beside what the month spent and
 * still holds. `hardLimitRoom` is that room, the limit less spent and held (null with no limit), and `hardLimitReached`
 * is set once nothing is left, when every new run is refused. `email` is the person's choice only: the
 * email channel is not connected, so it changes nothing that is sent.
 */
export const ownAgentUsageLimitsSchema = z.object({
  alertAt: z.string().nullable(),
  hardLimit: z.string().nullable(),
  email: z.boolean(),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  spent: z.string(),
  alertCrossed: z.boolean(),
  alert: z.object({ key: z.string(), spent: z.string() }).nullable(),
  hardLimitReached: z.boolean(),
  hardLimitRoom: z.string().nullable(),
  assetId: z.string(),
});
export type OwnAgentUsageLimits = z.infer<typeof ownAgentUsageLimitsSchema>;

/** What the person saves. Blank clears one of them; neither is required. */
export const ownAgentUsageLimitsInputSchema = z.object({
  id: z.string().min(1).max(64),
  alertAt: z.string().max(64).nullable(),
  hardLimit: z.string().max(64).nullable(),
  email: z.boolean(),
});
export type OwnAgentUsageLimitsInput = z.infer<typeof ownAgentUsageLimitsInputSchema>;
