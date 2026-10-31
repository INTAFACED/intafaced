/**
 * G — ONLY FOUNDERS SEE THE GLOBAL PANEL (W14, Isolation acceptance suites G1-G5, G7, G8, G10).
 *
 * Every call goes through the REAL merged tRPC router (`createCaller` on the same
 * composition as `src/index.ts`), against a real Postgres. The founder authority
 * is the production `createFounderAuthority`; only its HTTP dependency (identity)
 * is a controllable double, so "identity is down" and "entitlement revoked" are
 * real runtime paths, not mocked guards.
 *
 * Table-driven: the procedure list is READ FROM THE ROUTER. A new `founderAdmin.*`
 * or operator `payHalts.*` procedure is covered by every test here with no edit.
 * (Inputs for the positive control live in procedures.ts. Without an entry the call
 * uses `{}`, which still proves refusal because authority runs before parsing, but the
 * POSITIVE CONTROL then names the procedure as `other:BAD_REQUEST`: add its input there.)
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { router, scopedProcedure } from '@intafaced/contracts';
import type { Context } from '@intafaced/contracts';
import { findUnguardedFounderProcedures } from '../../src/namespaces/index.js';
import { ADMIN_SCOPES, callRest, callTrpc, createWorld, ctxOf, keyOf, principal, sessionOf, type Outcome, type World } from './fixture.js';
import { COMPLIANCE_PROCS, FOUNDER_EXTRA, FOUNDER_FLAG_OFF, FOUNDER_INPUTS, FOUNDER_PREFIXES } from './procedures.js';

type Verdict = 'allowed' | 'refused' | 'unavailable' | `other:${string}`;

/**
 * What the caller learns, in four words.
 *  - `allowed`: past the authority (data, a not-built stub, or a business answer about the target).
 *  - `refused`: UNAUTHORIZED / FORBIDDEN, or the control writer's typed `operator.denied` / `mfa.required` refusal.
 *  - `unavailable`: 503, or the control writer's typed `authority.unavailable` refusal.
 */
function verdict(o: Outcome): Verdict {
  if (o.kind === 'ok') {
    const v = o.value as { outcome?: string; code?: string } | null;
    if (v && v.outcome === 'refused') {
      if (v.code === 'operator.denied' || v.code === 'mfa.required') return 'refused';
      if (v.code === 'authority.unavailable') return 'unavailable';
    }
    return 'allowed';
  }
  if (o.code === 'UNAUTHORIZED' || o.code === 'FORBIDDEN') return 'refused';
  if (o.code === 'SERVICE_UNAVAILABLE') return 'unavailable';
  if (o.code === 'NOT_IMPLEMENTED') return 'allowed';
  return `other:${o.code}`;
}

