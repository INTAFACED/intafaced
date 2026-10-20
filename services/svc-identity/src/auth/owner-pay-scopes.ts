/**
 * Ask svc-pay which owner pay scopes this user may hold.
 *
 * The pay service runs `issueMerchantPayScopes`. This client does not decide
 * the law. A transport failure throws so the session issuer can omit pay
 * scopes and still sign the ordinary session.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export type OwnerPayScopeUserSnapshot = {
  accountStatus: string;
  emailVerified: boolean;
  secondFactorEnrolled: boolean;
};

export async function fetchOwnerPayScopes(input: {
  payUrl: string;
  secret: string;
  userId: string;
  user?: OwnerPayScopeUserSnapshot | null;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
}): Promise<readonly string[]> {
  const body = JSON.stringify({
    userId: input.userId,
    ...(input.user ? { user: input.user } : {}),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 2_000);
  try {
    const target = new URL('/internal/merchant-owner-pay-scopes', input.payUrl);
    const sign = serviceCallSigner({ service: 'svc-identity', audience: 'svc-pay', legacySecret: input.secret, s2s: input.s2s });
    const res = await (input.fetchImpl ?? fetch)(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sign(body, { method: 'POST', url: target, contentType: 'application/json' }) },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`owner pay scope lookup returned HTTP ${res.status}`);
    const json = (await res.json()) as { scopes?: unknown };
    if (!json || !Array.isArray(json.scopes)) throw new Error('owner pay scope lookup returned no scope list');
    return json.scopes.filter((scope): scope is string => typeof scope === 'string');
  } finally {
    clearTimeout(timer);
  }
}
