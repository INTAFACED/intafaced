import { unwrapTrpcData } from './action-approval-client.js';
import { serviceAuthHeadersForBody } from './service-auth.js';
import { serviceCallSigner, type ServiceAuthMode } from './service-auth-http.js';
import type { ServiceSigner } from './service-keys.js';
import {
  IDENTITY_WATCHLISTS_PROCEDURE,
  identityWatchlistsInputSchema,
  identityWatchlistsSchema,
  type IdentityWatchlistsPort,
  type IdentityWatchlistsResult,
} from './identity-watchlists.js';

const UNAVAILABLE: IdentityWatchlistsResult = { state: 'unavailable', code: 'identity.watchlists_unavailable' };

/**
 * svc-notify's client for svc-identity's `preferences.watchlistsFor`. One bounded request, signed over its body: with
 * svc-notify's own key once S2S is on, else the shared service secret. A missing or malformed URL, a secret under 32
 * characters, a non-2xx reply, a reply that does not parse, a timeout and a thrown fetch all answer `unavailable`: no answer
 * is never read as "no lists".
 */
export function createIdentityWatchlistsClient(options: {
  identityUrl?: string;
  secret?: string;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode } | undefined;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}): IdentityWatchlistsPort {
  let endpoint: string | null = null;
  try {
    const url = new URL(options.identityUrl ?? '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    endpoint = `${url.href.replace(/\/$/, '')}/trpc/${IDENTITY_WATCHLISTS_PROCEDURE}`;
  } catch {
    /* Missing or invalid transport reads nothing. */
  }
  const secret = options.secret ?? '';
  const sign = options.s2s
    ? serviceCallSigner({ service: 'svc-notify', audience: 'svc-identity', legacySecret: secret, s2s: options.s2s })
    : null;
  return {
    async read(raw) {
      if (endpoint === null || secret.length < 32) return UNAVAILABLE;
      const parsed = identityWatchlistsInputSchema.safeParse(raw);
      if (!parsed.success) return UNAVAILABLE;
      const body = JSON.stringify(parsed.data);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3000);
      try {
        const auth = sign
          ? sign(body, { method: 'POST', url: new URL(endpoint), contentType: 'application/json' })
          : serviceAuthHeadersForBody('svc-notify', secret, body);
        const response = await (options.fetcher ?? fetch)(endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...auth },
          body,
        });
        if (!response.ok) return UNAVAILABLE;
        const answer = identityWatchlistsSchema.safeParse(unwrapTrpcData(await response.json()));
        return answer.success ? { state: 'read', lists: answer.data.lists } : UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
