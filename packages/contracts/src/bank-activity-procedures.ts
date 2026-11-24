import { z } from 'zod';
import { defineProcedure } from './procedure.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `activity.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const ACTIVITY_MAX_LIMIT = 200;

export const ACTIVITY_DEFAULT_LIMIT = 50;

/**
 * ACTIVITY KIND — which ledger `module`/`reason` is which thing a person calls it.
 *
 * ONE FILE, ONE TABLE. `bank.activity.list` shows the ledger's own words as
 * typed rows ("Deposit", "Fee", "Trade"). The ledger's reasons are a permanent
 * record and must not change to suit a screen, so the screen's vocabulary lives
 * here and nowhere else. Every row has a test (`activity-kind.test.ts`).
 *
 * UNKNOWN IS `other`, NEVER DROPPED. A history that quietly left out a posting
 * it did not recognise would be a plausible list with money missing from it.
 *
 * DIRECTION. The book's convention is "debit increases the account, credit
 * decreases it" (analytics/ledger-history.ts). The feed reads the user's
 * `available` accounts, so a debit is money IN and a credit is money OUT.
 *
 * INVENTORY (grep of every ledger posting site on the tip this was written on):
 *   packages/ledger-client/src/recipes/index.ts   deposit 83-84, mm seed 119-120, withdraw 131-165,
 *     trade.fill 266-267, order.hold 292-347, mm fill 417-418, futures 451-620, p2p 648-715,
 *     pay 758-877, token 897-957, fee.charged 990/1014 (any module), token.fee.swept 1050-1051,
 *     rewardPay 1062-1063 (reason supplied by the caller)
 *   packages/ledger-client/src/recipes/bank.ts    transfer 95-96, earn 125-290, business 334-439
 *   packages/ledger-client/src/recipes/loans.ts   loan.* 125-485
 *   packages/ledger-client/src/recipes/chargeback.ts 200-353, market.ts 117-198,
 *     sub-accounts.ts 79-80, order-hold-amend.ts 45-46
 *   services/svc-bank/src/cards/card-service.ts:1095    rewardPay reason 'bank.card.cashback'
 *   services/svc-token/src/token-service.ts:1072        rewardPay reason 'token.yield.distributed'
 *
 * ORDER HOLD vs RELEASE. Classified only from the ledger's own `module/reason`
 * (`trade / order.hold`, `order.hold.amend`, `order.hold.released`), never from
 * amounts or timing. Spot orders and Convert post the same recipes.
 * A fill spends from the hold account, not `available`, so fill legs stay `trade`.
 * Added after the first six-kind release: a client that does not know these two
 * kinds must treat an unknown kind as `other`.
 *
 * DEPOSIT vs WELCOME FUNDS. A real deposit and a local-test grant both post
 * `ledger / deposit.credited`; only the post's rail tells them apart. The ledger
 * page returns that rail (allow-listed: crypto-native, card-sandbox,
 * bank-crypto-ledger, local-test, else null). `local-test` is `welcome_funds`;
 * an unknown rail, or a ledger that does not send one yet, stays `deposit`.
 *
 * EARN, STAKING, REWARD. Added after the order kinds (PF-activity-01), from the reasons the book already
 * posts: `bank.earn.*` is earn, `token.stake`/`token.unstake` is staking, `token.yield.distributed`, card
 * cashback and any `reward*` or `token.yield*` reason is reward. Dividends and corporate actions have no ledger
 * reason on this platform and are not invented. A client that does not know these kinds treats them as `other`.
 *
 * CONVERT vs TRADE. A Convert settles as a house fill (`trade / trade.fill.mm_maker`), the same reason a desk order
 * filled against the house maker posts. The fill's own `meta.product = 'convert'` (set by svc-trade convert/settle.ts,
 * echoed allow-listed by the ledger's history page as `product`) is what tells them apart: a fill that says it is a
 * convert is `convert`; every other fill stays `trade`. Its hold and any release stay order lines. Added after the earn
 * kinds (PF-activity-01); a client that does not know it treats it as `other`.
 */
export const ACTIVITY_KINDS = [
  'deposit',
  'welcome_funds',
  'transfer_in',
  'transfer_out',
  'trade',
  'convert',
  'fee',
  'payment',
  'withdrawal',
  'space_move',
  'order_hold',
  'order_release',
  'earn',
  'staking',
  'reward',
  'other',
] as const;

