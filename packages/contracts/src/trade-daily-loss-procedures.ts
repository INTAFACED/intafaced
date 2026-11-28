import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-trade's opt-in daily loss limit on the person's own venue account (svc-trade src/venue/daily-loss-limit.ts).
 * Nothing moves and the ledger posts nothing: the limit is a setting of the person's, judged against the venue's own fills.
 *
 * When the account's realised loss since 00:00 UTC (the venue's realised results less every fee) reaches the person's
 * limit, a new opening order warns (`advisory`, the default) or is refused (`blocking`). A reduce-only exit is never
 * blocked. A change that makes the limit stricter (a lower limit, advisory to blocking, turning it on) applies at once;
 * one that loosens it (a higher limit, blocking to advisory, turning it off) applies only 24 hours after it was asked.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;
const WRITE = { caller: 'scope', scope: 'trade:write', module: 'trade' } as const;

const decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);
const owner = z.string().max(64);

export const DAILY_LOSS_MODES = ['advisory', 'blocking'] as const;

/** The limit's terms: how much may be lost today, and whether reaching it warns or refuses. */
export const dailyLossTermsSchema = z.object({ mode: z.enum(DAILY_LOSS_MODES), limit: decimal });

export const dailyLossViewSchema = z.object({
  venue: z.object({ id: z.string(), name: z.string(), test: z.boolean() }),
  owner: z.string(),
  /**
   * The asset the loss and the limit are counted in: the venue's perpetuals collateral. `null` only on a `terms` read of
   * an account that never set a limit: the venue is not asked then.
   */
  asset: z.string().nullable(),
  /** The terms in force now; `null` while the limit is off. */
  active: dailyLossTermsSchema.nullable(),
  /** A loosening asked and still waiting out its 24 hours: `terms` null is turning the limit off. */
  pending: z.object({ terms: dailyLossTermsSchema.nullable(), effectiveAt: z.string() }).nullable(),
  /** Today's loss (since `since`, 00:00 UTC) on the venue's own fills; `null` when the venue could not be read just now. */
  /** `null` only on a `terms` read of an account that never set a limit (with `asset`): the venue is not asked then. */
  today: z
    .object({
      loss: decimal.nullable(),
      since: z.string(),
      /** The venue's own time for the fills `loss` was counted from; `null` with `loss`. */
      asOf: z.string().nullable(),
      /** The next 00:00 UTC: when today's loss starts again from zero. */
      resetsAt: z.string(),
      reached: z.boolean(),
    })
    .nullable(),
});

const refuse = (map: Record<string, 'BAD_REQUEST' | 'SERVICE_UNAVAILABLE'>): Refusals => Object.freeze(map);

const COMMON = {
  'trade.daily_loss_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.daily_loss_request_invalid': 'BAD_REQUEST',
} as const;

const OWNER = '0x1111111111111111111111111111111111111111';

/** The account's daily loss limit: the terms in force, a loosening waiting out its 24 hours, and today's loss. */
export const DAILY_LOSS_GET = defineProcedure({
  ...base,
  name: 'trade.dailyLoss.get',
  kind: 'query',
  path: 'dailyLoss.get',
  access: READ,
  refusals: refuse({ ...COMMON }),
  /**
   * `terms`: the desk's read. An account that never set a limit is answered from our own record alone, with no venue
   * read (`asset` and `today` null), so a desk that polls it asks the venue nothing more until a limit is set.
   */
  input: z.object({ owner, terms: z.boolean().optional() }),
  output: dailyLossViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER } },
    { verdict: 'accept', input: { owner: OWNER, terms: true } },
    { verdict: 'refuse', input: { owner: 7 } },
    { verdict: 'refuse', input: {} },
  ],
});

/**
 * Turn the limit on or change it. Stricter applies at once (and drops a waiting loosening); looser waits 24 hours.
 * `mode` left out is advisory.
 */
export const DAILY_LOSS_SET = defineProcedure({
  ...base,
  name: 'trade.dailyLoss.set',
  kind: 'mutation',
  path: 'dailyLoss.set',
  access: WRITE,
  refusals: refuse({ ...COMMON, 'trade.daily_loss_field_invalid': 'BAD_REQUEST' }),
  input: z.object({ owner, limit: z.string().max(64), mode: z.enum(DAILY_LOSS_MODES).optional() }),
  output: dailyLossViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, limit: '250' } },
    { verdict: 'accept', input: { owner: OWNER, limit: '100.5', mode: 'blocking' } },
    { verdict: 'refuse', input: { owner: OWNER, limit: '100', mode: 'hard' } },
    { verdict: 'refuse', input: { owner: OWNER } },
  ],
});

/** Turn the limit off: a loosening, so it takes effect 24 hours after it is asked. */
export const DAILY_LOSS_OFF = defineProcedure({
  ...base,
  name: 'trade.dailyLoss.off',
  kind: 'mutation',
  path: 'dailyLoss.off',
  access: WRITE,
  refusals: refuse({ ...COMMON }),
  input: z.object({ owner }),
  output: dailyLossViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER } },
    { verdict: 'refuse', input: {} },
  ],
});
