import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { serviceAuthHeadersForBody } from '@intafaced/contracts';
import { parseAmount, type LedgerTx } from '@intafaced/ledger-client';
import { matchBookedCapture, type AuthorizedPaymentRow } from './capture-reconcile.js';
import { registerCaptureReconcileRoutes } from './capture-reconcile-routes.js';
import { PayError } from './payment-service.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SECRET = 'capture-reconcile-test-secret-0123456789abcdef';

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
  it('accepts the capture key when amount, asset and rail reference agree', () => {
    const match = matchBookedCapture(row(), booked());
    expect(match).toEqual({ ledgerTxId: 'tx-1', amount: parseAmount('10'), railRef: 'rail-1' });
  });

  it('rejects a different amount, asset, key, reason, or rail reference', () => {
    expect(matchBookedCapture(row(), booked({}, parseAmount('9')))).toBeNull();
    expect(matchBookedCapture(row({ currency: 'BTC' }), booked())).toBeNull();
    expect(matchBookedCapture(row(), booked({ idempotencyKey: 'payment.capture:other' }))).toBeNull();
    expect(matchBookedCapture(row(), booked({ reason: 'payment.refunded' }))).toBeNull();
    expect(matchBookedCapture(row(), booked({ module: 'bank' }))).toBeNull();
    expect(matchBookedCapture(row(), booked({ entries: [] }))).toBeNull();
    expect(matchBookedCapture(row({ rail_ref: null }), booked())).toBeNull();
    expect(matchBookedCapture(row(), booked({ meta: { paymentId: 'someone-else', railRef: 'rail-1' } }))).toBeNull();
    expect(matchBookedCapture(row(), booked({ meta: { paymentId: row().id, railRef: 'other-rail' } }))).toBeNull();
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
});

describe('wiring', () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it('the job does not post, and index mounts the shared registrar', () => {
    const job = readFileSync(join(here, 'capture-reconcile.ts'), 'utf8');
    const index = readFileSync(join(here, 'index.ts'), 'utf8');
    expect(job).not.toMatch(/\.post\s*\(/);
    expect(job).toContain('getTxByKey');
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
