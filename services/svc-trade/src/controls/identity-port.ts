import { accountOperatorEntitlementSchema, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { LiveTradingOperatorPort } from './trading-controls.js';

/**
 * Owned bounded HTTP transport; never a positive cache or identity DB reader.
 *
 * Service-authenticated only: the body names the user and the session the edge authenticated, and identity checks
 * both live. No principal is signed or forwarded, so nothing here holds the shared edge secret.
 */
export function createLiveTradingOperator(
  config: { url: string; serviceSecret: string; s2s?: { signer: ServiceSigner; mode: ServiceAuthMode } },
  fetcher: typeof fetch = fetch,
): LiveTradingOperatorPort | null {
  try {
    const url = new URL(config.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  } catch {
    return null;
  }
  if (config.serviceSecret.length < 32) return null;
  const authHeaders = serviceCallSigner({
    service: 'svc-trade',
    audience: 'svc-identity',
    legacySecret: config.serviceSecret,
    s2s: config.s2s,
  });
  async function post(path: string, input: unknown): Promise<unknown> {
    const body = JSON.stringify(input);
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        (async () => {
          const target = new URL('/trpc/' + path, config.url);
          const request = {
            method: 'POST',
            redirect: 'error' as const,
            cache: 'no-store',
            headers: {
              'content-type': 'application/json',
              'cache-control': 'no-store',
              ...authHeaders(body, { method: 'POST', url: target, contentType: 'application/json' }),
            },
            body,
            signal: abort.signal,
          };
          const response = await fetcher(target, request);
          if (!response.ok) throw new Error('Identity authority refused');
          const wire = (await response.json()) as { result?: { data?: unknown } };
          if (!wire.result || !('data' in wire.result)) throw new Error('Invalid identity authority envelope');
          return wire.result.data;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abort.abort();
            reject(new Error('Identity authority timeout'));
          }, 2000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
  }
  return {
    async check(context) {
      try {
        const entitlement = accountOperatorEntitlementSchema.parse(
          await post('accountControls.serviceOperatorEntitlement', { userId: context.principal.userId, sessionId: context.principal.sid }),
        );
        if (entitlement.userId.toLowerCase() !== context.principal.userId.toLowerCase()) return 'unavailable';
        if (entitlement.status === 'enabled') return 'enabled';
        if (entitlement.status === 'unconfigured') return 'unavailable';
        return 'denied';
      } catch {
        return 'unavailable';
      }
    },
  };
}
