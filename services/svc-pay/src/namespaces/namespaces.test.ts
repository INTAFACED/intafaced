import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { mergeRouters, router, scopedProcedure, type Context } from '@intafaced/contracts';
import type { ControlService } from '../control/service.js';
import { createFounderAuthority } from '../founder-authority.js';
import { createMerchantPortalRouter } from '../merchant-portal/router.js';
import { createPayNamespaces, FOUNDER_ONLY_PREFIXES, findUnguardedFounderProcedures, founderProcedure } from './index.js';

const NAMESPACES = ['merchantControl', 'merchantMetrics', 'founderAdmin', 'conversion', 'payHalts'] as const;
/** Real procedures with their own suites, not W0 stubs. */
const isW15 = (path: string) =>
  path.startsWith('merchantOps.') ||
  path.startsWith('merchantCatalog.') ||
  path.startsWith('merchantStores.') ||
  path.startsWith('merchantCheckout.') ||
  path.startsWith('merchantCheckoutMethods.') ||
  path.startsWith('founderAdmin.ops.') ||
  path.startsWith('b2bRamp.') ||
  path.startsWith('merchant.customerEmails.') ||
  path.startsWith('payments.receipt.');

const id = () => randomUUID();
const merchantId = id();
const hash = `sha256:${'a'.repeat(64)}`;
const window = { kind: 'preset', preset: 'today' } as const;

