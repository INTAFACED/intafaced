/**
 * The copy lead doors' answer schemas (`trade.copy.*` for a lead's own desk, and the public pauses). Each names every
 * key its handler answers with (`answerKeys`) and checks no more than the handler's own type, so a reply leaves
 * exactly as it did before the schema was added.
 */
import { z } from 'zod';
import { answerKeys } from '../answer-keys.js';
import type { LeadEligibility, MyLeadAccount, MyLeadApplication, LeadMissionsView } from './lead-applications.js';
import type { LeadEarnings, LeadLevel } from './lead-desk.js';
import type { LeadCopierView, LeadTradesView } from './lead-trading.js';
import type { PublicPauses } from './platform-pauses.js';

const myLeadApplicationShape = z.object({
  applicationId: z.string(),
  state: z.enum(['submitted', 'under_review', 'approved', 'disapproved']),
  displayName: z.string(),
  submittedAt: z.string(),
  reason: z.string().nullable(),
  reapplyAfter: z.string().nullable(),
});

/** `copy.applyToLead`: the caller's application, new or the open one answered again. */
export const applyToLeadAnswer = myLeadApplicationShape;
answerKeys<MyLeadApplication>()(applyToLeadAnswer);

/** `copy.myLeadApplication`: the caller's newest application, or null. */
export const myLeadApplicationAnswer = myLeadApplicationShape.nullable();
answerKeys<MyLeadApplication | null>()(myLeadApplicationAnswer);

/** `copy.leadEligibility`. The read form is tried first: only it has `owner`, `test`, `usdc` and `asOf`, and its state is `read`, which the other branch refuses. */
export const leadEligibilityAnswer = z.object({
  following: z.object({ leaderRef: z.string().nullable(), displayName: z.string() }).nullable(),
  threshold: z.string().nullable(),
  venue: z.union([
    z.object({ state: z.literal('read'), owner: z.string(), test: z.boolean(), usdc: z.string(), asOf: z.string() }),
    z.object({ state: z.enum(['off', 'none', 'unreadable']) }),
  ]),
});
answerKeys<LeadEligibility>()(leadEligibilityAnswer);

/** `copy.myLead`: the caller's lead account once approved, or null. */
export const myLeadAnswer = z
  .object({
    leaderRef: z.string(),
    applicationId: z.string(),
    displayName: z.string(),
    state: z.string(),
    instruments: z.array(z.string()).readonly(),
  })
  .nullable();
answerKeys<MyLeadAccount | null>()(myLeadAnswer);

/** `copy.leadEarnings`. */
export const leadEarningsAnswer = z.object({
  profitShare: z.string(),
  leaderShareBps: z.string().nullable(),
  totals: z.array(z.object({ assetId: z.string(), amount: z.string() })),
  items: z.array(
    z.object({
      fillId: z.string(),
      followId: z.string(),
      assetId: z.string(),
      feeOnFill: z.string(),
      appliedShareBps: z.number(),
      amount: z.string(),
      at: z.string(),
      venueFillId: z.string().nullable(),
      ledgerKey: z.string(),
      owedBy: z.literal('intafaced'),
    }),
  ),
});
answerKeys<LeadEarnings>()(leadEarningsAnswer);

/** `copy.leadLevel`. */
export const leadLevelAnswer = z.object({
  leaderRef: z.string().nullable(),
  listingState: z.string().nullable(),
  level: z.null(),
  levelReason: z.literal('thresholds_unset'),
  maxRatio: z.null(),
});
answerKeys<LeadLevel>()(leadLevelAnswer);

/** `copy.leadMissions`. */
export const leadMissionsAnswer = z.object({
  missions: z.array(z.object({ id: z.enum(['apply', 'fund', 'listed']), done: z.boolean(), detail: z.string() })).readonly(),
  done: z.number(),
  total: z.number(),
});
answerKeys<LeadMissionsView>()(leadMissionsAnswer);

const leadTradeShape = z.object({
  orderId: z.string(),
  symbol: z.string(),
  side: z.enum(['buy', 'sell']),
  price: z.string().nullable(),
  amount: z.string(),
  filled: z.string(),
  status: z.string(),
  at: z.string(),
});

/** `copy.leadTrades`. */
export const leadTradesAnswer = z.object({
  ongoing: z.array(leadTradeShape).readonly(),
  history: z.array(leadTradeShape).readonly(),
  counts: z.object({ ongoing: z.number(), history: z.number() }),
});
answerKeys<LeadTradesView>()(leadTradesAnswer);

/** `copy.leadCopiers`. */
export const leadCopiersAnswer = z.array(
  z.object({
    followRef: z.string(),
    status: z.enum(['Active', 'Paused', 'Stopping', 'Close only', 'Stopped']),
    since: z.string(),
  }),
);
answerKeys<LeadCopierView[]>()(leadCopiersAnswer);

/** `copy.setProfitShare` and `copy.setMaxRatio`: both always refuse, so neither ever answers. */
export const refusedAlwaysAnswer = z.void();
answerKeys<void>()(refusedAlwaysAnswer);

/** `copy.platformPauses`. */
export const platformPausesAnswer = z.object({
  leads: z.array(z.string()).readonly(),
  botTypes: z.array(z.string()).readonly(),
  symbols: z.array(z.string()).readonly(),
});
answerKeys<PublicPauses>()(platformPausesAnswer);
