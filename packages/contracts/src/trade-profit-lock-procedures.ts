import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-trade's Profit lock on the person's own venue account (J-wallet-26; svc-trade src/venue/profit-lock.ts). The person
 * sets a weekly target for the account's realised profit, as the venue reports it on its own fills, a share of that
 * profit to lock, and their own cold wallet's address. Once a week, when the week's realised profit reaches the target,
 * one "Profit lock ready" message goes out, and the person is offered one venue withdrawal of the share to the cold
 * wallet, signed by their own main wallet through the venue door (never an agent key), or they close the offer and
 * nothing moves. INTAFACED holds, moves and signs nothing, and the ledger posts nothing.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;
const WRITE = { caller: 'scope', scope: 'trade:write', module: 'trade' } as const;

const decimal = z.string().regex(/^-?[0-9]+(\.[0-9]+)?$/);
/** A figure typed by the person: the service names a malformed field in its refusal. */
const typed = z.string().max(64);
const owner = z.string().max(64);
/** A known figure, or `known: false` where the venue publishes none (shown as "not known", never 0). */
const maybeKnown = z.union([z.object({ known: z.literal(true), value: decimal }), z.object({ known: z.literal(false) })]);

export const PROFIT_LOCK_OFFER_STATES = ['ready', 'declined', 'signed'] as const;

/** One week's offer: what the message named, and where it stands. */
export const profitLockOfferSchema = z.object({
  /** The business key the one message is filed under: `profit-lock:<user>:<venue>:<owner>:<week start>`. */
  offerKey: z.string(),
  weekFrom: z.string(),
  /** The week's realised profit as the venue reported it when the target was reached. */
  profit: decimal,
  target: decimal,
  /** In percent. */
  share: decimal,
  /** The share of `profit`, in the asset, rounded down to the asset's smallest unit. */
  amount: decimal,
  coldWallet: z.string(),
  state: z.enum(PROFIT_LOCK_OFFER_STATES),
  /** The withdrawal's own key at the venue door: one key per offer, so a retry or a double press is the same withdrawal. */
  withdrawalKey: z.string(),
  /** The signed withdrawal's nonce at the venue, once the person signed it. */
  nonce: z.string().nullable(),
  at: z.string(),
});

/** The withdrawal as it would be filled in now: the venue's terms and figures, read when the view was. */
export const profitLockWithdrawalSchema = z.object({
  /** What is asked: the offer's amount, cut to what the venue lets the account withdraw. */
  amount: decimal,
  /** True when the offer's amount was above what the venue lets the account withdraw, and was cut to it. */
  cut: z.boolean(),
  /** The venue's free balance of the asset, as it reports it. */
  free: decimal,
  /** What the venue lets the account withdraw: its free balance less its withdrawal fee, which it charges on top. */
  withdrawable: decimal,
  /** The venue's withdrawal fee, charged on top of the amount. */
  fee: maybeKnown,
  networkFee: maybeKnown,
  asOf: z.string(),
});

const venueSchema = z.object({ id: z.string(), name: z.string(), test: z.boolean() });

/** The person's Profit lock on one venue account, as they read it. */
export const profitLockViewSchema = z.object({
  venue: venueSchema,
  owner: z.string(),
  asset: z.string(),
  /** The lock's own id (the TEST clock ages it); `null` while nothing is set. */
  lockId: z.string().nullable(),
  setting: z.object({ target: decimal, share: decimal, coldWallet: z.string(), savedAt: z.string() }).nullable(),
  /** This week, as the venue reports it; `readable: false` names a read that failed, never a week with no profit. */
  week: z.object({
    from: z.string(),
    readable: z.boolean(),
    /** The week's realised profit from the venue's fills; `null` when the venue could not be read. */
    profit: decimal.nullable(),
    asOf: z.string().nullable(),
    /** The last time the venue was read for this lock; `null` before the first read. */
    lastReadAt: z.string().nullable(),
  }),
  /** This week's offer, or `null` before the target is reached (and while the venue can't be read). */
  offer: profitLockOfferSchema.nullable(),
  /** The withdrawal filled in for a ready offer; `null` otherwise. */
  withdrawal: profitLockWithdrawalSchema.nullable(),
});

const refuse = (map: Record<string, 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE'>): Refusals =>
  Object.freeze(map);

const COMMON = {
  'trade.profit_lock_unavailable': 'SERVICE_UNAVAILABLE',
  'trade.profit_lock_request_invalid': 'BAD_REQUEST',
} as const;

const OWNER = '0x1111111111111111111111111111111111111111';
const COLD = '0x2222222222222222222222222222222222222222';

/** The Profit lock on the venue account: its setting, this week's realised profit as the venue reports it, and any offer. */
export const PROFIT_LOCK_GET = defineProcedure({
  ...base,
  name: 'trade.profitLock.get',
  kind: 'query',
  path: 'profitLock.get',
  access: READ,
  refusals: refuse({ ...COMMON }),
  input: z.object({ owner }),
  output: profitLockViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER } },
    { verdict: 'refuse', input: {} },
  ],
});

/**
 * Set the weekly target, the share to lock and the cold wallet (J-wallet-26 #1). An INTAFACED address, or one whose
 * checksum shows a typing mistake, is refused naming why.
 */
export const PROFIT_LOCK_SET = defineProcedure({
  ...base,
  name: 'trade.profitLock.set',
  kind: 'mutation',
  path: 'profitLock.set',
  access: WRITE,
  refusals: refuse({
    ...COMMON,
    'trade.profit_lock_field_invalid': 'BAD_REQUEST',
    'trade.profit_lock_address_ours': 'BAD_REQUEST',
    'trade.profit_lock_address_mistyped': 'BAD_REQUEST',
  }),
  input: z.object({ owner, target: typed, share: typed, coldWallet: typed }),
  output: profitLockViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, target: '200', share: '50', coldWallet: COLD } },
    { verdict: 'refuse', input: { owner: OWNER, target: '200' } },
    { verdict: 'refuse', input: {} },
  ],
});

/** Close this week's offer without signing (J-wallet-26 #5): nothing is signed or sent, and it is not offered again. */
export const PROFIT_LOCK_DECLINE = defineProcedure({
  ...base,
  name: 'trade.profitLock.decline',
  kind: 'mutation',
  path: 'profitLock.decline',
  access: WRITE,
  refusals: refuse({ ...COMMON, 'trade.profit_lock_no_offer': 'CONFLICT' }),
  input: z.object({ owner, offerKey: z.string().min(1).max(256) }),
  output: profitLockViewSchema,
  samples: [
    { verdict: 'accept', input: { owner: OWNER, offerKey: `profit-lock:u:test-venue-sim:${OWNER}:2026-11-23T00:00:00.000Z` } },
    { verdict: 'refuse', input: { owner: OWNER, offerKey: '' } },
    { verdict: 'refuse', input: {} },
  ],
});
