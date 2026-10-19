import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { mergeRouters, router, scopedProcedure, type Context } from '@intafaced/contracts';
import { createFounderAuthority } from '../founder-authority.js';
import { createPayNamespaces, findUnguardedFounderProcedures } from '../namespaces/index.js';
import { unwiredApprovalConsumer } from '../action-approval-consume.js';

/**
 * Isolation suite G1-G5 for `founderAdmin.registries.*`: every procedure refuses
 * everyone who is not a live founder, BEFORE it parses input or touches the
 * database. The database handle below throws if anything reaches it.
 */
const id = () => randomUUID();
const untouchable = new Proxy(
  {},
  {
    get: () => {
      throw new Error('the registries touched the database for an unauthorised caller');
    },
  },
) as unknown as Sql;

const venueChange = {
  venueId: 'binance-spot',
  displayName: 'Binance Spot',
  mode: 'disabled',
  priority: 1,
  enabled: false,
  minOrder: null,
  maxOrder: null,
  supportedPairs: [],
  expectedVersion: null,
  reason: 'initial entry',
};
const networkChange = {
  networkId: 'ethereum',
  displayName: 'Ethereum',
  assetCodes: ['USDT'],
  confirmationsRequired: null,
  enabled: false,
  feeEstimateSource: null,
  feeEstimateAmount: null,
  expectedVersion: null,
  reason: 'initial entry',
};
const routeChange = {
  assetCode: 'USDT',
  networkId: 'ethereum',
  payoutAllowed: false,
  merchantAllow: [],
  merchantDeny: [],
  maxSinglePayout: null,
  expectedVersion: null,
  reason: 'initial entry',
};

const CALLS: Record<string, unknown> = {
  'founderAdmin.registries.venues.list': {},
  'founderAdmin.registries.venues.save': venueChange,
  'founderAdmin.registries.networks.list': {},
  'founderAdmin.registries.networks.save': networkChange,
  'founderAdmin.registries.walletRoutes.list': {},
  'founderAdmin.registries.walletRoutes.save': routeChange,
  'founderAdmin.registries.preview': { registry: 'venue', change: venueChange },
  'founderAdmin.registries.history': { registry: 'venue', limit: 10 },
};

