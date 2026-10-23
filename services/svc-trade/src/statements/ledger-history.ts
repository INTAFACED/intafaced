import { createLedgerTransport, formatAmount, parseAmount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/**
 * A person's ledger history, read from svc-ledger (`/trpc/historyPage`), never from its tables.
 *
 * One page is the newest lines first on the person's `available` accounts (every asset, or one): each line is one
 * balance change with the ledger's own references (the transaction id and the entry id). The sum of a person's lines in
 * one asset is that asset's free balance, the number the balances read calls `free`; what an open order holds sits in a
 * hold account and shows here as the line that moved it out of `available`. A read only: nothing here posts.
 *
 * A failure is thrown, never turned into an empty page: "no history" and "we could not ask" must not look alike.
 */
export interface LedgerLine {
  readonly entryId: string;
  readonly txId: string;
  readonly module: string;
  readonly reason: string;
  readonly direction: 'debit' | 'credit';
  readonly amount: string;
  readonly postedAt: Date;
  readonly assetId: string;
  readonly orderId: string | null;
}

export interface LedgerPage {
  readonly entries: readonly LedgerLine[];
  readonly nextCursor: string | null;
}

export interface LedgerPageRequest {
  readonly userId: string;
  readonly assetId?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface LedgerPages {
  page(request: LedgerPageRequest): Promise<LedgerPage>;
}

/** The ledger's own page cap (`HISTORY_PAGE_MAX_LIMIT`). */
export const LEDGER_PAGE_MAX = 200;

/** A history read scans a range of the book: 8s per attempt, one retry, 12s for the call (as svc-bank's). */
const HISTORY_BUDGET = { timeoutMs: 8_000, retries: 1, deadlineMs: 12_000 } as const;

type WireLine = {
  txId: string;
  module: string;
  reason: string;
  direction: 'debit' | 'credit';
  amount: string;
  postedAt: string;
  assetId: string;
  entryId?: string;
  orderId?: string | null;
};

export function createLedgerPages(
  baseUrl: string,
  internalSecret: string,
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode },
): LedgerPages {
  const call = createLedgerTransport({
    baseUrl,
    sign: serviceCallSigner({ service: 'svc-trade', audience: 'svc-ledger', legacySecret: internalSecret, s2s }),
    fetch: (input, init) => globalThis.fetch(input, init),
    ...HISTORY_BUDGET,
  });
  return {
    async page(request) {
      // The ledger's schema is strict: exactly these keys, nothing else.
      const body = {
        ownerType: 'user',
        ownerId: request.userId,
        kind: 'available',
        ...(request.assetId === undefined ? {} : { assetId: request.assetId }),
        limit: request.limit,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      };
      const answer = await call<{ entries: WireLine[]; nextCursor: string | null }>('/trpc/historyPage', body);
      return { entries: answer.entries.map(readLine), nextCursor: answer.nextCursor };
    },
  };
}

/** One wire line, checked: a line without an entry id, or with an amount or time that does not parse, is refused. */
export function readLine(e: WireLine): LedgerLine {
  if (typeof e.entryId !== 'string' || !/^\d{1,19}$/.test(e.entryId)) throw new Error('svc-ledger history line has no entry id');
  if (e.direction !== 'debit' && e.direction !== 'credit') throw new Error('svc-ledger history line has no direction');
  const postedAt = new Date(e.postedAt);
  if (Number.isNaN(postedAt.getTime())) throw new Error('svc-ledger history line has no posting time');
  return {
    entryId: e.entryId,
    txId: e.txId,
    module: e.module,
    reason: e.reason,
    direction: e.direction,
    // Round-trip through the scaled bigint, so a malformed amount is refused here, not shown.
    amount: formatAmount(parseAmount(e.amount)),
    postedAt,
    assetId: e.assetId,
    orderId: typeof e.orderId === 'string' && e.orderId !== '' ? e.orderId : null,
  };
}

/** A ledger line on the wire, in CCXT's ledger shape: a debit to an asset account is money in. */
export function presentLedgerLine(l: LedgerLine) {
  return {
    id: l.entryId,
    referenceId: l.txId,
    timestamp: l.postedAt.getTime(),
    datetime: l.postedAt.toISOString(),
    currency: l.assetId,
    direction: l.direction === 'debit' ? ('in' as const) : ('out' as const),
    amount: l.amount,
    type: l.reason,
    module: l.module,
    orderId: l.orderId,
  };
}

/** Raised when a range holds more ledger lines than one statement may carry. */
export class LedgerRangeTooLargeError extends Error {
  constructor(readonly max: number) {
    super(`more than ${max} ledger lines in this range; ask for a shorter range`);
    this.name = 'LedgerRangeTooLargeError';
  }
}

/**
 * Every ledger line posted in [from, to), oldest first. The ledger pages newest first (by posting sequence) with no time
 * filter, so this walks back from the newest line and stops after a page whose every line is before `from`: one page past
 * the boundary, so a line stamped a moment out of sequence near it is still read. More than `max` lines in the range
 * refuses rather than cutting the list short: a statement missing lines would look complete.
 */
export async function ledgerLinesInRange(
  pages: LedgerPages,
  userId: string,
  range: { from: Date; to: Date },
  max: number,
): Promise<LedgerLine[]> {
  const inRange: LedgerLine[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await pages.page({ userId, limit: LEDGER_PAGE_MAX, ...(cursor === undefined ? {} : { cursor }) });
    for (const line of page.entries) {
      if (line.postedAt < range.from || line.postedAt >= range.to) continue;
      inRange.push(line);
      if (inRange.length > max) throw new LedgerRangeTooLargeError(max);
    }
    const pastStart = page.entries.length > 0 && page.entries.every((line) => line.postedAt < range.from);
    if (pastStart || page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  // Newest first from the ledger; a statement reads oldest first, in posting order.
  return inRange.sort((a, b) => compareEntryIds(a.entryId, b.entryId));
}

function compareEntryIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
