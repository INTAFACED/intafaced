import { z } from 'zod';
import { defineProcedure } from './procedure.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-academy `paperDrill.*`, one record per call: svc-academy mounts each (`mountRecord`) and every app caller calls it by its record. */

const base = { service: 'svc-academy', module: 'academy', transport: 'trpc' } as const;

/** Trade's paper flag only. Extra live/realMoney keys must refuse, not strip. */
export const paperMarketFlagIn = z
  .object({
    marketId: z.string().min(1),
    paper: z.boolean(),
    symbol: z.string().min(1),
  })
  .strict();

/** The only venue a sealed result may claim. There is no second one. */
export const SIMULATED_VENUE = 'paper' as const;

/**
 * The seal, as a SCHEMA — every field a literal.
 *
 * This is the labelling rule enforced by the type system rather than by
 * remembering. A handler that returns a paper payload without `simulated: true`
 * does not compile, and one that somehow gets past that is rejected by the
 * output parser at runtime. The alternative — a `simulated?: boolean` a caller
 * is trusted to set — is the version that ships unlabelled on the day someone
 * adds a field in a hurry.
 *
 * `realMoney: false` is the D26-P1-C4 harden — paper flag never readable as
 * real money even if a client only checks one bit.
 */
export const simulatedSealOut = {
  simulated: z.literal(true),
  venue: z.literal(SIMULATED_VENUE),
  realLedger: z.literal(false),
  withdrawable: z.literal(false),
  realMoney: z.literal(false),
  disclaimer: z.string().min(1),
};

export const paperDrillOut = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    ...simulatedSealOut,
    marketId: z.string(),
    symbol: z.string(),
    steps: z.array(z.object({ id: z.string(), instruction: z.string() })),
  }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['not_paper', 'no_market', 'unknown_step', 'bad_fill']),
    message: z.string(),
  }),
]);

/**
 * Paper drill gate for a workbook (TRK-academy.paper-trading Stage 2+3).
 *
 * Read-only on purpose: the drill loop is a pure state machine and academy
 * holds no run state, so this answers one question — may this catalog item
 * be drilled against this market, and with which steps. A market that is
 * not flagged `paper: true` by trade refuses here rather than anywhere a
 * user could mistake it for live. Stage-3 ops kill-switch
 * (`ACADEMY_PAPER_TRADING_ENABLED=false`) refuses before the market check —
 * live trade is unaffected. No fills, prices or balances cross this
 * boundary; money truth stays on trade.
 */
export const ACADEMY_PAPER_DRILL = defineProcedure({
  ...base,
  name: 'academy.paperDrill',
  kind: 'query',
  path: 'paperDrill',
  access: { caller: 'scope', scope: 'academy:read', module: 'academy' },
  refusals: {
    'academy.curriculum_not_found': 'NOT_FOUND',
    'academy.paper_flag_mismatch': 'FORBIDDEN',
    'academy.paper_flag_unverified': 'PRECONDITION_FAILED',
    'academy.paper_market_unlisted': 'FORBIDDEN',
    'academy.paper_trading_disabled': 'FORBIDDEN',
    'academy.slug_reserved': 'BAD_REQUEST',
  },
  input: z
    .object({
      slug: z.string().min(1),
      market: paperMarketFlagIn.nullable().default(null),
    })
    .strict(),
  output: paperDrillOut,
  samples: [
    { verdict: 'accept', input: { slug: 'placeholder' } },
    { verdict: 'refuse', input: 42 },
  ],
});
