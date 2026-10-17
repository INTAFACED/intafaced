import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { parseAmount, type LedgerTx } from '@intafaced/ledger-client';
import {
  captureReconcileInputFromBody,
  matchBookedCapture,
  runCaptureReconcile,
  type AuthorizedPaymentRow,
  type CaptureAccountIds,
  type CaptureReconcileCursor,
} from './capture-reconcile.js';
import { registerCaptureReconcileRoutes } from './capture-reconcile-routes.js';
import { createLedgerClient } from './ledger-client.js';
import { PayError } from './payment-service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SECRET = 'capture-reconcile-test-secret-0123456789abcdef';
const UNVERIFIED: CaptureAccountIds = { railBoundaryAccountId: '', merchantClearingAccountId: '' };
const VERIFIED: CaptureAccountIds = { railBoundaryAccountId: 'a1', merchantClearingAccountId: 'a2' };

function row(over: Partial<AuthorizedPaymentRow> = {}): AuthorizedPaymentRow {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    merchant_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    profile_id: null,
    amount: '10',
    currency: 'USDT',
    method: 'card',
    rail_adapter: 'card-sandbox',
    rail_ref: 'rail-1',
    status: 'authorized',
    created_at: new Date('2026-10-16T00:00:00.000Z'),
    ...over,
  };
}

function booked(over: Partial<LedgerTx> = {}, entryAmount = parseAmount('10')): LedgerTx {
  const payment = row();
  return {
    id: 'tx-1',
    idempotencyKey: `payment.capture:${payment.id}`,
    module: 'pay',
    reason: 'payment.captured',
    meta: { paymentId: payment.id, railRef: 'rail-1' },
    postedAt: new Date('2026-10-16T00:00:01.000Z'),
    hash: 'h',
    previousHash: null,
    entries: [
      {
        id: 'e1',
        txId: 'tx-1',
        accountId: 'a1',
        assetId: 'USDT',
        direction: 'credit',
        amount: entryAmount,
        balanceAfter: entryAmount,
      },
      {
        id: 'e2',
        txId: 'tx-1',
        accountId: 'a2',
        assetId: 'USDT',
        direction: 'debit',
        amount: entryAmount,
        balanceAfter: entryAmount,
      },
    ],
    ...over,
  };
}

