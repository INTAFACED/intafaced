import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMessageCipher } from './cipher.js';
import { TravelRuleError, type TravelRuleErrorCode } from './errors.js';
import type { MessageInput, SetRuleInput } from './schemas.js';
import { TravelRuleService, type ProviderReply, type TravelRuleProvider } from './service.js';

/** The outbound travel rule against a real Postgres. TEST figures only. */
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
    .withDatabase('intafaced_travel_rule_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FOUNDER = 'founder-a';
const T0 = new Date('2026-10-20T10:00:00.000Z');
const MIN = 60_000;

async function code(p: Promise<unknown>): Promise<TravelRuleErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof TravelRuleError) return e.code;
    throw e;
  }
  throw new Error('expected the call to be refused');
}

const RULE: SetRuleInput = {
  region: 'DE',
  entity: 'individual',
  assetId: 'USDT',
  applies: true,
  threshold: '1000',
  fields: ['originator_name', 'beneficiary_name', 'self_or_third_party'],
  reason: 'TEST rule',
};
const FULL: Omit<MessageInput, 'transferId'> = {
  originator: { name: 'Ada Lovelace' },
  beneficiary: { name: 'Charles Babbage' },
  transfer: { selfOrThirdParty: 'third_party' },
};

describe('outbound travel rule (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let clock = T0;
  let svc: TravelRuleService;
  let reply: ProviderReply | null = null;
  const sent: string[] = [];
  const provider: TravelRuleProvider = {
    send: async ({ transferId }) => {
      sent.push(transferId);
      if (!reply) throw new Error('the counterparty is down');
      return reply;
    },
  };
  const cipher = createMessageCipher('k1', randomBytes(32));

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  beforeEach(async () => {
    await db.sql`TRUNCATE pay.travel_rule_messages, pay.travel_rule_transitions, pay.travel_rule_transfers, pay.travel_rule_wait_limit_events, pay.travel_rule_rule_events, pay.withdrawals RESTART IDENTITY CASCADE`;
    clock = T0;
    reply = null;
    sent.length = 0;
    svc = new TravelRuleService({ sql: db.sql, cipher, now: () => clock });
  });

  let n = 0;
  async function withdrawal(amount = '5000', userId = USER, assetId = 'USDT'): Promise<string> {
    const [row] = await db.sql<Array<{ id: string }>>`
      INSERT INTO pay.withdrawals (user_id, asset_id, amount, rail, destination, client_ref)
      VALUES (${userId}, ${assetId}, ${amount}::numeric, 'chain', ${db.sql.json({ kind: 'address', ref: 'TXaddr1' })}, ${'w-' + ++n})
      RETURNING id`;
    return row!.id;
  }
  const openInput = (withdrawalId: string, userId = USER) => ({
    withdrawalId,
    userId,
    networkId: 'tron-test',
    region: 'DE',
    entity: 'individual' as const,
  });
  async function ready(amount = '5000') {
    await svc.setRule(FOUNDER, RULE);
    await svc.setWaitLimits(FOUNDER, { pendingSeconds: 600, repairSeconds: 300 });
    const w = await withdrawal(amount);
    const t = await svc.open(FOUNDER, openInput(w));
    return { w, t };
  }
  const rows = async (table: string) => {
    const [r] = await db.sql.unsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM ${table}`);
    return r?.n;
  };

  // ── owner rules and assessment ─────────────────────────────────────────────

  it('refuses while the owner has decided nothing, and invents no rule', async () => {
    expect(await code(svc.assess({ region: 'DE', entity: 'individual', assetId: 'USDT', amount: '5000' }))).toBe(
      'wallet.travel_rule_undecided',
    );
    const w = await withdrawal();
    expect(await code(svc.open(FOUNDER, openInput(w)))).toBe('wallet.travel_rule_undecided');
    expect(await svc.listRules()).toEqual([]);
    expect(await svc.waitLimits()).toEqual({ pendingSeconds: null, repairSeconds: null, setBy: null, setAt: null });
  });

  it('applies at the threshold, not below it', async () => {
    await svc.setRule(FOUNDER, RULE);
    const a = (
      amount: string,
      collected?: MessageInput['originator'] extends never ? never : Array<'originator_name' | 'beneficiary_name' | 'self_or_third_party'>,
    ) => svc.assess({ region: 'DE', entity: 'individual', assetId: 'USDT', amount, collected });
    expect((await a('999.999999999999999999')).result).toBe('not_required');
    expect((await a('1000')).result).toBe('need_more_info');
    expect(await a('1000', ['originator_name', 'beneficiary_name', 'self_or_third_party'])).toMatchObject({
      result: 'required',
      missing: [],
    });
    expect(await a('1000', ['originator_name'])).toMatchObject({
      result: 'need_more_info',
      missing: ['beneficiary_name', 'self_or_third_party'],
    });
  });

  it('the exact region beats the fallback, the latest row wins, and a not-applies rule is not required at any amount', async () => {
    await svc.setRule(FOUNDER, { ...RULE, region: '*', threshold: '10', reason: 'TEST fallback' });
    await svc.setRule(FOUNDER, { ...RULE, region: 'DE', threshold: '1000' });
    const key = { entity: 'individual' as const, assetId: 'USDT' };
    expect((await svc.assess({ ...key, region: 'DE', amount: '500' })).result).toBe('not_required');
    expect((await svc.assess({ ...key, region: 'FR', amount: '500' })).result).toBe('need_more_info');
    const v1 = (await svc.assess({ ...key, region: 'DE', amount: '500' })).ruleVersion;
    const second = await svc.setRule(FOUNDER, { ...RULE, region: 'DE', threshold: '100' });
    expect(second.version).toBeGreaterThan(v1);
    expect((await svc.assess({ ...key, region: 'DE', amount: '500' })).result).toBe('need_more_info');
    await svc.setRule(FOUNDER, { region: 'DE', entity: 'individual', assetId: 'USDT', applies: false, fields: [], reason: 'TEST off' });
    expect(await svc.assess({ ...key, region: 'DE', amount: '99999999' })).toMatchObject({ result: 'not_required', fields: [] });
    expect(await svc.listRules()).toHaveLength(2);
  });

  // ── opening a transfer ─────────────────────────────────────────────────────

  it('a required transfer starts and waits for a message; it cannot open without wait limits', async () => {
    await svc.setRule(FOUNDER, RULE);
    const w = await withdrawal();
    expect(await code(svc.open(FOUNDER, openInput(w)))).toBe('travel_rule.wait_limit_unset');
    expect(await rows('pay.travel_rule_transfers')).toBe('0');
    await svc.setWaitLimits(FOUNDER, { pendingSeconds: 600, repairSeconds: 300 });
    const t = await svc.open(FOUNDER, openInput(w));
    expect(t).toMatchObject({ status: 'started', displayStatus: 'Pending', assessment: 'required', amount: '5000', assetId: 'USDT' });
    expect(t.requiredFields).toEqual(RULE.fields);
  });

  it('below the threshold the owner rule decides not required, shown as Bypassed with the rule version', async () => {
    const rule = await svc.setRule(FOUNDER, RULE);
    const w = await withdrawal('999');
    const t = await svc.open(FOUNDER, openInput(w));
    expect(t).toMatchObject({
      status: 'not_required',
      displayStatus: 'Bypassed',
      assessment: 'not_required',
      ruleVersion: rule.version,
      requiredFields: [],
    });
    await svc.assertMayBroadcast(w);
  });

  it('opening twice reads the same record; other terms conflict; the amount is the withdrawal own; another account is not found', async () => {
    const { w, t } = await ready();
    expect(await svc.open(FOUNDER, openInput(w))).toEqual(t);
    expect(await code(svc.open(FOUNDER, { ...openInput(w), region: 'FR' }))).toBe('travel_rule.transfer_differs');
    // A withdrawal that belongs to someone else reads as not found for this account.
    expect(await code(svc.open(FOUNDER, openInput(await withdrawal(), OTHER)))).toBe('travel_rule.withdrawal_not_found');
    expect(await rows('pay.travel_rule_transfers')).toBe('1');
  });

  // ── message ────────────────────────────────────────────────────────────────

  it('refuses a message while no key is loaded, and stores nothing', async () => {
    const { t } = await ready();
    const bare = new TravelRuleService({ sql: db.sql, now: () => clock });
    expect(await code(bare.attachMessage(FOUNDER, { transferId: t.id, ...FULL }))).toBe('travel_rule.cipher_unwired');
    expect(await rows('pay.travel_rule_messages')).toBe('0');
  });

  it('stores the message encrypted, takes amount and address from the stored records, and reads back for the adapter', async () => {
    const { t } = await ready();
    const r = await svc.attachMessage(FOUNDER, { transferId: t.id, ...FULL });
    expect(r).toMatchObject({ messageVersion: 1, missing: [], status: 'started' });
    const [raw] = await db.sql<Array<{ ciphertext: Buffer }>>`SELECT ciphertext FROM pay.travel_rule_messages`;
    expect(raw!.ciphertext.includes(Buffer.from('Ada Lovelace'))).toBe(false);
    expect(await svc.readMessage(t.id)).toMatchObject({
      originator: { name: 'Ada Lovelace' },
      transaction: { transferId: t.id, amount: '5000', assetId: 'USDT', networkId: 'tron-test', address: 'TXaddr1' },
    });
  });

  it('missing identity fields put the transfer in repair with a deadline; a complete message takes it out', async () => {
    const { t } = await ready();
    const r = await svc.attachMessage(FOUNDER, { transferId: t.id, originator: { name: 'Ada' }, beneficiary: {}, transfer: {} });
    expect(r).toMatchObject({ status: 'repair', missing: ['beneficiary_name', 'self_or_third_party'], messageVersion: 1 });
    const d = await svc.get(t.id);
    expect(d).toMatchObject({ status: 'repair', waitDeadline: new Date(T0.getTime() + 300_000).toISOString() });
    expect(await code(svc.submit(FOUNDER, t.id))).toBe('travel_rule.fields_missing');
    const fixed = await svc.attachMessage(FOUNDER, { transferId: t.id, ...FULL });
    expect(fixed).toMatchObject({ status: 'started', missing: [], messageVersion: 2 });
  });

  // ── sending ────────────────────────────────────────────────────────────────

  it('with no counterparty network connected a send records provider_unavailable, refuses vendor.travelrule and approves nothing', async () => {
    const { w, t } = await ready();
    expect(await code(svc.submit(FOUNDER, t.id))).toBe('travel_rule.message_missing');
    await svc.attachMessage(FOUNDER, { transferId: t.id, ...FULL });
    expect(await code(svc.submit(FOUNDER, t.id))).toBe('vendor.travelrule');
    expect(await svc.get(t.id)).toMatchObject({ status: 'provider_unavailable', blocker: 'vendor.travelrule' });
    expect(await code(svc.submit(FOUNDER, t.id))).toBe('vendor.travelrule');
    expect(await rows('pay.travel_rule_transitions')).toBe('2');
    expect(await code(svc.assertMayBroadcast(w))).toBe('travel_rule.not_accepted');
  });

  it('an accepted reply lets the withdrawal broadcast; completion follows the send', async () => {
    const { w, t } = await ready();
    const withProvider = new TravelRuleService({ sql: db.sql, cipher, provider, now: () => clock });
    await withProvider.attachMessage(FOUNDER, { transferId: t.id, ...FULL });
    reply = { status: 'accepted' };
    expect(await withProvider.submit(FOUNDER, t.id)).toMatchObject({ status: 'accepted' });
    expect(sent).toEqual([t.id]);
    await svc.assertMayBroadcast(w);
    expect(await svc.complete(t.id, 'rail')).toMatchObject({ status: 'completed', displayStatus: 'Completed' });
    await svc.assertMayBroadcast(w);
    // Sending again after acceptance does not call the counterparty again.
    await withProvider.submit(FOUNDER, t.id);
    expect(sent).toEqual([t.id]);
  });

  it('a provider that comes back after an outage resumes the same transfer', async () => {
    const { t } = await ready();
    await svc.attachMessage(FOUNDER, { transferId: t.id, ...FULL });
    expect(await code(svc.submit(FOUNDER, t.id))).toBe('vendor.travelrule');
    const withProvider = new TravelRuleService({ sql: db.sql, cipher, provider, now: () => clock });
    reply = { status: 'pending' };
    expect(await withProvider.submit(FOUNDER, t.id)).toMatchObject({ status: 'pending' });
  });

  it('no record, or any status but accepted, completed or not required, refuses the broadcast (S-17)', async () => {
    expect(await code(svc.assertMayBroadcast('33333333-3333-4333-8333-333333333333'))).toBe('travel_rule.record_missing');
    const { w, t } = await ready();
    expect(await code(svc.assertMayBroadcast(w))).toBe('travel_rule.not_accepted');
    await svc.recordReply(t.id, { status: 'pending' });
    expect(await code(svc.assertMayBroadcast(w))).toBe('travel_rule.not_accepted');
    await svc.recordReply(t.id, { status: 'review' });
    expect(await code(svc.assertMayBroadcast(w))).toBe('travel_rule.not_accepted');
  });

  // ── waits ──────────────────────────────────────────────────────────────────

  it('a pending wait past its limit becomes Blocking time expired, still blocks, and a late reply still counts (S-18)', async () => {
    const { w, t } = await ready();
    await svc.recordReply(t.id, { status: 'pending', reason: 'reply later' });
    expect((await svc.get(t.id)).waitDeadline).toBe(new Date(T0.getTime() + 600_000).toISOString());
    clock = new Date(T0.getTime() + 600_000 - 1);
    expect(await svc.expireDue('job')).toEqual([]);
    clock = new Date(T0.getTime() + 600_000);
    expect(await svc.expireDue('job')).toEqual([t.id]);
    expect(await svc.expireDue('job')).toEqual([]);
    expect(await svc.get(t.id)).toMatchObject({ status: 'blocking_time_expired', displayStatus: 'Blocking time expired' });
    expect(await code(svc.assertMayBroadcast(w))).toBe('travel_rule.not_accepted');
    expect(await svc.recordReply(t.id, { status: 'accepted' })).toMatchObject({ status: 'accepted' });
    await svc.assertMayBroadcast(w);
  });

  it('a reply that lands before the job runs is not overwritten by an expiry', async () => {
    const { t } = await ready();
    await svc.recordReply(t.id, { status: 'pending' });
    await svc.recordReply(t.id, { status: 'accepted' });
    clock = new Date(T0.getTime() + 10 * MIN);
    expect(await svc.expireDue('job')).toEqual([]);
    expect((await svc.get(t.id)).status).toBe('accepted');
  });

  it('a counterparty rejection is final', async () => {
    const { w, t } = await ready();
    expect(await svc.recordReply(t.id, { status: 'rejected', reason: 'unknown wallet' })).toMatchObject({
      status: 'rejected',
      displayStatus: 'Rejected',
    });
    expect(await code(svc.recordReply(t.id, { status: 'accepted' }))).toBe('travel_rule.transition_refused');
    expect(await code(svc.operatorMark(FOUNDER, { transferId: t.id, to: 'started', reason: 'again' }))).toBe(
      'travel_rule.transition_refused',
    );
    expect(await code(svc.assertMayBroadcast(w))).toBe('travel_rule.not_accepted');
  });

  // ── operators and races ────────────────────────────────────────────────────

  it('an operator cannot approve, bypass or complete a transfer, and a refusal writes nothing', async () => {
    const { t } = await ready();
    for (const to of ['accepted', 'not_required', 'completed', 'pending', 'blocking_time_expired'] as const) {
      expect(await code(svc.operatorMark(FOUNDER, { transferId: t.id, to, reason: 'TEST' }))).toBe('travel_rule.operator_cannot_bypass');
    }
    expect(await rows('pay.travel_rule_transitions')).toBe('1');
    expect(await svc.operatorMark(FOUNDER, { transferId: t.id, to: 'canceled', reason: 'customer withdrew' })).toMatchObject({
      status: 'canceled',
      displayStatus: 'Canceled',
    });
    expect((await svc.get(t.id)).transitions.at(-1)).toMatchObject({ source: 'operator', actor: FOUNDER, reason: 'customer withdrew' });
  });

  it('a counterparty cannot set a status that is not an answer, and the same answer twice is one record', async () => {
    const { t } = await ready();
    expect(await code(svc.recordReply(t.id, { status: 'completed' as never }))).toBe('travel_rule.transition_refused');
    await svc.recordReply(t.id, { status: 'pending' });
    await svc.recordReply(t.id, { status: 'pending' });
    expect(await rows('pay.travel_rule_transitions')).toBe('2');
  });

  it('two conflicting replies at once leave exactly one answer', async () => {
    const { t } = await ready();
    const out = await Promise.allSettled([
      svc.recordReply(t.id, { status: 'accepted' }),
      svc.recordReply(t.id, { status: 'rejected' }),
      svc.recordReply(t.id, { status: 'accepted' }),
      svc.recordReply(t.id, { status: 'rejected' }),
    ]);
    expect(out.filter((o) => o.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await rows('pay.travel_rule_transitions')).toBe('2');
    const final = (await svc.get(t.id)).status;
    expect(['accepted', 'rejected']).toContain(final);
  });

  // ── reads ──────────────────────────────────────────────────────────────────

  it("the customer sees their own withdrawal's status and the fields still to give; another account sees nothing", async () => {
    const { w, t } = await ready();
    expect(await svc.statusForCustomer(USER, w)).toMatchObject({ displayStatus: 'Pending', fieldsToCollect: RULE.fields, blocker: null });
    await svc.attachMessage(FOUNDER, { transferId: t.id, originator: { name: 'Ada' }, beneficiary: {}, transfer: {} });
    expect(await svc.statusForCustomer(USER, w)).toMatchObject({
      status: 'repair',
      fieldsToCollect: ['beneficiary_name', 'self_or_third_party'],
    });
    expect(await code(svc.statusForCustomer(OTHER, w))).toBe('travel_rule.transfer_not_found');
    await svc.recordReply(t.id, { status: 'rejected' });
    expect(await svc.statusForCustomer(USER, w)).toMatchObject({ displayStatus: 'Rejected', fieldsToCollect: [] });
  });

  it('lists and filters transfers, and reads by withdrawal', async () => {
    const { w, t } = await ready();
    const w2 = await withdrawal('10');
    await svc.open(FOUNDER, openInput(w2));
    expect(await svc.list({ limit: 10 })).toHaveLength(2);
    expect((await svc.list({ limit: 10, status: 'not_required' })).map((x) => x.withdrawalId)).toEqual([w2]);
    expect((await svc.listByWithdrawal(w))[0]).toMatchObject({ id: t.id, messageVersions: 0 });
    expect(await svc.listByWithdrawal('44444444-4444-4444-8444-444444444444')).toEqual([]);
  });

  it('never edits or deletes a rule, a transfer, a transition or a message', async () => {
    const { t } = await ready();
    await svc.attachMessage(FOUNDER, { transferId: t.id, ...FULL });
    for (const stmt of [
      'UPDATE pay.travel_rule_rule_events SET reason = reason',
      'UPDATE pay.travel_rule_transfers SET amount = 1',
      'DELETE FROM pay.travel_rule_transitions',
      'DELETE FROM pay.travel_rule_messages',
      'UPDATE pay.travel_rule_wait_limit_events SET pending_seconds = 1',
    ]) {
      await expect(db.sql.unsafe(stmt)).rejects.toThrow(/not permitted/);
    }
  });
});
