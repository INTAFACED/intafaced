import { serviceAuthHeadersForBody } from './service-auth.js';
import { bankOwnSpacesInputSchema, bankOwnSpacesSchema, type BankOwnSpacesPort, type BankOwnSpacesResult } from './bank-own-spaces.js';

const UNAVAILABLE: BankOwnSpacesResult = { state: 'unavailable', code: 'bank.own_spaces_unavailable' };

/**
 * svc-tax's client for svc-bank's `spaces.ownedAccounts`. One bounded request, signed over its body with the shared service
 * secret. A missing or malformed URL, a secret under 32 characters, a non-2xx reply, a reply that does not parse, a timeout
 * and a thrown fetch all answer `unavailable`: no answer is never read as "no spaces".
 */
export function createBankOwnSpacesClient(options: {
  bankUrl?: string;
  secret?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): BankOwnSpacesPort {
  let endpoint: string | null = null;
  try {
    const url = new URL(options.bankUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = `${url.href.replace(/\/$/, '')}/trpc/spaces.ownedAccounts`;
  } catch {
    /* Missing or invalid transport lists nothing. */
  }
  return {
    async list(raw) {
      if (endpoint === null || !options.secret || options.secret.length < 32) return UNAVAILABLE;
      const parsed = bankOwnSpacesInputSchema.safeParse(raw);
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
            ...serviceAuthHeadersForBody('svc-tax', options.secret, body),
          },
          body,
        });
        if (!response.ok) return UNAVAILABLE;
        const envelope: unknown = await response.json();
        if (!envelope || typeof envelope !== 'object' || !('result' in envelope)) return UNAVAILABLE;
        const answer = bankOwnSpacesSchema.safeParse((envelope as { result?: { data?: unknown } }).result?.data);
        return answer.success ? { state: 'read', spaces: answer.data.spaces } : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
