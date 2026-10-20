import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FeeEstimate, FeeEstimator } from '../fees/service.js';
import { CustodyUtxoError, type CustodyUtxoErrorCode } from './errors.js';
import { CustodyUtxoService, UtxoNodeRefusal, type NodeUtxo, type UtxoNode } from './service.js';

/** UTXO inventory and consolidation against a real Postgres and a fake node. TEST figures only. */
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
    .withDatabase('intafaced_utxo_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
const NET = 'btc-test';
const ADDR = 'bc1qtestaddress0001';

async function code(p: Promise<unknown>): Promise<CustodyUtxoErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CustodyUtxoError) return e.code;
    throw e;
  }
  throw new Error('expected the call to be refused');
}

class FakeNode implements UtxoNode {
  utxos: NodeUtxo[] = [];
  mode: 'ok' | 'refuse' | 'down' = 'ok';
  /** intentRef -> txid: the node is idempotent on the reference, like the real adapter must be. */
  readonly broadcasts = new Map<string, string>();
  calls = 0;
  onConsolidate: ((ref: string) => Promise<void>) | null = null;
  async list(): Promise<NodeUtxo[]> {
    return this.utxos;
  }
  async consolidate(input: { intentRef: string }): Promise<{ txid: string }> {
    this.calls++;
    await this.onConsolidate?.(input.intentRef);
    if (this.mode === 'refuse') throw new UtxoNodeRefusal('node.fee_too_high', 'TEST refusal');
    if (this.mode === 'down') throw new Error('socket hang up');
    const known = this.broadcasts.get(input.intentRef);
    if (known) return { txid: known };
    const txid = `cons${this.broadcasts.size + 1}`.padEnd(8, '0');
    this.broadcasts.set(input.intentRef, txid);
    return { txid };
  }
}

const u = (txid: string, vout: number, amount: string, confirmations = 6): NodeUtxo => ({ txid, vout, amount, confirmations });

