import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MerchantControlError } from '../../merchant-account-controls.js';
import { createPayNamespaces } from '../../namespaces/index.js';
import { CustodyTxError, type CustodyTxErrorCode } from './errors.js';
import { CustodyTxService, custodyState, type TxChainReader } from './service.js';

/** Custody transaction history, lifecycle, reasons and confirmation policy against a real Postgres. TEST figures only. */
const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('intafaced_custody_tx_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const NET = 'evm-test';
const OWN = '0xAbC0000000000000000000000000000000000001';
const OUTSIDE = '0x0000000000000000000000000000000000000dEa';

async function code(p: Promise<unknown>): Promise<CustodyTxErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CustodyTxError) return e.code;
    throw e;
  }
  throw new Error('expected the call to be refused');
}

describe('custody transactions (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let svc: CustodyTxService;
  let clock = new Date('2026-01-01T10:00:00.000Z');
  let chainAnswer: Awaited<ReturnType<TxChainReader['lookup']>> = null;
  const chain: TxChainReader = { lookup: async () => chainAnswer };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function seedNetwork(confirmations: number | null = 12): Promise<void> {
    await db.sql`DELETE FROM pay.network_registry WHERE network_id = ${NET}`;
    await db.sql`INSERT INTO pay.network_registry (network_id, display_name, asset_codes, confirmations_required, enabled, updated_by)
      VALUES (${NET}, ${NET}, ${db.sql.json(['USDT'])}, ${confirmations}, true, 'seed')`;
  }

  async function withdrawal(
    o: {
      status?: 'pending' | 'held' | 'sent' | 'failed';
      dest?: string;
      failure?: string | null;
      railRef?: string | null;
      user?: string;
      ref?: string;
    } = {},
  ): Promise<string> {
    const status = o.status ?? 'pending';
    const railRef = o.railRef === undefined ? (status === 'sent' ? '0xhash1' : null) : o.railRef;
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, rail_ref, failure_code, status, created_at, updated_at)
      VALUES (${o.user ?? 'user-1'}, 'USDT', 12.5, 'evm', ${db.sql.json({ kind: 'crypto', ref: o.dest ?? OUTSIDE })},
              ${o.ref ?? randomUUID()}, ${railRef}, ${o.failure ?? null}, ${status}::pay.withdrawal_status, ${clock.toISOString()}::timestamptz, ${clock.toISOString()}::timestamptz)
      RETURNING id`;
    return row!.id;
  }

  /** A travel-rule transfer with the given transitions, so the lifecycle can read its latest status. */
  async function travel(withdrawalId: string, statuses: string[], actor = 'system'): Promise<void> {
    const [rule] = await db.sql<Array<{ seq: string }>>`
      INSERT INTO pay.travel_rule_rule_events (region, entity, asset_id, applies, threshold, fields, reason, set_by)
      VALUES ('*', 'individual', 'USDT', true, 0, ${db.sql.json(['name'])}, 'TEST', 'seed') RETURNING seq::text`;
    const [t] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.travel_rule_transfers (withdrawal_id, user_id, asset_id, network_id, amount, region, entity, assessment, rule_seq, required_fields, opened_by)
      VALUES (${withdrawalId}::uuid, 'user-1', 'USDT', ${NET}, 12.5, 'DE', 'individual', 'required', ${rule!.seq}::bigint, ${db.sql.json(['name'])}, 'seed')
      RETURNING id`;
    let from: string | null = null;
    for (const to of statuses) {
      await db.sql`INSERT INTO pay.travel_rule_transitions (transfer_id, from_status, to_status, source, actor, reason)
        VALUES (${t!.id}::uuid, ${from}, ${to}, 'system', ${actor}, 'TEST')`;
      from = to;
    }
  }

  beforeEach(async () => {
    clock = new Date('2026-01-01T10:00:00.000Z');
    chainAnswer = null;
    await db.sql`TRUNCATE pay.confirmation_override_approvals, pay.confirmation_override_requests, pay.custody_lifecycle_timeout_events, pay.custody_tx_notes, pay.travel_rule_transitions, pay.travel_rule_messages, pay.travel_rule_transfers, pay.travel_rule_rule_events, pay.withdrawal_return_events, pay.withdrawal_returns, pay.withdrawals RESTART IDENTITY CASCADE`;
    await db.sql`DELETE FROM pay.custody_wallets`;
    await seedNetwork(12);
    svc = new CustodyTxService({ sql: db.sql, chain, now: () => clock });
  });

  it('maps every withdrawal status and a travel-rule outcome to one custody state, and never to a state with no signal', () => {
    expect(custodyState('requested', null)).toBe('SUBMITTED');
    expect(custodyState('pending_review', null)).toBe('PENDING_AUTHORIZATION');
    expect(custodyState('approved', null)).toBe('QUEUED');
    expect(custodyState('dispatching', null)).toBe('BROADCASTING');
    expect(custodyState('confirming', null)).toBe('CONFIRMING');
    expect(custodyState('settled', null)).toBe('COMPLETED');
    expect(custodyState('canceled', null)).toBe('CANCELLED');
    expect(custodyState('requested', 'pending')).toBe('PENDING_AML_SCREENING');
    expect(custodyState('held', 'blocking_time_expired')).toBe('BLOCKED');
    expect(custodyState('held', 'rejected')).toBe('BLOCKED');
    // a finished transaction is never blocked by an old travel-rule row
    expect(custodyState('settled', 'rejected')).toBe('COMPLETED');
    expect(custodyState('failed', 'repair')).toBe('FAILED');
  });

  it('lists every user withdrawal newest first in the custody vocabulary, paged to the end by a cursor', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      clock = new Date(clock.getTime() + 1000);
      ids.push(await withdrawal({ user: i % 2 ? 'user-2' : 'user-1' }));
      await db.sql`UPDATE pay.withdrawals SET created_at = ${clock.toISOString()}::timestamptz WHERE id = ${ids[i]!}::uuid`;
    }
    const seen: string[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await svc.list({ limit: 2, ...(after ? { after } : {}) });
      seen.push(...r.items.map((x) => x.withdrawalId));
      if (!r.next) break;
      after = r.next;
    }
    expect(seen).toEqual([...ids].reverse());
    const mine = await svc.list({ limit: 10, userId: 'user-2' });
    expect(mine.items.map((x) => x.withdrawalId)).toEqual([ids[3], ids[1]]);
    expect(mine.items[0]).toMatchObject({
      amount: '12.5',
      state: 'SUBMITTED',
      status: 'requested',
      reason: null,
      blockedBy: null,
      timeout: null,
    });
    expect(await code(svc.list({ limit: 5, after: 'garbage' }))).toBe('custody_tx.cursor_invalid');
  });

  it('filters by status, telling a cancelled withdrawal from a failed one', async () => {
    const failed = await withdrawal({ status: 'failed', failure: 'rail.refused' });
    const canceled = await withdrawal({ status: 'failed', failure: 'withdrawal.canceled' });
    const f = await svc.list({ limit: 10, status: 'failed' });
    expect(f.items.map((x) => x.withdrawalId)).toEqual([failed]);
    expect(f.items[0]).toMatchObject({ state: 'FAILED', reason: { code: 'rail.refused', known: true } });
    const c = await svc.list({ limit: 10, status: 'canceled' });
    expect(c.items.map((x) => x.withdrawalId)).toEqual([canceled]);
    expect(c.items[0]).toMatchObject({ state: 'CANCELLED', reason: { code: 'withdrawal.canceled', known: true } });
    expect((await svc.list({ limit: 10, status: 'confirming' })).items).toEqual([]);
  });

  it('shows an unknown failure code raw, and a held row with a code does not claim a reason', async () => {
    await withdrawal({ status: 'failed', failure: 'vendor.weird_code' });
    const held = await withdrawal({ status: 'held', failure: 'rail.failed' });
    const all = await svc.list({ limit: 10 });
    const raw = all.items.find((x) => x.state === 'FAILED')!;
    expect(raw.reason).toEqual({ code: 'vendor.weird_code', known: false, customer: 'vendor.weird_code', support: 'vendor.weird_code' });
    expect(all.items.find((x) => x.withdrawalId === held)!.reason).toBeNull();
    expect(svc.reasons().map((r) => r.code)).toEqual(
      expect.arrayContaining(['rail.failed', 'withdrawal.canceled', 'travel_rule.rejected']),
    );
    expect(svc.reasons().every((r) => r.known && r.customer.length > 0 && r.support.length > 0)).toBe(true);
  });

  it('shows a travel-rule block with the rule version and who decided it', async () => {
    const id = await withdrawal({ status: 'held' });
    await travel(id, ['started', 'pending', 'blocking_time_expired'], 'timer');
    const d = await svc.get(id);
    expect(d.state).toBe('BLOCKED');
    expect(d.blockedBy).toMatchObject({ source: 'travel_rule', status: 'blocking_time_expired', decidedBy: 'timer' });
    expect(d.reason).toMatchObject({ code: 'travel_rule.blocking_time_expired', known: true });
    const open = await withdrawal({ status: 'pending' });
    await travel(open, ['started', 'pending']);
    expect((await svc.get(open)).state).toBe('PENDING_AML_SCREENING');
  });

  it('shows block height and hash from the chain reader, and says unwired with none instead of guessing', async () => {
    const id = await withdrawal({ status: 'sent', railRef: '0xhash1' });
    chainAnswer = { blockHeight: 123, blockHash: '0xblock', confirmations: 7 };
    expect((await svc.get(id)).block).toEqual({
      state: 'in_block',
      txHash: '0xhash1',
      blockHeight: 123,
      blockHash: '0xblock',
      confirmations: 7,
    });
    chainAnswer = null;
    expect((await svc.get(id)).block).toEqual({ state: 'unknown_to_chain', txHash: '0xhash1' });
    const bare = new CustodyTxService({ sql: db.sql, now: () => clock });
    expect((await bare.get(id)).block).toEqual({ state: 'unwired', txHash: '0xhash1', blocker: 'rail.crypto' });
    const unsent = await withdrawal({ status: 'pending' });
    expect((await bare.get(unsent)).block).toEqual({ state: 'not_broadcast' });
    expect(await code(svc.get(randomUUID()))).toBe('custody_tx.not_found');
  });

  it('keeps operator notes append-only and puts them in the timeline in time order', async () => {
    const id = await withdrawal({ status: 'held' });
    await travel(id, ['started']);
    const after = await svc.addNote('op-1', id, 'Called the customer');
    expect(after.notes).toMatchObject([{ note: 'Called the customer', author: 'op-1' }]);
    const kinds = (await svc.timeline(id)).map((e) => e.kind);
    expect(kinds[0]).toBe('created');
    expect(kinds).toEqual(expect.arrayContaining(['travel_rule', 'note', 'current']));
    expect(await code(svc.addNote('op-1', randomUUID(), 'x'))).toBe('custody_tx.not_found');
    await expect(db.sql`UPDATE pay.custody_tx_notes SET note = 'x'`).rejects.toThrow(/never edited or deleted/);
    await expect(db.sql`DELETE FROM pay.custody_tx_notes`).rejects.toThrow(/never edited or deleted/);
  });

  it('reads an owner timeout per state: none means none, and a finished transaction is never overdue', async () => {
    const id = await withdrawal({ status: 'held' }); // updated at the clock, QUEUED
    expect((await svc.get(id)).timeout).toBeNull();
    expect((await svc.listTimeouts()).every((t) => t.seconds === null)).toBe(true);
    await svc.setTimeout('founder-a', { state: 'QUEUED', seconds: 600, reason: 'TEST' });
    expect((await svc.get(id)).timeout).toEqual({ seconds: 600, overdue: false });
    clock = new Date(clock.getTime() + 601_000);
    expect((await svc.get(id)).timeout).toEqual({ seconds: 600, overdue: true });
    await svc.setTimeout('founder-a', { state: 'QUEUED', seconds: 3600, reason: 'TEST' });
    expect((await svc.get(id)).timeout).toEqual({ seconds: 3600, overdue: false });
    await svc.setTimeout('founder-a', { state: 'COMPLETED', seconds: 1, reason: 'TEST' });
    const done = await withdrawal({ status: 'sent' });
    clock = new Date(clock.getTime() + 999_000);
    expect((await svc.get(done)).timeout).toEqual({ seconds: 1, overdue: false });
  });

  it('with no registry count the network default is blank: an override refuses and a customer credit refuses', async () => {
    await seedNetwork(null);
    expect(await svc.confirmationPolicy(NET, null)).toMatchObject({ networkDefault: null, effective: null, source: 'unset' });
    expect(
      await code(svc.requestOverride('a', { networkId: NET, confirmations: 3, reason: 'TEST', expiresAt: '2026-01-02T00:00:00Z' })),
    ).toBe('confirmation.default_unset');
    expect(await code(svc.creditConfirmations(NET))).toBe('confirmation.default_unset');
    expect(await code(svc.confirmationPolicy('nope-net', null))).toBe('confirmation.network_unknown');
  });

  it('an override needs a second approver; the requester cannot approve their own, and it is not effective until approved', async () => {
    const id = await withdrawal();
    const r = await svc.requestOverride('founder-a', { networkId: NET, withdrawalId: id, confirmations: 20, reason: 'TEST bigger' });
    expect(r.effective).toBe(false);
    expect(await svc.confirmationPolicy(NET, id)).toMatchObject({ effective: 12, source: 'default' });
    expect(await code(svc.approveOverride('founder-a', r.id))).toBe('confirmation.second_approver_required');
    // even a row written around the service for the requester does not make it effective
    await db.sql`INSERT INTO pay.confirmation_override_approvals (request_id, approver) VALUES (${r.id}::uuid, 'founder-a')`;
    expect((await svc.listOverrides(NET, 5))[0]).toMatchObject({ effective: false });
    expect(await svc.confirmationPolicy(NET, id)).toMatchObject({ effective: 12, source: 'default' });
    const approved = await svc.approveOverride('founder-b', r.id);
    expect(approved).toMatchObject({ effective: true, approvers: ['founder-a', 'founder-b'] });
    expect(await svc.confirmationPolicy(NET, id)).toMatchObject({ effective: 20, source: 'transaction_override', overrideId: r.id });
    // the override belongs to that transaction only
    const other = await withdrawal();
    expect(await svc.confirmationPolicy(NET, other)).toMatchObject({ effective: 12, source: 'default' });
    // approving twice is one approval
    expect((await svc.approveOverride('founder-b', r.id)).approvers).toEqual(['founder-a', 'founder-b']);
  });

  it('a count below the default needs an expiry, and once it expires the default applies again', async () => {
    const id = await withdrawal();
    expect(await code(svc.requestOverride('a', { networkId: NET, withdrawalId: id, confirmations: 3, reason: 'TEST' }))).toBe(
      'confirmation.expiry_required',
    );
    expect(
      await code(
        svc.requestOverride('a', { networkId: NET, withdrawalId: id, confirmations: 3, reason: 'TEST', expiresAt: '2026-01-01T09:00:00Z' }),
      ),
    ).toBe('confirmation.expiry_in_past');
    const r = await svc.requestOverride('a', {
      networkId: NET,
      withdrawalId: id,
      confirmations: 3,
      reason: 'TEST',
      expiresAt: '2026-01-01T11:00:00Z',
    });
    await svc.approveOverride('b', r.id);
    expect(await svc.confirmationPolicy(NET, id)).toMatchObject({
      effective: 3,
      source: 'transaction_override',
      expiresAt: '2026-01-01T11:00:00.000000Z',
    });
    clock = new Date('2026-01-01T11:00:01.000Z');
    expect(await svc.confirmationPolicy(NET, id)).toMatchObject({ effective: 12, source: 'default', overrideId: null });
    expect(await code(svc.approveOverride('c', r.id))).toBe('confirmation.request_expired');
  });

  it('zero is allowed only for one transaction to our own custody wallet, never for a network or an outside address', async () => {
    const [vault] = await db.sql<Array<{ vault_id: string }>>`
      WITH e AS (INSERT INTO pay.custody_entities (entity_id, display_name, ownership, environment, created_by)
                 VALUES ('house', 'House', 'entity_owned', 'testnet', 'seed') ON CONFLICT DO NOTHING RETURNING 1)
      INSERT INTO pay.custody_vaults (entity_id, client_ref, name, created_by, updated_by) VALUES ('house', 'v-1', 'Main', 'seed', 'seed')
      ON CONFLICT (entity_id, client_ref) DO UPDATE SET name = 'Main' RETURNING vault_id`;
    await db.sql`INSERT INTO pay.custody_wallets (vault_id, network_id, asset_code, address, created_by)
      VALUES (${vault!.vault_id}::uuid, ${NET}, 'USDT', ${OWN}, 'seed')`;
    const own = await withdrawal({ dest: OWN.toLowerCase() });
    const outside = await withdrawal({ dest: OUTSIDE });
    const base = { networkId: NET, confirmations: 0, reason: 'TEST', expiresAt: '2026-01-01T11:00:00Z' };
    expect(await code(svc.requestOverride('a', { ...base, withdrawalId: outside }))).toBe('confirmation.zero_needs_own_wallets');
    expect(await code(svc.requestOverride('a', base))).toBe('confirmation.zero_needs_own_wallets');
    const r = await svc.requestOverride('a', { ...base, withdrawalId: own });
    await svc.approveOverride('b', r.id);
    expect(await svc.confirmationPolicy(NET, own)).toMatchObject({ effective: 0 });
    // zero without an expiry is still refused: it is below the default
    expect(await code(svc.requestOverride('a', { networkId: NET, confirmations: 0, reason: 'TEST', withdrawalId: own }))).toBe(
      'confirmation.expiry_required',
    );
    await expect(
      db.sql`INSERT INTO pay.confirmation_override_requests (scope, network_id, confirmations, default_at_request, reason, requested_by, expires_at)
             VALUES ('network', ${NET}, 0, 12, 'TEST', 'a', now() + interval '1 day')`,
    ).rejects.toThrow();
  });

  it('a network override applies to custody, a transaction override beats it, and a customer credit ignores every override', async () => {
    const id = await withdrawal();
    const n = await svc.requestOverride('a', { networkId: NET, confirmations: 30, reason: 'TEST reorg risk' });
    await svc.approveOverride('b', n.id);
    expect(await svc.confirmationPolicy(NET, id)).toMatchObject({ effective: 30, source: 'network_override' });
    const t = await svc.requestOverride('a', { networkId: NET, withdrawalId: id, confirmations: 15, reason: 'TEST' });
    await svc.approveOverride('b', t.id);
    expect(await svc.confirmationPolicy(NET, id)).toMatchObject({ effective: 15, source: 'transaction_override' });
    expect(await svc.creditConfirmations(NET)).toBe(12);
    expect((await svc.listOverrides(NET, 10)).map((x) => x.id)).toEqual([t.id, n.id]);
    await expect(db.sql`UPDATE pay.confirmation_override_requests SET confirmations = 0`).rejects.toThrow(/never edited or deleted/);
    await expect(db.sql`DELETE FROM pay.confirmation_override_approvals`).rejects.toThrow(/never edited or deleted/);
  });
});

