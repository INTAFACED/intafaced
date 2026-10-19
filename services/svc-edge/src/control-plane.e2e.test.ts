import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { issueAccessToken, type TokenConfig } from '@intafaced/auth';
import { createAdminApi, type LedgerOperatorCall } from './admin-api.js';
import { stubApprovalConsumer } from './action-approval-consume.js';
import { registerAdminRoutes, registerKillSwitchGuard } from './control-plane.js';
import { KillSwitchState } from './kill-switch.js';
import { describeQuantHonestyDoorStatus } from './quant-honesty-status.js';

// These suites read the live process env for the sanctions-screening posture. An
// unset APP_ENV is production-like and refuses by design, so they declare the test env.
vi.stubEnv('APP_ENV', 'test');

/**
 * PULLING THE SWITCH, END TO END (§14.6).
 *
 * The DoD gate lists "kill-switch verified reachable from apps/admin" as a
 * manual sign-off item, and a kill-switch nobody has ever pulled is not a
 * kill-switch. So this file does not assert that an endpoint returns 200. It
 * mints a real operator token, sends a real HTTP request to the real
 * `/admin/kill-switches` route, and then sends real traffic at the modules to
 * prove the BEHAVIOUR changed.
 *
 * ── Why this is end-to-end and not a mock of one ────────────────────────────
 *
 * `registerKillSwitchGuard` and `registerAdminRoutes` are the same two functions
 * `index.ts` calls, in the same order, on the same kind of Fastify instance.
 * Nothing here is a parallel copy of the rule — a switch verified only through a
 * test-only path is not verified. What is stubbed is only what is on the far
 * side of the perimeter: the upstream services, which stand in for svc-trade,
 * svc-protocol and svc-token, and answer 200 so that a refusal can only have
 * come from the switch.
 *
 * The one thing this cannot cover is the proxy handler in `index.ts`, which
 * reads `env` and listens at module scope. It does not need to: the guard is an
 * `onRequest` hook, so it runs strictly before any handler, and a request that
 * the hook refuses never reaches one.
 */