describe('UTXO inventory and consolidation (real Postgres, fake node)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let node: FakeNode;
  let svc: CustodyUtxoService;
  let walletId = '';
  let estimate: FeeEstimate | 'down' | null = null;
  const estimator: FeeEstimator = {
    estimate: async () => {
      if (estimate === 'down' || estimate === null) throw new Error('no estimate');
      return estimate;
    },
  };

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function seed(confirmations: number | null = 3): Promise<void> {
    await db.sql`INSERT INTO pay.network_registry (network_id, display_name, asset_codes, confirmations_required, enabled, updated_by)
      VALUES (${NET}, ${NET}, ${db.sql.json(['BTC'])}, ${confirmations}, true, ${FOUNDER})
      ON CONFLICT (network_id) DO UPDATE SET confirmations_required = EXCLUDED.confirmations_required`;
    await db.sql`INSERT INTO pay.custody_entities (entity_id, display_name, ownership, environment, created_by)
      VALUES ('house', 'House', 'entity_owned', 'testnet', ${FOUNDER}) ON CONFLICT DO NOTHING`;
    const [v] = await db.sql<Array<{ vault_id: string }>>`
      INSERT INTO pay.custody_vaults (entity_id, client_ref, name, created_by, updated_by)
      VALUES ('house', 'v-1', 'Main', ${FOUNDER}, ${FOUNDER})
      ON CONFLICT (entity_id, client_ref) DO UPDATE SET name = EXCLUDED.name RETURNING vault_id`;
    const [w] = await db.sql<Array<{ wallet_id: string }>>`
      INSERT INTO pay.custody_wallets (vault_id, network_id, asset_code, address, created_by)
      VALUES (${v!.vault_id}::uuid, ${NET}, 'BTC', ${ADDR}, ${FOUNDER})
      ON CONFLICT (vault_id, network_id, asset_code) DO UPDATE SET address = EXCLUDED.address RETURNING wallet_id`;
    walletId = w!.wallet_id;
  }

  beforeEach(async () => {
    await db.sql`TRUNCATE pay.utxo_consolidation_outcomes, pay.utxo_consolidations, pay.utxo_label_events, pay.utxo_trigger_events, pay.utxo_records RESTART IDENTITY CASCADE`;
    await seed();
    node = new FakeNode();
    estimate = null;
    svc = new CustodyUtxoService({ sql: db.sql, node, estimator });
  });

  const rows = async (table: string) => {
    const [r] = await db.sql.unsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM ${table}`);
    return r?.n;
  };
  const four = () => [u('aa', 0, '0.5'), u('bb', 1, '0.25'), u('cc', 0, '1.125'), u('dd', 2, '0.1', 1)];

  it('with no node connected every read and write that needs it refuses rail.crypto and invents nothing', async () => {
    const bare = new CustodyUtxoService({ sql: db.sql });
    expect(await code(bare.list({ walletId }))).toBe('rail.crypto');
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 2, reason: 'TEST' });
    expect(await code(bare.due(walletId))).toBe('rail.crypto');
    expect(await code(bare.consolidate(FOUNDER, { walletId, intentRef: 'c-1' }))).toBe('rail.crypto');
    expect(await rows('pay.utxo_records')).toBe('0');
  });

  it('lists what the node reports with amounts, confirmations, states and labels; a vanished output becomes spent', async () => {
    node.utxos = four();
    const first = await svc.list({ walletId });
    expect(first.map((x) => [x.txid, x.vout, x.amount, x.confirmations, x.state, x.label])).toEqual([
      ['aa', 0, '0.5', 6, 'available', null],
      ['bb', 1, '0.25', 6, 'available', null],
      ['cc', 0, '1.125', 6, 'available', null],
      ['dd', 2, '0.1', 1, 'available', null],
    ]);
    node.utxos = [u('aa', 0, '0.5', 7), u('cc', 0, '1.125')];
    const second = await svc.list({ walletId });
    expect(second.find((x) => x.txid === 'aa')).toMatchObject({ confirmations: 7, state: 'available' });
    expect(second.filter((x) => x.state === 'spent').map((x) => x.txid)).toEqual(['bb', 'dd']);
    expect((await svc.list({ walletId, state: 'available' })).map((x) => x.txid)).toEqual(['aa', 'cc']);
    node.utxos = [u('bb', 1, '0.25')];
    expect((await svc.list({ walletId, state: 'available' })).map((x) => x.txid)).toEqual(['bb']);
  });

  it('refuses a wallet that does not exist or has no address yet', async () => {
    expect(await code(svc.list({ walletId: '33333333-3333-4333-8333-333333333333' }))).toBe('utxo.wallet_not_found');
    const [v] = await db.sql<Array<{ vault_id: string }>>`SELECT vault_id FROM pay.custody_vaults LIMIT 1`;
    const [w] = await db.sql<Array<{ wallet_id: string }>>`
      INSERT INTO pay.custody_wallets (vault_id, network_id, asset_code, created_by) VALUES (${v!.vault_id}::uuid, ${NET}, 'ETH', ${FOUNDER})
      RETURNING wallet_id`;
    expect(await code(svc.list({ walletId: w!.wallet_id }))).toBe('utxo.wallet_has_no_address');
  });

  it('labels and clears a label; unknown is not found and a spent output is not labellable', async () => {
    node.utxos = four();
    const [a] = await svc.list({ walletId });
    expect(await svc.label(FOUNDER, { utxoId: a!.id, label: 'exchange deposit' })).toMatchObject({ label: 'exchange deposit' });
    expect(await svc.label(FOUNDER, { utxoId: a!.id, label: null })).toMatchObject({ label: null });
    expect(await rows('pay.utxo_label_events')).toBe('2');
    expect(await code(svc.label(FOUNDER, { utxoId: '33333333-3333-4333-8333-333333333333', label: 'x' }))).toBe('utxo.not_found');
    node.utxos = [];
    await svc.list({ walletId });
    expect(await code(svc.label(FOUNDER, { utxoId: a!.id, label: 'late' }))).toBe('utxo.not_labellable');
  });

  it('blank triggers refuse; the latest trigger row is the setting', async () => {
    node.utxos = four();
    expect(await svc.triggers(NET)).toMatchObject({ configured: false, minUtxoCount: null, feeBelow: null });
    expect(await code(svc.due(walletId))).toBe('utxo.triggers_unset');
    expect(await code(svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' }))).toBe('utxo.triggers_unset');
    expect(node.calls).toBe(0);
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 9, reason: 'TEST' });
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 3, feeBelow: '5', feeUnit: 'sat/vB', reason: 'TEST again' });
    expect(await svc.triggers(NET)).toMatchObject({ configured: true, minUtxoCount: 3, feeBelow: '5', feeUnit: 'sat/vB', setBy: FOUNDER });
    expect(await code(svc.setTriggers(FOUNDER, { networkId: 'nowhere', minUtxoCount: 3, reason: 'x' }))).toBe('utxo.network_unknown');
  });

  it('a blank confirmation depth in the registry refuses', async () => {
    await seed(null);
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 2, reason: 'TEST' });
    node.utxos = four();
    expect(await code(svc.due(walletId))).toBe('utxo.confirmations_unset');
  });

  it('the count trigger fires at the owner number of confirmed available outputs, not below it', async () => {
    node.utxos = four(); // three are confirmed (depth 3); dd has 1
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 3, reason: 'TEST' });
    expect(await svc.due(walletId)).toMatchObject({ due: true, reasons: ['utxo_count'], utxoCount: 3 });
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 4, reason: 'TEST' });
    expect(await svc.due(walletId)).toMatchObject({ due: false, reasons: [], utxoCount: 3 });
    // an output at exactly the registry depth is confirmed; one block short is not
    node.utxos = [...four(), u('ee', 0, '0.3', 3), u('ff', 0, '0.2', 2)];
    expect(await svc.due(walletId)).toMatchObject({ due: true, reasons: ['utxo_count'], utxoCount: 4 });
  });

  it('the fee trigger fires at or below the owner level, and an unreadable estimate is never a yes', async () => {
    node.utxos = four();
    await svc.setTriggers(FOUNDER, { networkId: NET, feeBelow: '5', feeUnit: 'sat/vB', reason: 'TEST' });
    estimate = { unit: 'sat/vB', low: '5', medium: '9', high: '20', asOf: '2026-10-20T10:00:00.000Z' };
    expect(await svc.due(walletId)).toMatchObject({ due: true, reasons: ['low_fee'], feeNote: null });
    estimate = { unit: 'sat/vB', low: '5.000000000000000001', medium: '9', high: '20', asOf: '2026-10-20T10:00:00.000Z' };
    expect(await svc.due(walletId)).toMatchObject({ due: false });
    estimate = { unit: 'gwei', low: '1', medium: '2', high: '3', asOf: '2026-10-20T10:00:00.000Z' };
    expect(await svc.due(walletId)).toMatchObject({ due: false, feeNote: expect.stringContaining('gwei') });
    estimate = 'down';
    expect(await svc.due(walletId)).toMatchObject({ due: false, feeNote: 'custody_fees.estimate_failed' });
    const noEstimator = new CustodyUtxoService({ sql: db.sql, node });
    expect(await noEstimator.due(walletId)).toMatchObject({ due: false, feeNote: 'custody_fees.estimator_unwired' });
  });

  it('refuses when no trigger is met, and when fewer than two confirmed outputs are there', async () => {
    node.utxos = four();
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 4, reason: 'TEST' });
    expect(await code(svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' }))).toBe('utxo.not_due');
    node.utxos = [u('aa', 0, '0.5')];
    estimate = { unit: 'sat/vB', low: '1', medium: '2', high: '3', asOf: '2026-10-20T10:00:00.000Z' };
    await svc.setTriggers(FOUNDER, { networkId: NET, feeBelow: '5', feeUnit: 'sat/vB', reason: 'TEST' });
    expect(await code(svc.consolidate(FOUNDER, { walletId, intentRef: 'c-2' }))).toBe('utxo.nothing_to_consolidate');
    expect(await rows('pay.utxo_consolidations')).toBe('0');
    expect(node.calls).toBe(0);
  });

  it('writes the intent before the node is asked, freezes the inputs, reserves them and records the broadcast', async () => {
    node.utxos = four();
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 3, reason: 'TEST' });
    let intentSeenByNode = '';
    let stateSeenByNode = '';
    node.onConsolidate = async () => {
      intentSeenByNode = (await rows('pay.utxo_consolidations')) ?? '';
      const [s] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.utxo_records WHERE state = 'reserved'`;
      stateSeenByNode = s?.n ?? '';
    };
    const view = await svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' });
    expect(intentSeenByNode).toBe('1');
    expect(stateSeenByNode).toBe('3');
    expect(view).toMatchObject({ status: 'broadcast', intentRef: 'c-1', inputCount: 3, totalAmount: '1.875', createdBy: FOUNDER });
    expect(view.txid).toBe(node.broadcasts.get('c-1'));
    const [stored] = await db.sql<Array<{ inputs: Array<{ txid: string }> }>>`SELECT inputs FROM pay.utxo_consolidations`;
    expect(stored!.inputs.map((i) => i.txid)).toEqual(['aa', 'bb', 'cc']);
    expect((await svc.list({ walletId, state: 'available' })).map((x) => x.txid)).toEqual(['dd']);
    // Once the chain no longer shows the inputs they read spent; the reserved ones were never offered again.
    node.utxos = [u('dd', 2, '0.1', 1), u('cons1000', 0, '1.875', 0)];
    const after = await svc.list({ walletId });
    expect(after.filter((x) => x.state === 'spent').map((x) => x.txid)).toEqual(['aa', 'bb', 'cc']);
  });

  it('the same reference twice is one intent and one broadcast; another wallet under it conflicts', async () => {
    node.utxos = four();
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 3, reason: 'TEST' });
    const a = await svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' });
    const b = await svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' });
    expect(b).toEqual(a);
    expect(node.calls).toBe(1);
    expect(await rows('pay.utxo_consolidations')).toBe('1');
    const [v] = await db.sql<Array<{ vault_id: string }>>`SELECT vault_id FROM pay.custody_vaults LIMIT 1`;
    const [w2] = await db.sql<Array<{ wallet_id: string }>>`
      INSERT INTO pay.custody_wallets (vault_id, network_id, asset_code, address, created_by) VALUES (${v!.vault_id}::uuid, ${NET}, 'BCH', 'bc1qother', ${FOUNDER})
      RETURNING wallet_id`;
    expect(await code(svc.consolidate(FOUNDER, { walletId: w2!.wallet_id, intentRef: 'c-1' }))).toBe('utxo.intent_differs');
  });

  it('a definite node refusal records failed and frees the outputs for a new reference', async () => {
    node.utxos = four();
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 3, reason: 'TEST' });
    node.mode = 'refuse';
    expect(await svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' })).toMatchObject({
      status: 'failed',
      failureCode: 'node.fee_too_high',
      txid: null,
    });
    expect((await svc.list({ walletId, state: 'available' })).map((x) => x.txid)).toEqual(['aa', 'bb', 'cc', 'dd']);
    node.mode = 'ok';
    // The failed reference stays failed; a new one gets the outputs.
    expect(await svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' })).toMatchObject({ status: 'failed' });
    expect(await svc.consolidate(FOUNDER, { walletId, intentRef: 'c-2' })).toMatchObject({ status: 'broadcast', inputCount: 3 });
  });

  it('an unknown node answer keeps the intent and the reservation; the same reference resumes with the frozen inputs', async () => {
    node.utxos = four();
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 3, reason: 'TEST' });
    node.mode = 'down';
    expect(await code(svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' }))).toBe('utxo.outcome_unknown');
    expect(await rows('pay.utxo_consolidations')).toBe('1');
    expect(await rows('pay.utxo_consolidation_outcomes')).toBe('0');
    expect((await svc.listConsolidations(walletId, 10))[0]).toMatchObject({ status: 'intent' });
    // While it is unresolved, a different reference cannot take the same outputs.
    node.mode = 'ok';
    expect(await code(svc.consolidate(FOUNDER, { walletId, intentRef: 'c-2' }))).toBe('utxo.not_due');
    // The inventory changes under it; the resumed call still sends the frozen set.
    node.utxos = [u('zz', 0, '9'), ...four()];
    const resumed = await svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' });
    expect(resumed).toMatchObject({ status: 'broadcast', inputCount: 3, totalAmount: '1.875' });
    expect(node.broadcasts.size).toBe(1);
  });

  it('parallel consolidations on one wallet take the outputs once', async () => {
    node.utxos = four();
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 3, reason: 'TEST' });
    const out = await Promise.allSettled(
      ['p-1', 'p-2', 'p-3', 'p-4'].map((intentRef) => svc.consolidate(FOUNDER, { walletId, intentRef })),
    );
    expect(out.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await rows('pay.utxo_consolidations')).toBe('1');
    expect(node.broadcasts.size).toBe(1);
  });

  it('never edits or deletes a label event, a trigger, an intent, an outcome or an inventory row', async () => {
    node.utxos = four();
    await svc.setTriggers(FOUNDER, { networkId: NET, minUtxoCount: 3, reason: 'TEST' });
    const [a] = await svc.list({ walletId });
    await svc.label(FOUNDER, { utxoId: a!.id, label: 'x' });
    await svc.consolidate(FOUNDER, { walletId, intentRef: 'c-1' });
    for (const stmt of [
      'UPDATE pay.utxo_label_events SET label = NULL',
      'DELETE FROM pay.utxo_trigger_events',
      'UPDATE pay.utxo_consolidations SET input_count = 9',
      'DELETE FROM pay.utxo_consolidation_outcomes',
      'DELETE FROM pay.utxo_records',
    ]) {
      await expect(db.sql.unsafe(stmt)).rejects.toThrow(/not permitted|never deleted/);
    }
  });
});
