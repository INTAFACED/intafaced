import { z } from 'zod';
import { GLOBAL_HOLD_STATES } from './bank-global-procedures.js';
import { LINKED_ACCOUNT_STATES, LINKED_ACCOUNT_BLOCKERS } from './bank-cash-out-procedures.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** The schemas svc-bank's records share, copied from the service's router while its Rust port is in flight (the router keeps its own until the port's switch). */

export const limitField = z.number().int().min(1).max(100).optional();

export const holdState = z.enum(GLOBAL_HOLD_STATES);

export const operatorHoldView = z.object({
  id: z.string(),
  sendId: z.string(),
  state: holdState,
  reason: z.string(),
  heldBy: z.string(),
  infoRequest: z.string().nullable(),
  proof: z.object({ name: z.string(), type: z.string(), size: z.number(), sha256: z.string(), uploadedAt: z.string() }).nullable(),
  releasedBy: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * Customer doors for /pay/bills and /pay/global.
 *
 * Reads are `bank:read`. Money instructions are `bank:write`. Founder counts
 * are `admin:read` and are refused to a session that only holds bank scopes.
 * `runDue` is the svc-bank job, not a customer.
 */
export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

/**
 * RAMPS — crypto ledger half. Fiat is socket.psp-partners commercially.
 * Kind fiat refuses `bank.fiat_ramp_socket` before any row or ledger post.
 *
 * `simulated` is never omitted: this surface does not broadcast to a chain and
 * never claims a live PSP. Live confirmation stays in svc-pay; Class X is a
 * human decision to point working code at real money.
 */
export const rampProgrammeOutput = z.object({
  id: z.string(),
  simulated: z.boolean(),
  displayName: z.string(),
  cryptoRail: z.string().nullable(),
  fiatLeg: z.literal('socket.psp-partners'),
  fiatVia: z.literal('svc-pay.RailAdapter'),
});

export const destinationViewOutput = z.object({
  destinationId: z.string(),
  label: z.string().nullable(),
  kind: z.enum(['crypto', 'bank']),
  ref: z.string(),
  refMasked: z.string(),
  assetId: z.string().nullable(),
  network: z.string().nullable(),
  tag: z.string().nullable(),
  origin: z.enum(['legacy', 'customer']),
  state: z.enum(['pending', 'cooling', 'active', 'blocked', 'archived']),
  addedAt: z.string(),
  coolingOffEndsAt: z.string().nullable(),
  coolingBlocker: z.literal('bank.offramp_cooling_unset').nullable(),
  lookalikeConfirmedAt: z.string().nullable(),
  ownership: z
    .object({
      state: z.enum(['none', 'pending', 'verified', 'expired']),
      verifiedAt: z.string().nullable(),
      validUntil: z.string().nullable(),
      offerExpiresAt: z.string().nullable(),
    })
    .strict(),
  approvedAt: z.string().nullable(),
  approvedBy: z.enum(['link', 'device']).nullable(),
  approvalLinkExpiresAt: z.string().nullable(),
});

export const billView = z.object({
  id: z.string(),
  billerId: z.string(),
  reference: z.string(),
  amount: amountString,
  assetId: z.string(),
  fromSpaceId: z.string(),
  status: z.enum(['submitted', 'accepted', 'paid', 'failed', 'returned']),
  failureCode: z.string().nullable(),
  failureBlocker: z.string().nullable(),
  providerRef: z.string().nullable(),
  ledgerTxId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** `pay_by_bank` is a hosted bank-payment page, like card and wallet: the partner returns where to pay. */
export const ONRAMP_METHODS = ['card', 'bank_transfer', 'pay_by_bank', 'wallet_pay'] as const;

export const rail = z.enum(['rail.bank', 'rail.card']);

export const onramp = z.object({
  onrampId: z.string(),
  quoteId: z.string(),
  method: z.enum(ONRAMP_METHODS),
  /** What the person receives, in `assetId`: the quote's receive amount. */
  assetId: z.string(),
  amount: z.string(),
  payAmount: z.string(),
  fee: z.string(),
  payCurrency: z.string(),
  status: z.literal('pending_payment'),
  partnerRail: z.string(),
  hostedUrl: z.string().nullable(),
  bankInstructions: z.object({ reference: z.string(), accountName: z.string(), accountRef: z.string() }).nullable(),
});

export const request = z.object({
  requestId: z.string(),
  assetId: z.string(),
  amount: z.string(),
  method: z.enum(ONRAMP_METHODS),
  country: z.string(),
  rail,
  status: z.enum(['opening', 'refused', 'opened', 'pending', 'credited', 'returned', 'delivered']),
  refusalCode: z.string().nullable(),
  onramp: onramp.nullable(),
  createdAt: z.string(),
  openedAt: z.string().nullable(),
  pendingAt: z.string().nullable(),
  creditedAt: z.string().nullable(),
  creditedAmount: z.string().nullable(),
  creditedBy: z.enum(['ledger', 'partner']).nullable(),
  returnedAt: z.string().nullable(),
  walletAddress: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  deliveryTx: z.string().nullable(),
});

/**
 * `bank.linkedAccounts.list/link/remove` (BK-acct-02, J-bank-02 #6): the customer's own accounts at other banks
 * (`./linked-accounts.ts`). Linking and removing take `trade:withdraw`, the step-up scope, as saving a withdrawal address
 * does: a leaked key or a stolen access token must not be able to add the account that money is later paid out to.
 */
export const account = z
  .object({
    accountId: z.string().guid(),
    label: z.string(),
    holderName: z.string(),
    ibanMasked: z.string(),
    country: z.string(),
    state: z.enum(LINKED_ACCOUNT_STATES),
    usable: z.boolean(),
    blocker: z.enum(LINKED_ACCOUNT_BLOCKERS).nullable(),
    verificationRail: z.literal('rail.bank').nullable(),
    linkedAt: z.string(),
    coolingOffEndsAt: z.string().nullable(),
  })
  .strict();

export const plan = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.string(),
  price: z.string(),
  assetId: z.string(),
  period: z.literal('month'),
});

/**
 * J-wallet-01 #3: what a partner-held person can withdraw from their main balance at the partner, and what the partner
 * still holds back of their purchases, with each hold's release time and each release once. Every figure is the
 * partner's. A partner that does not report its holds is `reported: false`: what is held back, and so what can be
 * withdrawn, is "not reported by the partner", never 0. `held: false` is a person the partner holds no money for.
 */
export const hold = z.object({
  id: z.string(),
  assetId: z.string(),
  amount: z.string(),
  paidBy: z.enum(['card', 'bank_pull']),
  releaseAt: z.string(),
});

export const legView = z.object({
  position: z.number().int(),
  spaceId: z.string(),
  amount: z.string(),
  status: z.enum(['pending', 'settled', 'rejected', 'unsplit']),
  moveId: z.string().nullable(),
  rejectionCode: z.string().nullable(),
  unsplitMoveId: z.string().nullable(),
});

export const salaryCreditView = z.object({
  networkId: z.string(),
  assetId: z.string(),
  amount: z.string(),
  originatorName: z.string(),
  state: z.enum(['pending', 'received', 'returned', 'reversed']),
  refusalCode: z.string().nullable(),
  creditMoveId: z.string().nullable(),
  reversalMoveId: z.string().nullable(),
  createdAt: z.string(),
  receivedAt: z.string().nullable(),
  reversedAt: z.string().nullable(),
  legs: z.array(legView),
});

export const pot = z.object({ id: z.string(), name: z.string(), assetId: z.string() });

export const card = z.object({
  cardId: z.string(),
  panTail: z.string(),
  status: z.enum(['active', 'frozen', 'closed']),
  frozenBy: z.enum(['owner', 'holder', 'operator']).nullable(),
});

export const person = z.object({ userId: z.string(), handle: z.string().nullable() });

export const SHARED_POT_ROLES = ['contributor', 'viewer'] as const;

export const role = z.enum(SHARED_POT_ROLES);

export const member = person.extend({ role, joinedAt: z.string() });

export const invite = z.object({
  inviteId: z.string(),
  spaceId: z.string(),
  role,
  createdAt: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
});

export const SHARED_POT_ACTIVITY_KINDS = [
  'invited',
  'cancelled',
  'joined',
  'declined',
  'left',
  'removed',
  'card_linked',
  'card_unlinked',
  'card_frozen',
  'card_unfrozen',
] as const;

/** What a statement file holds. */
export const STATEMENT_REPORTS = ['statement', 'ledger', 'trades', 'balances'] as const;

/**
 * `bank.statements.export` — a signed CSV or a one-month PDF of the caller's
 * own posted lines, plus a proof object that names the holder, the period and
 * the file hash. It does not state a balance.
 */
export const lineTotalOutput = z.object({
  asset: z.string(),
  net: z.string().regex(/^-?\d+(\.\d{1,18})?$/),
  lines: z.number().int().nonnegative(),
});

export const statementOutput = z.object({
  format: z.enum(['csv', 'pdf']),
  filename: z.string(),
  contentType: z.string(),
  bodyBase64: z.string(),
  sha256: z.string(),
  signature: z.string(),
  rowCount: z.number().int().nonnegative(),
  /** Per asset, the net of the file's lines; the same fold as `activity.totals`. Not a balance. */
  totals: z.array(lineTotalOutput).optional(),
  generatedAt: z.string().datetime(),
  proof: z.object({
    holderUserId: z.string().guid(),
    from: z.string(),
    to: z.string(),
    assetId: z.string().nullable(),
    spaceId: z.string().nullable(),
    report: z.enum(['statement', 'ledger', 'trades']),
    rowCount: z.number().int().nonnegative(),
    generatedAt: z.string().datetime(),
    sha256: z.string(),
  }),
});

export const requestInput = z
  .object({
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    assetId: z.string().min(1).max(16).optional(),
    spaceId: z.string().guid().optional(),
    format: z.enum(['csv', 'pdf']),
    report: z.enum(STATEMENT_REPORTS).optional(),
  })
  .strict();

export const jobOutput = z.object({
  id: z.string().guid(),
  report: z.enum(['statement', 'ledger', 'trades']),
  format: z.enum(['csv', 'pdf']),
  from: z.string(),
  to: z.string(),
  assetId: z.string().nullable(),
  spaceId: z.string().nullable(),
  state: z.enum(['queued', 'rendering', 'ready', 'failed']),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  filename: z.string().nullable(),
  sha256: z.string().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  errorCode: z.string().nullable(),
});

export const accountId = z.string().guid();

export const period = { from: z.string().datetime(), to: z.string().datetime() };

export const accountInput = z.object({ accountId: z.string().guid() }).strict();

/** REGISTRY_ASSET_KINDS in contracts' `asset-registry.ts`, written out: that file is not browser-safe. */
export const REGISTRY_ASSET_KINDS = ['crypto', 'fiat', 'native', 'commodity'] as const;

/** ASSET_ACTIONS in contracts' `asset-registry.ts`, written out: that file is not browser-safe. */
export const ASSET_ACTIONS = ['deposit', 'withdraw', 'trade', 'transfer'] as const;

/** ASSET_STATES in contracts' `asset-registry.ts`, written out: that file is not browser-safe. */
export const ASSET_STATES = ['active', 'halted', 'retired'] as const;

/** Full-precision signed decimal string (a per-asset value or price move). */
export const signedAmountString = z.string().regex(/^-?\d+(\.\d{1,18})?$/);

/**
 * ALLOCATION (PF-balances-02). The priced holdings of the total-value rule, grouped; nothing new is priced here.
 *
 * Class comes from svc-ledger's asset registry (`kinds`, asset id -> registry kind): `fiat`, `crypto` (crypto and the native
 * token) and `commodity`, except the par assets USDT and USDC, which are `stablecoin` by their code. What sits in the bank's
 * earn positions is `earn`, whatever the coin (a token stake stays in its coin's class). An asset the registry does not list (its precision is
 * not published) has no class: it lands in `unclassified`, named, and still counts in the total. With no registry to read
 * (`kinds` null) the classes are left out and `classesRefused` says why; the places do not need it and are still given. An asset with no price is
 * not in any share (the same rule as the total) and is listed apart under `unpriced`. Type is where the money sits:
 * `available` (spendable) or `locked` (order, escrow, stake, loan collateral), from the same holdings. Each grouping adds
 * up to `totalValueUsd` exactly; a share is value / total at 18 places, so shares can differ from 1 by the last place.
 */
export const ALLOCATION_CLASSES = ['fiat', 'stablecoin', 'crypto', 'commodity', 'earn', 'unclassified'] as const;

export const ALLOCATION_TYPES = ['available', 'locked'] as const;

export const allocationOutput = z.object({
  totalValueUsd: signedAmountString,
  classes: z.array(
    z.object({
      class: z.enum(ALLOCATION_CLASSES),
      valueUsd: signedAmountString,
      share: signedAmountString,
      assets: z.array(z.object({ asset: z.string(), valueUsd: signedAmountString, share: signedAmountString })),
    }),
  ),
  /** Set when the classes could not be worked out (the asset registry could not be read); `classes` is then empty. */
  classesRefused: z.literal('bank.asset_registry_unavailable').nullable(),
  types: z.array(z.object({ type: z.enum(ALLOCATION_TYPES), valueUsd: signedAmountString, share: signedAmountString })),
  unpriced: z.array(z.object({ asset: z.string(), amount: z.string(), reason: z.enum(['no_market', 'no_price_yet']) })),
  asOf: z.number().int(),
});

export const balanceEntriesOutput = z.object({
  assetId: z.string(),
  entries: z.array(
    z.object({
      entryId: z.string().nullable(),
      txId: z.string(),
      accountId: z.string(),
      reason: z.string(),
      direction: z.enum(['debit', 'credit']),
      amount: signedAmountString,
      postedAt: z.string(),
      state: z.literal('completed'),
      fee: z
        .string()
        .regex(/^\d+(\.\d{1,18})?$/)
        .nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
  sumCheck: z.object({ ok: z.literal(true), entriesSum: signedAmountString, balance: signedAmountString, entryCount: z.number().int() }),
});

/** 2-decimal USD figure on the wire. May be negative (a price move). */
export const usd2String = z.string().regex(/^-?\d+\.\d{2}$/);

export const portfolioSummaryOutput = z.object({
  totalUsd: usd2String.nullable(),
  change24hUsd: usd2String.nullable(),
  cashUsd: usd2String.nullable(),
  cryptoUsd: usd2String.nullable(),
  priced: z.array(
    z.object({
      asset: z.string(),
      amount: z.string(),
      priceUsd: z.string(),
      valueUsd: z.string(),
      change24hUsd: signedAmountString.nullable(),
      pair: z.string().nullable(),
    }),
  ),
  unpriced: z.array(z.object({ asset: z.string(), amount: z.string(), reason: z.enum(['no_market', 'no_price_yet']) })),
  asOf: z.number().int(),
  windowStart: z.number().int().nullable(),
  /** Only when `valueIn` is `btc`. Both fields are null, with a reason, while no BTC price is published. */
  btc: z
    .object({
      total: z.string().nullable(),
      priceUsd: z.string().nullable(),
      reason: z.enum(['no_price_published', 'nothing_priced']).nullable(),
    })
    .optional(),
});

export const balanceBreakdownOutput = z.object({
  assets: z.array(
    z.object({
      assetId: z.string(),
      total: signedAmountString,
      available: signedAmountString,
      locked: z.array(
        z.object({
          kind: z.string(),
          amount: signedAmountString,
          claims: z.array(z.object({ purpose: z.string(), amount: signedAmountString })),
        }),
      ),
    }),
  ),
});
