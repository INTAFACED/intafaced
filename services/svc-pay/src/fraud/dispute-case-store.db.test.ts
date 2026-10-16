import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { DisputeOpsService } from '../merchant-ops/disputes.js';
import type { MerchantCaller } from '../merchant-ops/roles.js';
import { PayService } from '../payment-service.js';
import { CardSandboxAdapter } from '../rails/card-sandbox.js';
import { RailRegistry } from '../rails/registry.js';
import { PostgresDisputeCaseStore } from './dispute-case-store.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_dispute_case_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const nid = () => randomUUID();
const SECRET = 'svc-pay-test-secret-at-least-32-characters';

describe('Postgres dispute cases survive a new store', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDatabase | undefined;
  let sql!: Sql;
  let merchant = '';
  const owner = nid();
  const caller = (): MerchantCaller => ({
    merchantId: merchant,
    userId: owner,
    role: 'owner',
    viaApiKey: false,
    interactive: true,
  });

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    sql = db.sql;
    merchant = (await sql<Array<{ id: string }>>`INSERT INTO pay.merchants (user_id) VALUES (${owner}) RETURNING id`)[0]!.id;
    await sql`UPDATE pay.merchants SET status = 'active'::pay.merchant_status WHERE id = ${merchant}`;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  });

  async function captured(railRef: string) {
    const rows = await sql<Array<{ id: string }>>`
      INSERT INTO pay.payments (merchant_id, amount, currency, method, rail_adapter, rail_ref, status)
      VALUES (${merchant}, '10', 'USDT', 'card', 'card-sandbox', ${railRef}, 'captured'::pay.payment_status)
      RETURNING id`;
    return rows[0]!.id;
  }

  function rail() {
    return new CardSandboxAdapter({ secret: SECRET, toleranceSeconds: 300 });
  }

  function payFor(store: PostgresDisputeCaseStore, adapter = rail()) {
    return new PayService(sql, new MemoryLedger(), new RailRegistry([adapter]), { disputeCases: store });
  }

  it('keeps the case across a new store, accepts a response, and applies won once', async () => {
    const adapter = rail();
    const railRef = `ch_${nid()}`;
    const paymentId = await captured(railRef);
    const disputeId = `dp-persist-${nid()}`;
    const due = '2026-11-01T15:04:05.000Z';
    const openEvent = `evt-open-${nid()}`;
    const store = new PostgresDisputeCaseStore(sql);
    await payFor(store, adapter).handleWebhook(
      'card-sandbox',
      adapter.signWebhook({
        id: openEvent,
        type: 'dispute.opened',
        ref: railRef,
        amount: '10',
        assetId: 'USDT',
        disputeId,
        evidenceDueBy: due,
      }),
    );

    const restarted = new PostgresDisputeCaseStore(sql);
    const visible = await restarted.get(disputeId);
    expect(visible?.paymentId).toBe(paymentId);
    expect(visible?.merchantId).toBe(merchant);
    expect(visible?.status).toBe('open');
    expect((await restarted.listForMerchant(merchant)).some((c) => c.disputeId === disputeId)).toBe(true);

    const sha = createHash('sha256').update('proof').digest('hex');
    await sql`
      INSERT INTO pay.merchant_dispute_evidence (merchant_id, dispute_id, kind, file_name, content_type, size_bytes, sha256, added_by)
      VALUES (${merchant}, ${disputeId}, 'receipt', 'receipt.pdf', 'application/pdf', ${5}, ${sha}, ${owner})`;
    const ops = new DisputeOpsService(sql, restarted);
    const before = await ops.get(caller(), disputeId);
    expect(before.responseDueAt).toBe(due);
    expect(before.evidence).toHaveLength(1);
    const answered = await ops.respond(caller(), { requestId: nid(), disputeId, action: 'contest', note: 'shipped' });
    expect(answered.status).toBe('contested');
    expect((await new PostgresDisputeCaseStore(sql).get(disputeId))?.status).toBe('contested');

    const wonId = `evt-won-${nid()}`;
    const wonBody = adapter.signWebhook({
      id: wonId,
      type: 'dispute.won',
      ref: railRef,
      amount: '10',
      disputeId,
    });
    const pay = payFor(new PostgresDisputeCaseStore(sql), adapter);
    const first = await pay.handleWebhook('card-sandbox', wonBody);
    expect(first.applied).toBe(true);
    expect(first.duplicate).toBe(false);
    const second = await pay.handleWebhook('card-sandbox', wonBody);
    expect(second.duplicate).toBe(true);
    const afterWon = await new PostgresDisputeCaseStore(sql).get(disputeId);
    expect(afterWon?.status).toBe('won');
    const applied = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.dispute_case_rail_events WHERE dispute_id = ${disputeId} AND outcome = 'won'`;
    expect(applied[0]!.n).toBe(1);
    const replay = await new PostgresDisputeCaseStore(sql).applyRailResolution({
      disputeId,
      railEventId: `card-sandbox:${wonId}`,
      outcome: 'won',
    });
    expect(replay?.status).toBe('won');
    expect(replay?.closedAt).toBe(afterWon?.closedAt);
    const stillOne = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.dispute_case_rail_events WHERE dispute_id = ${disputeId}`;
    expect(stillOne[0]!.n).toBe(1);
  });

  it('applies a lost rail event once on the persisted case', async () => {
    const adapter = rail();
    const railRef = `ch_${nid()}`;
    await captured(railRef);
    const disputeId = `dp-lost-${nid()}`;
    const store = new PostgresDisputeCaseStore(sql);
    await payFor(store, adapter).handleWebhook(
      'card-sandbox',
      adapter.signWebhook({
        id: `evt-open-${nid()}`,
        type: 'dispute.opened',
        ref: railRef,
        amount: '10',
        assetId: 'USDT',
        disputeId,
      }),
    );
    const lostId = `evt-lost-${nid()}`;
    const body = adapter.signWebhook({ id: lostId, type: 'dispute.lost', ref: railRef, amount: '10', disputeId });
    const pay = payFor(new PostgresDisputeCaseStore(sql), adapter);
    expect((await pay.handleWebhook('card-sandbox', body)).applied).toBe(true);
    expect((await pay.handleWebhook('card-sandbox', body)).duplicate).toBe(true);
    expect((await new PostgresDisputeCaseStore(sql).get(disputeId))?.status).toBe('lost');
    const n = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.dispute_case_rail_events WHERE dispute_id = ${disputeId} AND outcome = 'lost'`;
    expect(n[0]!.n).toBe(1);
  });

  it('opens the ledger case when the rail due date is not a date', async () => {
    const noted: string[] = [];
    const adapter = new CardSandboxAdapter({
      secret: SECRET,
      toleranceSeconds: 300,
      noteMalformedEvidenceDueBy: (eventId) => noted.push(eventId),
    });
    const railRef = `ch_${nid()}`;
    await captured(railRef);
    const disputeId = `dp-bad-due-${nid()}`;
    const eventId = `evt-bad-${nid()}`;
    const pay = payFor(new PostgresDisputeCaseStore(sql), adapter);
    const outcome = await pay.handleWebhook(
      'card-sandbox',
      adapter.signWebhook({
        id: eventId,
        type: 'dispute.opened',
        ref: railRef,
        amount: '10',
        assetId: 'USDT',
        disputeId,
        evidenceDueBy: 'not-a-date',
      }),
    );
    expect(outcome.applied).toBe(true);
    expect(noted).toEqual([eventId]);
    const opened = await new PostgresDisputeCaseStore(sql).get(disputeId);
    expect(opened?.status).toBe('open');
    expect(opened?.ledgerWire).toBe('refused');
    expect(opened?.ledgerRefuse?.code).toBeTruthy();
    const due = await sql<Array<{ response_due_at: Date | null }>>`
      SELECT response_due_at FROM pay.dispute_response_deadlines
       WHERE merchant_id = ${merchant} AND dispute_id = ${disputeId}`;
    expect(due[0]!.response_due_at).toBeNull();
  });
});
