import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { issueAccessToken } from '@intafaced/auth';
import { registerOperatorHttp } from './operator-http.js';
import { stubApprovalConsumer } from './ledger/action-approval-consume.js';
import type { LedgerService } from './service.js';

/**
 * THE OPERATOR HTTP SURFACE — freeze already reached the port; reconcile did not.
 *
 * `createLedgerRouter` exposes `reconcile` behind `admin:treasury`, and
 * `LedgerService.reconcile` runs the three real checks (balances, chain,
 * totalsByAsset). `index.ts` mounts only `registerOperatorHttp` for operators —
 * not the tRPC router — so until `/operator/reconcile` exists, on-demand
 * reconciliation is still only a scheduled job. apps/admin's reconcile button
 * stays honest-simulated for that reason (and edge still has no proxy), but the
 * ledger wall closes when the switch is reachable here.
 *
 * This file guards authorisation and the report shape, not the three checks
 * themselves — those live in `reconcile.ts` + `postgres-ledger.test.ts`.
 */

const tokens = {
  secret: 'a-ledger-operator-test-secret-long-enough',
  issuer: 'intafaced',
  audience: 'intafaced.api',
  accessTtlSeconds: 900,
};

const OPERATOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONFIRM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

async function bearer(scopes: string[], mfa = true): Promise<string> {
  const { token } = await issueAccessToken(
    {
      userId: OPERATOR,
      sessionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      scopes,
      tier: 'basic',
      mfa,
    },
    tokens,
  );
  return `Bearer ${token}`;
}

function stubService(overrides: Partial<Record<string, unknown>> = {}): LedgerService {
  return {
    freezeState: async () => ({
      frozen: false,
      reason: null,
      actor: null,
      changedAt: new Date('2026-07-27T00:00:00Z'),
      changedAtPrecise: '2026-07-27 00:00:00.000000+00',
    }),
    freeze: async (reason: string, actor: string) => ({
      frozen: true,
      reason,
      actor,
      changedAt: new Date('2026-07-27T00:00:00Z'),
      changedAtPrecise: '2026-07-27 00:00:00.000000+00',
    }),
    unfreeze: async (actor: string) => ({
      frozen: false,
      reason: null,
      actor,
      changedAt: new Date('2026-07-27T00:00:00Z'),
      changedAtPrecise: '2026-07-27 00:00:00.000000+00',
    }),
    reconcile: async () => ({
      ok: true,
      ranAt: new Date('2026-08-09T12:00:00.000Z'),
      balances: { ok: true as const, accountsChecked: 11 },
      chain: { ok: true as const, length: 42 },
      totals: { USDT: '0' },
      unbalancedAssets: [] as string[],
    }),
    ...overrides,
  } as unknown as LedgerService;
}

async function buildApp(ledger: LedgerService): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerOperatorHttp(app, ledger, tokens, stubApprovalConsumer(CONFIRM));
  await app.ready();
  return app;
}

describe('operator HTTP — reconciliation controls are a named door', () => {
  it('refuses an anonymous run and does not mount the bookkeeping router', async () => {
    const app = await buildApp(stubService());
    const missing = await app.inject({ method: 'POST', url: '/operator/reconciliation/controls/run' });
    expect(missing.statusCode).toBe(401);
    const post = await app.inject({ method: 'POST', url: '/trpc/post', payload: {} });
    expect(post.statusCode).toBe(404);
    await app.close();
  });

  it('refuses treasury without MFA, and a wired token with no book answers source unavailable', async () => {
    const app = await buildApp(stubService());
    const noMfa = await app.inject({
      method: 'POST',
      url: '/operator/reconciliation/controls',
      headers: { authorization: await bearer(['admin:treasury'], false) },
      payload: {},
    });
    expect(noMfa.statusCode).toBe(401);
    const unwired = await app.inject({
      method: 'POST',
      url: '/operator/reconciliation/controls/run',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: {
        controlId: '11111111-1111-4111-8111-111111111111',
        reason: 'run the reconciliation control',
        approvalId: 'appr-1',
        operationId: 'op-1',
      },
    });
    expect(unwired.statusCode).toBe(503);
    expect(unwired.json()).toMatchObject({ code: 'ledger.reconcile_source_unavailable' });
    await app.close();
  });
});

