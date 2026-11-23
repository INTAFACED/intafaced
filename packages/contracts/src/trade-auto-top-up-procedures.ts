import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-trade's auto top-up of an isolated position's margin on the person's own venue account (J-derivatives-06 #4;
 * svc-trade src/venue/auto-top-up.ts). INTAFACED holds and moves nothing, and the ledger posts nothing. The person's
 * wallet approves, on the venue, the auto top-up agent permission with its own cap; for each position they set the margin
 * level that starts a top-up, the amount each adds and a cap. Each time the position's margin falls to the level, our
 * engine adds the set amount once, one `update_isolated_margin` the agent key signs under
 * `margin:<owner>:<symbol>:auto:<sequence>`, never past the position's cap or the permission's own cap.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;
const WRITE = { caller: 'scope', scope: 'trade:write', module: 'trade' } as const;

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
/** A decimal typed by the person, or blank: the service names a blank or malformed field in its refusal. */
const typed = z.string().max(64).optional().nullable();
const owner = z.string().max(64);
const symbol = z.string().min(3).max(64);

export const AUTO_TOP_UP_STOPS = ['cap', 'permission_cap'] as const;
export const AUTO_TOP_UP_ADD_STATES = ['sending', 'added', 'refused'] as const;

/** One position's auto top-up as the person reads it: every figure a decimal string, the position's from the venue. */
export const autoTopUpViewSchema = z.object({
  venue: z.object({ id: z.string(), name: z.string(), test: z.boolean() }),
  owner: z.string(),
  symbol: z.string(),
  /** The venue's collateral asset every amount here is in. */
  asset: z.string(),
  /** The position as the venue reports it now; `null` with no isolated position open on the symbol. */
  position: z
    .object({
      margin: decimal,
      unrealisedPnl: decimal,
      /** The figure a top-up watches: the position's margin with its unrealised result. */
      marginWithResult: decimal,
      asOf: z.string(),
    })
    .nullable(),
  /** The auto top-up agent permission on this venue account, or `null` before one is asked for. */
  permission: z
    .object({
      agentAddress: z.string(),
      agentName: z.string(),
      /** Whether the venue lists the agent key approved now. Our engine signs nothing until it does. */
      approved: z.boolean(),
      cap: decimal,
      /** What every top-up under it added, or is adding, on every position. */
      used: decimal,
      room: decimal,
    })
    .nullable(),
  /** The position's setting, or `null` when auto top-up was never turned on for it. */
  setting: z
    .object({
      on: z.boolean(),
      triggerLevel: decimal,
      amountEach: decimal,
      cap: decimal,
      /** What this run's top-ups added, or are adding, toward its cap. */
      added: decimal,
      room: decimal,
      /** True once the margin was read above the level: the next fall to it is a new crossing. */
      armed: z.boolean(),
      /** Why the last crossing sent nothing, or `null`. */
      stopped: z.enum(AUTO_TOP_UP_STOPS).nullable(),
    })
    .nullable(),
  topUps: z.array(
    z.object({
      sequence: z.number().int(),
      changeKey: z.string(),
      amount: decimal,
      /** The margin with its result our engine read when it crossed the level. */
      marginAt: decimal,
      state: z.enum(AUTO_TOP_UP_ADD_STATES),
      refusal: z.string().nullable(),
      at: z.string(),
    }),
  ),
  /** The agent permission the person's wallet is asked to sign, while the venue does not list it. */
  next: z
    .object({
      actionKey: z.string(),
      digest: z.string(),
      typedData: z.object({
        domain: z.record(z.string(), z.union([z.string(), z.number()])),
        types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
        primaryType: z.string(),
        message: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
      }),
    })
    .nullable(),
});

