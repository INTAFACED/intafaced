import { parseAmount, rehydrateLedgerHttpError, type AccountRef, type Amount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { TAX_LEDGER_HISTORY_UNAVAILABLE, TAX_LEDGER_UNWIRED, TaxError } from './codes.js';
import type { Fill } from './lot-book.js';
import { WITHDRAWAL_HOLD_PREFIX } from './withdrawals.js';

export interface HistoryRange {
  readonly from: Date;
  readonly to: Date;
}

export interface HistoryEntry {
  readonly txId: string;
  readonly module: string;
  readonly reason: string;
  readonly direction: 'debit' | 'credit';
  readonly amount: Amount;
  readonly postedAt: Date;
}

/** One fill or convert on a single sub-account. Nulls stay null — never a borrowed basis. */
export interface SubAccountActivityLine {
  readonly id: string;
  readonly kind: 'fill' | 'convert';
  readonly postedAt: Date;
  readonly assetId: string;
  readonly qty: Amount;
  readonly fee: Amount | null;
  readonly makerRebate: Amount | null;
  readonly costBasis: Amount | null;
  readonly proceeds: Amount | null;
}

/** The customer's own trade fills, both legs of each, newest history first read. */
export interface TradeFills {
  readonly fills: Fill[];
  /** True when the read stopped at the page ceiling before the start of history. */
  readonly truncated: boolean;
  /** Assets that reached the available balance other than by a fill or an own-coin return (a deposit, a transfer in, interest). */
  readonly outsideInflows: ReadonlySet<string>;
  /** Each of those arrivals, one per ledger line, so each can be a lot of its own. */
  readonly inflows?: readonly InflowLine[];
  /** What left the available balance other than by a fill (a hold, a withdrawal, a move to a space), one per ledger line. */
  readonly outflows?: readonly AccountLine[];
  /** Each of the customer's withdrawal holds (`withdraw:<id>`) with every line on it: held, settled, put back. */
  readonly withdrawalHolds?: readonly WithdrawalHold[];
}

/** One withdrawal's own hold account and its lines (`withdrawalHoldAccount`, purpose `withdraw:<id>`). */
export interface WithdrawalHold {
  readonly purpose: string;
  readonly lines: readonly AccountLine[];
}

/** One line on one of the customer's accounts. */
export interface AccountLine {
  readonly txId: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly amount: Amount;
  readonly reason: string;
  readonly direction: 'debit' | 'credit';
}

/** Every line on the available balance of the customer's named spaces. */
export interface SpaceHistory {
  readonly lines: ReadonlyArray<AccountLine & { readonly spaceId: string }>;
  /** True when a space's read stopped at the page ceiling before the start of its history. */
  readonly truncated: boolean;
}

/** One arrival on the available balance that was not a fill and not the customer's own coins coming back. */
export interface InflowLine {
  readonly txId: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly amount: Amount;
  readonly reason: string;
}

export interface TaxBalance {
  readonly account: AccountRef;
  readonly accountId: string;
  readonly amount: Amount;
}

export interface TaxLedgerReads {
  balances(ownerType: AccountRef['ownerType'], ownerId: string): Promise<TaxBalance[]>;
  history(account: AccountRef, range: HistoryRange): Promise<HistoryEntry[]>;
  /**
   * Sub-accounts owned by this user, in parent order.
   * Absent on the ledger wire: the history read has no parent index, fee, maker rebate, or cost basis.
   * Both methods must be present or the year pack stays unwired and invents no rows.
   */
  subAccountIds?(userId: string): Promise<readonly string[]>;
  /**
   * The user's trade fills from the ledger's paged history: the received leg from the `available` account, the paying leg
   * from that order's `hold` account, joined on the transaction. Absent = unwired.
   */
  tradeFills?(userId: string): Promise<TradeFills>;
  subAccountActivity?(subAccountId: string, range: HistoryRange): Promise<readonly SubAccountActivityLine[]>;
  /** The available-balance history of each named space (`subaccount` owner = space id). Absent = unwired. */
  spaceHistory?(spaceIds: readonly string[]): Promise<SpaceHistory>;
}

export function unwiredLedgerReads(): TaxLedgerReads {
  const refuse = async (): Promise<never> => {
    throw new TaxError(TAX_LEDGER_UNWIRED, 'LEDGER_URL is unset — tax reads the ledger; it does not invent books');
  };
  return { balances: refuse, history: refuse };
}

export function createTaxLedgerReads(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): TaxLedgerReads {
  const url = baseUrl.replace(/\/$/, '');
  const authHeaders = serviceCallSigner({ service: 'svc-tax', audience: 'svc-ledger', legacySecret: internalSecret, s2s });

  const page = async (body: Record<string, unknown>) =>
    call<{ entries: PageEntry[]; nextCursor: string | null }>(url, '/trpc/historyPage', body, authHeaders);

  // Walk every page of one account scope, newest first, up to a fixed ceiling. A ceiling hit is reported, never silent.
  const walkScope = async (scope: Record<string, unknown>): Promise<{ entries: PageEntry[]; truncated: boolean }> => {
    const entries: PageEntry[] = [];
    let cursor: string | undefined;
    for (let pages = 0; ; pages++) {
      if (pages >= TRADE_FILL_PAGE_CEILING) return { entries, truncated: true };
      const got = await page({ ...scope, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
      entries.push(...got.entries);
      if (got.nextCursor === null) return { entries, truncated: false };
      cursor = got.nextCursor;
    }
  };

  const accounts = (ownerType: AccountRef['ownerType'], ownerId: string) =>
    call<Array<{ accountId: string; assetId: string; kind: string; purpose?: string; amount: string }>>(
      url,
      '/trpc/balances',
      { ownerType, ownerId },
      authHeaders,
    );

  return {
    async balances(ownerType, ownerId) {
      const result = await accounts(ownerType, ownerId);
      return result.map((b) => ({
        account: {
          ownerType,
          ownerId,
          assetId: b.assetId,
          kind: b.kind as AccountRef['kind'],
          ...(typeof b.purpose === 'string' && b.purpose.length > 0 ? { purpose: b.purpose } : {}),
        },
        accountId: b.accountId,
        amount: parseAmount(b.amount),
      }));
    },

    async tradeFills(userId) {
      let truncated = false;
      const walk = async (scope: Record<string, unknown>) => {
        const got = await walkScope(scope);
        if (got.truncated) truncated = true;
        return got.entries;
      };

      try {
        const availableEntries = await walk({ ownerType: 'user', ownerId: userId, kind: 'available' });
        const received = availableEntries.filter((e) => FILL_REASONS.has(e.reason) && e.direction === 'debit');
        const arrivals = availableEntries.filter(
          (e) => e.direction === 'debit' && !FILL_REASONS.has(e.reason) && !OWN_COIN_RETURNS.has(e.reason),
        );
        const outsideInflows = new Set(arrivals.map((e) => e.assetId));
        const inflows: InflowLine[] = arrivals.map((e) => {
          const { direction: _direction, ...line } = lineOf(e);
          return line;
        });
        const outflows: AccountLine[] = availableEntries.filter((e) => e.direction === 'credit' && !FILL_REASONS.has(e.reason)).map(lineOf);
        // Every withdrawal has its own hold account, so its lines pair by account, never by amount or time. The ledger
        // lists every account the customer has, empty ones included.
        const holdPurposes = [
          ...new Set(
            (await accounts('user', userId))
              .filter((a) => a.kind === 'hold' && typeof a.purpose === 'string' && a.purpose.startsWith(WITHDRAWAL_HOLD_PREFIX))
              .map((a) => a.purpose as string),
          ),
        ];
        const withdrawalHolds: WithdrawalHold[] = [];
        for (let i = 0; i < holdPurposes.length; i += HOLD_WALK_PARALLEL) {
          const batch = await Promise.all(
            holdPurposes.slice(i, i + HOLD_WALK_PARALLEL).map(async (purpose) => ({
              purpose,
              lines: (await walk({ ownerType: 'user', ownerId: userId, kind: 'hold', purpose })).map(lineOf),
            })),
          );
          withdrawalHolds.push(...batch);
        }
        const orderIds = [...new Set(received.map((e) => e.orderId).filter((id): id is string => typeof id === 'string' && id !== ''))];
        // Keyed by order AND transaction: a self-trade moves two of the same user's orders in one transaction.
        const paidByLeg = new Map<string, { assetId: string; amount: Amount }>();
        for (let i = 0; i < orderIds.length; i += HOLD_WALK_PARALLEL) {
          await Promise.all(
            orderIds.slice(i, i + HOLD_WALK_PARALLEL).map(async (orderId) => {
              const holds = await walk({ ownerType: 'user', ownerId: userId, kind: 'hold', purpose: `order:${orderId}` });
              for (const e of holds) {
                if (FILL_REASONS.has(e.reason) && e.direction === 'credit') {
                  paidByLeg.set(`${orderId}|${e.txId}`, { assetId: e.assetId, amount: parseAmount(e.amount) });
                }
              }
            }),
          );
        }
        const fills: Fill[] = received.map((e) => ({
          txId: e.txId,
          postedAt: new Date(e.postedAt),
          received: { assetId: e.assetId, amount: parseAmount(e.amount) },
          paid: (typeof e.orderId === 'string' && paidByLeg.get(`${e.orderId}|${e.txId}`)) || null,
          // The ledger names the fee taken from this line (0 when none); a ledger that does not send it leaves it unknown.
          fee: typeof e.fee === 'string' ? parseAmount(e.fee) : null,
        }));
        return { fills, truncated, outsideInflows, inflows, outflows, withdrawalHolds };
      } catch (err) {
        if (err instanceof TaxError) throw err;
        throw new TaxError(TAX_LEDGER_HISTORY_UNAVAILABLE, err instanceof Error ? err.message : 'ledger history read failed');
      }
    },

    async spaceHistory(spaceIds) {
      try {
        let truncated = false;
        const lines: Array<AccountLine & { spaceId: string }> = [];
        // A few spaces at a time, like the hold reads.
        for (let i = 0; i < spaceIds.length; i += HOLD_WALK_PARALLEL) {
          const pages = await Promise.all(
            spaceIds.slice(i, i + HOLD_WALK_PARALLEL).map(async (spaceId) => ({
              spaceId,
              got: await walkScope({ ownerType: 'subaccount', ownerId: spaceId, kind: 'available' }),
            })),
          );
          for (const { spaceId, got } of pages) {
            if (got.truncated) truncated = true;
            for (const e of got.entries) lines.push({ ...lineOf(e), spaceId });
          }
        }
        return { lines, truncated };
      } catch (err) {
        if (err instanceof TaxError) throw err;
        throw new TaxError(TAX_LEDGER_HISTORY_UNAVAILABLE, err instanceof Error ? err.message : 'ledger history read failed');
      }
    },

    async history(account, range) {
      try {
        const result = await call<
          Array<{ txId: string; module: string; reason: string; direction: 'debit' | 'credit'; amount: string; postedAt: string }>
        >(url, '/trpc/history', { account, from: range.from.toISOString(), to: range.to.toISOString() }, authHeaders);
        return result.map((e) => ({
          txId: e.txId,
          module: e.module,
          reason: e.reason,
          direction: e.direction,
          amount: parseAmount(e.amount),
          postedAt: new Date(e.postedAt),
        }));
      } catch (err) {
        if (err instanceof TaxError) throw err;
        throw new TaxError(TAX_LEDGER_HISTORY_UNAVAILABLE, err instanceof Error ? err.message : 'ledger history read failed');
      }
    },
  };
}

interface PageEntry {
  txId: string;
  reason: string;
  direction: 'debit' | 'credit';
  amount: string;
  postedAt: string;
  assetId: string;
  orderId?: string | null;
  /** On the customer's receiving line of a fill: the fee taken from it. */
  fee?: string | null;
}

function lineOf(e: PageEntry): AccountLine {
  return {
    txId: e.txId,
    postedAt: new Date(e.postedAt),
    assetId: e.assetId,
    amount: parseAmount(e.amount),
    reason: e.reason,
    direction: e.direction,
  };
}

/** Entries per ledger page (the door's maximum). */
const PAGE_LIMIT = 200;
/**
 * Ledger reasons for a customer's side of a spot, convert or OTC fill: the second is a fill against a house quote, the
 * third a customer maker's sale to the token buyback (`recipes.buybackTakerFill`).
 */
const FILL_REASONS: ReadonlySet<string> = new Set(['trade.fill', 'trade.fill.mm_maker', 'trade.fill.buyback']);
/** Reasons that put the customer's own coins back on available (a released hold, a reversed withdrawal): not new coins. */
const OWN_COIN_RETURNS: ReadonlySet<string> = new Set([
  'order.hold.released',
  'order.hold.mm.released',
  'withdraw.reversed',
  'futures.margin.release',
  'token.unstake',
  // An earn position's principal leaves the customer's own stake account and comes back here: their coins, not new ones.
  'bank.earn.withdrawn',
  // An overcharged trading fee given back: coins the customer already had.
  'trade.fill.fee.correction',
]);
/** Hold reads (an order's, a withdrawal's) run this many at a time. */
const HOLD_WALK_PARALLEL = 8;
/** A technical read bound, not a business limit: 200 pages of 200 entries per scope. Past it the book says it is incomplete. */
const TRADE_FILL_PAGE_CEILING = 200;

type LedgerSigner = ReturnType<typeof serviceCallSigner>;

async function call<T>(base: string, path: string, body: unknown, auth: LedgerSigner): Promise<T> {
  const payload = JSON.stringify(body);
  const target = `${base}${path}`;
  const response = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...auth(payload, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
    },
    body: payload,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw rehydrateLedgerHttpError(path, response.status, detail);
  }

  return (await response.json()) as T;
}