describe('matchBookedCapture', () => {
  const postedAt = new Date('2026-10-16T00:00:01.000Z');

  it('accepts the capture when the accounts, amount, asset and payment rail reference agree', () => {
    const match = matchBookedCapture(row(), booked(), VERIFIED);
    expect(match).toEqual({ ledgerTxId: 'tx-1', amount: parseAmount('10'), railRef: 'rail-1', postedAt });
  });

  it('accepts the same capture when meta has no rail reference, as long as the accounts and the payment rail reference match', () => {
    const match = matchBookedCapture(row(), booked({ meta: {} }), VERIFIED);
    expect(match).toEqual({ ledgerTxId: 'tx-1', amount: parseAmount('10'), railRef: 'rail-1', postedAt });
  });

  it('refuses a payment with no rail reference, the same as a live capture', () => {
    expect(matchBookedCapture(row({ rail_ref: null }), booked({ meta: {} }), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row({ rail_ref: null }), booked(), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row({ rail_ref: '' }), booked(), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row({ rail_ref: null }), booked({ meta: { railRef: 'rail-1' } }), VERIFIED)).toBeNull();
  });

  it('refuses the capture when account ids cannot be read, even if the rail references agree', () => {
    expect(matchBookedCapture(row(), booked(), UNVERIFIED)).toBeNull();
    expect(matchBookedCapture(row(), booked({ meta: {} }), UNVERIFIED)).toBeNull();
    expect(matchBookedCapture(row(), booked(), { railBoundaryAccountId: '', merchantClearingAccountId: 'a2' })).toBeNull();
  });

  it('rejects a different amount, asset, key, reason, rail reference, or account direction', () => {
    expect(matchBookedCapture(row(), booked({}, parseAmount('9')), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row({ currency: 'BTC' }), booked(), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row(), booked({ idempotencyKey: 'payment.capture:other' }), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row(), booked({ reason: 'payment.refunded' }), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row(), booked({ module: 'bank' }), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row(), booked({ entries: [] }), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row(), booked({ meta: { paymentId: 'someone-else', railRef: 'rail-1' } }), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row(), booked({ meta: { paymentId: row().id, railRef: 'other-rail' } }), VERIFIED)).toBeNull();
    expect(matchBookedCapture(row(), booked({ meta: {} }), { railBoundaryAccountId: 'a2', merchantClearingAccountId: 'a1' })).toBeNull();
    const swapped = booked({ meta: {} });
    expect(
      matchBookedCapture(
        row(),
        {
          ...swapped,
          entries: swapped.entries.map((entry) => ({ ...entry, direction: entry.direction === 'credit' ? 'debit' : 'credit' })),
        },
        VERIFIED,
      ),
    ).toBeNull();
  });

  it('accepts the HTTP ledger client shape, whose getTx returns an empty meta', async () => {
    const payment = row();
    const txId = '9d2a8a4e-6f31-4c0e-9a55-0d7f4b1c2e11';
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const body =
        path === '/trpc/txByKey'
          ? { found: true, txId, hash: 'h9', postedAt: postedAt.toISOString(), module: 'pay', reason: 'payment.captured' }
          : {
              found: true,
              txId,
              idempotencyKey: `payment.capture:${payment.id}`,
              hash: 'h9',
              postedAt: postedAt.toISOString(),
              module: 'pay',
              reason: 'payment.captured',
              entries: [
                { accountId: 'boundary-1', assetId: 'USDT', direction: 'credit', amount: '10' },
                { accountId: 'clearing-1', assetId: 'USDT', direction: 'debit', amount: '10' },
              ],
            };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const tx = await createLedgerClient('http://ledger.test', 'test-internal-service-secret-32-chars').getTxByKey(
        `payment.capture:${payment.id}`,
      );
      expect(tx?.meta).toEqual({});
      expect(matchBookedCapture(payment, tx!, { railBoundaryAccountId: 'boundary-1', merchantClearingAccountId: 'clearing-1' })).toEqual({
        ledgerTxId: txId,
        amount: parseAmount('10'),
        railRef: 'rail-1',
        postedAt,
      });
      expect(matchBookedCapture(payment, tx!, UNVERIFIED)).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe('cursor validation', () => {
  const deps = {
    sql: { reserve: () => Promise.reject(new Error('should not reserve')) } as never,
    ledger: {
      getTxByKey: async () => null,
      balance: async () => {
        throw new Error('should not read a balance');
      },
    },
    lockMerchant: async () => undefined,
    complete: async () => ({ status: 'captured' }),
  };

  it('refuses a cursor that is not an instant before it reserves a connection', async () => {
    await expect(
      runCaptureReconcile(deps, { limit: 1, cursor: { createdAt: 'yesterday', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } }, 'required'),
    ).rejects.toMatchObject({ code: 'pay.validation_failed' });
  });

  it('refuses a null cursor and a numeric createdAt before it reserves a connection', async () => {
    await expect(runCaptureReconcile(deps, { limit: 1, cursor: null }, 'required')).rejects.toMatchObject({
      code: 'pay.validation_failed',
    });
    const numeric = { createdAt: 1_700_000_000_000, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } as unknown as CaptureReconcileCursor;
    await expect(runCaptureReconcile(deps, { limit: 1, cursor: numeric }, 'required')).rejects.toMatchObject({
      code: 'pay.validation_failed',
    });
  });

  it('refuses a non-object body, a null cursor, and a numeric createdAt before the job runs', () => {
    expect(() => captureReconcileInputFromBody(null)).toThrowError(expect.objectContaining({ code: 'pay.validation_failed' }));
    expect(() => captureReconcileInputFromBody({ limit: 1, cursor: null })).toThrowError(
      expect.objectContaining({ code: 'pay.validation_failed' }),
    );
    expect(() => captureReconcileInputFromBody({ limit: 1, cursor: { createdAt: 1_700_000_000_000, id: 'x' } })).toThrowError(
      expect.objectContaining({ code: 'pay.validation_failed' }),
    );
    expect(captureReconcileInputFromBody({ limit: 2 })).toEqual({ limit: 2 });
  });
});

describe('reconcile route', () => {
  function headers(payload: string): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...serviceAuthHeadersForBody('svc-cron', SECRET, payload),
    };
  }

  async function mount(pay: { reconcileAuthorizedCaptures: ReturnType<typeof vi.fn> }, mode: 'off' | 'required' = 'required') {
    const app = Fastify({ logger: false });
    registerCaptureReconcileRoutes(app, { internalSecret: SECRET, pay: pay as never, mode });
    await app.ready();
    return app;
  }

  it('refuses a caller without service credentials', async () => {
    const reconcileAuthorizedCaptures = vi.fn();
    const app = await mount({ reconcileAuthorizedCaptures });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: { 'content-type': 'application/json' },
      payload: { limit: 10 },
    });
    expect(res.statusCode).toBe(401);
    expect(reconcileAuthorizedCaptures).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses while the flag is off and does not run the job', async () => {
    const reconcileAuthorizedCaptures = vi.fn(async () => {
      throw new PayError(
        'PAY_CAPTURE_RECONCILE is off. The reconciler moves nothing until an owner sets it to required.',
        'pay.capture_reconcile_disabled',
      );
    });
    const app = await mount({ reconcileAuthorizedCaptures }, 'off');
    const payload = JSON.stringify({ limit: 10 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: headers(payload),
      payload,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('pay.capture_reconcile_disabled');
    await app.close();
  });

  it('refuses a blank limit', async () => {
    const reconcileAuthorizedCaptures = vi.fn(async () => {
      throw new PayError('capture reconcile batch size is unset', 'pay.capture_reconcile_batch_limit_unset');
    });
    const app = await mount({ reconcileAuthorizedCaptures });
    const payload = JSON.stringify({});
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: headers(payload),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('pay.capture_reconcile_batch_limit_unset');
    await app.close();
  });

  it('runs one pass for a credentialed caller and returns the report', async () => {
    const report = { examined: 1, reconciled: 1, leftAuthorized: 0, alreadyCaptured: 0, mismatched: 0 };
    const reconcileAuthorizedCaptures = vi.fn(async () => report);
    const app = await mount({ reconcileAuthorizedCaptures });
    const payload = JSON.stringify({ limit: 10 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: headers(payload),
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(report);
    expect(reconcileAuthorizedCaptures).toHaveBeenCalledWith({ limit: 10 }, 'required');
    await app.close();
  });

  it('answers 400 for a null cursor or a numeric createdAt and does not run the job', async () => {
    const reconcileAuthorizedCaptures = vi.fn();
    const app = await mount({ reconcileAuthorizedCaptures });
    const nullCursor = JSON.stringify({ limit: 10, cursor: null });
    const nullRes = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: headers(nullCursor),
      payload: nullCursor,
    });
    expect(nullRes.statusCode).toBe(400);
    expect(nullRes.json().error).toBe('pay.validation_failed');

    const numeric = JSON.stringify({
      limit: 10,
      cursor: { createdAt: 1700000000000, id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    const numericRes = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: headers(numeric),
      payload: numeric,
    });
    expect(numericRes.statusCode).toBe(400);
    expect(numericRes.json().error).toBe('pay.validation_failed');
    expect(reconcileAuthorizedCaptures).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 400 when the body is not an object', async () => {
    const reconcileAuthorizedCaptures = vi.fn();
    const app = await mount({ reconcileAuthorizedCaptures });
    const payload = 'null';
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: headers(payload),
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('pay.validation_failed');
    expect(reconcileAuthorizedCaptures).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards a cursor', async () => {
    const reconcileAuthorizedCaptures = vi.fn(async () => ({ busy: false, examined: 0 }));
    const app = await mount({ reconcileAuthorizedCaptures });
    const cursor = { createdAt: '2026-01-15T12:00:00.000000Z', id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
    const payload = JSON.stringify({ limit: 2, cursor });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: headers(payload),
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(reconcileAuthorizedCaptures).toHaveBeenCalledWith({ limit: 2, cursor }, 'required');
    await app.close();
  });

  it('answers 409 when the pass is busy', async () => {
    const report = {
      busy: true,
      examined: 0,
      reconciled: 0,
      leftAuthorized: 0,
      alreadyCaptured: 0,
      mismatched: 0,
      failed: 0,
      nextCursor: null,
    };
    const reconcileAuthorizedCaptures = vi.fn(async () => report);
    const app = await mount({ reconcileAuthorizedCaptures });
    const payload = JSON.stringify({ limit: 10 });
    const res = await app.inject({
      method: 'POST',
      url: '/internal/jobs/reconcile-authorized-captures',
      headers: headers(payload),
      payload,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual(report);
    await app.close();
  });
});

describe('wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('the job does not post, and index mounts the shared registrar', () => {
    const job = readFileSync(join(here, 'capture-reconcile.ts'), 'utf8');
    const index = readFileSync(join(here, 'index.ts'), 'utf8');
    expect(job).not.toMatch(/\.post\s*\(/);
    expect(job).toContain('getTxByKey');
    expect(job).toContain('pg_try_advisory_lock');
    expect(job).not.toContain('pg_advisory_lock(');
    expect(index).toContain('setCaptureReconcileLogger');
    expect(index).toContain('setOverCapNoticeLogger');
    expect(index).toMatch(/registerCaptureReconcileRoutes\(app,/);
    expect(index).not.toMatch(/app\.post[^\n]*reconcile-authorized-captures/);
  });

  it('the flag defaults off in env and in the svc-pay compose block', () => {
    const envTs = readFileSync(join(ROOT, 'services/svc-pay/src/env.ts'), 'utf8');
    const compose = readFileSync(join(ROOT, 'docker-compose.apps.yml'), 'utf8');
    const block = compose.match(/^  svc-pay:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m)?.[0] ?? '';
    expect(envTs).toMatch(/PAY_CAPTURE_RECONCILE:\s*z\.enum\(\['off', 'required'\]\)\.default\('off'\)/);
    expect(block).toMatch(/PAY_CAPTURE_RECONCILE:\s*\$\{PAY_CAPTURE_RECONCILE:-off\}/);
  });
});