const refuse = (map: Record<string, 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE'>): Refusals =>
  Object.freeze(map);

const COMMON = {
  'trade.auto_top_up_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.auto_top_up_request_invalid': 'BAD_REQUEST',
} as const;

const OWNER = '0x1111111111111111111111111111111111111111';

/** One position's auto top-up, its agent permission and its top-ups, with the position as the venue reports it now. */
export const AUTO_TOP_UP_GET = defineProcedure({
  ...base,
  name: 'trade.autoTopUp.get',
  kind: 'query',
  path: 'autoTopUp.get',
  access: READ,
  refusals: refuse({ ...COMMON }),
  input: z.object({ owner, symbol }),
  output: autoTopUpViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP' } },
    { verdict: 'refuse', input: { owner: OWNER, symbol: '' } },
    { verdict: 'refuse', input: {} },
  ],
});

/**
 * Turn auto top-up on for an isolated position, or change its terms (J-derivatives-06 #4): the margin level that starts a
 * top-up, the amount each adds, and a cap, never below the amount. The first time on a venue account it also sets the
 * agent permission's own cap and answers the permission for the wallet to sign (`next`). Refused naming the field.
 */
export const AUTO_TOP_UP_SET = defineProcedure({
  ...base,
  name: 'trade.autoTopUp.set',
  kind: 'mutation',
  path: 'autoTopUp.set',
  access: WRITE,
  refusals: refuse({
    ...COMMON,
    'trade.auto_top_up_field_invalid': 'BAD_REQUEST',
    'trade.auto_top_up_no_position': 'CONFLICT',
    'trade.auto_top_up_agent_key_unset': 'SERVICE_UNAVAILABLE',
  }),
  input: z.object({
    owner,
    symbol,
    triggerLevel: typed,
    amountEach: typed,
    cap: typed,
    /** The agent permission's own cap: asked only while the account has no permission yet. */
    permissionCap: typed,
  }),
  output: autoTopUpViewSchema,
  samples: [
    {
      verdict: 'accept',
      input: { owner: OWNER, symbol: 'BTC-PERP', triggerLevel: '100', amountEach: '10', cap: '50', permissionCap: '60' },
    },
    { verdict: 'refuse', input: { owner: OWNER, symbol: '' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** The wallet's signature of the auto top-up agent permission, sent once under its key. */
export const AUTO_TOP_UP_SUBMIT_PERMISSION = defineProcedure({
  ...base,
  name: 'trade.autoTopUp.submitPermission',
  kind: 'mutation',
  path: 'autoTopUp.submitPermission',
  access: WRITE,
  refusals: refuse({
    ...COMMON,
    'trade.auto_top_up_not_asked': 'CONFLICT',
    'trade.auto_top_up_agent_key_unset': 'SERVICE_UNAVAILABLE',
  }),
  input: z.object({
    owner,
    symbol,
    actionKey: z.string().min(3).max(200),
    signature: z.object({
      digest: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
      signedBy: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    }),
  }),
  output: autoTopUpViewSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        owner: OWNER,
        symbol: 'BTC-PERP',
        actionKey: `auto-top-up-agent:${OWNER}:0x2222222222222222222222222222222222222222`,
        signature: { digest: `0x${'ab'.repeat(32)}`, signature: `0x${'cd'.repeat(65)}`, signedBy: OWNER },
      },
    },
    { verdict: 'refuse', input: { owner: OWNER, symbol: 'BTC-PERP', actionKey: 'a', signature: { digest: '0x1' } } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Turn a position's auto top-up off: no top-up starts again until it is turned on, which starts a new cap. */
export const AUTO_TOP_UP_OFF = defineProcedure({
  ...base,
  name: 'trade.autoTopUp.off',
  kind: 'mutation',
  path: 'autoTopUp.off',
  access: WRITE,
  refusals: refuse({ ...COMMON }),
  input: z.object({ owner, symbol }),
  output: autoTopUpViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, symbol: 'BTC-PERP' } },
    { verdict: 'refuse', input: { owner: OWNER } },
    { verdict: 'refuse', input: {} },
  ],
});
