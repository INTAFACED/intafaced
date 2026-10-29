import { serviceCallSigner, type ServiceCallSignerOptions } from './service-auth-http.js';
import {
  BANK_SEND_DESTINATION_PROCEDURE,
  bankSendDestinationInputSchema,
  bankSendDestinationSchema,
  type BankSendDestinationPort,
  type BankSendDestinationResult,
} from './bank-send-destination.js';

const UNAVAILABLE: BankSendDestinationResult = { state: 'unavailable', code: 'bank.send_destination_unavailable' };

/**
 * svc-pay's client for svc-bank's `ramps.destinations.sendable`. One bounded request, signed over its body: with svc-pay's own
 * key once it has one (`s2s`, so a svc-bank in `keypair` mode accepts it), else with the shared service secret. A missing or
 * malformed URL, a secret under 32 characters, an input that does not parse, a non-2xx reply, a reply that does not parse, a
 * timeout and a thrown fetch all answer `unavailable`: an address is never assumed ready.
 */
export function createBankSendDestinationClient(options: {
  bankUrl?: string;
  secret?: string;
  /** svc-pay's signing key and S2S mode. Absent leaves the call on the shared secret alone. */
  s2s?: ServiceCallSignerOptions['s2s'];
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): BankSendDestinationPort {
  let endpoint: string | null = null;
  try {
    const url = new URL(options.bankUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = `${url.href.replace(/\/$/, '')}/trpc/${BANK_SEND_DESTINATION_PROCEDURE}`;
  } catch {
    /* Missing or invalid transport cannot say an address is ready. */
  }
  return {
    async check(raw) {
      if (endpoint === null || !options.secret || options.secret.length < 32) return UNAVAILABLE;
      const parsed = bankSendDestinationInputSchema.safeParse(raw);
      if (!parsed.success) return UNAVAILABLE;
      const body = JSON.stringify(parsed.data);
      const sign = serviceCallSigner({ service: 'svc-pay', audience: 'svc-bank', legacySecret: options.secret, s2s: options.s2s });
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
            ...sign(body, { method: 'POST', url: new URL(endpoint), contentType: 'application/json' }),
          },
          body,
        });
        if (!response.ok) return UNAVAILABLE;
        const envelope: unknown = await response.json();
        if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) return UNAVAILABLE;
        const answer = bankSendDestinationSchema.safeParse((envelope as { result?: { data?: unknown } }).result?.data);
        return answer.success ? answer.data : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
