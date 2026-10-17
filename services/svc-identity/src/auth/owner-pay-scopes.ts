/**
 * Ask svc-pay which owner pay scopes this user may hold.
 *
 * The pay service runs `issueMerchantPayScopes`. This client does not decide
 * the law. A transport failure throws so the session issuer can omit pay
 * scopes and still sign the ordinary session.
 */

import { serviceAuthHeadersForBody } from '@intafaced/contracts';

export async function fetchOwnerPayScopes(input: {
  payUrl: string;
  secret: string;
  userId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<readonly string[]> {
  const body = JSON.stringify({ userId: input.userId });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 2_000);
  try {
    const res = await (input.fetchImpl ?? fetch)(new URL('/internal/merchant-owner-pay-scopes', input.payUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-identity', input.secret, body) },
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
