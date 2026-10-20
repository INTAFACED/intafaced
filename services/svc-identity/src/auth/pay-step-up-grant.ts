/**
 * Ask svc-pay whether this user may refund or pay out for one merchant.
 *
 * The pay service decides the role. This client does not. A transport failure
 * throws so the step-up mint can refuse and issue nothing.
 */

import { serviceCallSigner, type ServiceAuthMode, type ServiceSigner } from '@intafaced/contracts';

export type PayStepUpGrantRead = {
  readonly role: string | null;
  readonly permissions: {
    readonly 'refunds.create': boolean;
    readonly 'payout.send': boolean;
  };
};

export async function fetchPayStepUpGrant(input: {
  payUrl: string;
  secret: string;
  userId: string;
  merchantId: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  s2s?: { signer: ServiceSigner; mode: ServiceAuthMode };
}): Promise<PayStepUpGrantRead> {
  const body = JSON.stringify({ userId: input.userId, merchantId: input.merchantId });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), input.timeoutMs ?? 2_000);
  try {
    const target = new URL('/internal/merchant-pay-step-up-grant', input.payUrl);
    const sign = serviceCallSigner({ service: 'svc-identity', audience: 'svc-pay', legacySecret: input.secret, s2s: input.s2s });
    const res = await (input.fetchImpl ?? fetch)(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...sign(body, { method: 'POST', url: target, contentType: 'application/json' }) },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`pay step-up grant lookup returned HTTP ${res.status}`);
    const json = (await res.json()) as {
      role?: unknown;
      permissions?: { 'refunds.create'?: unknown; 'payout.send'?: unknown };
    };
    const permissions = json?.permissions;
    if (!permissions || typeof permissions !== 'object') throw new Error('pay step-up grant lookup returned no permissions');
    return {
      role: typeof json.role === 'string' ? json.role : null,
      permissions: {
        'refunds.create': permissions['refunds.create'] === true,
        'payout.send': permissions['payout.send'] === true,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
