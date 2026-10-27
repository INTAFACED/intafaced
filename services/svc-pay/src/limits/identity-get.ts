import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

/** How svc-pay reaches svc-identity's service-authenticated internal reads. */
export interface IdentityReadOptions {
  readonly baseUrl: string;
  readonly internalSecret: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** svc-pay's own key. With it the read is key-signed for svc-identity; `dual` also sends the shared-secret form. */
  readonly s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
}

const DEFAULT_TIMEOUT_MS = 2_000;

/**
 * One signed GET of an identity internal read (`path` starts with `/internal/`), returning the parsed JSON body. Every
 * failure THROWS with "identity" and `what` in the message: transport, timeout, a status that is not 2xx, or a body that
 * is not JSON. The caller checks the body against the published contract and binds it to what it asked.
 */
export function createIdentityGet(options: IdentityReadOptions, client: string): (path: string, what: string) => Promise<unknown> {
  if (!options.internalSecret.trim()) throw new Error(`${client} needs the internal service secret`);
  const base = options.baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sign = serviceCallSigner({ service: 'svc-pay', audience: 'svc-identity', legacySecret: options.internalSecret, s2s: options.s2s });

  return async (path, what) => {
    const target = `${base}${path}`;
    let response: Response;
    try {
      response = await fetchImpl(target, {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error(`identity unreachable: ${what} not read`);
    }
    if (!response.ok) throw new Error(`identity refused the ${what} read (${response.status})`);
    try {
      return await response.json();
    } catch {
      throw new Error(`identity answered with a body that is not JSON: ${what} not read`);
    }
  };
}
