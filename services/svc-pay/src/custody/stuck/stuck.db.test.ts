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
import { PayError } from '../../payment-service.js';
import { CustodyStuckError, type CustodyStuckErrorCode } from './errors.js';
import {
  CustodyStuckService,
  ReplacerRefusal,
  type NonceChain,
  type NonceStatus,
  type ReplaceRequest,
  type TxReplacer,
} from './service.js';

/** Per-vault queue, stuck transaction handling and reverse against a real Postgres and fake ports. TEST figures only. */
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
    .withDatabase('intafaced_custody_stuck_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const NET = 'evm-test';
const HASH = '0xAAA1';

async function code(p: Promise<unknown>): Promise<CustodyStuckErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CustodyStuckError) return e.code;
    throw e;
  }
  throw new Error('expected the call to be refused');
}

class FakeReplacer implements TxReplacer {
  mode: 'ok' | 'refuse' | 'down' = 'ok';
  calls = 0;
  /** actionKey -> hash: idempotent on the key, like a real signer must be. */
  readonly sent = new Map<string, string>();
  async submit(input: ReplaceRequest): Promise<{ txHash: string }> {
    this.calls++;
    if (this.mode === 'refuse') throw new ReplacerRefusal('GAS_PRICE_TOO_LOW_FOR_RBF', 'TEST');
    if (this.mode === 'down') throw new Error('socket hang up');
    const known = this.sent.get(input.actionKey);
    if (known) return { txHash: known };
    const h = `0xnew${this.sent.size + 1}`;
    this.sent.set(input.actionKey, h);
    return { txHash: h };
  }
}

