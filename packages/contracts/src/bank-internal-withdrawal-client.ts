import { serviceCallSigner, type ServiceCallSignerOptions } from './service-auth-http.js';
import {
  BANK_INTERNAL_WITHDRAWAL_PROCEDURE,
  bankInternalWithdrawalInputSchema,
  bankInternalWithdrawalSchema,
  type BankInternalWithdrawalPort,
  type BankInternalWithdrawalResult,
} from './bank-internal-withdrawal.js';

const UNKNOWN: BankInternalWithdrawalResult = { state: 'unknown', code: 'bank.internal_withdrawal_unknown' };

/**
 * svc-pay's client for svc-bank's `transfers.settleWithdrawal`. One bounded request, signed over its body: with svc-pay's own
 * key once it has one (`s2s`, so a svc-bank in `keypair` mode accepts it), else with the shared service secret. Only a parsed `posted` or `refused` answer is an answer. A missing or malformed URL, a secret under 32
 * characters, a non-2xx reply, a reply that does not parse, a timeout and a thrown fetch all answer `unknown`: the send may
 * have posted, so the caller keeps its withdrawal open and asks again with the same key.
 *
 * An input this client refuses to send is the caller's bug, not a refusal from svc-bank: it throws, so nothing is recorded as
 * refused and nothing is sent.
 */
export function createBankInternalWithdrawalClient(options: {
  bankUrl?: string;
  secret?: string;
  /** svc-pay's signing key and S2S mode. Absent leaves the call on the shared secret alone. */
  s2s?: ServiceCallSignerOptions['s2s'];
  fetcher?: typeof fetch;
  /** Longer than svc-bank's own worst case for a send that posts (the ledger, then up to 5 s for its notice and 5 s for the sorter). */
  timeoutMs?: number;
}): BankInternalWithdrawalPort {
  let endpoint: string | null = null;
  try {
    const url = new URL(options.bankUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = `${url.href.replace(/\/$/, '')}/trpc/${BANK_INTERNAL_WITHDRAWAL_PROCEDURE}`;
  } catch {
    /* Missing or invalid transport cannot send anything. */
  }
  return {
    async settle(raw) {
      const parsed = bankInternalWithdrawalInputSchema.parse(raw);
      if (endpoint === null || !options.secret || options.secret.length < 32) return UNKNOWN;
      const body = JSON.stringify(parsed);
      const sign = serviceCallSigner({ service: 'svc-pay', audience: 'svc-bank', legacySecret: options.secret, s2s: options.s2s });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
      try {
        const response = await (options.fetcher ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            ...sign(body, { method: 'POST', url: new URL(endpoint), contentType: 'application/json' }),
          },
          body,
        });
        if (!response.ok) return UNKNOWN;
        const envelope: unknown = await response.json();
        if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) return UNKNOWN;
        const answer = bankInternalWithdrawalSchema.safeParse((envelope as { result?: { data?: unknown } }).result?.data);
        return answer.success ? answer.data : UNKNOWN;
      } catch {
        return UNKNOWN;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
