import { accountStateSchema, serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';
import type { KycTierOf } from './guards.js';

/**
 * The customer's KYC tier for the withdrawal limit (D-148), read per request from
 * svc-identity's `GET /internal/account/:userId` (the published `AccountState`),
 * service-authenticated like every other internal read. Nothing is cached or
 * copied: identity derives the tier from approved, unexpired documents.
 *
 * Every failure THROWS: transport, timeout, 401, 404, a body off the published
 * contract, or a body for another user. The guard turns a throw into
 * `pay.guard_unavailable`, so a limit is never applied against a guessed tier
 * and a dark identity service never reads as "full".
 */
export interface IdentityKycTierOptions {
  readonly baseUrl: string;
  readonly internalSecret: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  /** svc-pay's own key. With it the read is key-signed for svc-identity; `dual` also sends the shared-secret form. */
  readonly s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
}

const DEFAULT_TIMEOUT_MS = 2_000;

export function createIdentityKycTierClient(options: IdentityKycTierOptions): KycTierOf {
  if (!options.internalSecret.trim()) throw new Error('identity KYC tier client needs the internal service secret');
  const base = options.baseUrl.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sign = serviceCallSigner({ service: 'svc-pay', audience: 'svc-identity', legacySecret: options.internalSecret, s2s: options.s2s });

  return async (userId) => {
    let response: Response;
    try {
      const target = `${base}/internal/account/${encodeURIComponent(userId)}`;
      response = await fetchImpl(target, {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          ...sign('', { method: 'GET', url: new URL(target), contentType: 'application/json' }),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('identity unreachable: KYC tier not read');
    }
    if (!response.ok) throw new Error(`identity refused the KYC tier read (${response.status})`);

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new Error('identity answered with a body that is not JSON: KYC tier not read');
    }
    const parsed = accountStateSchema.safeParse(body);
    if (!parsed.success) throw new Error('identity answered off the published account contract: KYC tier not read');
    // Bind the answer to the user we asked about, so a misrouted reply cannot set another customer's limit.
    if (parsed.data.userId !== userId) throw new Error('identity answered for a different user: KYC tier not read');
    return parsed.data.kycTier;
  };
}
