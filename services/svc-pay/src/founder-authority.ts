import type { Context } from '@intafaced/contracts';
import { accountOperatorEntitlementSchema, forwardedPrincipalHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { MerchantControlError } from './merchant-account-controls.js';

export type FounderAuthority = (ctx: Context) => Promise<string>;
/** Identity authenticates the original signed interactive principal and checks current DB entitlement/session/MFA. */
export function createFounderAuthority(options: {
  identityUrl?: string;
  serviceSecret?: string;
  fetcher?: typeof fetch;
}): FounderAuthority {
  return async (ctx) => {
    const p = ctx.principal;
    if (ctx.service || !p || p.kid || p.sub_account || !p.mfa || p.expiresAt.getTime() <= Date.now())
      throw new MerchantControlError('operator.denied');
    // The edge-signed principal passes through byte for byte. Pay holds no key to sign one, so a request without it
    // cannot be vouched for here.
    if (!options.identityUrl || !options.serviceSecret || !ctx.forwardedPrincipal) throw new MerchantControlError('authority.unavailable');
    const body = JSON.stringify({ userId: p.userId });
    try {
      const response = await (options.fetcher ?? fetch)(
        `${options.identityUrl.replace(/\/$/, '')}/trpc/accountControls.operatorEntitlement`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            ...serviceAuthHeadersForBody('svc-pay', options.serviceSecret, body),
            ...forwardedPrincipalHeaders(ctx),
          },
          body,
          signal: AbortSignal.timeout(3000),
        },
      );
      if (response.status === 401 || response.status === 403) throw new MerchantControlError('operator.denied');
      if (!response.ok) throw new MerchantControlError('authority.unavailable');
      const envelope: unknown = await response.json();
      const value = envelope as { result?: { data?: unknown } };
      const authority = accountOperatorEntitlementSchema.parse(value.result?.data);
      if (authority.status !== 'enabled' || authority.userId.toLowerCase() !== p.userId.toLowerCase())
        throw new MerchantControlError('operator.denied');
      return p.userId.toLowerCase();
    } catch (error) {
      if (error instanceof MerchantControlError) throw error;
      throw new MerchantControlError('authority.unavailable');
    }
  };
}