/**
 * `bank.activity.list` (UI-SPEC U5b) — the signed-in user's merged money history.
 *
 * Self-only: the owner is `ctx.principal.userId`. There is no input that names a
 * user, an owner or a Space, and `.strict()` refuses a smuggled one instead of
 * stripping it. In its own file so `router.ts` carries one import and one mount line.
 */
export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/);

export const activityListInput = z
  .object({
    limit: z.number().int().min(1).max(ACTIVITY_MAX_LIMIT).default(ACTIVITY_DEFAULT_LIMIT),
    cursor: z.string().min(1).max(16_384).optional(),
    assetId: assetIdSchema.min(1).max(16).optional(),
    kind: z.array(z.enum(ACTIVITY_KINDS)).min(1).max(ACTIVITY_KINDS.length).optional(),
    direction: z.enum(['in', 'out']).optional(),
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    q: z.string().trim().min(1).max(80).optional(),
    minAmount: amountString.optional(),
    maxAmount: amountString.optional(),
    /** Oldest first or newest first (the default). */
    sort: z.enum(['asc', 'desc']).optional(),
    /** `main` for the account itself, or the id of one named Space. */
    accountId: z.union([z.literal('main'), z.string().guid()]).optional(),
    /** A UTC calendar year. */
    year: z.number().int().min(1970).max(2200).optional(),
    /** A tax year. Its start date is an owner value that is not set, so this refuses `portfolio.tax_year_start_unset`. */
    taxYear: z.number().int().min(1970).max(2200).optional(),
    /** Part of a withdrawal address. Lines with no recorded address never match. */
    address: z.string().trim().min(4).max(128).optional(),
    /** Only lines the caller has put a note or a report description on. */
    hasNote: z.boolean().optional(),
  })
  .strict();

export const activityItem = z.object({
  id: z.string(),
  kind: z.enum(ACTIVITY_KINDS),
  direction: z.enum(['in', 'out']),
  asset: z.string(),
  amount: amountString,
  postedAt: z.string().datetime(),
  txId: z.string(),
  counterparty: z.object({ handle: z.string() }).nullable(),
  spaceName: z.string().nullable(),
  /** Present only when the ledger links the line to the user's own trade order. Omitted otherwise. */
  orderId: z.string().min(1).max(128).optional(),
  /** True on the line that brought in an asset the customer bought. Omitted on every other line. */
  purchase: z.literal(true).optional(),
  /** Transfer note both parties can read. Omitted when the transfer had none. */
  note: z.string().min(1).max(140).optional(),
  /** Payment reference both parties can read. */
  reference: z.string().min(1).max(64).optional(),
  /** This caller's private note. */
  privateNote: z.string().max(500).optional(),
  /** This caller's description for a report or a statement. */
  reportDescription: z.string().max(500).optional(),
  dispute: z.object({ id: z.string().guid(), status: z.literal('open'), reason: z.string().max(500) }).optional(),
  /** The crypto address a withdrawal went to, when one was recorded. Omitted on every other line. */
  address: z.string().min(1).max(256).optional(),
  /** Set on a line the partner bank reports: whose record it is, TEST on the TEST partner. */
  heldAt: z.object({ label: z.string() }).optional(),
  /**
   * On a personal send, the payment's fees as the bank recorded them when it was made: our fee, and the network fee
   * the book that moved it stated ("0" on our own book; null when the partner gave none). Omitted on every other line.
   */
  fees: z.object({ fee: amountString.nullable(), networkFee: amountString.nullable() }).optional(),
});

export const activityListOutput = z.object({ items: z.array(activityItem), nextCursor: z.string().nullable() });

export const BANK_ACTIVITY_LIST = defineProcedure({
  ...base,
  name: 'bank.activity.list',
  kind: 'query',
  path: 'activity.list',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: activityListInput,
  output: activityListOutput,
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Lines grouped by how they are taxed. Refuses while the owner has not set the effect of each kind; on a test stack
 * with the TEST map chosen, answers that map labelled `TEST` (`activity/tax-effects.ts`).
 */
export const BANK_ACTIVITY_TAX_EFFECTS = defineProcedure({
  ...base,
  name: 'bank.activity.taxEffects',
  kind: 'query',
  path: 'activity.taxEffects',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({}).strict(),
  output: z.object({ effects: z.record(z.string(), z.string()), label: z.literal('TEST').nullable() }),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});