/** One valid input per procedure. A new procedure with no entry here fails the coverage test below. */
const CALLS: Record<string, { founder: boolean; input: unknown }> = {
  'merchantControl.get': { founder: false, input: { merchantId } },
  'merchantControl.reserve': { founder: false, input: { merchantId } },
  'merchantControl.topUp.options': { founder: false, input: { merchantId } },
  'merchantControl.approvals.list': { founder: false, input: { merchantId, limit: 10 } },
  'merchantControl.approvals.decide': {
    founder: false,
    input: { approvalId: id(), decision: 'approve', expectedPayloadHash: hash, reason: 'checked' },
  },
  'merchantMetrics.snapshot': { founder: false, input: { merchantId, window } },
  'merchantMetrics.series': {
    founder: false,
    input: { merchantId, from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', bucket: 'day' },
  },
  'merchantMetrics.settlementAssets': { founder: false, input: { merchantId } },
  'conversion.quote': {
    founder: false,
    input: { merchantId, settlementId: id(), fromAsset: 'USD', toAsset: 'USDT', fromAmount: '10' },
  },
  'conversion.execute': { founder: false, input: { requestId: id(), quoteId: id() } },
  'conversion.get': { founder: false, input: { conversionId: id() } },
  'conversion.list': { founder: false, input: { merchantId, limit: 10 } },
  'payHalts.status': { founder: false, input: {} },
  'payHalts.set': {
    founder: true,
    input: { requestId: id(), scope: 'intake', target: { level: 'global' }, halted: true, reason: 'drill', expectedVersion: '0' },
  },
  'payHalts.history': { founder: true, input: { limit: 10 } },
  'payHalts.pendingClears': { founder: true, input: { limit: 10 } },
  'payHalts.operatorStatus': { founder: true, input: {} },
  'founderAdmin.merchants.list': { founder: true, input: { limit: 10 } },
  'founderAdmin.merchants.drilldown': { founder: true, input: { merchantId, window } },
  'founderAdmin.merchants.section': { founder: true, input: { merchantId, section: 'profile', limit: 10 } },
  'founderAdmin.merchants.recent': { founder: true, input: { limit: 10 } },
  'founderAdmin.payouts.list': { founder: true, input: { limit: 10 } },
  'founderAdmin.disputes.list': { founder: true, input: { limit: 10 } },
  'founderAdmin.live.summary': { founder: true, input: {} },
  'founderAdmin.risk.summary': { founder: true, input: { topN: 5 } },
  'founderAdmin.metrics.global': { founder: true, input: { window } },
  'founderAdmin.metrics.merchant': { founder: true, input: { merchantId, window } },
  'founderAdmin.metrics.merchantSeries': {
    founder: true,
    input: { merchantId, from: '2026-10-01T00:00:00Z', to: '2026-10-08T00:00:00Z', bucket: 'day' },
  },
  'founderAdmin.changes.submit': {
    founder: true,
    input: {
      requestId: id(),
      merchantId,
      change: { kind: 'set_tier', tierId: 'tier-a', archetypeId: null },
      reason: 'review',
      expectedVersion: '0',
    },
  },
  'founderAdmin.changes.confirm': {
    founder: true,
    input: { requestId: id(), decision: 'confirm', reason: 'second founder agrees', expectedChangeHash: `sha256:${'a'.repeat(64)}` },
  },
  'founderAdmin.changes.pending': { founder: true, input: { limit: 10 } },
  'founderAdmin.approvals.list': { founder: true, input: { limit: 10 } },
  'founderAdmin.approvals.destination': { founder: true, input: { approvalId: id() } },
  'founderAdmin.treasury.exposure': { founder: true, input: {} },
  'founderAdmin.conversion.resolve.propose': {
    founder: true,
    input: { requestId: id(), conversionId: id(), reason: 'drill' },
  },
  'founderAdmin.conversion.resolve.confirm': {
    founder: true,
    input: { requestId: id(), decision: 'reject', reason: 'drill', expectedChangeHash: hash },
  },
  'founderAdmin.conversion.holds.sweep': { founder: true, input: {} },
  'founderAdmin.conversion.lateFill.propose': {
    founder: true,
    input: { requestId: id(), auditId: id(), settlement: 'reviewed outside the book', reason: 'drill' },
  },
  'founderAdmin.conversion.lateFill.confirm': {
    founder: true,
    input: { requestId: id(), decision: 'reject', reason: 'drill', expectedChangeHash: hash },
  },
  'founderAdmin.conversion.lateFill.sweep': { founder: true, input: {} },
  'founderAdmin.conversion.lateFill.book.propose': {
    founder: true,
    input: { requestId: id(), auditId: id(), reason: 'drill' },
  },
  'founderAdmin.conversion.lateFill.book.confirm': {
    founder: true,
    input: { requestId: id(), decision: 'reject', reason: 'drill', expectedChangeHash: hash },
  },
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

const merchant: Principal = { ...base, scopes: ['pay:read', 'pay:write', 'pay:payout'] };

const identity = { identityUrl: 'https://identity.invalid', serviceSecret: 's'.repeat(32) };
const entitlement = (status: string, forUser = userId) =>
  new Response(JSON.stringify({ result: { data: { status, userId: forUser, version: '1', changedAt: '2026-10-10T00:00:00Z' } } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function build(fetcher: typeof fetch) {
  return createPayNamespaces({ founderAuthority: createFounderAuthority({ ...identity, fetcher }) });
}

type Callable = (input: unknown) => Promise<unknown>;
function procedureAt(caller: unknown, path: string): Callable {
  return path.split('.').reduce((node, key) => (node as Record<string, unknown>)[key], caller) as Callable;
}

const allProcedures = (r: unknown) => Object.keys((r as { _def: { procedures: Record<string, unknown> } })._def.procedures).sort();
const procedures = (r: unknown) => allProcedures(r).filter((p) => !isW15(p));

describe('W0 namespaces are mounted', () => {
  it('lists every new namespace and covers every procedure with a test input', () => {
    const paths = procedures(build(vi.fn()));
    expect([...new Set(paths.map((p) => p.split('.')[0]))].sort()).toEqual([...NAMESPACES].sort());
    expect(paths).toEqual(Object.keys(CALLS).sort());
  });

  it('is merged into the live appRouter in index.ts together with the guard registry', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf8');
    expect(src).toMatch(
      /createPayNamespaces\(\{\s*founderAuthority,\s*metrics,\s*registries: \{ sql, approvals: actionApprovals \},\s*sql,/,
    );
    expect(src).toContain('receiptPlaces: createReceiptAssetPlaces(');
    expect(src).toContain('startMetricsRefresher(metrics.projector');
    expect(src).toContain('const haltStore = new PayHaltStore(sql, loadHaltAutoTripConfig(process.env), rails);');
    expect(src).toContain('retryAdoptConfig');
    expect(src).toContain('haltStore.adoptConfig()');
    expect(src).toContain('setAutoTripAccountErrorSink');
    expect(src).toContain('payHalts: { store: haltStore, merchants: pay, team: teamReadFromSql(sql) }');
    expect(src).toContain('control: new ControlService(sql, teamAccessPorts(sql))');
    expect(src).toMatch(/const payGuards = buildPayGuards\(\{\s*sql,\s*ledger,\s*kycTierOf:/);
    // One registry instance serves the payment service, the user-money service, and conversion.
    expect(src.match(/guards: payGuards,/g)).toHaveLength(3);
  });

  it('merges with an existing router without a path collision', () => {
    const existing = router({ health: scopedProcedure('pay:read').query(() => 'ok') });
    const merged = mergeRouters(existing, build(vi.fn()));
    expect(procedures(merged)).toContain('health');
    expect(procedures(merged)).toContain('founderAdmin.merchants.list');
  });

  it('merges with a router that already owns merchant', () => {
    const portal = createMerchantPortalRouter({
      sql: {} as never,
      pay: {} as never,
      trees: null,
      team: {} as never,
    });
    const namespaces = build(vi.fn());
    expect(allProcedures(namespaces).some((path) => path.startsWith('merchant.'))).toBe(false);
    expect(() => mergeRouters(portal, namespaces)).not.toThrow();
    const merged = mergeRouters(portal, namespaces);
    expect(allProcedures(merged)).toEqual(
      expect.arrayContaining([
        'merchant.customerEmails.get',
        'merchant.customerEmails.set',
        'merchant.myAccess',
        'payments.receipt.preview',
        'payments.receipt.send',
      ]),
    );
  });
});

describe('without a metrics runtime, every stub refuses with pay.not_built and never returns data', () => {
  // payHalts is built (W5): with no store wired it refuses closed instead of answering "nothing is halted".
  for (const [path, call] of Object.entries(CALLS).filter(([p]) => !p.startsWith('payHalts.'))) {
    it(path, async () => {
      const fetcher = vi.fn<typeof fetch>(async () => entitlement('enabled'));
      const caller = build(fetcher).createCaller(ctxOf(call.founder ? base : merchant));
      // A principal that passes every guard (a real founder, or a merchant with all pay scopes) reaches the stub.
      const error = await procedureAt(
        caller,
        path,
      )(call.input).then(
        () => null,
        (e: unknown) => e as { code: string; cause?: { code?: string } },
      );
      expect(error).not.toBeNull();
      expect(error!.code).toBe('NOT_IMPLEMENTED');
      expect(error!.cause?.code).toBe('pay.not_built');
      expect(fetcher).toHaveBeenCalledTimes(call.founder ? 1 : 0);
    });
  }
});

describe('payHalts.* without a halt store refuses closed', () => {
  for (const [path, call] of Object.entries(CALLS).filter(([p]) => p.startsWith('payHalts.'))) {
    it(path, async () => {
      const fetcher = vi.fn<typeof fetch>(async () => entitlement('enabled'));
      const caller = build(fetcher).createCaller(ctxOf(call.founder ? base : merchant));
      const error = await procedureAt(
        caller,
        path,
      )(call.input).then(
        () => null,
        (e: unknown) => e as { code: string; cause?: { code?: string } },
      );
      expect(error!.code).toBe('SERVICE_UNAVAILABLE');
      expect(error!.cause?.code).toBe('pay.halt_store_unavailable');
    });
  }
});

describe('G7: static inventory of founder-only procedures', () => {
  it('no founderAdmin.* (or operator payHalts.*) procedure is outside founder authority', () => {
    expect(findUnguardedFounderProcedures(build(vi.fn()), FOUNDER_ONLY_PREFIXES)).toEqual([]);
  });

  it('mounts b2bRamp.founderStatus behind founder authority', () => {
    const r = build(vi.fn());
    expect(allProcedures(r)).toContain('b2bRamp.founderStatus');
    expect(findUnguardedFounderProcedures(r, ['b2bRamp.founderStatus'])).toEqual([]);
  });

  it('founderAdmin.approvals.destination is a mutation, so a reveal is not a cacheable query', () => {
    const typeOf = (routerValue: unknown) =>
      (routerValue as { _def: { procedures: Record<string, { _def: { type: string } }> } })._def.procedures[
        'founderAdmin.approvals.destination'
      ]!._def.type;
    expect(typeOf(build(vi.fn()))).toBe('mutation');
    expect(
      typeOf(
        createPayNamespaces({
          founderAuthority: createFounderAuthority({ ...identity, fetcher: vi.fn() }),
          control: {} as ControlService,
        }),
      ),
    ).toBe('mutation');
  });

  it('every procedure the manifest marks founder-only is guarded, and founderAdmin.* is all of them', () => {
    const r = build(vi.fn());
    const founderPaths = Object.entries(CALLS)
      .filter(([, c]) => c.founder)
      .map(([p]) => p);
    expect(findUnguardedFounderProcedures(r, founderPaths)).toEqual([]);
    for (const path of Object.keys(CALLS).filter((p) => p.startsWith('founderAdmin.'))) expect(CALLS[path]!.founder).toBe(true);
  });

  it('the check really fails: an admin:read-scoped founderAdmin procedure is reported', () => {
    const authority = createFounderAuthority({ ...identity, fetcher: vi.fn() });
    const leaky = router({
      founderAdmin: router({
        ok: founderProcedure(authority).query(() => 1),
        leaky: scopedProcedure('admin:read').query(() => 1),
        publicLeak: scopedProcedure('pay:read').query(() => 1),
      }),
    });
    expect(findUnguardedFounderProcedures(leaky, ['founderAdmin.'])).toEqual(['founderAdmin.leaky', 'founderAdmin.publicLeak']);
  });

  it('the check also fails when founder authority is spliced in AFTER input parsing', () => {
    const authority = createFounderAuthority({ ...identity, fetcher: vi.fn() });
    const late = router({
      founderAdmin: router({
        late: scopedProcedure('admin:read')
          .input(z.object({ merchantId: z.string() }))
          .concat(founderProcedure(authority))
          .query(() => 1),
      }),
    });
    expect(findUnguardedFounderProcedures(late, ['founderAdmin.'])).toEqual(['founderAdmin.late']);
  });
});

describe('founderAdmin.* refuses everyone who is not a live founder', () => {
  const founderPaths = Object.entries(CALLS)
    .filter(([, c]) => c.founder)
    .map(([p]) => p);

  async function refusedAll(ctx: Context, fetcher: typeof fetch, expectedCodes: string[]) {
    const caller = build(fetcher).createCaller(ctx);
    for (const path of founderPaths) {
      const error = await procedureAt(
        caller,
        path,
      )(CALLS[path]!.input).then(
        () => null,
        (e: unknown) => e as { code: string },
      );
      expect(error, path).not.toBeNull();
      expect(expectedCodes, `${path} -> ${error!.code}`).toContain(error!.code);
      expect(error!.code).not.toBe('NOT_IMPLEMENTED');
    }
  }

  it('G1: a merchant interactive session with MFA, no founder entitlement, is refused', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }));
    await refusedAll(ctxOf({ ...base, scopes: ['pay:read', 'pay:write', 'pay:payout'] }), fetcher, ['FORBIDDEN']);
    expect(fetcher).toHaveBeenCalledTimes(founderPaths.length);
  });

  it('G1: a merchant session whose entitlement is not enabled is refused', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('revoked'));
    await refusedAll(ctxOf(base), fetcher, ['FORBIDDEN']);
  });

  it('G2: an ifc_ API key with admin:read is refused before identity is even asked', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('enabled'));
    await refusedAll(ctxOf({ ...base, kid: id(), scopes: ['admin:read', 'pay:read'], mfa: false }), fetcher, ['FORBIDDEN']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('G2: an API key is refused even when the key holder is a real founder and carries MFA', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('enabled'));
    await refusedAll(ctxOf({ ...base, kid: id(), scopes: ['admin:read', 'admin:write', 'admin:compliance'] }), fetcher, ['FORBIDDEN']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('G3: admin scopes without a founder entitlement are refused', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('revoked'));
    await refusedAll(ctxOf({ ...base, scopes: ['admin:read', 'admin:write', 'admin:compliance'] }), fetcher, ['FORBIDDEN']);
  });

  it('G4: a founder without MFA or with an expired session is refused; identity unreachable is 503, never a cached allow', async () => {
    const enabled = vi.fn<typeof fetch>(async () => entitlement('enabled'));
    await refusedAll(ctxOf({ ...base, mfa: false }), enabled, ['FORBIDDEN']);
    await refusedAll(ctxOf({ ...base, expiresAt: new Date(Date.now() - 1000) }), enabled, ['FORBIDDEN']);
    expect(enabled).not.toHaveBeenCalled();
    const down = vi.fn<typeof fetch>(async () => {
      throw new Error('network');
    });
    await refusedAll(ctxOf(base), down, ['SERVICE_UNAVAILABLE']);
    const broken = vi.fn<typeof fetch>(async () => new Response('boom', { status: 500 }));
    await refusedAll(ctxOf(base), broken, ['SERVICE_UNAVAILABLE']);
  });

  it('G4: an unconfigured authority (no identity URL) refuses with 503', async () => {
    const r = createPayNamespaces({ founderAuthority: createFounderAuthority({}) });
    const caller = r.createCaller(ctxOf(base));
    await expect(procedureAt(caller, 'founderAdmin.merchants.list')({ limit: 10 })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('G5: a sub-account principal and a service-to-service context are refused', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('enabled'));
    await refusedAll(ctxOf({ ...base, sub_account: id() } as Principal), fetcher, ['FORBIDDEN']);
    await refusedAll(ctxOf(base, 'svc-admin'), fetcher, ['FORBIDDEN']);
    await refusedAll(ctxOf(null, 'svc-admin'), fetcher, ['UNAUTHORIZED']);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('an anonymous caller is unauthenticated, not merely forbidden', async () => {
    await refusedAll(ctxOf(null), vi.fn(), ['UNAUTHORIZED']);
  });

  it('a different user in the entitlement answer is refused (no confused deputy)', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => entitlement('enabled', id()));
    await refusedAll(ctxOf(base), fetcher, ['FORBIDDEN']);
  });

  it('refuses before parsing input: an unauthorised caller with garbage input sees FORBIDDEN, not BAD_REQUEST', async () => {
    const caller = build(vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }))).createCaller(ctxOf(base));
    await expect(procedureAt(caller, 'founderAdmin.merchants.list')({ nonsense: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('merchant-facing stubs still need their scope', () => {
  it('a principal without the pay scope is refused before the stub', async () => {
    const caller = build(vi.fn()).createCaller(ctxOf({ ...base, scopes: ['trade:read'] }));
    await expect(procedureAt(caller, 'merchantMetrics.snapshot')(CALLS['merchantMetrics.snapshot']!.input)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('payHalts.set is not reachable with a merchant pay scope alone', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 403 }));
    const caller = build(fetcher).createCaller(ctxOf({ ...base, scopes: ['pay:read', 'pay:write', 'pay:payout'] }));
    await expect(procedureAt(caller, 'payHalts.set')(CALLS['payHalts.set']!.input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
