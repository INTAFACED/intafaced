import type { Context } from '@intafaced/contracts';
import { accountOperatorEntitlementSchema, encodePrincipal, serviceAuthHeadersForBody, signPrincipalHeader } from '@intafaced/contracts';
import { OutreachError } from './config.js';

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
    if (!p || p.kid || p.sub_account || !p.mfa || p.expiresAt.getTime() <= Date.now())
      throw new OutreachError('ops.crm.operator_forbidden');
    if (!options.identityUrl || !options.serviceSecret || !options.principalSecret)
      throw new OutreachError('ops.crm.authority_unconfigured');
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
            ...serviceAuthHeadersForBody('svc-ops', options.serviceSecret, body),
            'x-intafaced-principal': raw,
            'x-intafaced-principal-sig': signPrincipalHeader(raw, options.principalSecret, ctx.region),
            'x-intafaced-region': ctx.region,
          },
          body,
          signal: AbortSignal.timeout(3000),
        },
      );
      if (response.status === 401 || response.status === 403) throw new OutreachError('ops.crm.operator_forbidden');
      if (!response.ok) throw new OutreachError('ops.crm.authority_unavailable');
      const envelope: unknown = await response.json();
      const value = envelope as { result?: { data?: unknown } };
      const authority = accountOperatorEntitlementSchema.parse(value.result?.data);
      if (authority.status !== 'enabled' || authority.userId !== p.userId) throw new OutreachError('ops.crm.operator_forbidden');
      return p.userId;
    } catch (error) {
      if (error instanceof OutreachError) throw error;
      throw new OutreachError('ops.crm.authority_unavailable');
    }
  };
}
