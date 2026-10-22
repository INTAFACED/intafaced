import {
  ledgerFeeRevenueSchema,
  serviceCallSigner,
  type LedgerFeeRevenue,
  type ServiceAuthMode,
  type ServiceSigner,
} from '@intafaced/contracts';
import { OPS_FEE_REVENUE_UNAVAILABLE, OPS_FEE_REVENUE_UNCONFIGURED } from './codes.js';

/** The ledger's fee revenue for a window, or the typed code it could not be had under. Never a zero. */
export type FeeRevenueRead = { ok: true; value: LedgerFeeRevenue } | { ok: false; code: string; message: string };

export interface FeeRevenuePort {
  readonly configured: boolean;
  read(window: { from: Date; to: Date }): Promise<FeeRevenueRead>;
}

const TIMEOUT_MS = 5000;

/**
 * Reads svc-ledger's `feeRevenue` door. It is the only door the ledger lets svc-ops call, and it is a read. No answer is
 * ever turned into zero: a missing URL, a refusal, a timeout, a malformed body and an answer for another window each
 * come back as a typed unavailable, so the report says it could not ask rather than that no fees were taken.
 */
export function createFeeRevenueClient(options: {
  ledgerUrl?: string;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
  fetcher?: typeof fetch;
}): FeeRevenuePort {
  let base: string | null = null;
  try {
    const url = new URL(options.ledgerUrl ?? '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    base = url.href.replace(/\/$/, '');
  } catch {
    /* Missing transport is explicitly unconfigured. */
  }
  const sign = serviceCallSigner({ service: 'svc-ops', audience: 'svc-ledger', legacySecret: options.secret ?? '', s2s: options.s2s });
  const credentialed = Boolean(options.secret && options.secret.length >= 32) || options.s2s?.mode === 'keypair';
  const configured = base !== null && credentialed;
  const unavailable = (message: string): FeeRevenueRead => ({ ok: false, code: OPS_FEE_REVENUE_UNAVAILABLE, message });

  return {
    configured,
    async read(window) {
      if (!configured) {
        return {
          ok: false,
          code: OPS_FEE_REVENUE_UNCONFIGURED,
          message: 'The ledger is not wired to this service. No fee revenue was invented.',
        };
      }
      const body = JSON.stringify({ from: window.from.toISOString(), to: window.to.toISOString() });
      const target = `${base}/trpc/feeRevenue`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await (options.fetcher ?? fetch)(target, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...sign(body, { method: 'POST', url: new URL(target), contentType: 'application/json' }),
          },
          body,
        });
        if (!response.ok) return unavailable(`The ledger refused the fee revenue read (${response.status}).`);
        const parsed = ledgerFeeRevenueSchema.safeParse(await response.json());
        if (!parsed.success) return unavailable('The ledger answered fee revenue in a shape this service does not read.');
        if (parsed.data.from !== window.from.toISOString() || parsed.data.to !== window.to.toISOString()) {
          return unavailable('The ledger answered fee revenue for a different window than the one asked.');
        }
        return { ok: true, value: parsed.data };
      } catch {
        return unavailable('The ledger did not answer the fee revenue read.');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
