import { parseAmount, rehydrateLedgerHttpError, type AccountRef, type Amount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { TAX_LEDGER_HISTORY_UNAVAILABLE, TAX_LEDGER_UNWIRED, TaxError } from './codes.js';
import type { Fill } from './lot-book.js';

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

  return {
    async balances(ownerType, ownerId) {
      const result = await call<Array<{ accountId: string; assetId: string; kind: string; purpose?: string; amount: string }>>(
        url,
        '/trpc/balances',
        { ownerType, ownerId },
        authHeaders,
      );
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
      const page = async (body: Record<string, unknown>) =>
        call<{
          entries: Array<{
            txId: string;
            reason: string;
            direction: 'debit' | 'credit';
            amount: string;
            postedAt: string;
            assetId: string;
            orderId?: string | null;
          }>;
          nextCursor: string | null;
        }>(url, '/trpc/historyPage', body, authHeaders);

      let truncated = false;
      // Walk every page of one account scope, newest first, up to a fixed ceiling. A ceiling hit is reported, never silent.
      const walk = async (scope: Record<string, unknown>) => {
        const out: Array<Awaited<ReturnType<typeof page>>['entries'][number]> = [];
        let cursor: string | undefined;
        for (let pages = 0; ; pages++) {
          if (pages >= TRADE_FILL_PAGE_CEILING) {
            truncated = true;
            return out;
          }
          const got = await page({ ...scope, limit: PAGE_LIMIT, ...(cursor === undefined ? {} : { cursor }) });
          out.push(...got.entries);
          if (got.nextCursor === null) return out;
          cursor = got.nextCursor;
        }
      };

      try {
        const received = (await walk({ ownerType: 'user', ownerId: userId, kind: 'available' })).filter(
          (e) => e.reason === 'trade.fill' && e.direction === 'debit',
        );
        const orderIds = [...new Set(received.map((e) => e.orderId).filter((id): id is string => typeof id === 'string' && id !== ''))];
        const paidByTx = new Map<string, { assetId: string; amount: Amount }>();
        for (const orderId of orderIds) {
          const holds = await walk({ ownerType: 'user', ownerId: userId, kind: 'hold', purpose: `order:${orderId}` });
          for (const e of holds) {
            if (e.reason === 'trade.fill' && e.direction === 'credit')
              paidByTx.set(e.txId, { assetId: e.assetId, amount: parseAmount(e.amount) });
          }
        }
        const fills: Fill[] = received.map((e) => ({
          txId: e.txId,
          postedAt: new Date(e.postedAt),
          received: { assetId: e.assetId, amount: parseAmount(e.amount) },
          paid: paidByTx.get(e.txId) ?? null,
        }));
        return { fills, truncated };
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

/** Entries per ledger page (the door's maximum). */
const PAGE_LIMIT = 200;
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