describe('custody queue, stuck transactions and reverse (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let replacer: FakeReplacer;
  let chainState: NonceStatus = { state: 'pending' };
  const chain: NonceChain = { status: async () => chainState };
  let cancelCalls: Array<{ userId: string; withdrawalId: string }> = [];
  let cancelError: Error | null = null;
  let reverseCalls: Array<{ withdrawalId: string; evidenceRef: string }> = [];
  let reverseError: Error | null = null;
  let clock = new Date('2026-01-01T10:00:00.000Z');
  let svc: CustodyStuckService;
  let walletId = '';

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  async function seedWallet(): Promise<void> {
    await db.sql`DELETE FROM pay.network_registry WHERE network_id = ${NET}`;
    await db.sql`INSERT INTO pay.network_registry (network_id, display_name, asset_codes, confirmations_required, enabled, updated_by)
      VALUES (${NET}, ${NET}, ${db.sql.json(['USDT'])}, 12, true, 'seed')`;
    await db.sql`INSERT INTO pay.custody_entities (entity_id, display_name, ownership, environment, created_by)
      VALUES ('house', 'House', 'entity_owned', 'testnet', 'seed') ON CONFLICT DO NOTHING`;
    const [v] = await db.sql<Array<{ vault_id: string }>>`
      INSERT INTO pay.custody_vaults (entity_id, client_ref, name, created_by, updated_by) VALUES ('house', 'v-1', 'Main', 'seed', 'seed')
      ON CONFLICT (entity_id, client_ref) DO UPDATE SET name = 'Main' RETURNING vault_id`;
    const [w] = await db.sql<Array<{ wallet_id: string }>>`
      INSERT INTO pay.custody_wallets (vault_id, network_id, asset_code, address, created_by)
      VALUES (${v!.vault_id}::uuid, ${NET}, 'USDT', '0xHOT', 'seed')
      ON CONFLICT (vault_id, network_id, asset_code) DO UPDATE SET address = '0xHOT' RETURNING wallet_id`;
    walletId = w!.wallet_id;
  }

  async function withdrawal(status: 'pending' | 'held' | 'sent' | 'failed' = 'held', ageSeconds = 0): Promise<string> {
    const at = new Date(clock.getTime() - ageSeconds * 1000).toISOString();
    const [r] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref, rail_ref, status, created_at, updated_at)
      VALUES ('user-1', 'USDT', 5, 'evm', ${db.sql.json({ kind: 'crypto', ref: '0xDEST' })}, ${randomUUID()},
              ${status === 'sent' ? '0xsent' : null}, ${status}::pay.withdrawal_status, ${at}::timestamptz, ${at}::timestamptz)
      RETURNING id`;
    return r!.id;
  }

  beforeEach(async () => {
    clock = new Date('2026-01-01T10:00:00.000Z');
    replacer = new FakeReplacer();
    chainState = { state: 'pending' };
    cancelCalls = [];
    cancelError = null;
    reverseCalls = [];
    reverseError = null;
    await db.sql`TRUNCATE pay.custody_reverse_outcomes, pay.custody_reverse_approvals, pay.custody_reverse_requests, pay.custody_tx_action_outcomes, pay.custody_tx_actions, pay.custody_stuck_threshold_events, pay.custody_tx_wallet_links, pay.custody_tx_notes, pay.withdrawals RESTART IDENTITY CASCADE`;
    await db.sql`DELETE FROM pay.custody_wallets`;
    await seedWallet();
    svc = new CustodyStuckService({
      sql: db.sql,
      replacer,
      chain,
      canceller: {
        cancelWithdrawal: async (i) => {
          cancelCalls.push(i);
          if (cancelError) throw cancelError;
        },
      },
      reverser: {
        reverseDropped: async (i) => {
          reverseCalls.push(i);
          if (reverseError) throw reverseError;
        },
      },
      now: () => clock,
    });
  });

  const act = (id: string, o: Record<string, unknown> = {}) => ({
    kind: 'boost' as const,
    actionKey: 'act-1',
    withdrawalId: id,
    originalTxHash: HASH,
    nonce: 7,
    reason: 'TEST stuck',
    ...o,
  });
  const linked = async (status: 'held' | 'pending' = 'held', nonce: number | null = 7, age = 0) => {
    const id = await withdrawal(status, age);
    await svc.link('op-1', { withdrawalId: id, walletId, ...(nonce === null ? {} : { nonce }) });
    return id;
  };

  it('links a withdrawal to a wallet and nonce once; a different link for the same withdrawal conflicts', async () => {
    const id = await withdrawal();
    const l = await svc.link('op-1', { withdrawalId: id, walletId, nonce: 7 });
    expect(l).toMatchObject({ withdrawalId: id, walletId, nonce: 7, linkedBy: 'op-1' });
    expect(await svc.link('op-2', { withdrawalId: id, walletId, nonce: 7 })).toMatchObject({ linkedBy: 'op-1' });
    expect(await code(svc.link('op-1', { withdrawalId: id, walletId, nonce: 8 }))).toBe('stuck.already_linked');
    expect(await code(svc.link('op-1', { withdrawalId: randomUUID(), walletId }))).toBe('stuck.withdrawal_not_found');
    expect(await code(svc.link('op-1', { withdrawalId: id, walletId: randomUUID() }))).toBe('stuck.wallet_not_found');
    await expect(db.sql`DELETE FROM pay.custody_tx_wallet_links`).rejects.toThrow(/never edited or deleted/);
  });

  it('lists the per-wallet queue lowest nonce first with the head of line marked; only held, linked rows are in flight', async () => {
    const a = await linked('held', 8, 120);
    const b = await linked('held', 7, 300);
    await linked('pending', 9);
    const unlinked = await withdrawal('held');
    const q = await svc.queue(walletId);
    expect(q.items.map((i) => [i.withdrawalId, i.nonce, i.headOfLine])).toEqual([
      [b, 7, true],
      [a, 8, false],
    ]);
    expect(q.items.map((i) => i.withdrawalId)).not.toContain(unlinked);
    expect(q.items[0]).toMatchObject({ ageSeconds: 300, stuck: null });
    expect(q.thresholdSeconds).toBeNull();
    expect(await code(svc.queue(randomUUID()))).toBe('stuck.wallet_not_found');
  });

  it('diagnosis refuses with no owner threshold; with one it names the stuck head of line and a transaction with no nonce', async () => {
    const head = await linked('held', 7, 300);
    await linked('held', 8, 10);
    const noNonce = await linked('held', null, 5);
    expect(await code(svc.diagnose(walletId))).toBe('stuck.threshold_unset');
    expect(await code(svc.setThreshold('op-1', { networkId: 'no-such', seconds: 60, reason: 'TEST' }))).toBe('stuck.network_unknown');
    await svc.setThreshold('op-1', { networkId: NET, seconds: 60, reason: 'TEST' });
    const d = await svc.diagnose(walletId);
    expect(d).toMatchObject({ inFlight: 3, stuckCount: 1, thresholdSeconds: 60 });
    expect(d.findings.map((f) => [f.code, f.withdrawalId])).toEqual(
      expect.arrayContaining([
        ['head_of_line_stuck', head],
        ['nonce_unknown', noNonce],
      ]),
    );
    // exactly at the threshold is not stuck yet
    await svc.setThreshold('op-1', { networkId: NET, seconds: 300, reason: 'TEST' });
    expect((await svc.diagnose(walletId)).stuckCount).toBe(0);
  });

  it('with no signer connected a boost refuses rail.crypto and writes nothing', async () => {
    const id = await linked();
    const bare = new CustodyStuckService({ sql: db.sql, now: () => clock });
    expect(await code(bare.act('op-1', act(id)))).toBe('rail.crypto');
    expect(await code(bare.resolve(randomUUID()))).toBe('rail.crypto');
    const [n] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.custody_tx_actions`;
    expect(n!.n).toBe('0');
  });

  it('boosting twice with the same key is one action and one replacement; the intent is written before the signer is asked', async () => {
    const id = await linked();
    let seenIntent = false;
    const spy: TxReplacer = {
      submit: async (i) => {
        const [r] = await db.sql`SELECT 1 FROM pay.custody_tx_actions WHERE action_key = ${i.actionKey}`;
        seenIntent = r !== undefined;
        return replacer.submit(i);
      },
    };
    const s = new CustodyStuckService({ sql: db.sql, replacer: spy, chain, now: () => clock });
    const first = await s.act('op-1', act(id, { maxFee: '0.5', maxFeeUnit: 'gwei' }));
    const second = await s.act('op-2', act(id, { maxFee: '0.50', maxFeeUnit: 'gwei' }));
    expect(seenIntent).toBe(true);
    expect(first).toMatchObject({ status: 'submitted', submittedTxHash: '0xnew1', maxFee: '0.5', maxFeeUnit: 'gwei', requestedBy: 'op-1' });
    expect(second.id).toBe(first.id);
    expect(replacer.calls).toBe(1);
    expect(replacer.sent.size).toBe(1);
    const [n] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.custody_tx_actions`;
    expect(n!.n).toBe('1');
    expect(await code(s.act('op-1', act(id, { nonce: 7, originalTxHash: '0xother' })))).toBe('stuck.action_differs');
    expect(await code(s.act('op-1', act(id, { kind: 'drop' })))).toBe('stuck.action_differs');
  });

  it('refuses an action on a withdrawal that is not linked, not in flight, or has another nonce', async () => {
    const unlinked = await withdrawal('held');
    expect(await code(svc.act('op-1', act(unlinked)))).toBe('stuck.not_linked');
    const sent = await withdrawal('sent');
    await svc.link('op-1', { withdrawalId: sent, walletId, nonce: 7 });
    expect(await code(svc.act('op-1', act(sent, { actionKey: 'a-2' })))).toBe('stuck.not_in_flight');
    const id = await linked('held', 7);
    expect(await code(svc.act('op-1', act(id, { actionKey: 'a-3', nonce: 9 })))).toBe('stuck.nonce_mismatch');
    expect(await code(svc.act('op-1', act(randomUUID(), { actionKey: 'a-4' })))).toBe('stuck.withdrawal_not_found');
    expect(replacer.calls).toBe(0);
  });

  it('records a definite refusal as failed (GAS_PRICE_TOO_LOW_FOR_RBF) and does not ask the signer again for that key', async () => {
    const id = await linked();
    replacer.mode = 'refuse';
    const r = await svc.act('op-1', act(id));
    expect(r).toMatchObject({ status: 'failed', failureCode: 'GAS_PRICE_TOO_LOW_FOR_RBF', submittedTxHash: null });
    replacer.mode = 'ok';
    expect((await svc.act('op-1', act(id))).status).toBe('failed');
    expect(replacer.calls).toBe(1);
    // a new key is a new attempt
    expect((await svc.act('op-1', act(id, { actionKey: 'act-2' }))).status).toBe('submitted');
  });

  it('an unknown signer answer keeps the intent with no outcome, and the same key resumes with one replacement', async () => {
    const id = await linked();
    replacer.mode = 'down';
    expect(await code(svc.act('op-1', act(id)))).toBe('stuck.outcome_unknown');
    const [a] = await svc.listActions(id);
    expect(a).toMatchObject({ status: 'intent', submittedTxHash: null });
    replacer.mode = 'ok';
    expect(await svc.act('op-1', act(id))).toMatchObject({ status: 'submitted', submittedTxHash: '0xnew1' });
    expect(replacer.sent.size).toBe(1);
  });

  it('the original is replaced or dropped only when the chain shows it: pending records nothing, original mined is recorded', async () => {
    const id = await linked();
    const a = await svc.act('op-1', act(id));
    expect((await svc.resolve(a.id)).status).toBe('submitted');
    chainState = { state: 'replaced', replacementTxHash: '0xelse' };
    expect(await svc.resolve(a.id)).toMatchObject({ status: 'replaced' });
    const b = await svc.act('op-1', act(id, { actionKey: 'act-2' }));
    chainState = { state: 'original_mined' };
    expect((await svc.resolve(b.id)).status).toBe('original_mined');
    await expect(db.sql`UPDATE pay.custody_tx_action_outcomes SET outcome = 'dropped'`).rejects.toThrow(/never edited or deleted/);
  });

  describe('reverse after a drop', () => {
    async function dropped(): Promise<{ id: string; actionId: string }> {
      const id = await linked();
      const a = await svc.act('op-1', act(id, { kind: 'drop', actionKey: 'drop-1' }));
      chainState = { state: 'replaced', replacementTxHash: a.submittedTxHash };
      expect((await svc.resolve(a.id)).status).toBe('dropped');
      return { id, actionId: a.id };
    }
    const evidence = { evidenceTxHash: HASH, evidenceNonce: 7, reason: 'TEST drop confirmed' };

    it('a drop is shown only when the nonce was taken by the drop itself; an eviction or another transaction is not enough', async () => {
      const id = await linked();
      const a = await svc.act('op-1', act(id, { kind: 'drop', actionKey: 'drop-1' }));
      chainState = { state: 'dropped' };
      expect((await svc.resolve(a.id)).status).toBe('submitted');
      chainState = { state: 'replaced', replacementTxHash: '0xsomeone-else' };
      expect((await svc.resolve(a.id)).status).toBe('replaced');
      expect(await code(svc.requestReverse('op-1', { withdrawalId: id, actionId: a.id, ...evidence }))).toBe('stuck.reverse_needs_drop');
    });

    it('refuses a reverse with no drop evidence: a boost, a mismatched hash or nonce, or another withdrawal', async () => {
      const id = await linked();
      const boost = await svc.act('op-1', act(id));
      chainState = { state: 'dropped' };
      await svc.resolve(boost.id);
      expect(await code(svc.requestReverse('op-1', { withdrawalId: id, actionId: boost.id, ...evidence }))).toBe(
        'stuck.reverse_needs_drop',
      );
      const d = await dropped();
      expect(
        await code(svc.requestReverse('op-1', { withdrawalId: d.id, actionId: d.actionId, ...evidence, evidenceTxHash: '0xwrong' })),
      ).toBe('stuck.reverse_evidence_mismatch');
      expect(await code(svc.requestReverse('op-1', { withdrawalId: d.id, actionId: d.actionId, ...evidence, evidenceNonce: 8 }))).toBe(
        'stuck.reverse_evidence_mismatch',
      );
      expect(await code(svc.requestReverse('op-1', { withdrawalId: id, actionId: d.actionId, ...evidence }))).toBe(
        'stuck.action_not_found',
      );
      expect(reverseCalls).toEqual([]);
    });

    it('needs a second approver: the requester cannot approve, and nothing runs until another founder has', async () => {
      const d = await dropped();
      const r = await svc.requestReverse('op-1', { withdrawalId: d.id, actionId: d.actionId, ...evidence });
      expect(r).toMatchObject({ approved: false, executed: false });
      expect(await code(svc.approveReverse('op-1', r.id))).toBe('stuck.second_approver_required');
      expect(await code(svc.executeReverse('op-1', r.id))).toBe('stuck.reverse_not_approved');
      // a row written around the service for the requester does not approve it
      await db.sql`INSERT INTO pay.custody_reverse_approvals (request_id, approver) VALUES (${r.id}::uuid, 'op-1')`;
      expect(await code(svc.executeReverse('op-1', r.id))).toBe('stuck.reverse_not_approved');
      expect(reverseCalls).toEqual([]);
      expect((await svc.approveReverse('op-2', r.id)).approved).toBe(true);
    });

    it('with evidence and a second approver it posts one reverse; running it again, or asking again, does not post a second', async () => {
      const d = await dropped();
      const r = await svc.requestReverse('op-1', { withdrawalId: d.id, actionId: d.actionId, ...evidence });
      expect((await svc.requestReverse('op-3', { withdrawalId: d.id, actionId: d.actionId, ...evidence })).id).toBe(r.id);
      await svc.approveReverse('op-2', r.id);
      const done = await svc.executeReverse('op-2', r.id);
      const again = await svc.executeReverse('op-1', r.id);
      expect(done.executed).toBe(true);
      expect(again.executed).toBe(true);
      expect(reverseCalls).toEqual([{ withdrawalId: d.id, evidenceRef: r.id }]);
      const [n] = await db.sql<Array<{ n: string }>>`SELECT count(*)::text AS n FROM pay.custody_reverse_outcomes`;
      expect(n!.n).toBe('1');
    });

    it('a failed reverse records nothing and is safe to run again', async () => {
      const d = await dropped();
      const r = await svc.requestReverse('op-1', { withdrawalId: d.id, actionId: d.actionId, ...evidence });
      await svc.approveReverse('op-2', r.id);
      reverseError = new PayError('ledger down', 'pay.ledger_outcome_unknown');
      expect(await code(svc.executeReverse('op-2', r.id))).toBe('stuck.reverse_failed');
      expect((await svc.approveReverse('op-2', r.id)).executed).toBe(false);
      const bare = new CustodyStuckService({ sql: db.sql, now: () => clock });
      expect(await code(bare.executeReverse('op-2', r.id))).toBe('stuck.reverse_unwired');
      reverseError = null;
      expect((await svc.executeReverse('op-2', r.id)).executed).toBe(true);
    });
  });

  it('operator cancel calls the withdrawal cancel; a refusal (held or sent) is a typed refusal and leaves no note', async () => {
    const id = await withdrawal('pending');
    expect(await svc.cancel('op-1', id)).toEqual({ withdrawalId: id, canceled: true });
    expect(cancelCalls).toEqual([{ userId: 'user-1', withdrawalId: id }]);
    const [note] = await db.sql<
      Array<{ note: string; author: string }>
    >`SELECT note, author FROM pay.custody_tx_notes WHERE withdrawal_id = ${id}::uuid`;
    expect(note).toMatchObject({ author: 'op-1' });
    const held = await withdrawal('held');
    cancelError = new PayError('The withdrawal is being sent', 'pay.withdrawal_not_cancellable');
    expect(await code(svc.cancel('op-1', held))).toBe('stuck.cancel_refused');
    const [n] = await db.sql<
      Array<{ n: string }>
    >`SELECT count(*)::text AS n FROM pay.custody_tx_notes WHERE withdrawal_id = ${held}::uuid`;
    expect(n!.n).toBe('0');
    expect(await code(svc.cancel('op-1', randomUUID()))).toBe('stuck.withdrawal_not_found');
    const bare = new CustodyStuckService({ sql: db.sql });
    expect(await code(bare.cancel('op-1', id))).toBe('stuck.cancel_unwired');
  });

  it('threshold history is append-only and the latest row is the setting', async () => {
    expect((await svc.threshold(NET)).seconds).toBeNull();
    await svc.setThreshold('op-1', { networkId: NET, seconds: 60, reason: 'TEST' });
    await svc.setThreshold('op-2', { networkId: NET, seconds: 120, reason: 'TEST' });
    expect(await svc.threshold(NET)).toMatchObject({ seconds: 120, setBy: 'op-2' });
    await expect(db.sql`DELETE FROM pay.custody_stuck_threshold_events`).rejects.toThrow(/never edited or deleted/);
  });
});

describe('custody stuck router', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let founderOk = true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const founderAuthority = async () => {
      if (!founderOk) throw new MerchantControlError('operator.denied');
      return 'founder-a';
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
    const id = randomUUID();
    expect((await refused(c().queue.list({ walletId: id }))).code).toBe('FORBIDDEN');
    expect((await refused(c().queue.cancel({ withdrawalId: id }))).code).toBe('FORBIDDEN');
    expect((await refused(c().stuck.threshold({ networkId: NET }))).code).toBe('FORBIDDEN');
    expect((await refused(c().stuck.executeReverse({ requestId: id }))).code).toBe('FORBIDDEN');
  });

  it('parses strictly: unknown keys, bad ids, a fee ceiling without its unit, a zero fee and a negative nonce are parse errors', async () => {
    const c = () => api.founderAdmin.custody;
    const id = randomUUID();
    const base = { kind: 'boost', actionKey: 'k-1', withdrawalId: id, originalTxHash: '0xabc', nonce: 1, reason: 'TEST' };
    expect((await refused(c().queue.list({ walletId: id, extra: 1 }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().queue.list({ walletId: 'nope' }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().stuck.act({ ...base, maxFee: '1' }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().stuck.act({ ...base, maxFee: '0', maxFeeUnit: 'gwei' }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().stuck.act({ ...base, nonce: -1 }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().stuck.act({ ...base, kind: 'cancel' }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().stuck.act({ ...base, actionKey: 'has space' }))).code).toBe('BAD_REQUEST');
    expect((await refused(c().stuck.setThreshold({ networkId: NET, seconds: 0, reason: 'TEST' }))).code).toBe('BAD_REQUEST');
  });

  it('with no signer, chain reader, cancel or ledger connected, each says so and writes nothing', async () => {
    const c = () => api.founderAdmin.custody;
    const id = randomUUID();
    const act = { kind: 'drop', actionKey: 'k-1', withdrawalId: id, originalTxHash: '0xabc', nonce: 1, reason: 'TEST' };
    expect((await refused(c().stuck.act(act))).message).toContain('rail.crypto');
    expect((await refused(c().stuck.resolve({ actionId: id }))).message).toContain('rail.crypto');
    expect((await refused(c().queue.cancel({ withdrawalId: id }))).message).toContain('stuck.cancel_unwired');
    expect((await refused(c().stuck.get({ actionId: id }))).message).toContain('stuck.action_not_found');
    expect((await refused(c().queue.list({ walletId: id }))).message).toContain('stuck.wallet_not_found');
    expect((await refused(c().stuck.executeReverse({ requestId: id }))).message).toContain('stuck.reverse_not_found');
    expect((await c().stuck.threshold({ networkId: NET })).seconds).toBeNull();
  });
});
