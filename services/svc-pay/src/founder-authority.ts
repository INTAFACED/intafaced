import type { Context } from '@intafaced/contracts';
import { accountOperatorEntitlementSchema, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { MerchantControlError } from './merchant-account-controls.js';

export type FounderAuthority = (ctx: Context) => Promise<string>;
/** Identity authenticates the original signed interactive principal and checks current DB entitlement/session/MFA. */
export function createFounderAuthority(options: {
  identityUrl?: string;
  serviceSecret?: string;
  principalSecret?: string;
  fetcher?: typeof fetch;
}): FounderAuthority {
  return async (ctx) => {
    const p = ctx.principal;
    if (ctx.service || !p || p.kid || p.sub_account || !p.mfa || p.expiresAt.getTime() <= Date.now())
      throw new MerchantControlError('operator.denied');
    if (!options.identityUrl || !options.serviceSecret || !options.principalSecret) throw new MerchantControlError('authority.unavailable');
    const body = JSON.stringify({ userId: p.userId });
    const raw = encodePrincipal(p);
    try {
      const response = await (options.fetcher ?? fetch)(
        `${options.identityUrl.replace(/\/$/, '')}/trpc/accountControls.operatorEntitlement`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            ...serviceAuthHeadersForBody('svc-pay', options.serviceSecret, body),
            'x-intafaced-principal': raw,
            'x-intafaced-principal-sig': signPrincipalHeader(raw, options.principalSecret, ctx.region),
            'x-intafaced-region': ctx.region,
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
