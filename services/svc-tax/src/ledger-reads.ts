import { parseAmount, rehydrateLedgerHttpError, type AccountRef, type Amount } from '@intafaced/ledger-client';
import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import { TAX_LEDGER_HISTORY_UNAVAILABLE, TAX_LEDGER_UNWIRED, TaxError } from './codes.js';

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
