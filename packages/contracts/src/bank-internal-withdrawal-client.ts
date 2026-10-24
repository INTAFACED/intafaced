import { serviceAuthHeadersForBody } from './service-auth.js';
import {
  BANK_INTERNAL_WITHDRAWAL_PROCEDURE,
  bankInternalWithdrawalInputSchema,
  bankInternalWithdrawalSchema,
  type BankInternalWithdrawalPort,
  type BankInternalWithdrawalResult,
} from './bank-internal-withdrawal.js';

const UNKNOWN: BankInternalWithdrawalResult = { state: 'unknown', code: 'bank.internal_withdrawal_unknown' };

/**
 * svc-pay's client for svc-bank's `transfers.settleWithdrawal`. One bounded request, signed over its body with the shared
 * service secret. Only a parsed `posted` or `refused` answer is an answer. A missing or malformed URL, a secret under 32
 * characters, a non-2xx reply, a reply that does not parse, a timeout and a thrown fetch all answer `unknown`: the send may
 * have posted, so the caller keeps its withdrawal open and asks again with the same key.
 *
 * An input this client refuses to send is the caller's bug, not a refusal from svc-bank: it throws, so nothing is recorded as
 * refused and nothing is sent.
 */
export function createBankInternalWithdrawalClient(options: {
  bankUrl?: string;
  secret?: string;
  fetcher?: typeof fetch;
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
      try {
        const response = await (options.fetcher ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            ...serviceAuthHeadersForBody('svc-pay', options.secret, body),
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
