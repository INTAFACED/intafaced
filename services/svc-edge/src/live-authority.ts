import type { Principal } from '@intafaced/auth';
import {
  currentAuthorityInputSchema,
  currentAuthorityResultSchema,
  serviceAuthHeadersForBody,
  type CurrentAuthorityResult,
} from '@intafaced/contracts';
import { assertIdentityApiKeyLive } from './api-key-revoked.js';
import { assertApiKeyIp, optionalIpAllowlist } from './api-key-ip.js';
import { assertApiKeyOrigin, optionalOriginAllowlist } from './api-key-origin.js';
import { assertApiKeyProduct, optionalProductScopes } from './api-key-product.js';
import { assertApiKeyAccount, optionalAccountIdFromExchange } from './api-key-account.js';
import { assertKeyNotExpired, optionalExpiresAtFromExchange } from './api-key-expires.js';

type Eligible = Extract<CurrentAuthorityResult, { status: 'eligible' }>;
export type EdgeAuthorityOptions = {
  identityUrl?: string;
  identityOwnershipSecret?: string;
  fetch?: typeof fetch;
  clientIp?: string | null;
  origin?: string | null;
  accountId?: string | null;
  product?: string | null;
};

/** One fresh read per request; never money admission or a cached founder entitlement. */
export async function readEdgeAuthority(principal: Principal, options: EdgeAuthorityOptions): Promise<Eligible | null> {
  let base: string;
  try {
    const url = new URL(options.identityUrl ?? '');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !options.identityOwnershipSecret ||
      options.identityOwnershipSecret.length < 32
    )
      return null;
    base = url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
  const secret = options.identityOwnershipSecret!;
  const subject = currentAuthorityInputSchema.safeParse({
    userId: principal.userId.toLowerCase(),
    credential: principal.kid
      ? { kind: 'api_key', apiKeyId: principal.kid.toLowerCase() }
      : { kind: 'session', sessionId: principal.sid.toLowerCase() },
    ...(principal.sub_account ? { subAccountId: principal.sub_account.toLowerCase() } : {}),
  });
  if (!subject.success) return null;
  const started = performance.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, 3000);
  });
  const guardedFetch: typeof fetch = (url, init) => {
    const request = {
      ...init,
      signal: controller.signal,
      redirect: 'error' as const,
      cache: 'no-store',
      headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cache-control': 'no-store' },
    };
    return (options.fetch ?? fetch)(url, request);
  };
  const call = async (): Promise<Eligible | null> => {
    try {
      const body = JSON.stringify(subject.data);
      const response = await guardedFetch(`${base}/trpc/accountControls.currentAuthority`, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-edge', secret, body) },
      });
      if (!response.ok) return null;
      const envelope: unknown = await response.json();
      const parsed = currentAuthorityResultSchema.safeParse((envelope as { result?: { data?: unknown } } | null)?.result?.data);
      if (!parsed.success || parsed.data.status !== 'eligible') return null;
      const proof = parsed.data;
      if (JSON.stringify(proof.subject) !== body || Date.parse(proof.leaseExpiresAt) <= Date.now() || performance.now() - started >= 5000)
        return null;
      if (principal.kid) {
        const metadata = await assertIdentityApiKeyLive({
          identityUrl: base,
          apiKeyId: principal.kid.toLowerCase(),
          userId: subject.data.userId,
          identityOwnershipSecret: secret,
          fetch: guardedFetch,
        });
        assertApiKeyIp(optionalIpAllowlist(metadata), options.clientIp);
        assertApiKeyOrigin(optionalOriginAllowlist(metadata), options.origin);
        assertApiKeyProduct(optionalProductScopes(metadata) ?? [], options.product);
        assertApiKeyAccount(optionalAccountIdFromExchange(metadata), options.accountId);
        assertKeyNotExpired(optionalExpiresAtFromExchange(metadata), new Date());
      }
      return performance.now() - started < 5000 && Date.parse(proof.leaseExpiresAt) > Date.now() ? proof : null;
    } catch {
      return null;
    }
  };
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
