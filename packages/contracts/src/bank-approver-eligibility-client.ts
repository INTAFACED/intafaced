import { serviceAuthHeadersForBody } from './service-auth.js';
import {
  bankApproverEligibilityInputSchema,
  bankApproverEligibilitySchema,
  type BankApproverEligibilityPort,
  type BankApproverEligibilityResult,
} from './bank-approver-eligibility.js';

const UNAVAILABLE: BankApproverEligibilityResult = { state: 'unavailable', code: 'bank.approver_eligibility_unavailable' };

/**
 * svc-pay's client for svc-bank's `business.approverEligibility`. One bounded request, signed over its body with the shared
 * service secret. A missing or malformed URL, a secret under 32 characters, a non-2xx reply, a reply that does not parse, a
 * timeout and a thrown fetch all answer `unavailable`: the approver is never assumed eligible.
 */
export function createBankApproverEligibilityClient(options: {
  bankUrl?: string;
  secret?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): BankApproverEligibilityPort {
  let endpoint: string | null = null;
  try {
    const url = new URL(options.bankUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = `${url.href.replace(/\/$/, '')}/trpc/business.approverEligibility`;
  } catch {
    /* Missing or invalid transport cannot approve anything. */
  }
  return {
    async check(raw) {
      if (endpoint === null || !options.secret || options.secret.length < 32) return UNAVAILABLE;
      const parsed = bankApproverEligibilityInputSchema.safeParse(raw);
      if (!parsed.success) return UNAVAILABLE;
      const body = JSON.stringify(parsed.data);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
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
        if (!response.ok) return UNAVAILABLE;
        const envelope: unknown = await response.json();
        if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) return UNAVAILABLE;
        const answer = bankApproverEligibilitySchema.safeParse((envelope as { result?: { data?: unknown } }).result?.data);
        return answer.success ? answer.data : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