describe('G: founder-only procedures', () => {
  let w: World;
  let paths: string[];
  /** founderAdmin.* and payHalts.set/history/operatorStatus — the ones the static inventory covers. */
  let inventoried: string[];

  beforeAll(async () => {
    w = await createWorld();
    const all = Object.keys((w.appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);
    inventoried = all.filter((p) => FOUNDER_PREFIXES.some((x) => p.startsWith(x))).sort();
    paths = [...inventoried, ...FOUNDER_EXTRA].sort();
    for (const extra of FOUNDER_EXTRA) expect(all, `${extra} no longer exists: update FOUNDER_EXTRA`).toContain(extra);
  }, 120_000);
  afterAll(async () => {
    await w?.stop();
  }, 60_000);
  beforeEach(() => {
    w.identity.mode = 'normal';
    w.identity.calls.length = 0;
  });

  const call = (ctx: Context, path: string) => callTrpc(w, ctx, path, FOUNDER_INPUTS[path]?.(w) ?? {});

  /** Run every founder-only procedure as `ctx`; return `path -> verdict`. */
  async function sweep(ctx: Context): Promise<Record<string, Verdict>> {
    const out: Record<string, Verdict> = {};
    for (const p of paths) out[p] = verdict(await call(ctx, p));
    return out;
  }
  const everyone = (v: Verdict): Record<string, Verdict> => Object.fromEntries(paths.map((p) => [p, v]));

  it('the table is not empty and covers the namespaces that must be founder-only', () => {
    expect(inventoried.length).toBeGreaterThanOrEqual(19);
    expect(inventoried).toEqual(
      expect.arrayContaining([
        'founderAdmin.merchants.list',
        'founderAdmin.metrics.global',
        'founderAdmin.metrics.merchant',
        'founderAdmin.metrics.merchantSeries',
        'founderAdmin.registries.venues.save',
        'founderAdmin.registries.walletRoutes.save',
        'founderAdmin.registries.history',
        'founderAdmin.treasury.exposure',
        'founderAdmin.changes.submit',
        'founderAdmin.changes.confirm',
        'founderAdmin.approvals.list',
        'founderAdmin.approvals.destination',
        'founderAdmin.control.tiers.list',
        'founderAdmin.control.pricing.rules',
        'founderAdmin.control.merchant.get',
        'founderAdmin.control.merchant.usage',
        'founderAdmin.control.configure.submit',
        'founderAdmin.control.configure.confirm',
        'founderAdmin.control.approvals.decide',
        'payHalts.set',
        'payHalts.history',
        'payHalts.operatorStatus',
        'b2bRamp.founderStatus',
      ]),
    );
  });

  it('W1: every founder procedure of the control room has an explicit input in procedures.ts (a bare `{}` would only prove refusal)', () => {
    const w1 = inventoried.filter((p) => p.startsWith('founderAdmin.control.') || /^founderAdmin\.(changes|approvals)\./.test(p));
    expect(w1).toHaveLength(15);
    for (const p of w1) expect(FOUNDER_INPUTS[p], `${p} has no entry in FOUNDER_INPUTS`).toBeDefined();
  });

  it('POSITIVE CONTROL: an entitled founder with MFA gets past every guard (the refusals below are not a broken fixture)', async () => {
    const founder = sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES });
    const ctx = ctxOf(founder);
    for (const path of Object.keys(FOUNDER_FLAG_OFF)) expect(paths, path).toContain(path);
    const got: Record<string, string> = {};
    for (const p of paths) {
      const o = await call(ctx, p);
      const flagOff = FOUNDER_FLAG_OFF[p];
      got[p] = flagOff ? (o.kind === 'error' && o.causeCode === flagOff ? flagOff : verdict(o)) : verdict(o);
    }
    expect(got).toEqual(Object.fromEntries(paths.map((p) => [p, FOUNDER_FLAG_OFF[p] ?? 'allowed'])));
    expect(w.identity.calls.length).toBe(paths.length);
  });

  it('HARNESS SANITY: the sweep would see a leak (an admin:read-scoped procedure answers an interactive admin session)', async () => {
    const leaky = router({ leak: scopedProcedure('admin:read').query(() => 'every merchant volume') });
    const caller = leaky.createCaller(ctxOf(sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES })));
    const o = await caller.leak().then(
      (value): Outcome => ({ kind: 'ok', value }),
      (e: { code: string; message: string }): Outcome => ({ kind: 'error', code: e.code, message: e.message, causeCode: undefined }),
    );
    expect(verdict(o)).toBe('allowed');
  });

  it('G1: a merchant interactive session WITH MFA is refused on every founder-only procedure', async () => {
    for (const tag of ['A', 'B', 'P', 'C1'] as const) {
      const s = sessionOf(w.e[tag].userId);
      expect(s.mfa).toBe(true);
      expect(await sweep(ctxOf(s)), `merchant ${tag}`).toEqual(everyone('refused'));
    }
  });

  it('G1: ... and it asks identity every time (the answer is "not an operator", never assumed)', async () => {
    await sweep(ctxOf(sessionOf(w.e.A.userId)));
    expect(w.identity.calls.length).toBe(paths.length);
  });

  it('G1: a merchant session is refused when identity says 403 too', async () => {
    w.identity.mode = 'http403';
    expect(await sweep(ctxOf(sessionOf(w.e.A.userId)))).toEqual(everyone('refused'));
  });

  describe('G2: an ifc_ API key can never be a founder', () => {
    const variants: Array<[string, (userId: string) => ReturnType<typeof keyOf>]> = [
      ['admin:read key minted by a founder', (u) => keyOf(u, { scopes: ['admin:read'] })],
      ['admin:read + admin:write + admin:compliance key', (u) => keyOf(u, { scopes: ADMIN_SCOPES })],
      ['key that also claims mfa=true', (u) => keyOf(u, { scopes: ADMIN_SCOPES, mfa: true })],
      ['sandbox-env key', (u) => keyOf(u, { scopes: ADMIN_SCOPES, key_env: 'sandbox' })],
    ];
    for (const [name, make] of variants) {
      it(name, async () => {
        w.identity.entitlements.set(w.founderUserId, 'enabled');
        expect(await sweep(ctxOf(make(w.founderUserId)))).toEqual(everyone('refused'));
        // Refused locally: identity is not even consulted for a key principal.
        expect(w.identity.calls).toHaveLength(0);
      });
    }
    it('a merchant key (pay scopes only) is refused too', async () => {
      expect(await sweep(ctxOf(keyOf(w.e.A.userId)))).toEqual(everyone('refused'));
      expect(w.identity.calls).toHaveLength(0);
    });
  });

  describe('G3: admin scopes are not an entitlement', () => {
    for (const status of ['not_operator', 'unconfigured', 'revoked'] as const) {
      it(`admin:read/write/compliance session, identity says ${status}`, async () => {
        const userId = randomUUID();
        w.identity.entitlements.set(userId, status);
        const s = sessionOf(userId, { scopes: ADMIN_SCOPES });
        expect(await sweep(ctxOf(s))).toEqual(everyone('refused'));
      });
    }
  });

  describe('G4: a founder who is not currently valid', () => {
    it('without MFA is refused (identity not consulted)', async () => {
      expect(await sweep(ctxOf(sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES, mfa: false })))).toEqual(everyone('refused'));
      expect(w.identity.calls).toHaveLength(0);
    });
    it('with an expired session is refused (identity not consulted)', async () => {
      const s = sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES, expiresAt: new Date(Date.now() - 1_000) });
      expect(await sweep(ctxOf(s))).toEqual(everyone('refused'));
      expect(w.identity.calls).toHaveLength(0);
    });
    for (const status of ['revoked', 'unconfigured', 'not_operator'] as const) {
      it(`with entitlement ${status} (not enabled) is refused`, async () => {
        w.identity.entitlements.set(w.founderUserId, status);
        try {
          expect(await sweep(ctxOf(sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES })))).toEqual(everyone('refused'));
        } finally {
          w.identity.entitlements.set(w.founderUserId, 'enabled');
        }
      });
    }
    for (const mode of ['unreachable', 'http500', 'garbage'] as const) {
      it(`identity ${mode}: nothing is allowed on any procedure`, async () => {
        w.identity.mode = mode;
        const v = await sweep(ctxOf(sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES })));
        expect(Object.entries(v).filter(([, x]) => x === 'allowed')).toEqual([]);
      });
      it(`identity ${mode}: every founder-only procedure answers 503 SERVICE_UNAVAILABLE`, async () => {
        w.identity.mode = mode;
        const ctx = ctxOf(sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES }));
        const wrong: string[] = [];
        for (const p of paths) {
          const o = await call(ctx, p);
          if (!(o.kind === 'error' && o.code === 'SERVICE_UNAVAILABLE'))
            wrong.push(`${p} -> ${o.kind === 'ok' ? 'HTTP 200 ' + JSON.stringify((o.value as { code?: string })?.code) : o.code}`);
        }
        expect(wrong).toEqual([]);
      });
    }
    it('NO CACHED ALLOW: allow, then identity goes away => 503, then back => allow, asking identity every time', async () => {
      const ctx = ctxOf(sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES }));
      const p = inventoried.find((path) => FOUNDER_FLAG_OFF[path] === undefined)!;
      expect(verdict(await call(ctx, p))).toBe('allowed');
      w.identity.mode = 'unreachable';
      expect(verdict(await call(ctx, p))).toBe('unavailable');
      w.identity.mode = 'http500';
      expect(verdict(await call(ctx, p))).toBe('unavailable');
      w.identity.entitlements.set(w.founderUserId, 'revoked');
      w.identity.mode = 'normal';
      try {
        expect(verdict(await call(ctx, p))).toBe('refused');
      } finally {
        w.identity.entitlements.set(w.founderUserId, 'enabled');
      }
      expect(verdict(await call(ctx, p))).toBe('allowed');
      expect(w.identity.calls).toHaveLength(5);
    });
  });

  describe('G5: sub-account and service-to-service', () => {
    it('a founder-user sub-account principal is refused (identity not consulted)', async () => {
      const s = sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES, sub_account: randomUUID() });
      expect(await sweep(ctxOf(s))).toEqual(everyone('refused'));
      expect(w.identity.calls).toHaveLength(0);
    });
    it('a service-to-service context is refused, even carrying a founder principal', async () => {
      const s = sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES });
      expect(await sweep(ctxOf(s, 'svc-admin'))).toEqual(everyone('refused'));
      expect(await sweep(ctxOf(null, 'svc-admin'))).toEqual(everyone('refused'));
      expect(w.identity.calls).toHaveLength(0);
    });
    it('an anonymous caller is refused', async () => {
      expect(await sweep(ctxOf(null))).toEqual(everyone('refused'));
      expect(w.identity.calls).toHaveLength(0);
    });
    it('a merchant principal in a service context is refused', async () => {
      expect(await sweep(ctxOf(sessionOf(w.e.A.userId), 'svc-edge'))).toEqual(everyone('refused'));
    });
  });

  it('refusal reveals nothing about the input: garbage input to a founder-only procedure is FORBIDDEN, not BAD_REQUEST', async () => {
    for (const p of inventoried) {
      const o = await callTrpc(w, ctxOf(sessionOf(w.e.A.userId)), p, { nonsense: true, merchantId: 'not-a-uuid' });
      expect(o, p).toMatchObject({ kind: 'error', code: 'FORBIDDEN' });
    }
  });

  it('a refused merchant call leaves no trace in B/A rows (control writer targets nothing real)', async () => {
    const before = await w.sql`SELECT count(*)::int AS n FROM pay.merchants WHERE operations_restricted`;
    await sweep(ctxOf(sessionOf(w.e.A.userId)));
    const after = await w.sql`SELECT count(*)::int AS n FROM pay.merchants WHERE operations_restricted`;
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  describe('G7: static route inventory', () => {
    it('no founderAdmin.* (or operator payHalts.set/history/operatorStatus) procedure is outside founder authority', () => {
      expect(findUnguardedFounderProcedures(w.appRouter, FOUNDER_PREFIXES)).toEqual([]);
    });
    it('every founder-only prefix matched at least one procedure (a typo cannot make the inventory vacuous)', () => {
      for (const prefix of FOUNDER_PREFIXES)
        expect(
          inventoried.some((p) => p.startsWith(prefix)),
          prefix,
        ).toBe(true);
    });
    it('compliance decides are mounted beside decideKyb and are not founder-only paths', () => {
      const all = Object.keys((w.appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);
      for (const path of COMPLIANCE_PROCS) {
        expect(all, path).toContain(path);
        expect(FOUNDER_PREFIXES.some((prefix) => path.startsWith(prefix))).toBe(false);
        expect((FOUNDER_EXTRA as readonly string[]).includes(path)).toBe(false);
      }
    });
    it('merchant sessions, API keys, and callers without admin:compliance are refused on every compliance procedure', async () => {
      const inputFor = (path: string): unknown => {
        const merchantId = w.e.A.merchantId;
        if (path === 'kyb.decisionBinding' || path === 'kyb.documents.reviewView') return { merchantId };
        if (path === 'kyb.documents.review') {
          return { applicationId: randomUUID(), documentId: randomUUID(), verdict: 'rejected', reason: 'isolation drill' };
        }
        if (path === 'kyb.documents.file') return { applicationId: randomUUID(), documentId: randomUUID() };
        if (path === 'kyb.requests.reviewList') return { merchantId };
        if (path === 'kyb.requests.create') {
          return {
            merchantId,
            requestKey: 'isolation:drill',
            text: 'isolation drill',
            dueAt: new Date(Date.now() + 86_400_000).toISOString(),
          };
        }
        if (path === 'kyb.requests.close') return { requestId: randomUUID(), note: 'isolation drill' };
        if (path === 'kyb.requests.file') return { requestId: randomUUID() };
        if (path === 'kyb.decide') {
          return { merchantId, decision: 'rejected', reason: 'isolation drill', approvalId: 'appr-1', operationId: 'op-1' };
        }
        if (path === 'merchant.decideKyb') {
          return { merchantId, decision: 'rejected', approvalId: 'appr-1', operationId: 'op-1' };
        }
        return {
          merchantId,
          requestId: randomUUID(),
          decision: 'rejected',
          reason: 'isolation drill',
          expectedChangeHash: `sha256:${'a'.repeat(64)}`,
          approvalId: 'appr-1',
          operationId: 'op-1',
        };
      };
      const callers = [
        ctxOf(sessionOf(w.e.A.userId)),
        ctxOf(keyOf(w.e.A.userId)),
        ctxOf(sessionOf(w.e.B.userId, { scopes: ['admin:read'] })),
        ctxOf(sessionOf(w.e.B.userId, { scopes: ['admin:write'] })),
        ctxOf(keyOf(w.founderUserId, { scopes: ADMIN_SCOPES })),
        ctxOf(null),
      ];
      for (const ctx of callers) {
        const got: Record<string, Verdict> = {};
        for (const path of COMPLIANCE_PROCS) got[path] = verdict(await callTrpc(w, ctx, path, inputFor(path)));
        expect(got).toEqual(Object.fromEntries(COMPLIANCE_PROCS.map((path) => [path, 'refused'])));
      }
    });
    it('an admin:compliance session can read the KYB decision binding without founder authority', async () => {
      const operator = sessionOf(randomUUID(), { scopes: ['admin:compliance'] });
      const o = await callTrpc(w, ctxOf(operator), 'kyb.decisionBinding', { merchantId: w.e.A.merchantId });
      expect(o.kind).toBe('ok');
      if (o.kind !== 'ok') return;
      const view = o.value as { merchantId: string; identityHash: string };
      expect(view.merchantId).toBe(w.e.A.merchantId);
      expect(view.identityHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(view).not.toHaveProperty('profileVersion');
      const foreign = await callTrpc(w, ctxOf(sessionOf(w.e.B.userId)), 'kyb.decisionBinding', { merchantId: w.e.A.merchantId });
      expect(foreign).toMatchObject({ kind: 'error', code: 'FORBIDDEN' });
    });
    it('the self-guarded operator surfaces are pinned: a new accountControls.* / merchantState.* procedure must be added to FOUNDER_EXTRA', () => {
      const all = Object.keys((w.appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);
      const operatorish = all.filter((p) => p.startsWith('accountControls.') || p.startsWith('merchantState.')).sort();
      expect(operatorish).toEqual([...FOUNDER_EXTRA].sort());
    });
  });

  describe('G8: the public OpenAPI spec and REST door carry no founder or operator path', () => {
    it('GET /v1/openapi.json lists only the merchant surface', async () => {
      const res = await w.rest.inject({ method: 'GET', url: '/v1/openapi.json' });
      expect(res.statusCode).toBe(200);
      const spec = JSON.parse(res.body) as { paths: Record<string, unknown> };
      const paths = Object.keys(spec.paths);
      expect(paths.length).toBeGreaterThan(10);
      for (const p of paths) {
        expect(p, `public path ${p} is not on the merchant allowlist`).toMatch(
          /^\/(payments|balances|payment-links|webhook-endpoints|webhook-deliveries|submerchant-permissions)(\/|$)/,
        );
      }
      const text = res.body.toLowerCase();
      for (const needle of [
        'founder',
        'payhalts',
        'halt',
        'operator',
        'accountcontrols',
        'merchantstate',
        'treasury',
        'admin:read',
        'admin:write',
        'admin:compliance',
      ]) {
        expect(text, `spec mentions "${needle}"`).not.toContain(needle);
      }
    });
    it('the REST door has no founder/operator route registered, and probing for one is a 404', async () => {
      const routes = w.rest.printRoutes().toLowerCase();
      for (const needle of ['founder', 'halt', 'operator', 'admin', 'control']) expect(routes).not.toContain(needle);
      const founder = sessionOf(w.founderUserId, { scopes: ADMIN_SCOPES });
      for (const url of [
        '/v1/founder-admin/merchants',
        '/v1/founderAdmin/metrics/global',
        '/v1/pay-halts',
        '/v1/admin/merchants',
        '/trpc/founderAdmin.merchants.list',
      ]) {
        const r = await callRest(w, founder, { method: 'GET', url });
        expect(r.status, url).toBe(404);
      }
    });
  });

  describe('G10: founder-only data never appears in outbound merchant webhooks or CSV exports', () => {
    /** The complete set of keys a merchant webhook may carry. Adding one is a reviewed decision. */
    const ALLOWED_PAYMENT_KEYS = [
      'amount',
      'assetId',
      'capturedAmount',
      'createdAt',
      'id',
      'merchantId',
      'method',
      'mode',
      'profileId',
      'railAdapter',
      'railRef',
      'refundedAmount',
      'status',
    ];
    it('a delivered payment event carries only the allowlisted payment-state keys, for A only', async () => {
      await w.webhooks.enqueue({ type: 'payment.captured', payment: await w.pay.getPayment(w.e.A.paymentId) });
      await w.webhooks.processDue(50);
      const forA = w.outbound.filter((o) => o.url.includes('hook-A'));
      expect(forA.length).toBeGreaterThan(0);
      for (const o of forA) {
        const body = JSON.parse(o.body) as { id: string; type: string; createdAt: string; data: { payment: Record<string, unknown> } };
        expect(Object.keys(body).sort()).toEqual(['createdAt', 'data', 'id', 'type']);
        expect(Object.keys(body.data)).toEqual(['payment']);
        expect(Object.keys(body.data.payment).sort()).toEqual(ALLOWED_PAYMENT_KEYS);
        const text = o.body.toLowerCase();
        for (const needle of ['founder', 'feebps', 'reserve', 'tier', 'halt', 'kyb', 'risk', 'treasury', 'spread', 'cap']) {
          expect(text, `webhook body contains "${needle}"`).not.toContain(needle.replace('cap', 'capacity'));
        }
      }
    });
  });

  describe('composition pin', () => {
    it('src/index.ts still composes the routers this fixture mirrors, with the one live founder authority', () => {
      const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'index.ts'), 'utf8');
      for (const piece of [
        'createPayRouter(pay, rails, userMoney, subMerchants',
        'createMerchantStateRouter(',
        'createKybPspRouter(',
        'createSubMerchantRouter(subMerchants, pay, sql)',
        'new MerchantAccountControls(sql, founderAuthority',
        'createMetricsRuntime({ sql, pay, trees: subMerchants, rails }, { settlementAssets })',
        'registerPublicPayRest(app',
      ]) {
        expect(src, piece).toContain(piece);
      }
      // The namespaces mount list may grow; what it must keep is the one live authority, the metrics
      // runtime, the registries wired to the real approvals consumer, and (W15) the pay database, which
      // is what mounts merchantOps.* and founderAdmin.ops.* (without it every merchantOps call refuses closed).
      const mount = /createPayNamespaces\(\{([^}]*(?:\{[^}]*\}[^}]*)*)\}\)/.exec(src);
      expect(mount, 'src/index.ts no longer calls createPayNamespaces({ ... })').not.toBeNull();
      const args = mount![1]!;
      for (const piece of ['founderAuthority', 'metrics', 'registries: { sql, approvals: actionApprovals }']) {
        expect(args, `createPayNamespaces is no longer given ${piece}`).toContain(piece);
      }
      // W5: one halt store, built from the database, the configured count, and the rail registry,
      // so payHalts.* answer for real instead of refusing closed. The same object is what rail-send paths record into.
      expect(src, 'halt store is no longer the live PayHaltStore').toContain(
        'const haltStore = new PayHaltStore(sql, loadHaltAutoTripConfig(process.env), rails);',
      );
      for (const piece of [
        'payHalts: { store: haltStore, merchants: pay, team: teamReadFromSql(sql) }',
        'treasury: { sql,',
        'control: new ControlService(sql, teamAccessPorts(sql))',
      ]) {
        expect(args, `createPayNamespaces is no longer given ${piece}`).toContain(piece);
      }
      const topLevel = args.replace(/\{[^{}]*\}/g, '{}');
      expect(topLevel, 'createPayNamespaces is no longer given the pay database as its own `sql` argument').toMatch(/(^|,)\s*sql\s*(,|$)/);
      expect(src.match(/createFounderAuthority\(/g), 'exactly one live founder authority').toHaveLength(1);
    });
  });
});
