import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount } from '@intafaced/ledger-client';
import { PayService } from '../payment-service.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { composeGuards } from '../seams/guards.js';
import { createControlGuards } from './guards.js';
import { capturedOverCapTotal, resetCapturedOverCapTotalForTests } from './over-cap-signal.js';
import { ChangeService } from './changes.js';
import { applyChange, migrations, openAdmin, resetControl, SECRET, TEST_GLOBAL_RULE, TEST_TIER } from './control.testkit.js';

describe('captured_over_cap metric and alert', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let sql!: TestDatabase['sql'];
  let pay!: PayService;
  let changes!: ChangeService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    changes = new ChangeService(sql);
  }, 120_000);

  beforeEach(async () => {
    await resetControl(sql);
    resetCapturedOverCapTotalForTests();
    pay = new PayService(sql, new MemoryLedger(), new RailRegistry([new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 })]), {
      guards: composeGuards(createControlGuards({ sql, mode: 'required' })),
    });
  }, 30_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function merchant() {
    const created = await pay.createMerchant({ userId: randomUUID(), pricing: { feeBps: 0 } });
    await applyChange(changes, sql, { scope: 'tier', change: { kind: 'upsert_tier', tier: TEST_TIER } });
    await applyChange(changes, sql, {
      scope: 'merchant',
      merchantId: created.id,
      change: { kind: 'set_tier', tierId: TEST_TIER.id, archetypeId: null },
    });
    await applyChange(changes, sql, {
      scope: 'pricing',
      change: { kind: 'set_pricing_layer', layer: 'global', scopeId: null, rules: [TEST_GLOBAL_RULE] },
    });
    return created;
  }

  async function open(merchantId: string, amount: string) {
    const created = await pay.createPayment({
      requestId: randomUUID(),
      merchantId,
      amount: parseAmount(amount),
      assetId: 'USDT',
      method: 'card',
      railAdapter: 'card-sandbox',
    });
    await pay.authorize(created.id);
    return created.id;
  }

  async function notices(merchantId: string) {
    return sql<Array<{ kind: string; dedupe_key: string | null; subject_id: string | null }>>`
      SELECT kind, dedupe_key, subject_id FROM pay.merchant_notifications WHERE merchant_id = ${merchantId} ORDER BY created_at
    `;
  }

  async function flags(merchantId: string) {
    return sql<Array<{ id: string }>>`
      SELECT id FROM pay.control_audit WHERE merchant_id = ${merchantId} AND kind = 'payment.captured_over_cap'
    `;
  }

  it('a capture inside the cap emits neither the counter nor the alert', async () => {
    const m = await merchant();
    const id = await open(m.id, '100');
    await pay.capture(id);
    expect(capturedOverCapTotal()).toBe(0);
    expect(await notices(m.id)).toEqual([]);
    expect(await flags(m.id)).toEqual([]);
  });

  it('a capture over the daily cap counts once, alerts once, and a repeat does not double either', async () => {
    const m = await merchant();
    const ids = [await open(m.id, '100'), await open(m.id, '100'), await open(m.id, '100'), await open(m.id, '100')];
    for (const id of ids) await pay.capture(id);
    expect(capturedOverCapTotal()).toBe(1);
    const rows = await notices(m.id);
    expect(rows).toEqual([{ kind: 'limit_threshold', dedupe_key: `captured_over_cap:${ids[3]}`, subject_id: ids[3] }]);
    expect(await flags(m.id)).toHaveLength(1);
    await pay.capture(ids[3]!);
    expect(capturedOverCapTotal()).toBe(1);
    expect(await notices(m.id)).toHaveLength(1);
  });

  it('a muted limit_threshold preference skips the in-app alert and still counts', async () => {
    const m = await merchant();
    await sql`
      INSERT INTO pay.merchant_notification_preferences (merchant_id, kind, in_app, updated_by)
      VALUES (${m.id}, 'limit_threshold', false, ${m.userId})
    `;
    const ids = [await open(m.id, '100'), await open(m.id, '100'), await open(m.id, '100'), await open(m.id, '100')];
    for (const id of ids) await pay.capture(id);
    expect(capturedOverCapTotal()).toBe(1);
    expect(await notices(m.id)).toEqual([]);
    expect(await flags(m.id)).toHaveLength(1);
  });
});
