import type { Context } from '@intafaced/contracts';
import { accountOperatorEntitlementSchema, forwardedPrincipalHeaders, serviceAuthHeadersForBody } from '@intafaced/contracts';
import { OutreachError } from './config.js';

export type FounderAuthority = (ctx: Context) => Promise<string>;
/** Identity authenticates the original signed interactive principal and checks current DB entitlement/session/MFA. */
export function createFounderAuthority(options: {
  identityUrl?: string;
  serviceSecret?: string;
  /** Ignored. Ops forwards the edge principal; it does not mint one. */
  principalSecret?: string;
  fetcher?: typeof fetch;
}): FounderAuthority {
  return async (ctx) => {
    const p = ctx.principal;
    const forwarded = forwardedPrincipalHeaders(ctx.forwardedPrincipal);
    if (!p || p.kid || p.sub_account || !p.mfa || p.expiresAt.getTime() <= Date.now())
      throw new OutreachError('ops.crm.operator_forbidden');
    if (!options.identityUrl || !options.serviceSecret) throw new OutreachError('ops.crm.authority_unconfigured');
    if (!forwarded) throw new OutreachError('ops.crm.operator_forbidden');
    const body = JSON.stringify({ userId: p.userId });
    try {
      const response = await (options.fetcher ?? fetch)(
        `${options.identityUrl.replace(/\/$/, '')}/trpc/accountControls.operatorEntitlement`,
        {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/json',
            ...serviceAuthHeadersForBody('svc-ops', options.serviceSecret, body),
            ...forwarded,
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