describe('operator HTTP — reconcile is reachable (not half-green)', () => {
  it('refuses with no credential, and never runs the book', async () => {
    let ran = false;
    const app = await buildApp(
      stubService({
        reconcile: async () => {
          ran = true;
          return {
            ok: true,
            ranAt: new Date(),
            balances: { ok: true, accountsChecked: 0 },
            chain: { ok: true, length: 0 },
            totals: {},
            unbalancedAssets: [],
          };
        },
      }),
    );

    const res = await app.inject({ method: 'POST', url: '/operator/reconcile' });
    expect(res.statusCode).toBe(401);
    expect(ran).toBe(false);
    await app.close();
  });

  it('refuses admin:treasury without MFA — interactive-only scope', async () => {
    let ran = false;
    const app = await buildApp(
      stubService({
        reconcile: async () => {
          ran = true;
          throw new Error('must not run');
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/operator/reconcile',
      headers: { authorization: await bearer(['admin:treasury'], false) },
    });
    expect(res.statusCode).toBe(401);
    expect(ran).toBe(false);
    await app.close();
  });

  it('refuses a privileged scope that is not treasury', async () => {
    let ran = false;
    const app = await buildApp(
      stubService({
        reconcile: async () => {
          ran = true;
          throw new Error('must not run');
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/operator/reconcile',
      headers: { authorization: await bearer(['admin:write'], true) },
    });
    expect(res.statusCode).toBe(403);
    expect(ran).toBe(false);
    await app.close();
  });

  it('runs the real reconcile path and returns the three-check report shape', async () => {
    const app = await buildApp(stubService());

    const res = await app.inject({
      method: 'POST',
      url: '/operator/reconcile',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, unknown>;
    // No simulated marker — this is the live book answer.
    expect(body).not.toHaveProperty('simulated');
    expect(body).toMatchObject({
      ok: true,
      accountsChecked: 11,
      chainLength: 42,
      unbalancedAssets: [],
      ranAt: '2026-08-09T12:00:00.000Z',
      confirmOperatorId: CONFIRM,
    });
    await app.close();
  });

  it('when the book fails, reports ok:false and still freezes via the service (not a local invent)', async () => {
    let reconcileCalls = 0;
    const app = await buildApp(
      stubService({
        reconcile: async () => {
          reconcileCalls += 1;
          return {
            ok: false,
            ranAt: new Date('2026-08-09T12:01:00.000Z'),
            balances: {
              ok: false as const,
              accountsChecked: 4,
              drift: [
                {
                  accountId: 'a1',
                  assetId: 'USDT',
                  cached: '10',
                  replayed: '9',
                  difference: '1',
                },
              ],
            },
            chain: { ok: true as const, length: 3 },
            totals: { USDT: '0' },
            unbalancedAssets: [] as string[],
          };
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/operator/reconcile',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(reconcileCalls).toBe(1);
    expect(res.json()).toMatchObject({
      ok: false,
      accountsChecked: 4,
      chainLength: 3,
      unbalancedAssets: [],
      ranAt: '2026-08-09T12:01:00.000Z',
      confirmOperatorId: CONFIRM,
    });
    await app.close();
  });

  it('when the chain is broken, chainLength is still reported (length so far), not invented green', async () => {
    const app = await buildApp(
      stubService({
        reconcile: async () => ({
          ok: false,
          ranAt: new Date('2026-08-09T12:02:00.000Z'),
          balances: { ok: true as const, accountsChecked: 2 },
          chain: { ok: false as const, brokenAt: 'tx-broken', length: 5 },
          totals: { USDT: '0' },
          unbalancedAssets: [] as string[],
        }),
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/operator/reconcile',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });

    expect(res.statusCode).toBe(200);
    // Router used to collapse a broken chain to length 0. The operator needs the
    // length AT the break — that is the only number that tells them how far the
    // chain verified before it stopped. Zero would look like an empty book.
    expect(res.json()).toMatchObject({
      ok: false,
      accountsChecked: 2,
      chainLength: 5,
      chainBrokenAt: 'tx-broken',
      confirmOperatorId: CONFIRM,
    });
    await app.close();
  });

  it('when totals do not net to zero, names the unbalanced assets', async () => {
    const app = await buildApp(
      stubService({
        reconcile: async () => ({
          ok: false,
          ranAt: new Date('2026-08-09T12:03:00.000Z'),
          balances: { ok: true as const, accountsChecked: 9 },
          chain: { ok: true as const, length: 20 },
          totals: { USDT: '1', BTC: '0' },
          unbalancedAssets: ['USDT'],
        }),
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/operator/reconcile',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      unbalancedAssets: ['USDT'],
      chainLength: 20,
      accountsChecked: 9,
      confirmOperatorId: CONFIRM,
    });
    await app.close();
  });

  it('POST /operator/reconcile without a distinct confirm refuses and does not run', async () => {
    let ran = false;
    const app = await buildApp(
      stubService({
        reconcile: async () => {
          ran = true;
          throw new Error('must not run');
        },
      }),
    );
    const headers = { authorization: await bearer(['admin:treasury'], true) };

    const missing = await app.inject({ method: 'POST', url: '/operator/reconcile', headers, payload: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'ledger.operator_request_failed' });

    const same = await app.inject({
      method: 'POST',
      url: '/operator/reconcile',
      headers,
      payload: { confirmOperatorId: OPERATOR },
    });
    expect(same.statusCode).toBe(400);
    expect(same.json()).toMatchObject({ code: 'ledger.operator_request_failed' });
    expect(ran).toBe(false);
    await app.close();
  });
});

describe('operator HTTP — freeze surface still gates correctly (regression)', () => {
  it('GET /operator/freeze requires admin:treasury + MFA', async () => {
    const app = await buildApp(stubService());
    const bare = await app.inject({ method: 'GET', url: '/operator/freeze' });
    expect(bare.statusCode).toBe(401);

    const noMfa = await app.inject({
      method: 'GET',
      url: '/operator/freeze',
      headers: { authorization: await bearer(['admin:treasury'], false) },
    });
    expect(noMfa.statusCode).toBe(401);

    const ok = await app.inject({
      method: 'GET',
      url: '/operator/freeze',
      headers: { authorization: await bearer(['admin:treasury'], true) },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ frozen: false, reason: null, actor: null });
    expect(ok.json().version).toBe('2026-07-27 00:00:00.000000+00');
    await app.close();
  });

  it('POST /operator/freeze demands a usable reason (≥12 chars) — same floor as tRPC', async () => {
    let freezeCalls = 0;
    const app = await buildApp(
      stubService({
        freeze: async (reason: string, actor: string) => {
          freezeCalls += 1;
          return { frozen: true, reason, actor, changedAt: new Date('2026-08-09T12:04:00.000Z') };
        },
      }),
    );

    const short = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: { reason: 'too short' },
    });
    // Schema refuse before the service runs — an empty-looking reason must never
    // land on the durable freeze row (#1282 floor on both doors).
    expect(short.statusCode).toBe(400);
    expect(freezeCalls).toBe(0);

    const empty = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: { reason: '' },
    });
    expect(empty.statusCode).toBe(400);
    expect(freezeCalls).toBe(0);

    // Twelve spaces satisfy raw min(12) but name no usable reason.
    const spaces = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: { reason: '            ' },
    });
    expect(spaces.statusCode).toBe(400);
    expect(freezeCalls).toBe(0);

    const ok = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: { reason: 'suspected USDT chain drift', approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(ok.statusCode).toBe(200);
    expect(freezeCalls).toBe(1);
    expect(ok.json()).toMatchObject({
      frozen: true,
      reason: 'suspected USDT chain drift',
      confirmOperatorId: CONFIRM,
    });
    await app.close();
  });

  it('service secret / non-treasury cannot open the freeze door', async () => {
    let freezeCalls = 0;
    const app = await buildApp(
      stubService({
        freeze: async () => {
          freezeCalls += 1;
          throw new Error('must not run');
        },
      }),
    );

    const noAuth = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      payload: { reason: 'suspected USDT chain drift' },
    });
    expect(noAuth.statusCode).toBe(401);

    const wrongScope = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: await bearer(['admin:write'], true) },
      payload: { reason: 'suspected USDT chain drift' },
    });
    expect(wrongScope.statusCode).toBe(403);
    expect(freezeCalls).toBe(0);
    await app.close();
  });

  it('POST /operator/freeze returns 409 when attribution already stands (not soft-200)', async () => {
    // Soft-200 used to return the standing freeze and look like success while
    // the operator's reason never landed. Conflict is the honest answer.
    const { LedgerError } = await import('@intafaced/ledger-client');
    let freezeCalls = 0;
    const app = await buildApp(
      stubService({
        freeze: async () => {
          freezeCalls += 1;
          throw new LedgerError(
            'Ledger already frozen by recon: reconciliation mismatch — refusing to overwrite (STOP §4.2b #3)',
            'ledger.freeze_attributed',
          );
        },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers: { authorization: await bearer(['admin:treasury'], true) },
      payload: { reason: 'operator: suspected USDT drift', approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'ledger.freeze_attributed' });
    expect(freezeCalls).toBe(1);
    await app.close();
  });

  it('POST freeze/unfreeze without approval ids refuse and do not write', async () => {
    let freezeCalls = 0;
    let thawCalls = 0;
    const app = await buildApp(
      stubService({
        freeze: async (reason: string, actor: string) => {
          freezeCalls += 1;
          return { frozen: true, reason, actor, changedAt: new Date('2026-08-09T12:04:00.000Z') };
        },
        unfreeze: async (actor: string) => {
          thawCalls += 1;
          return { frozen: false, reason: null, actor, changedAt: new Date('2026-08-09T12:05:00.000Z') };
        },
      }),
    );
    const headers = { authorization: await bearer(['admin:treasury'], true) };

    const missing = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers,
      payload: { reason: 'suspected USDT chain drift' },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ code: 'ledger.operator_request_failed' });

    const same = await app.inject({
      method: 'POST',
      url: '/operator/freeze',
      headers,
      payload: { reason: 'suspected USDT chain drift', confirmOperatorId: OPERATOR },
    });
    expect(same.statusCode).toBe(400);
    expect(same.json()).toMatchObject({ code: 'ledger.operator_request_failed' });
    expect(freezeCalls).toBe(0);

    const thawMissing = await app.inject({ method: 'POST', url: '/operator/unfreeze', headers, payload: {} });
    expect(thawMissing.statusCode).toBe(400);
    const thawSame = await app.inject({
      method: 'POST',
      url: '/operator/unfreeze',
      headers,
      payload: { confirmOperatorId: OPERATOR },
    });
    expect(thawSame.statusCode).toBe(400);
    expect(thawCalls).toBe(0);

    const thaw = await app.inject({
      method: 'POST',
      url: '/operator/unfreeze',
      headers,
      payload: { approvalId: 'appr-1', operationId: 'op-1' },
    });
    expect(thaw.statusCode).toBe(200);
    expect(thaw.json()).toMatchObject({ frozen: false, confirmOperatorId: CONFIRM });
    expect(thawCalls).toBe(1);
    await app.close();
  });
});