describe('custody transactions through the founder router', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  const FOUNDER = 'founder-a';

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const founderAuthority = async () => {
      if (!founderOk) throw new MerchantControlError('operator.denied');
      return FOUNDER;
    };
    const userId = randomUUID();
    const principal: Principal = {
      userId,
      sub: userId,
      sid: randomUUID(),
      scopes: [...SESSION_SCOPES],
      mfa: true,
      tier: 'full',
      expiresAt: new Date(Date.now() + 3_600_000),
    };
    api = createPayNamespaces({ founderAuthority, custody: { sql: db.sql } }).createCaller({
      principal,
      service: null,
      region: 'DE',
      requestId: 'r',
    });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(() => {
    founderOk = true;
  });

  const refused = async (p: Promise<unknown>): Promise<{ code: string; message: string }> => {
    try {
      await p;
    } catch (e) {
      return e as { code: string; message: string };
    }
    throw new Error('expected the call to be refused');
  };

  it('refuses a caller who is not the founder on every procedure', async () => {
    founderOk = false;
    const c = () => api.founderAdmin.custody;
    expect((await refused(c().tx.list({ limit: 5 }))).code).toBe('FORBIDDEN');
    expect((await refused(c().reasons.catalog())).code).toBe('FORBIDDEN');
    expect((await refused(c().lifecycle.timeouts())).code).toBe('FORBIDDEN');
    expect((await refused(c().confirmation.get({ networkId: NET }))).code).toBe('FORBIDDEN');
  });

  it('parses strictly: no page size, unknown keys, bad ids and an empty note are parse errors', async () => {
    const c = () => api.founderAdmin.custody;
    expect((await refused(c().tx.list({}))).code).toBe('BAD_REQUEST');
    expect((await refused(c().tx.list({ limit: 5, extra: 1 }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().tx.get({ withdrawalId: 'nope' }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().tx.addNote({ withdrawalId: randomUUID(), note: '   ' }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().lifecycle.setTimeout({ state: 'QUEUED', seconds: 0, reason: 'TEST' }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().confirmation.request({ networkId: NET, confirmations: -1, reason: 'TEST' }))).code).toBe('BAD_REQUEST');
  });

  it('serves the catalog and an empty list, maps typed refusals, and shows the raw blank default', async () => {
    const c = () => api.founderAdmin.custody;
    const catalog = await c().reasons.catalog();
    expect(catalog.length).toBeGreaterThan(5);
    expect(catalog[0]).toEqual(expect.objectContaining({ known: true }));
    expect(await c().tx.list({ limit: 5 })).toEqual({ items: [], next: null });
    expect((await c().lifecycle.timeouts()).every((t: { seconds: number | null }) => t.seconds === null)).toBe(true);
    expect((await refused(c().tx.get({ withdrawalId: randomUUID() }))).message).toContain('custody_tx.not_found');
    expect((await refused(c().confirmation.get({ networkId: 'no-such-net' }))).message).toContain('confirmation.network_unknown');
  });
});
