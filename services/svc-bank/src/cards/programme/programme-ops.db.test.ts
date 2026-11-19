/**
 * J-bank-26 (BK-cops-01 to -03, -06 to -08): the card programme desk over real rows. A shadow rule counts what it would
 * have declined over past TEST authorisations and decides nothing; promoted it declines new authorisations only, and a
 * roll back puts the version before it back with past decisions unchanged. Each decision keeps its trace; an online
 * payment within the SCA exemption skips the challenge and says why. The KYC and KYB gate refuses and queues a business
 * with no beneficial owner; screening refuses with no list and queues a match. A viewer changes nothing, and the audit
 * log cannot be edited. A bulk file with a bad row issues nothing; the same good file twice makes its cards once. A card
 * with an open hold is not reassigned. The simulator refuses outside a test stack. The export is signed over its text.
 *
 * PG-hard: a missing database fails the suite. CI uses TEST_DATABASE_URL; without it, Testcontainers `postgres:16-alpine`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CardService } from '../card-service.js';
import { cardSim } from '../issuer.js';
import { BankError } from '../../errors.js';
import { memoryRecipientState } from '../../recipient-state.js';
import type { BusinessDirectoryPort } from '../../business/business-directory.js';
import { CardProgrammeOps, uuidFromKey } from './programme-ops.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (error) {
    if (error instanceof BankError) return error.code;
    throw error;
  }
  throw new Error('expected a refusal');
};

const OPERATOR = randomUUID();
const SECRET = 'test-secret-for-card-programme-exports';

describe('card programme desk (J-bank-26, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let cards: CardService;
  let accounts: Map<string, string>;
  let identity: ReturnType<typeof memoryRecipientState>;
  let tiers: Record<string, 'none' | 'basic' | 'full' | 'institutional'>;
  let sanctions: string | undefined;
  let simulatorAllowed: boolean;

  const directory: BusinessDirectoryPort = {
    handlesOf: async () => new Map(),
    publishedNames: async () => new Map(),
    findActive: async (q) => {
      const userId = 'email' in q ? accounts.get(q.email) : undefined;
      return userId ? { userId, handle: 'h' } : null;
    },
  };
  const ops = () =>
    new CardProgrammeOps(sql, { cards, directory, identity, sanctions: () => sanctions, simulatorAllowed, exportSecret: SECRET });

  beforeAll(async () => {
    const admin = await openAdmin();
    stop = admin.stop;
    db = await createTestDatabase({ service: 'bank', url: admin.url, migrations });
    sql = db.sql;
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
    await stop();
  }, 60_000);

  beforeEach(async () => {
    ledger = new MemoryLedger();
    cards = new CardService(sql, ledger, { issuer: cardSim() });
    accounts = new Map();
    tiers = {};
    identity = memoryRecipientState({}, { tiers });
    sanctions = 'LOCAL TEST Sanctioned Cardholder';
    simulatorAllowed = true;
    await sql`TRUNCATE bank.card_reassignments, bank.card_bulk_cards, bank.card_bulk_batches, bank.card_cardholders,
      bank.card_programme_staff, bank.card_programme_audit, bank.card_programme_rules, bank.card_programme_settings, bank.card_authorization_traces,
      bank.card_settlements, bank.card_conversions, bank.card_cashback, bank.card_authorizations, bank.cards CASCADE`;
  });

  /** A verified person with a funded USDT balance and an app account the directory finds by email. */
  async function person(tier: 'basic' | 'full' = 'full') {
    const userId = randomUUID();
    const email = `p-${userId.slice(0, 8)}@example.test`;
    accounts.set(email, userId);
    tiers[userId] = tier;
    await ledger.post(recipes.deposit({ userId, assetId: 'USDT', amount: amt('1000'), rail: 'test', railRef: `fund:${userId}` }));
    return { userId, email };
  }
  async function cardFor(userId: string) {
    return cards.issue({ cardId: randomUUID(), userId, assetId: 'USDT', perAuthorizationLimit: amt('500') });
  }

  it('a shadow rule counts what it would decline over past TEST authorisations, decides nothing, and declines only new ones once promoted; roll back restores the version before', async () => {
    const p = await person();
    const card = await cardFor(p.userId);
    for (let i = 0; i < 10; i++) {
      await cards.authorize({
        cardId: card.id,
        authorizationRef: `past-${i}`,
        amount: amt('1'),
        merchantCategory: i < 3 ? 'gambling' : 'groceries',
      });
    }
    const shadow = await ops().createRule(OPERATOR, {
      ruleKey: 'no-gambling',
      name: 'No gambling',
      params: { kind: 'merchant_category', category: 'gambling' },
    });
    expect(shadow).toMatchObject({ state: 'shadow', version: 1, shadow: { evaluated: 10, wouldDecline: 3 } });
    // In shadow it decides nothing.
    expect(
      (await cards.authorize({ cardId: card.id, authorizationRef: 'during-shadow', amount: amt('1'), merchantCategory: 'gambling' }))
        .decision,
    ).toBe('approved');
    await ops().promoteRule(OPERATOR, shadow.id);
    const declined = await cards.authorize({
      cardId: card.id,
      authorizationRef: 'after-promote',
      amount: amt('1'),
      merchantCategory: 'gambling',
    });
    expect(declined).toMatchObject({ decision: 'declined', declineCode: 'bank.card_rule_declined' });
    const detail = await ops().authorization(declined.id);
    expect(detail.trace?.find((s) => s.check === 'Programme rules')).toMatchObject({
      result: 'decline',
      detail: 'Declined by rule “No gambling” version 1: it declines merchant category gambling.',
    });
    // Past decisions are unchanged: the shadow-time approval is still approved.
    const [past] = await sql<
      Array<{ decision: string }>
    >`SELECT decision FROM bank.card_authorizations WHERE authorization_ref = 'during-shadow'`;
    expect(past!.decision).toBe('approved');

    // Version 2 (a stricter amount rule under the same key) replaces version 1; rolling back puts version 1 back.
    const v2 = await ops().createRule(OPERATOR, {
      ruleKey: 'no-gambling',
      name: 'No gambling v2',
      params: { kind: 'amount_above', assetId: 'USDT', amount: '0.5' },
    });
    await ops().promoteRule(OPERATOR, v2.id);
    expect(
      (await cards.authorize({ cardId: card.id, authorizationRef: 'v2', amount: amt('1'), merchantCategory: 'groceries' })).declineCode,
    ).toBe('bank.card_rule_declined');
    const rolled = await ops().rollbackRule(OPERATOR, 'no-gambling');
    expect(rolled.find((r) => r.version === 1)!.state).toBe('active');
    expect(rolled.find((r) => r.version === 2)!.state).toBe('retired');
    expect(
      (await cards.authorize({ cardId: card.id, authorizationRef: 'after-rollback', amount: amt('1'), merchantCategory: 'groceries' }))
        .decision,
    ).toBe('approved');
    expect(await code(ops().promoteRule(OPERATOR, v2.id))).toBe('bank.card_rule_state');
    await ops().rollbackRule(OPERATOR, 'no-gambling');
    expect(await code(ops().rollbackRule(OPERATOR, 'no-gambling'))).toBe('bank.card_rule_state');
  });

  it('3DS: an online payment of 25.00 under an exemption limit of 30.00 skips the challenge and the trace says why; above it, no challenge passed declines', async () => {
    const p = await person();
    const card = await cardFor(p.userId);
    await ops().configure(OPERATOR, 'threeds', { mode: 'challenge_all', lowValueExemption: { assetId: 'USDT', limit: '30.00' } });
    const exempt = await cards.authorize({ cardId: card.id, authorizationRef: 'online-25', amount: amt('25.00'), channel: 'online' });
    expect(exempt.decision).toBe('approved');
    const trace = (await ops().authorization(exempt.id)).trace!;
    expect(trace.find((s) => s.check === '3DS policy')).toEqual({
      check: '3DS policy',
      result: 'skip',
      detail: 'SCA low-value exemption: 25 USDT is under the exemption limit of 30.00 USDT, so the challenge was skipped.',
    });
    expect(await ops().exemptionCount()).toBe(1);
    const high = await cards.authorize({ cardId: card.id, authorizationRef: 'online-40', amount: amt('40'), channel: 'online' });
    expect(high).toMatchObject({ decision: 'declined', declineCode: 'bank.card_3ds_required' });
    const passed = await cards.authorize({
      cardId: card.id,
      authorizationRef: 'online-40b',
      amount: amt('40'),
      channel: 'online',
      threeDs: 'authenticated',
    });
    expect(passed.decision).toBe('approved');
    // Card-present payments are not asked; clearing the policy asks no challenge again.
    expect((await cards.authorize({ cardId: card.id, authorizationRef: 'shop-40', amount: amt('40') })).decision).toBe('approved');
    await ops().clearThreeDs(OPERATOR);
    expect(
      (await cards.authorize({ cardId: card.id, authorizationRef: 'online-40c', amount: amt('40'), channel: 'online' })).decision,
    ).toBe('approved');
  });

  it('lifecycle and capture variance: a 25 hold captured at 20 shows 20 captured, 5 given back and a variance of -5', async () => {
    const p = await person();
    const card = await cardFor(p.userId);
    const a = await cards.authorize({ cardId: card.id, authorizationRef: 'cap', amount: amt('25') });
    await cards.capture({ cardId: card.id, authorizationRef: 'cap', amount: amt('20') });
    const d = await ops().authorization(a.id);
    expect(d.variance).toEqual({ authorised: '25', captured: '20', returned: '5', stillHeld: '0', captureVariance: '-5' });
    expect(d.lifecycle.map((e) => e.event)).toEqual(['authorised', 'captured', 'given back']);
    expect(d.trace!.at(-1)).toMatchObject({ check: 'Hold', result: 'pass' });
    expect(await code(ops().authorization(randomUUID()))).toBe('bank.ops_authorization_not_found');
  });

  it('the KYC and KYB gate: a business with no beneficial owner refuses bank.cardholder_unverified and lands in the review queue; screening with no list refuses and stores nothing', async () => {
    const biz = ops().createCardholder(OPERATOR, { requestKey: 'biz-no-owner-1', kind: 'business', name: 'TEST Shop Ltd', country: 'NL' });
    expect(await code(biz)).toBe('bank.cardholder_unverified');
    const queue = await ops().reviewQueue();
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ name: 'TEST Shop Ltd', status: 'review', gapCode: 'bank.cardholder_unverified' });
    expect(queue[0]!.gap).toContain('No beneficial owner on file');
    // The same key replays the same refusal; other details under it conflict.
    expect(
      await code(
        ops().createCardholder(OPERATOR, { requestKey: 'biz-no-owner-1', kind: 'business', name: 'TEST Shop Ltd', country: 'NL' }),
      ),
    ).toBe('bank.cardholder_unverified');
    expect(
      await code(ops().createCardholder(OPERATOR, { requestKey: 'biz-no-owner-1', kind: 'business', name: 'Other', country: 'NL' })),
    ).toBe('bank.cardholder_conflict');
    // With a verified owner the business passes.
    const owner = await person();
    const ok = await ops().createCardholder(OPERATOR, {
      requestKey: 'biz-owner-1',
      kind: 'business',
      name: 'TEST Owned Ltd',
      country: 'NL',
      beneficialOwners: [{ name: 'TEST Owner', email: owner.email }],
    });
    expect(ok.status).toBe('verified');
    // An individual below the full level is unverified; a name on the list is under review.
    const low = await person('basic');
    expect(
      await code(
        ops().createCardholder(OPERATOR, { requestKey: 'low-tier-1', kind: 'individual', name: 'Low', email: low.email, country: 'NL' }),
      ),
    ).toBe('bank.cardholder_unverified');
    const listed = await person();
    expect(
      await code(
        ops().createCardholder(OPERATOR, {
          requestKey: 'listed-1',
          kind: 'individual',
          name: 'local test sanctioned  cardholder',
          email: listed.email,
          country: 'NL',
        }),
      ),
    ).toBe('bank.cardholder_under_review');
    sanctions = '';
    expect(
      await code(
        ops().createCardholder(OPERATOR, { requestKey: 'no-list-1', kind: 'individual', name: 'N', email: listed.email, country: 'NL' }),
      ),
    ).toBe('bank.cardholder_screening_unset');
    const [n] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.card_cardholders WHERE request_key = 'no-list-1'`;
    expect(n!.n).toBe(0);
    // Directory search by a card's last four digits.
    sanctions = 'LOCAL TEST Sanctioned Cardholder';
    const holder = await person();
    const ch = await ops().createCardholder(OPERATOR, {
      requestKey: 'search-1',
      kind: 'individual',
      name: 'TEST Searcher',
      email: holder.email,
      country: 'NL',
    });
    const card = await cardFor(holder.userId);
    const found = await ops().cardholders(card.panTail);
    expect(found.map((h) => h.id)).toContain(ch.id);
  });

  it('a viewer reads and changes nothing; every change is in the audit log, which cannot be edited', async () => {
    const viewer = await person();
    await ops().assignStaff(OPERATOR, { email: viewer.email, role: 'viewer' });
    expect(await code(ops().configure(viewer.userId, 'bin', { bin: '400000', network: 'TEST network', range: 'shared' }))).toBe(
      'bank.card_programme_viewer',
    );
    expect(await code(ops().createRule(viewer.userId, { ruleKey: 'x-rule', name: 'X', params: { kind: 'channel', channel: 'atm' } }))).toBe(
      'bank.card_programme_viewer',
    );
    expect(
      await code(
        ops().assignStaff(OPERATOR, {
          email: [...accounts.keys()].find((e) => accounts.get(e) === OPERATOR) ?? 'none@x.test',
          role: 'viewer',
        }),
      ),
    ).toBe('bank.card_programme_invalid');
    await ops().configure(OPERATOR, 'bin', { bin: '400000', network: 'TEST network', range: 'shared' });
    await ops().configure(OPERATOR, 'bin', { bin: '400001', network: 'TEST network', range: 'dedicated' });
    const log = await ops().auditLog();
    expect(log[0]).toMatchObject({ actor: OPERATOR, action: 'setting.bin', target: 'bin' });
    expect(JSON.parse(log[0]!.before!)).toMatchObject({ bin: '400000' });
    expect(JSON.parse(log[0]!.after!)).toMatchObject({ bin: '400001' });
    expect(log.some((e) => e.action === 'staff.assign')).toBe(true);
    await expect(sql`UPDATE bank.card_programme_audit SET actor = 'someone else'`).rejects.toThrow(/written once/);
    await expect(sql`DELETE FROM bank.card_programme_audit`).rejects.toThrow(/written once/);
  });

  it('bulk issue: a file of 5 rows with one bad lists the bad row and issues nothing; the 4 good rows issued twice make 4 cards once', async () => {
    const a = await person();
    const b = await person();
    const ha = await ops().createCardholder(OPERATOR, {
      requestKey: 'bulk-holder-a',
      kind: 'individual',
      name: 'A',
      email: a.email,
      country: 'NL',
    });
    const hb = await ops().createCardholder(OPERATOR, {
      requestKey: 'bulk-holder-b',
      kind: 'individual',
      name: 'B',
      email: b.email,
      country: 'NL',
    });
    const good = [`${ha.id},USDT,50`, `${ha.id},USDT,60`, `${hb.id},USDT,50`, `${hb.id},USDT,60`];
    const bad = ['cardholder_id,asset,per_authorisation_limit', ...good.slice(0, 2), `${randomUUID()},USDT,50`, ...good.slice(2)].join(
      '\n',
    );
    const checked = await ops().validateBulk(bad);
    expect(checked.ok).toBe(false);
    expect(checked.rows.filter((r) => r.error).map((r) => r.row)).toEqual([3]);
    expect(await code(ops().issueBulk(OPERATOR, bad))).toBe('bank.card_bulk_invalid');
    const [none] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.cards`;
    expect(none!.n).toBe(0);
    const file = good.join('\n');
    const first = await ops().issueBulk(OPERATOR, file);
    const second = await ops().issueBulk(OPERATOR, file);
    expect(first.cards).toHaveLength(4);
    expect(second.cards.map((c) => c.cardId)).toEqual(first.cards.map((c) => c.cardId));
    expect(second.cardsInBatch).toBe(4);
    const [count] = await sql<Array<{ n: number }>>`SELECT count(*)::int AS n FROM bank.cards`;
    expect(count!.n).toBe(4);
    expect(first.cards[0]!.cardId).toBe(uuidFromKey(`card-bulk:${first.batchId}:1`));
    expect(first.batchId).toBe(
      createHash('sha256')
        .update(good.map((l) => l.toLowerCase().replace('usdt', 'USDT')).join('\n'))
        .digest('hex'),
    );
  });

  it('reassign moves a card with no open hold to a verified cardholder, and refuses one with an open hold; nothing posts', async () => {
    const a = await person();
    const b = await person();
    const hb = await ops().createCardholder(OPERATOR, {
      requestKey: 'reassign-holder-b',
      kind: 'individual',
      name: 'B',
      email: b.email,
      country: 'NL',
    });
    const card = await cardFor(a.userId);
    await cards.authorize({ cardId: card.id, authorizationRef: 'open-hold', amount: amt('5') });
    expect(await code(ops().reassign(OPERATOR, { cardId: card.id, toCardholderId: hb.id }))).toBe('bank.card_reassign_open_hold');
    await cards.reverse({ cardId: card.id, authorizationRef: 'open-hold' });
    const posted = ledger.journal().length;
    const moved = await ops().reassign(OPERATOR, { cardId: card.id, toCardholderId: hb.id });
    expect(moved.cardholderId).toBe(hb.id);
    expect((await cards.card(card.id)).userId).toBe(b.userId);
    expect(ledger.journal().length).toBe(posted);
  });

  it('the simulator is labelled TEST, runs on a test stack only, and drives the real authorise and capture path', async () => {
    const p = await person();
    const card = await cardFor(p.userId);
    const auth = await ops().simulate(OPERATOR, { kind: 'authorize', cardId: card.id, authorizationRef: 'sim-1', amount: '12' });
    expect(auth).toMatchObject({ test: true, kind: 'authorize', decision: 'approved' });
    expect(await ops().simulate(OPERATOR, { kind: 'capture', cardId: card.id, authorizationRef: 'sim-1', amount: '10' })).toMatchObject({
      test: true,
      captured: '10',
      returned: '2',
    });
    // Each TEST event is kept in the audit table, and left out of the desk's audit list (the decision log lists it).
    expect((await sql`SELECT count(*)::int AS n FROM bank.card_programme_audit WHERE action LIKE 'simulator.%'`)[0]!.n).toBe(2);
    expect((await ops().auditLog()).some((e) => e.action.startsWith('simulator.'))).toBe(false);
    simulatorAllowed = false;
    expect(await code(ops().simulate(OPERATOR, { kind: 'authorize', cardId: card.id, authorizationRef: 'sim-2', amount: '1' }))).toBe(
      'bank.card_sim_not_live',
    );
  });

  it('the export is signed over its text, carries its freshness time and its totals equal the report', async () => {
    const p = await person();
    const card = await cardFor(p.userId);
    await cards.authorize({ cardId: card.id, authorizationRef: 'r1', amount: amt('3') });
    await cards.authorize({ cardId: card.id, authorizationRef: 'r2', amount: amt('900') });
    const report = await ops().report();
    expect(report.totals).toEqual({ approved: 1, declined: 1 });
    const file = await ops().exportReport(OPERATOR);
    expect(file.sha256).toBe(createHash('sha256').update(file.text).digest('hex'));
    expect(file.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(file.text).toContain(`As of (UTC): ${file.asOf}`);
    expect(file.text).toContain('USDT,1,3,1');
    expect(file.text).toContain('total,1,,1');
  });

  it('the checklist names the simulated issuer as rail.card and offers no go-live step', async () => {
    const list = await ops().checklist();
    expect(list.find((i) => i.id === 'issuer')).toMatchObject({ done: false });
    expect(list.find((i) => i.id === 'issuer')!.blocker).toContain('rail.card');
    expect(list.map((i) => i.id)).not.toContain('go_live');
  });
});
