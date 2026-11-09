import {
  OPS_CAPITAL_SOURCE_UNAVAILABLE,
  bankPartnerReservesSchema,
  ledgerOwnFundsSchema,
  serviceCallSigner,
  type BankPartnerReserves,
  type LedgerOwnFunds,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { baseOf } from '../restore/watermark-reader.js';

/** One source's answer, or why it could not be had. Never a zero. */
export type SourceRead<T> = { ok: true; value: T } | { ok: false; code: typeof OPS_CAPITAL_SOURCE_UNAVAILABLE; message: string };

export interface CapitalSources {
  ownFunds(): Promise<SourceRead<LedgerOwnFunds>>;
  partnerReserves(): Promise<SourceRead<BankPartnerReserves>>;
}

const TIMEOUT_MS = 5000;

interface Door<T> {
  readonly name: string;
  readonly audience: 'svc-ledger' | 'svc-bank';
  readonly base: string | null;
  readonly path: string;
  readonly parse: (raw: unknown) => T | null;
}

/**
 * Reads the capital monitor's two sources: svc-ledger's `ownFunds` and svc-bank's partner reserves, each a signed POST
 * that svc-ops alone may make. A missing URL or credential, a refusal, a timeout and an answer in another shape are each
 * `ops.capital.source_unavailable`, naming the source: the monitor then reads that part "unknown", never zero.
 */
export function createCapitalSources(options: {
  ledgerUrl?: string;
  bankUrl?: string;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetcher?: typeof fetch;
}): CapitalSources {
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  const read = async <T>(door: Door<T>): Promise<SourceRead<T>> => {
    const unavailable = (message: string): SourceRead<T> => ({
      ok: false,
      code: OPS_CAPITAL_SOURCE_UNAVAILABLE,
      message: `${door.name}: ${message}`,
    });
    if (!door.base || !credentialed) return unavailable('not wired to this service, so nothing was read.');
    const target = new URL(`${door.base}${door.path}`);
    const body = '{}';
    const sign = serviceCallSigner({ service: 'svc-ops', audience: door.audience, legacySecret: options.secret ?? '', s2s: options.s2s });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await (options.fetcher ?? fetch)(target, {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...sign(body, { method: 'POST', url: target, contentType: 'application/json' }) },
        body,
      });
      if (!response.ok) return unavailable(`refused the read (${response.status}).`);
      const parsed = door.parse(await response.json());
      return parsed === null ? unavailable('answered in a shape this service does not read.') : { ok: true, value: parsed };
    } catch {
      return unavailable('did not answer.');
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    ownFunds: () =>
      read({
        name: 'svc-ledger',
        audience: 'svc-ledger',
        base: baseOf(options.ledgerUrl),
        path: '/trpc/ownFunds',
        parse: (raw) => {
          const p = ledgerOwnFundsSchema.safeParse(raw);
          return p.success ? p.data : null;
        },
      }),
    partnerReserves: () =>
      read({
        name: 'svc-bank',
        audience: 'svc-bank',
        base: baseOf(options.bankUrl),
        path: '/internal/capital/partner-reserves',
        parse: (raw) => {
          const p = bankPartnerReservesSchema.safeParse(raw);
          return p.success ? p.data : null;
        },
      }),
  };
}