const userId = id();
const base: Principal = {
  userId,
  sub: userId,
  sid: id(),
  scopes: [...SESSION_SCOPES],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 60_000),
};
const ctxOf = (principal: Principal | null, service: string | null = null): Context => ({
  principal,
  service,
  region: 'DE',
  requestId: id(),
  forwardedPrincipal: principal ? { raw: 'test-principal', signature: 'test-signature', region: 'DE' } : undefined,
});
const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
const entitlement = (status: string, forUser = userId) =>
  new Response(JSON.stringify({ result: { data: { status, userId: forUser, version: '1', changedAt: '2026-10-10T00:00:00Z' } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function build(fetcher: typeof fetch) {
  return createPayNamespaces({
    founderAuthority: createFounderAuthority({ ...identity, fetcher }),
    registries: { sql: untouchable, approvals: unwiredApprovalConsumer() },
  });
}
type Callable = (input: unknown) => Promise<unknown>;
const procedureAt = (caller: unknown, path: string): Callable =>
  path.split('.').reduce((node, key) => (node as Record<string, unknown>)[key], caller) as Callable;
const procedures = (r: unknown) =>
  Object.keys((r as { _def: { procedures: Record<string, unknown> } })._def.procedures)
    .filter((p) => p.startsWith('founderAdmin.registries.'))
    .sort();

describe('registries procedure inventory', () => {
  it('every procedure is covered by a test input, and all sit under founderAdmin.registries', () => {
    expect(procedures(build(vi.fn()))).toEqual(Object.keys(CALLS).sort());
  });

  it('G7: every registries procedure is behind founder authority, ahead of input parsing', () => {
    expect(findUnguardedFounderProcedures(build(vi.fn()), ['founderAdmin.'])).toEqual([]);
  });

  it('is mounted in index.ts, beside the W0 founderAdmin procedures, and absent when no deps are supplied', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8');
    expect(src).toMatch(
      /createPayNamespaces\(\{\s*founderAuthority,\s*metrics,\s*registries: \{ sql, approvals: actionApprovals \},\s*sql,/,
    );
    const authority = createFounderAuthority({ ...identity, fetcher: vi.fn() });
    const all = (r: unknown) => Object.keys((r as { _def: { procedures: Record<string, unknown> } })._def.procedures);
    expect(all(build(vi.fn()))).toContain('founderAdmin.merchants.list');
    expect(all(createPayNamespaces({ founderAuthority: authority })).filter((p) => p.includes('registries'))).toEqual([]);
    const merged = mergeRouters(build(vi.fn()), router({ extra: scopedProcedure('pay:read').query(() => 1) }));
    expect(findUnguardedFounderProcedures(merged, ['founderAdmin.'])).toEqual([]);
  });

  it('the inventory check really fails for an admin:read registries procedure', () => {
    const leaky = router({ founderAdmin: router({ registries: router({ leak: scopedProcedure('admin:read').query(() => 1) }) }) });
    expect(findUnguardedFounderProcedures(leaky, ['founderAdmin.'])).toEqual(['founderAdmin.registries.leak']);
  });
});

describe('founderAdmin.registries.* refuses everyone who is not a live founder', () => {
  async function refusedAll(ctx: Context, fetcher: typeof fetch, expectedCodes: string[]) {
    const caller = build(fetcher).createCaller(ctx);
    for (const [path, input] of Object.entries(CALLS)) {
      const error = await procedureAt(
        caller,
        path,
      )(input).then(
        () => null,
        (e: unknown) => e as { code: string },
      );
      expect(error, path).not.toBeNull();
      expect(expectedCodes, `${path} -> ${error!.code}`).toContain(error!.code);
    }
  }

  it('G1: a merchant session with MFA and no founder entitlement is refused on every procedure', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }));
    await refusedAll(ctxOf({ ...base, scopes: ['pay:read', 'pay:write', 'pay:payout'] }), fetcher, ['FORBIDDEN']);
    expect(fetcher).toHaveBeenCalledTimes(Object.keys(CALLS).length);
  });

  it('G1: a revoked entitlement is refused', async () => {
    await refusedAll(
      ctxOf(base),
      vi.fn<typeof fetch>(async () => entitlement('revoked')),
      ['FORBIDDEN'],
    );
  });

  it('G2: an ifc_ API key with admin:read is refused before identity is asked', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('enabled'));
    await refusedAll(ctxOf({ ...base, kid: id(), scopes: ['admin:read', 'pay:read'], mfa: false }), fetcher, ['FORBIDDEN']);
    await refusedAll(ctxOf({ ...base, kid: id(), scopes: ['admin:read', 'admin:write', 'admin:compliance'] }), fetcher, ['FORBIDDEN']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('G3: admin scopes without a founder entitlement are refused', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('revoked'));
    await refusedAll(ctxOf({ ...base, scopes: ['admin:read', 'admin:write', 'admin:compliance'] }), fetcher, ['FORBIDDEN']);
  });

  it('a founder without MFA or with an expired session is refused; identity down is 503, never a cached allow', async () => {
    const enabled = vi.fn<typeof fetch>(async () => entitlement('enabled'));
    await refusedAll(ctxOf({ ...base, mfa: false }), enabled, ['FORBIDDEN']);
    await refusedAll(ctxOf({ ...base, expiresAt: new Date(Date.now() - 1000) }), enabled, ['FORBIDDEN']);
    expect(enabled).not.toHaveBeenCalled();
    await refusedAll(
      ctxOf(base),
      vi.fn<typeof fetch>(async () => {
        throw new Error('network');
      }),
      ['SERVICE_UNAVAILABLE'],
    );
  });

  it('sub-account and service-to-service callers are refused; anonymous is unauthenticated', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('enabled'));
    await refusedAll(ctxOf({ ...base, sub_account: id() } as Principal), fetcher, ['FORBIDDEN']);
    await refusedAll(ctxOf(base, 'svc-admin'), fetcher, ['FORBIDDEN']);
    await refusedAll(ctxOf(null), vi.fn(), ['UNAUTHORIZED']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('a different user in the entitlement answer is refused', async () => {
    await refusedAll(
      ctxOf(base),
      vi.fn<typeof fetch>(async () => entitlement('enabled', id())),
      ['FORBIDDEN'],
    );
  });

  it('refuses before parsing input: garbage from an unauthorised caller sees FORBIDDEN, not BAD_REQUEST', async () => {
    const caller = build(vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }))).createCaller(ctxOf(base));
    await expect(procedureAt(caller, 'founderAdmin.registries.venues.save')({ nonsense: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
