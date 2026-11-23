import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-trade's auto top-up of an isolated position's margin on the person's own venue account (J-derivatives-06 #4;
 * svc-trade src/venue/margin-topup.ts). INTAFACED holds and moves nothing: a top-up is one venue margin change that moves
 * the person's own free collateral into their own position's margin, signed by the margin top-up agent permission their
 * wallet approves once, and sent once under its own key (`margin:<owner>:<symbol>:add:auto.<n>`). The person sets the
 * margin level that starts a top-up, what each adds, and a cap; the permission has a cap of its own, set when it is given.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;
const WRITE = { caller: 'scope', scope: 'trade:write', module: 'trade' } as const;

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
/** A decimal typed by the person, or blank: the service names a blank or malformed field in its refusal. */
const typed = z.string().max(64).optional().nullable();
const owner = z.string().min(1).max(64);
const symbol = z.string().min(3).max(64);

export const MARGIN_TOPUP_STATES = ['sending', 'added', 'refused'] as const;
/** Why a fall added nothing: the rule's own cap, or the permission's own cap, would have been passed. */
export const MARGIN_TOPUP_STOPS = ['cap', 'permission_cap'] as const;

/** Auto top-up on one position as the person reads it: every figure a decimal string, the position's from the venue. */
export const marginTopUpViewSchema = z.object({
  venue: z.object({ id: z.string(), name: z.string(), test: z.boolean() }),
  owner: z.string(),
  symbol: z.string(),
  /** The collateral asset a top-up moves, as the venue names it. */
  asset: z.string(),
  /**
   * The open isolated position as the venue reports it now, or null with none open. `marginLevel` is its margin with its
   * unrealised result as a percent of the venue's maintenance margin, cut to two places (never rounded up); null where
   * the venue publishes no maintenance margin for it.
   */
  position: z
    .object({
      margin: decimal,
      unrealisedPnl: decimal,
      maintenanceMargin: decimal.nullable(),
      marginLevel: decimal.nullable(),
      asOf: z.string(),
    })
    .nullable(),
  /**
   * The margin top-up agent permission on this venue account: the key INTAFACED holds for it, whether the venue lists it
   * approved now, the permission's own cap (null until the person sets one) and what was added under it in all.
   */
  permission: z.object({
    agentAddress: z.string(),
    agentName: z.string(),
    /** The business key the wallet's approval of the key is prepared and sent under. */
    actionKey: z.string(),
    approved: z.boolean(),
    cap: decimal.nullable(),
    added: decimal,
  }),
  /** The person's rule for this position, or null when they never set one. */
  rule: z
    .object({
      on: z.boolean(),
      /** The margin level, in percent, that starts a top-up. */
      level: decimal,
      /** What each top-up adds. */
      amount: decimal,
      /** The most the rule may add in all while it is on. */
      cap: decimal,
      /** What it added since it was turned on. */
      added: decimal,
      /** True while the margin level is above `level`: the next fall to it adds once. False until it has risen above again. */
      armed: z.boolean(),
      /** Set when the last fall added nothing because a cap would have been passed. */
      stopped: z.enum(MARGIN_TOPUP_STOPS).nullable(),
    })
    .nullable(),
  /** Each top-up our engine sent for this position, newest first. */
  topUps: z.array(
    z.object({
      n: z.number().int(),
      changeKey: z.string(),
      amount: decimal,
      /** The margin level the venue's figures gave when it started. */
      levelSeen: decimal,
      state: z.enum(MARGIN_TOPUP_STATES),
      /** The venue's words when it refused. */
      failure: z.string().nullable(),
      at: z.string(),
    }),
  ),
});

const refuse = (map: Record<string, 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'SERVICE_UNAVAILABLE'>): Refusals => Object.freeze(map);

const COMMON = {
  'trade.margin_topup_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.margin_topup_agent_key_unset': 'SERVICE_UNAVAILABLE',
  'trade.margin_topup_field_invalid': 'BAD_REQUEST',
} as const;

const OWNER = '0x1111111111111111111111111111111111111111';

/** Auto top-up on one position: the venue's figures now, the permission, the rule and its top-ups. */
export const MARGIN_TOPUP_GET = defineProcedure({
  ...base,
  name: 'trade.marginTopUp.get',
  kind: 'query',
  path: 'marginTopUp.get',
  access: READ,
  refusals: refuse(COMMON),
  input: z.object({ owner, symbol }),
  output: marginTopUpViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP' } },
    { verdict: 'refuse', input: { owner: OWNER } },
    { verdict: 'refuse', input: {} },
  ],
});

/**
 * Set the permission's own cap: the most the margin top-up key may add in all on this venue account, across every
 * position. It is stored before the wallet is asked to approve the key (the view's `permission.actionKey`), so the key
 * never adds anything without a cap. A blank or non-positive cap, or one below what was already added, is refused naming
 * it, and nothing changes.
 */
export const MARGIN_TOPUP_SET_PERMISSION_CAP = defineProcedure({
  ...base,
  name: 'trade.marginTopUp.setPermissionCap',
  kind: 'mutation',
  path: 'marginTopUp.setPermissionCap',
  access: WRITE,
  refusals: refuse(COMMON),
  input: z.object({ owner, symbol, cap: typed }),
  output: marginTopUpViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP', cap: '25' } },
    { verdict: 'refuse', input: { owner: OWNER, cap: '25' } },
    { verdict: 'refuse', input: {} },
  ],
});

/**
 * Turn auto top-up on for one position, or change it: the margin level that starts a top-up, what each adds, and the
 * cap. Refused, with nothing saved: a blank or malformed field (named), an amount above the cap, no open isolated
 * position, a position the venue publishes no maintenance margin for, a level the position is already at or below (it
 * would add at once), and a permission the venue does not list approved or that has no cap.
 */
export const MARGIN_TOPUP_SET = defineProcedure({
  ...base,
  name: 'trade.marginTopUp.set',
  kind: 'mutation',
  path: 'marginTopUp.set',
  access: WRITE,
  refusals: refuse({
    ...COMMON,
    'trade.margin_topup_amount_above_cap': 'BAD_REQUEST',
    'trade.margin_topup_no_position': 'CONFLICT',
    'trade.margin_topup_level_unmeasured': 'CONFLICT',
    'trade.margin_topup_level_reached': 'CONFLICT',
    'trade.margin_topup_permission_missing': 'CONFLICT',
  }),
  input: z.object({ owner, symbol, level: typed, amount: typed, cap: typed }),
  output: marginTopUpViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP', level: '1000', amount: '10', cap: '20' } },
    { verdict: 'refuse', input: { owner: OWNER, level: '1000' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Turn auto top-up off for one position: our engine adds nothing more there. A top-up already sent is not undone. */
export const MARGIN_TOPUP_OFF = defineProcedure({
  ...base,
  name: 'trade.marginTopUp.off',
  kind: 'mutation',
  path: 'marginTopUp.off',
  access: WRITE,
  refusals: refuse(COMMON),
  input: z.object({ owner, symbol }),
  output: marginTopUpViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP' } },
    { verdict: 'refuse', input: { symbol: 'BTC-PERP' } },
    { verdict: 'refuse', input: {} },
  ],
});