const tokens: TokenConfig = {
  secret: 'test-only-signing-secret-at-least-32-characters-long',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const CONFIRM = '44444444-4444-4444-8444-444444444444';
const SESSION = '22222222-2222-4222-8222-222222222222';
const TRADER = '33333333-3333-4333-8333-333333333333';

async function bearer(scopes: string[], mfa = true, userId = OPERATOR): Promise<string> {
  const { token } = await issueAccessToken({ userId, sessionId: SESSION, scopes, tier: 'institutional', mfa }, tokens);
  return `Bearer ${token}`;
}

/** An operator who may halt a module. */
const asOperator = () => bearer(['admin:write']);
/** An operator who may halt the money plane. */
const asTreasury = () => bearer(['admin:treasury']);
/** An ordinary user session, exactly as svc-identity issues one. */
const asUser = () => bearer(['identity:read', 'identity:write', 'trade:read', 'trade:write', 'ledger:read'], true, TRADER);

interface Harness {
  app: FastifyInstance;
  state: KillSwitchState;
  /** Every upstream call the stub services saw. Empty means nothing got through. */
  reached: string[];
}

let harness: Harness | null = null;

async function edge(ledger: LedgerOperatorCall | null = null, statePath?: string): Promise<Harness> {
  const app = Fastify({ logger: false });
  const state = new KillSwitchState({ statePath });
  const reached: string[] = [];

  // THE SAME TWO CALLS `index.ts` MAKES, in the same order.
  registerKillSwitchGuard(app, state);
  registerAdminRoutes(app, createAdminApi(state, { tokens, ledger, approvals: stubApprovalConsumer(CONFIRM) }));

  // The far side of the perimeter. Answers 200 to everything, so a non-200 can
  // only have come from the switch — which is the whole point of the assertion.
  app.all('/api/*', async (req) => {
    reached.push(`${req.method} ${req.url}`);
    return { ok: true };
  });

  await app.ready();
  harness = { app, state, reached };
  return harness;
}

afterEach(async () => {
  await harness?.app.close();
  harness = null;
});

/** Flip a switch the way an operator does: over HTTP, with a token, a reason, and a confirmer. */
async function flip(
  h: Harness,
  module: string,
  disabled: boolean,
  reason: string,
  auth?: string,
  confirmOperatorId: string | null = CONFIRM,
) {
  return h.app.inject({
    method: 'POST',
    url: '/admin/kill-switches',
    headers: { authorization: auth ?? (await asOperator()) },
    payload: { module, disabled, reason, confirmOperatorId, approvalId: 'appr-1', operationId: 'op-1' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A-P5-OPS — operator status surface (summary without treasury)
// ─────────────────────────────────────────────────────────────────────────────

describe('/admin/status — control-plane summary', () => {
  it('refuses an ordinary user session', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asUser() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns disabled count and ledgerConfigured without requiring treasury', async () => {
    const h = await edge();
    const WHY = 'status probe after manual halt of trade for book review';
    expect((await flip(h, 'trade', true, WHY)).statusCode).toBe(200);

    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      ok: boolean;
      disabledModules: string[];
      disabledCount: number;
      ledgerConfigured: boolean;
      auditCount: number;
      lastChange: { module: string } | null;
    };
    expect(body.ok).toBe(true);
    expect(body.disabledModules).toEqual(['trade']);
    expect(body.disabledCount).toBe(1);
    expect(body.ledgerConfigured).toBe(false);
    expect(body.auditCount).toBeGreaterThanOrEqual(1);
    expect(body.lastChange?.module).toBe('trade');
  });

  /**
   * THE residual that made a green console a lie: `ws` is not behind this edge.
   * Status must name the gap so an operator never reads "disabledModules"
   * and invents a halted market-data socket. Multi-replica share must stay
   * explicitly false — inventing a shared store is fenced (§13).
   */
  it('names modules outside the door and process-local kill durability', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      outsideTheDoor: Record<string, string>;
      enforceableModules: string[];
      killState: { persistence: string; multiReplicaShared: boolean; note: string };
      disabledModules: string[];
    };

    expect((body as { killMutateDualControl?: boolean }).killMutateDualControl).toBe(true);
    expect(body.outsideTheDoor.ws).toMatch(/socket\.ws-behind-the-edge|not through this edge/i);
    expect(body.outsideTheDoor.ledger).toMatch(/posting_freeze|admin\/ledger\/freeze/i);
    expect(body.outsideTheDoor.matching).toBeTruthy();
    // A halted list that contains `ws` would be the old green-while-live failure.
    expect(body.disabledModules).not.toContain('ws');
    expect(body.enforceableModules).toContain('trade');
    expect(body.enforceableModules).not.toContain('ws');
    expect(body.killState.multiReplicaShared).toBe(false);
    expect(body.killState.persistence === 'file' || body.killState.persistence === 'memory').toBe(true);
    expect(body.killState.note.length).toBeGreaterThan(20);
  });

  it('names edge.gateway as unenforced so status cannot invent a flag-only halt', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      liveKillControl: string;
      flagEdgeGateway: { key: string; enforced: boolean; note: string };
    };
    expect(body.liveKillControl).toBe('operator-kill-switch');
    expect(body.flagEdgeGateway).toMatchObject({ key: 'edge.gateway', enforced: false });
    expect(body.flagEdgeGateway.note).toMatch(/NOT_ENFORCED|does not stop the proxy/i);
  });

  /**
   * Wave 10 ops residual: #1551 config honesty must reach the door.
   * unset network ≠ clear; invent freezes refused; analytics never live without lag.
   */
  it('surfaces network/freeze/compliance/analytics honesty on status', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      networkSignal: { declaration: string; partnerConfigured: boolean; accessCode: string };
      freezeAuthority: {
        soleKey: string;
        inventTradeFreezeOk: boolean;
        ledgerPostingOk: boolean;
      };
      complianceQueue: { empty: boolean; partnerConfigured: boolean };
      analytics: { mayLabelLive: boolean; surfaceStatus: string };
    };
    expect(body.networkSignal.declaration).toBe('unset');
    expect(body.networkSignal.partnerConfigured).toBe(false);
    expect(body.freezeAuthority.soleKey).toBe('ledger.posting');
    expect(body.freezeAuthority.inventTradeFreezeOk).toBe(false);
    expect(body.freezeAuthority.ledgerPostingOk).toBe(true);
    expect(body.complianceQueue.empty).toBe(true);
    expect(body.analytics.mayLabelLive).toBe(false);
    expect(body.analytics.surfaceStatus).not.toBe('ok');
  });

  it('surfaces quant honesty door status including composite assess path', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      quantHonesty: {
        compositeHonestyWired: boolean;
        inventsReturns: boolean;
        edgeDoorPathsAlignedWithDataLake: boolean;
        mountedOnControlPlane: boolean;
        notProxiedToSvcQuant: boolean;
        statusLine: string;
        doors: { path: string; package: string; method: string }[];
      };
    };
    expect(body.quantHonesty.compositeHonestyWired).toBe(true);
    expect(body.quantHonesty.inventsReturns).toBe(false);
    expect(body.quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(body.quantHonesty.mountedOnControlPlane).toBe(true);
    expect(body.quantHonesty.notProxiedToSvcQuant).toBe(true);
    expect(body.quantHonesty.statusLine).toMatch(/not proxied to svc-quant/i);
    expect(body.quantHonesty.statusLine).toMatch(/backtest/i);
    expect(body.quantHonesty.statusLine).toMatch(/surface render/i);
    expect(body.quantHonesty.statusLine).toMatch(/composite assess/i);
    const doorPaths = body.quantHonesty.doors.map((door) => door.path);
    expect(doorPaths).toContain('/quant/honesty/assess-composite');
    expect(doorPaths).toContain('/quant/honesty/assess-surface-render');
    expect(doorPaths).toContain('/quant/honesty/assess-comparison-order');
    const byPath = Object.fromEntries(body.quantHonesty.doors.map((door) => [door.path, door.package]));
    expect(byPath['/quant/honesty/assess-surface-render']).toBe('@intafaced/connect-data-lake');
    expect(byPath['/quant/honesty/assess-composite']).toBe('composite');
    expect(byPath['/quant/honesty/assess-backtest']).toBe('@intafaced/quant-honesty');
    expect(byPath['/quant/honesty/assess-comparison-order']).toBe('@intafaced/quant-honesty');
    const methodsByPath = Object.fromEntries(body.quantHonesty.doors.map((door) => [door.path, door.method]));
    expect(methodsByPath['/quant/honesty/performance-labels']).toBe('GET');
    expect(methodsByPath['/quant/honesty/assess-backtest']).toBe('POST');
    expect(methodsByPath['/quant/honesty/assess-comparison-order']).toBe('POST');
    expect(methodsByPath['/quant/honesty/assess-surface-render']).toBe('POST');
    expect(body.quantHonesty.doors).toHaveLength(5);
    expect(doorPaths.sort()).toEqual(
      [
        '/quant/honesty/assess-backtest',
        '/quant/honesty/assess-comparison-order',
        '/quant/honesty/assess-composite',
        '/quant/honesty/assess-surface-render',
        '/quant/honesty/performance-labels',
      ].sort(),
    );
  });

  it('quant honesty status reports five unique doors with mount honesty flags (D65)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const { quantHonesty } = res.json() as {
      quantHonesty: {
        doors: { path: string }[];
        mountedOnControlPlane: boolean;
        notProxiedToSvcQuant: boolean;
        inventsReturns: boolean;
        compositeHonestyWired: boolean;
        edgeDoorPathsAlignedWithDataLake: boolean;
      };
    };
    expect(new Set(quantHonesty.doors.map((door) => door.path)).size).toBe(5);
    expect(quantHonesty.mountedOnControlPlane).toBe(true);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.compositeHonestyWired).toBe(true);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
  });

  it('quant honesty statusLine names all door families over HTTP (D67)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const { quantHonesty } = res.json() as {
      quantHonesty: { statusLine: string; doors: unknown[] };
    };
    expect(quantHonesty.statusLine).toMatch(/backtest/i);
    expect(quantHonesty.statusLine).toMatch(/comparison/i);
    expect(quantHonesty.statusLine).toMatch(/labels/i);
    expect(quantHonesty.statusLine).toMatch(/surface render/i);
    expect(quantHonesty.statusLine).toMatch(/composite assess/i);
    expect(quantHonesty.statusLine).toMatch(/not proxied to svc-quant/i);
    expect(quantHonesty.doors).toHaveLength(5);
  });

  it('quant honesty doors report package and method per path over HTTP (D71)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const { quantHonesty } = res.json() as {
      quantHonesty: { doors: { path: string; package: string; method: string }[] };
    };
    const byPath = Object.fromEntries(quantHonesty.doors.map((door) => [door.path, door]));
    expect(byPath['/quant/honesty/assess-backtest']).toMatchObject({ method: 'POST', package: '@intafaced/quant-honesty' });
    expect(byPath['/quant/honesty/assess-comparison-order']).toMatchObject({ method: 'POST', package: '@intafaced/quant-honesty' });
    expect(byPath['/quant/honesty/performance-labels']).toMatchObject({ method: 'GET', package: '@intafaced/quant-honesty' });
    expect(byPath['/quant/honesty/assess-surface-render']).toMatchObject({ method: 'POST', package: '@intafaced/connect-data-lake' });
    expect(byPath['/quant/honesty/assess-composite']).toMatchObject({ method: 'POST', package: 'composite' });
    expect(quantHonesty.doors).toHaveLength(5);
  });

  it('quant honesty HTTP admin status mirrors describeQuantHonestyDoorStatus board (D75)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const { quantHonesty } = res.json() as {
      quantHonesty: {
        statusLine: string;
        mountedOnControlPlane: boolean;
        notProxiedToSvcQuant: boolean;
        inventsReturns: boolean;
        compositeHonestyWired: boolean;
        edgeDoorPathsAlignedWithDataLake: boolean;
        doors: { path: string; package: string; method: string }[];
      };
    };
    const status = describeQuantHonestyDoorStatus();
    expect(quantHonesty.mountedOnControlPlane).toBe(status.mountedOnControlPlane);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(status.notProxiedToSvcQuant);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.compositeHonestyWired).toBe(status.compositeHonestyWired);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.statusLine).toMatch(/not proxied to svc-quant/i);
    expect(quantHonesty.doors.map((door) => door.path).sort()).toEqual(status.doors.map((door) => door.path).sort());
  });

  it('quant honesty HTTP admin status full board complete (D77)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const { quantHonesty } = res.json() as {
      quantHonesty: {
        statusLine: string;
        mountedOnControlPlane: boolean;
        notProxiedToSvcQuant: boolean;
        inventsReturns: boolean;
        compositeHonestyWired: boolean;
        edgeDoorPathsAlignedWithDataLake: boolean;
        doors: { path: string; package: string; method: string }[];
      };
    };
    const status = describeQuantHonestyDoorStatus();
    expect(quantHonesty.statusLine).toBe(status.statusLine);
    expect(quantHonesty.mountedOnControlPlane).toBe(true);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.compositeHonestyWired).toBe(true);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.doors).toHaveLength(5);
    for (const door of status.doors) {
      expect(quantHonesty.doors).toContainEqual(door);
    }
  });

  it('quant honesty HTTP admin status denon board complete (D79)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
  });

  it('quant honesty HTTP admin status denon board complete (D81)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.statusLine).toMatch(/not proxied to svc-quant/i);
    expect(quantHonesty.mountedOnControlPlane).toBe(true);
    expect(quantHonesty.compositeHonestyWired).toBe(true);
    expect(quantHonesty.doors.map((door) => door.package)).toEqual([
      '@intafaced/quant-honesty',
      '@intafaced/quant-honesty',
      '@intafaced/quant-honesty',
      '@intafaced/connect-data-lake',
      'composite',
    ]);
  });

  it('quant honesty HTTP admin status denon board complete (D83)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D85)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.statusLine).toMatch(/not proxied to svc-quant/i);
    expect(quantHonesty.mountedOnControlPlane).toBe(true);
    expect(quantHonesty.compositeHonestyWired).toBe(true);
    expect(quantHonesty.doors.map((door) => door.package)).toEqual([
      '@intafaced/quant-honesty',
      '@intafaced/quant-honesty',
      '@intafaced/quant-honesty',
      '@intafaced/connect-data-lake',
      'composite',
    ]);
  });

  it('quant honesty HTTP admin status denon board complete (D87)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D89)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.statusLine).toMatch(/not proxied to svc-quant/i);
    expect(quantHonesty.mountedOnControlPlane).toBe(true);
    expect(quantHonesty.compositeHonestyWired).toBe(true);
    expect(quantHonesty.doors.map((door) => door.package)).toEqual([
      '@intafaced/quant-honesty',
      '@intafaced/quant-honesty',
      '@intafaced/quant-honesty',
      '@intafaced/connect-data-lake',
      'composite',
    ]);
  });

  it('quant honesty HTTP admin status denon board complete (D91)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D93)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D95)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D97)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D99)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D101)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D103)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D105)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D107)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D109)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D111)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D113)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D115)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D117)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('quant honesty HTTP admin status denon board complete (D119)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'GET',
      url: '/admin/status',
      headers: { authorization: await asOperator() },
    });
    expect(res.statusCode).toBe(200);
    const status = describeQuantHonestyDoorStatus();
    const { quantHonesty } = res.json() as { quantHonesty: ReturnType<typeof describeQuantHonestyDoorStatus> };
    expect(quantHonesty).toEqual(status);
    expect(quantHonesty.doors).toHaveLength(5);
    expect(quantHonesty.edgeDoorPathsAlignedWithDataLake).toBe(true);
    expect(quantHonesty.inventsReturns).toBe(false);
    expect(quantHonesty.notProxiedToSvcQuant).toBe(true);
  });

  it('refuses partner_cleared on the queue HTTP path without a screening partner', async () => {
    const h = await edge();
    // Seed via admin API method through status surface — open is not HTTP yet
    // for thrift; disposition is. Open case via the same process's createAdminApi
    // is only unit-tested; here we prove HTTP refuse shape when item missing first.
    const missing = await h.app.inject({
      method: 'POST',
      url: '/admin/compliance/queue/disposition',
      headers: { authorization: await asOperator(), 'content-type': 'application/json' },
      payload: { itemId: 'no-such', status: 'partner_cleared', partnerRef: 'slot' },
    });
    expect(missing.statusCode).toBe(409);
    expect(missing.json()).toMatchObject({ ok: false, code: 'refuse.unknown_item' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// trade.spot — §14's own worked example, and the asymmetry that is the point
// ─────────────────────────────────────────────────────────────────────────────

describe('trade.spot off: new risk refused, and the door out stays open', () => {
  const WHY = 'incident 2026-07-30, book quoting stale prices';

  it('accepts orders before the switch is pulled', async () => {
    const h = await edge();
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/orders' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/api/trade/trpc/orders.create' })).statusCode).toBe(200);
  });

  it('REFUSES a new order once trade is halted — over tRPC and over the CCXT REST path', async () => {
    const h = await edge();
    expect((await flip(h, 'trade', true, WHY)).statusCode).toBe(200);

    const trpc = await h.app.inject({ method: 'POST', url: '/api/trade/trpc/orders.create' });
    expect(trpc.statusCode).toBe(503);
    expect(trpc.json()).toMatchObject({ code: 'edge.module_killed', module: 'trade' });

    // The path a ccxt client actually uses. This is the one an earlier revision
    // left un-killable, because `/api/v1` does not spell "trade".
    const rest = await h.app.inject({ method: 'POST', url: '/api/v1/orders' });
    expect(rest.statusCode).toBe(503);
    expect(rest.json()).toMatchObject({ code: 'edge.module_killed', module: 'trade' });

    // Nothing reached svc-trade. A refusal that still forwards is not a halt.
    expect(h.reached).toEqual([]);
  });

  /**
   * THE HALF THAT MAKES IT A SAFETY CONTROL RATHER THAN A TRAP.
   *
   * An operator halting a market is stopping new risk, not confiscating
   * positions. A user must always be able to get out.
   */
  it('STILL LETS A USER CANCEL — over tRPC and over the CCXT REST path', async () => {
    const h = await edge();
    await flip(h, 'trade', true, WHY);

    expect((await h.app.inject({ method: 'POST', url: '/api/trade/trpc/orders.cancel' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/orders/8f3c1d2e-0000-4000-8000-000000000001' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/orders' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/orders?symbol=BTC/USDT' })).statusCode).toBe(200);

    // And they genuinely reached the service, rather than being answered by the
    // edge with a cheerful 200 that cancelled nothing.
    expect(h.reached).toHaveLength(4);
  });

  it('still serves the reads a user needs to see what they are cancelling', async () => {
    const h = await edge();
    await flip(h, 'trade', true, WHY);

    expect((await h.app.inject({ method: 'GET', url: '/api/v1/orders/open' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/account/balance' })).statusCode).toBe(200);
  });

  it('leaves every other module alone', async () => {
    const h = await edge();
    await flip(h, 'trade', true, WHY);

    expect((await h.app.inject({ method: 'POST', url: '/api/identity/trpc/auth.login' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/api/pay/trpc/deposit.credit' })).statusCode).toBe(200);
  });

  it('comes back, so an incident can end', async () => {
    const h = await edge();
    await flip(h, 'trade', true, WHY);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/orders' })).statusCode).toBe(503);

    await flip(h, 'trade', false, 'feed recovered, resuming the market');
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/orders' })).statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The relay, and emissions
// ─────────────────────────────────────────────────────────────────────────────

describe('the relay switch: the protocol path refuses', () => {
  it('refuses a relayed submission once protocol is halted', async () => {
    const h = await edge();
    expect((await h.app.inject({ method: 'POST', url: '/api/protocol/trpc/relay.submit' })).statusCode).toBe(200);

    await flip(h, 'protocol', true, 'sequencer wedged, stop accepting relayed transactions');

    const res = await h.app.inject({ method: 'POST', url: '/api/protocol/trpc/relay.submit' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'edge.module_killed', module: 'protocol' });
    expect(h.reached).toHaveLength(1); // only the pre-halt call
  });

  it('still lets a user read their own protocol state during the halt', async () => {
    const h = await edge();
    await flip(h, 'protocol', true, 'sequencer wedged, stop accepting relayed transactions');
    expect((await h.app.inject({ method: 'GET', url: '/api/protocol/trpc/account.get' })).statusCode).toBe(200);
  });
});

describe('emissions off: the mint fails closed', () => {
  /**
   * `svc-token/src/env.ts` states the reason this switch must fail closed
   * rather than degrade: "inflation cannot be un-minted". A mint that is refused
   * can be retried; a mint that happened cannot be taken back.
   */
  it('refuses a mint once token is halted', async () => {
    const h = await edge();
    await flip(h, 'token', true, 'emission curve under review, stop minting');

    const res = await h.app.inject({ method: 'POST', url: '/api/token/trpc/emissions.mintEpoch' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'edge.module_killed', module: 'token' });
    expect(h.reached).toEqual([]);
  });

  it('never answers a refused mint with a success', async () => {
    const h = await edge();
    await flip(h, 'token', true, 'emission curve under review, stop minting');

    const res = await h.app.inject({ method: 'POST', url: '/api/token/trpc/emissions.mintEpoch' });
    expect(res.statusCode).toBeGreaterThanOrEqual(500);
    // The internal mint is not a public door — 404 here, never a 200 that reached token.
    const s2s = await h.app.inject({ method: 'POST', url: '/api/token/internal/emissions/mint-next' });
    expect(s2s.statusCode).toBe(404);
    expect(s2s.json()).toMatchObject({ code: 'edge.s2s_not_proxied' });
    expect(h.reached).toEqual([]);
  });
});

describe('service /internal/ is not a public door', () => {
  it('404s pay/identity/token internals even when the module is live', async () => {
    const h = await edge();
    for (const url of [
      '/api/token/internal/emissions/mint-next',
      '/api/token/internal/stake/11111111-1111-4111-8111-111111111111',
      '/api/identity/internal/rank/11111111-1111-4111-8111-111111111111/perks',
      '/api/pay/internal/jobs/run-due-subscriptions',
      '/api/academy/internal/anything',
      '/api/support/internal/anything',
    ]) {
      const res = await h.app.inject({ method: 'POST', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toMatchObject({ code: 'edge.s2s_not_proxied' });
    }
    expect(h.reached).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Fail closed
// ─────────────────────────────────────────────────────────────────────────────

describe('an errored switch check behaves as ENGAGED', () => {
  /**
   * The one bug that makes a safety control worse than not having it. If the
   * check throws and the request is let through, the operator believes the
   * market is halted, the console says it is halted, and orders are being
   * accepted.
   */
  it('refuses every write when the switch itself throws', async () => {
    const app = Fastify({ logger: false });
    const reached: string[] = [];

    const broken = new KillSwitchState();
    // Stands in for a durable flag store that has lost its connection — the
    // realistic way this fails once the §13 socket is filled.
    broken.decide = () => {
      throw new Error('flag store unreachable');
    };

    registerKillSwitchGuard(app, broken);
    app.all('/api/*', async (req) => {
      reached.push(req.url);
      return { ok: true };
    });
    await app.ready();
    harness = { app, state: broken, reached };

    const res = await app.inject({ method: 'POST', url: '/api/v1/orders' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'edge.kill_switch_undecidable' });
    expect(reached).toEqual([]);
  });

  it('says WHY it refused, so a broken check is never mistaken for an operator halt', async () => {
    const h = await edge();
    await flip(h, 'trade', true, 'incident 2026-07-30, book quoting stale prices');

    const halted = await h.app.inject({ method: 'POST', url: '/api/v1/orders' });
    expect(halted.json().code).toBe('edge.module_killed');
    // The two call for completely different responses at 3am, so they must never
    // share a code.
    expect(halted.json().code).not.toBe('edge.kill_switch_undecidable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Authorisation — an operator control any authenticated user can reach is not a control
// ─────────────────────────────────────────────────────────────────────────────

describe('who can actually reach the switch', () => {
  const WHY = 'incident 2026-07-30, book quoting stale prices';

  it('refuses an anonymous caller', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/kill-switches',
      payload: { module: 'trade', disabled: true, reason: WHY, approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(res.statusCode).toBe(401);
    expect(h.state.isKilled('trade')).toBe(false);
  });

  /** The property that matters most: a valid user session must not halt the exchange. */
  it('refuses an ordinary user session, however valid', async () => {
    const h = await edge();
    const res = await flip(h, 'trade', true, WHY, await asUser());
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'scope.denied' });
    expect(h.state.isKilled('trade')).toBe(false);
  });

  it('refuses an operator who has not passed a second factor', async () => {
    const h = await edge();
    const res = await flip(h, 'trade', true, WHY, await bearer(['admin:write'], false));
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'mfa.required' });
    expect(h.state.isKilled('trade')).toBe(false);
  });

  it('refuses a token signed with another key', async () => {
    const h = await edge();
    const { token } = await issueAccessToken(
      { userId: OPERATOR, sessionId: SESSION, scopes: ['admin:write'], mfa: true },
      { ...tokens, secret: 'a-completely-different-secret-that-is-long-enough' },
    );
    expect((await flip(h, 'trade', true, WHY, `Bearer ${token}`)).statusCode).toBe(401);
    expect(h.state.isKilled('trade')).toBe(false);
  });

  it('refuses a halt with no usable reason', async () => {
    const h = await edge();
    expect((await flip(h, 'trade', true, 'oops')).statusCode).toBe(400);
    expect(h.state.isKilled('trade')).toBe(false);
  });

  it('refuses a halt with no approval ids — a typed-in second name is not approval', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/kill-switches',
      headers: { authorization: await asOperator() },
      payload: { module: 'trade', disabled: true, reason: WHY, confirmOperatorId: CONFIRM },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'action_approval.missing' });
    expect(h.state.isKilled('trade')).toBe(false);
  });

  it('accepts kill with approval ids even if confirmOperatorId is omitted (display-only)', async () => {
    const h = await edge();
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/kill-switches',
      headers: { authorization: await asOperator() },
      payload: { module: 'trade', disabled: true, reason: WHY, approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(h.state.isKilled('trade')).toBe(true);
  });

  it('accepts two distinct operators and records the confirmer', async () => {
    const h = await edge();
    const res = await flip(h, 'trade', true, WHY);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ confirmOperatorId: CONFIRM, disabledModules: ['trade'] });
    expect(h.state.auditTrail()[0]).toMatchObject({ actor: OPERATOR, confirmOperatorId: CONFIRM });
  });

  it('refuses a module that does not exist rather than inventing one', async () => {
    const h = await edge();
    expect((await flip(h, 'not-a-module', true, WHY)).statusCode).toBe(400);
  });

  /**
   * If halting `edge` could take the control plane down with it, the switch that
   * stopped the platform could not be used to restart it.
   */
  it('keeps the control plane reachable while modules are killed', async () => {
    const h = await edge();
    await flip(h, 'trade', true, WHY);
    await flip(h, 'identity', true, 'credential stuffing wave, close registration');

    const read = await h.app.inject({ method: 'GET', url: '/admin/kill-switches', headers: { authorization: await asOperator() } });
    expect(read.statusCode).toBe(200);
    expect(read.json().disabledModules).toEqual(['identity', 'trade']);

    // And the halt can still be lifted.
    expect((await flip(h, 'trade', false, 'feed recovered, resuming the market')).statusCode).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A switch that cannot be enforced must not be armable
// ─────────────────────────────────────────────────────────────────────────────

describe('the console cannot arm a kill the edge cannot enforce', () => {
  const WHY = 'incident drill, attempting to halt a module outside the edge';

  /**
   * THE BUG THIS FIXES, IN ONE TEST.
   *
   * `toggleSchema` accepted every one of the 23 `MODULE_IDS`, while the edge can
   * only refuse the 13 with a prefix in the route table. `ws` is the one that
   * mattered: svc-ws is deployed, publishes 4014, and the browser connects to it
   * directly. Halting it returned 200, wrote a real audit entry, showed up in
   * `disabledModules` — and refused nothing.
   */
  it('refuses to halt `ws`, because svc-ws does not sit behind this edge', async () => {
    const h = await edge();
    const res = await flip(h, 'ws', true, WHY);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('edge.invalid_kill_switch');
    // The operator is told WHICH control is missing, not merely refused.
    expect(res.json().error).toContain('not through this edge');
    // And nothing was recorded as halted.
    expect(h.state.isKilled('ws')).toBe(false);
  });

  it('does not write an audit entry for a halt it refused to arm', async () => {
    const h = await edge();
    await flip(h, 'ws', true, WHY);

    const read = await h.app.inject({ method: 'GET', url: '/admin/kill-switches', headers: { authorization: await asOperator() } });
    expect(read.json().audit).toEqual([]);
    expect(read.json().disabledModules).toEqual([]);
  });

  /** The money plane has a stronger, durable control — this one must not shadow it. */
  it('points the operator at the ledger freeze instead of a module flag', async () => {
    const h = await edge();
    const res = await flip(h, 'ledger', true, WHY);

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('/admin/ledger/freeze');
  });

  it('still arms every module the edge CAN enforce', async () => {
    const h = await edge();
    // One from each shape: tRPC-only, the dual-contract trade module, protocol.
    for (const module of ['identity', 'trade', 'protocol', 'pay', 'academy']) {
      const res = await flip(h, module, true, `drill halt of ${module} during the reachability audit`);
      expect(res.statusCode, module).toBe(200);
    }
  });

  /** The refusal must read as a sentence, not as a nested JSON dump. */
  it('gives a reason an operator can read at 3am', async () => {
    const h = await edge();
    const error = (await flip(h, 'ws', true, WHY)).json().error as string;
    expect(error).not.toContain('"code"'); // not a serialised zod issue array
    expect(error).toContain('"ws" cannot be halted at this edge');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The audit trail
// ─────────────────────────────────────────────────────────────────────────────

describe('the audit trail, read back over HTTP', () => {
  it('names who pulled it, when, what, and what it was before', async () => {
    const h = await edge();
    await flip(h, 'trade', true, 'incident 2026-07-30, book quoting stale prices');

    const read = await h.app.inject({ method: 'GET', url: '/admin/kill-switches', headers: { authorization: await asOperator() } });
    const [entry] = read.json().audit;

    expect(entry).toMatchObject({
      module: 'trade',
      actor: OPERATOR, // WHO — from the token, never from the request body
      reason: 'incident 2026-07-30, book quoting stale prices', // WHAT, and why
      previous: false, // THE PRIOR STATE
      next: true,
      changed: true,
    });
    expect(Date.parse(entry.at)).not.toBeNaN(); // WHEN
  });

  it('records the resume as well as the halt, so an incident has an end', async () => {
    const h = await edge();
    await flip(h, 'trade', true, 'incident 2026-07-30, book quoting stale prices');
    await flip(h, 'trade', false, 'feed recovered, resuming the market');

    const read = await h.app.inject({ method: 'GET', url: '/admin/kill-switches', headers: { authorization: await asOperator() } });
    expect(read.json().audit.map((e: { next: boolean }) => e.next)).toEqual([false, true]);
  });

  it('does not record a halt that never happened', async () => {
    const h = await edge();
    await flip(h, 'trade', true, 'oops'); // refused: reason too short

    const read = await h.app.inject({ method: 'GET', url: '/admin/kill-switches', headers: { authorization: await asOperator() } });
    expect(read.json().audit).toEqual([]);
  });

  it('is operator-only — an incident timeline is not public', async () => {
    const h = await edge();
    expect((await h.app.inject({ method: 'GET', url: '/admin/kill-switches' })).statusCode).toBe(401);
    expect(
      (await h.app.inject({ method: 'GET', url: '/admin/kill-switches', headers: { authorization: await asUser() } })).statusCode,
    ).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The money plane
// ─────────────────────────────────────────────────────────────────────────────

describe('the ledger freeze — the switch that halts all value movement', () => {
  const WHY = 'reconciliation mismatch on BTC, halting posting';

  /** A stub svc-ledger operator surface, recording what the edge sent it. */
  function stubLedger() {
    const calls: { path: string; bearer: string; body: unknown }[] = [];
    const call: LedgerOperatorCall = async (path, _method, bearerHeader, body) => {
      calls.push({ path, bearer: bearerHeader, body });
      return { status: 200, body: { frozen: path === '/operator/freeze', actor: OPERATOR } };
    };
    return { calls, call };
  }

  it('refuses admin:write — halting a market is not the authority to halt the money plane', async () => {
    const { calls, call } = stubLedger();
    const h = await edge(call);

    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/ledger/freeze',
      headers: { authorization: await asOperator() },
      payload: { reason: WHY, approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(res.statusCode).toBe(403);
    expect(calls).toEqual([]);
  });

  it('accepts admin:treasury and forwards the operator OWN token', async () => {
    const { calls, call } = stubLedger();
    const h = await edge(call);
    const auth = await asTreasury();

    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/ledger/freeze',
      headers: { authorization: auth },
      payload: { reason: WHY, approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(res.statusCode).toBe(200);

    // svc-ledger writes `posting_freeze.actor` from ITS OWN verification of this
    // token, so the edge cannot cause a freeze attributed to anybody else.
    expect(calls).toEqual([
      {
        path: '/operator/freeze',
        bearer: auth,
        body: { reason: WHY, approvalId: 'appr-1', operationId: 'op-1' },
      },
    ]);
  });

  it('refuses an unexplained freeze before it leaves the edge', async () => {
    const { calls, call } = stubLedger();
    const h = await edge(call);

    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/ledger/freeze',
      headers: { authorization: await asTreasury() },
      payload: { reason: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(calls).toEqual([]);
  });

  it('thaws, and carries no reason because a cleared freeze has none', async () => {
    const { calls, call } = stubLedger();
    const h = await edge(call);

    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/ledger/unfreeze',
      headers: { authorization: await asTreasury() },
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({
      path: '/operator/unfreeze',
      body: { approvalId: 'appr-1', operationId: 'op-1' },
    });
  });

  it('is not a proxy — an unnamed action is a 404, not a pass-through', async () => {
    const { calls, call } = stubLedger();
    const h = await edge(call);

    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/ledger/post',
      headers: { authorization: await asTreasury() },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(calls).toEqual([]);
  });

  /**
   * An operator told the platform is halted when it is not is worse off than one
   * told nothing at all.
   */
  it('never turns an unreachable ledger into a success', async () => {
    const h = await edge(null);
    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/ledger/freeze',
      headers: { authorization: await asTreasury() },
      payload: { reason: WHY, approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'edge.ledger_unreachable' });
  });

  it('passes a failing ledger through with its own status', async () => {
    const failing: LedgerOperatorCall = async () => ({ status: 502, body: { code: 'edge.ledger_unavailable' } });
    const h = await edge(failing);

    const res = await h.app.inject({
      method: 'POST',
      url: '/admin/ledger/freeze',
      headers: { authorization: await asTreasury() },
      payload: { reason: WHY, approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(res.statusCode).toBe(502);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D26-P2-10 — every money module killable from the SAME surface, proven over HTTP
// ─────────────────────────────────────────────────────────────────────────────

describe('money modules — same kill surface (D26-P2-10)', () => {
  /**
   * Catalogue lives in `@intafaced/config` (`MONEY_PUBLIC_DOORS`). Arming is
   * always `POST /admin/kill-switches` — the same route trade/token already use.
   * Do not invent a second operator UX.
   */
  const MONEY_MODULES = ['trade', 'pay', 'bank', 'p2p', 'token', 'market', 'agents'] as const;

  const SAMPLE_DOOR: Record<(typeof MONEY_MODULES)[number], string> = {
    trade: '/api/trade/trpc/convert.execute',
    // Public REST commit path (not only tRPC) — same /api/pay prefix kill.
    pay: '/api/pay/v1/payments',
    bank: '/api/bank/trpc/loans.open',
    p2p: '/api/p2p/trpc/disputes.open',
    token: '/api/token/trpc/unstake',
    market: '/api/market/trpc/purchase',
    agents: '/api/agents/trpc/run.complete',
  };

  it('arms every live money module from POST /admin/kill-switches', async () => {
    const h = await edge();
    for (const module of MONEY_MODULES) {
      const res = await flip(h, module, true, `D26-P2-10 halt ${module} money door during completeness drill`);
      expect(res.statusCode, module).toBe(200);
      expect(h.state.isKilled(module), module).toBe(true);
    }
  });

  it('REFUSES each money module sample door once killed — upstream never reached', async () => {
    const h = await edge();
    for (const module of MONEY_MODULES) {
      h.reached.length = 0;
      await flip(h, module, true, `D26-P2-10 refuse proof for ${module} public money door`);
      const res = await h.app.inject({ method: 'POST', url: SAMPLE_DOOR[module] });
      expect(res.statusCode, module).toBe(503);
      expect(res.json(), module).toMatchObject({ code: 'edge.module_killed', module });
      expect(h.reached, module).toEqual([]);
      await flip(h, module, false, `D26-P2-10 resume ${module} after refuse proof`);
    }
  });

  it('still points ledger at /admin/ledger/freeze — not a module flag on the same board family', async () => {
    const h = await edge();
    const res = await flip(h, 'ledger', true, 'D26-P2-10 must not arm a fake ledger module kill');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('/admin/ledger/freeze');
  });
});

// Exercise the actual operator route and request guard, not a parallel persistence path.
it('a failed durable resume returns an error and keeps new commitments halted', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'edge-durable-http-'));
  const statePath = join(directory, 'state.json');
  try {
    writeFileSync(statePath, JSON.stringify({ killed: [] }));
    const h = await edge(null, statePath);
    expect((await flip(h, 'trade', true, 'incident requires durable halt')).statusCode).toBe(200);
    const auditBefore = h.state.auditTrail();
    unlinkSync(statePath);
    mkdirSync(statePath);
    const refused = await flip(h, 'trade', false, 'attempt durable incident resume');
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'edge.invalid_kill_switch' });
    expect(refused.json()).not.toHaveProperty('changed');
    expect(h.state.isKilled('trade')).toBe(true);
    expect(h.state.auditTrail()).toEqual(auditBefore);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/orders' })).statusCode).toBe(503);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/orders' })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/orders/id' })).statusCode).toBe(200);
    expect(new KillSwitchState({ statePath }).isKilled('trade')).toBe(true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it.each([undefined, '{corrupt'])(
  'untrusted file-backed startup blocks commitments but permits reads and cancellation (%s)',
  async (body) => {
    const directory = mkdtempSync(join(tmpdir(), 'edge-boot-http-'));
    const statePath = join(directory, 'state.json');
    try {
      if (body !== undefined) writeFileSync(statePath, body);
      const h = await edge(null, statePath);
      expect(h.state.isKilled('trade')).toBe(true);
      expect((await h.app.inject({ method: 'POST', url: '/api/v1/orders' })).statusCode).toBe(503);
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/orders' })).statusCode).toBe(200);
      expect((await h.app.inject({ method: 'DELETE', url: '/api/v1/orders/id' })).statusCode).toBe(200);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
