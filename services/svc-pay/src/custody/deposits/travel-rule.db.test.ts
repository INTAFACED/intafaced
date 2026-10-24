import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { SESSION_SCOPES, type Principal } from '@intafaced/auth';
import { MemoryLedger, parseAmount, recipes, userAvailable } from '@intafaced/ledger-client';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NetworkState } from '../../registries/policy.js';
import { createMessageCipher, type MessageCipher } from '../../travel-rule/cipher.js';
import { createPayNamespaces } from '../../namespaces/index.js';
import { CustodyDepositBook } from './book.js';
import { createDepositTravelRuleCustomerRouter, type DepositTravelRuleBook, type DepositTravelRuleDeps } from './travel-rule.js';

/**
 * The inbound travel rule on customer deposits (W-deposit-07, J-wallet-03 #1-#3) against a real Postgres: every forward
 * migration, the real founder and customer routers, the real deposit record and the memory ledger. TEST figures only.
 */
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
    .withDatabase('intafaced_deposit_travel_rule_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const FOUNDER = 'founder-a';
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const ADDRESS = '0x00000000000000000000000000000000000000a1';
const TX = '0xabc0000000000000000000000000000000000000000000000000000000000001';
const KEY = `deposit:crypto-native:ethereum:${TX}:0`;
const NAME = 'TEST Originator Person';

type Err = { code: string; message?: string };
async function refused(p: Promise<unknown>): Promise<Err> {
  try {
    await p;
  } catch (e) {
    return e as Err;
  }
  throw new Error('expected the call to be refused');
}

const network = (): NetworkState =>
  ({
    networkId: 'ethereum',
    displayName: 'Ethereum',
    assetCodes: ['USDT'],
    confirmationsRequired: 12,
    enabled: true,
    feeEstimateSource: 'fixed',
    feeEstimateAmount: '1',
  }) as NetworkState;

const principalFor = (userId: string): Principal => ({
  userId,
  sub: userId,
  sid: randomUUID(),
  scopes: [...SESSION_SCOPES],
  mfa: true,
  tier: 'full',
  expiresAt: new Date(Date.now() + 3_600_000),
});

describe('deposit travel rule (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let ledger!: MemoryLedger;
  let failPost = false;
  let cipher: MessageCipher | null = null;
  const logs: string[] = [];

  const book = () =>
    new CustodyDepositBook({
      sql: db.sql,
      postDeposit: async (input) => {
        if (failPost) throw new Error('ledger timeout');
        const { networkId, txHash, outputIndex, ...rest } = input;
        return ledger.post(recipes.deposit({ ...rest, rail: 'crypto-native', railRef: `${networkId}:${txHash}:${outputIndex}` }));
      },
      registries: { listRoutableNetworks: async () => [network()] },
      log: (msg) => logs.push(msg),
    });
  // The routers read the cipher when they are called, so a test can unwire it.
  const travelDeps = (): DepositTravelRuleDeps => {
    const port: DepositTravelRuleBook = {
      releaseTravelRule: (id, record) => book().releaseTravelRule(id, record),
      markTravelRuleReason: (tx, id, state) => book().markTravelRuleReason(tx, id, state),
    };
    return {
      sql: db.sql,
      book: port,
      get cipher() {
        return cipher;
      },
    };
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let alice: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bob: any;
  const tr = () => api.founderAdmin.depositTravelRule;
  const seen = (over: Partial<Parameters<CustodyDepositBook['receive']>[0]> = {}) => ({
    address: ADDRESS,
    txHash: TX,
    outputIndex: 0,
    assetId: 'USDT',
    amount: parseAmount('2500'),
    confirmations: 12,
    ...over,
  });
  const balance = async () => (await ledger.balance(userAvailable(ALICE, 'USDT'))).amount;
  const posts = () => ledger.journal().filter((t) => t.reason === 'deposit.credited');
  const row = async () => (await db.sql`SELECT * FROM pay.custody_deposits`)[0]!;
  const record = async () => (await db.sql`SELECT * FROM pay.custody_deposit_travel_rule`)[0];
  const states = async () => (await db.sql`SELECT state FROM pay.custody_deposit_travel_rule_events ORDER BY seq`).map((r) => r.state);
  const setRule = (over: Record<string, unknown> = {}) =>
    tr().rules.set({
      assetId: 'USDT',
      applies: true,
      threshold: '1000',
      fields: ['originator_name', 'originator_address'],
      reason: 'TEST inbound rule',
      ...over,
    });
  const declaration = (over: Record<string, unknown> = {}) => ({
    depositId: '',
    walletType: 'exchange',
    fields: { originator_name: NAME, originator_address: '0x00000000000000000000000000000000000000b2' },
    ...over,
  });
  async function heldDeposit(): Promise<string> {
    await setRule();
    expect(await book().receive(seen())).toEqual({ state: 'recorded', status: 'held_travel_rule', reason: 'travel_rule_declaration' });
    return (await row()).id as string;
  }

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
    const ns = createPayNamespaces({ founderAuthority: async () => FOUNDER, depositTravelRule: travelDeps() });
    api = ns.createCaller({ principal: principalFor(randomUUID()), service: null, region: 'DE', requestId: 'r' });
    const customer = createDepositTravelRuleCustomerRouter(travelDeps());
    alice = customer.createCaller({ principal: principalFor(ALICE), service: null, region: 'DE', requestId: 'r' } as never);
    bob = customer.createCaller({ principal: principalFor(BOB), service: null, region: 'DE', requestId: 'r' } as never);
  }, 120_000);
  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);
  beforeEach(async () => {
    ledger = new MemoryLedger();
    failPost = false;
    cipher = createMessageCipher('test-key-1', randomBytes(32));
    logs.length = 0;
    await db.sql`TRUNCATE pay.custody_deposit_travel_rule_events, pay.custody_deposit_travel_rule, pay.travel_rule_inbound_rule_events, pay.travel_rule_wait_limit_events, pay.custody_deposits, pay.custody_deposit_settings, pay.custody_deposit_addresses, pay.custody_deposit_reorgs`;
    await db.sql`INSERT INTO pay.custody_deposit_addresses (user_id, asset_id, network_id, address) VALUES (${ALICE}, 'USDT', 'ethereum', ${ADDRESS})`;
    await db.sql`
      INSERT INTO pay.custody_deposit_settings (asset_id, network_id, label, minimum_deposit, estimated_arrival_minutes, set_by)
      VALUES ('USDT', 'ethereum', 'Ethereum', '10', 5, 'test-profile')`;
  }, 30_000);

  it('a blank rule credits nothing: confirming with travel_rule_unset, and credits once a rule is set', async () => {
    expect(await book().receive(seen())).toEqual({ state: 'recorded', status: 'confirming', reason: 'travel_rule_unset' });
    expect(await book().settleOpen()).toBe(0);
    expect(posts()).toHaveLength(0);
    await setRule({ applies: false, threshold: null, fields: [] });
    expect(await book().settleOpen()).toBe(1);
    expect(posts()).toHaveLength(1);
    expect(await balance()).toBe(parseAmount('2500'));
  });

  it('under the threshold credits as any other deposit and opens no record', async () => {
    await setRule();
    expect(await book().receive(seen({ amount: parseAmount('999.99') }))).toMatchObject({ status: 'credited' });
    expect(await record()).toBeUndefined();
    expect(posts()).toHaveLength(1);
  });

  it('at the threshold the deposit is held with a record, follows its confirmations and is never credited by a pass', async () => {
    await setRule();
    expect(await book().receive(seen({ amount: parseAmount('1000') }))).toEqual({
      state: 'recorded',
      status: 'held_travel_rule',
      reason: 'travel_rule_declaration',
    });
    expect(await record()).toMatchObject({ user_id: ALICE, required_fields: ['originator_name', 'originator_address'], declared_at: null });
    expect(await states()).toEqual(['awaiting_declaration']);
    await book().receive(seen({ amount: parseAmount('1000'), confirmations: 30 }));
    expect(await row()).toMatchObject({ status: 'held_travel_rule', confirmations: 30, credit_started_at: null });
    expect(await book().settleOpen()).toBe(0);
    expect(posts()).toHaveLength(0);
    expect(await balance()).toBe(0n);
    const listed = await book().records({ userId: ALICE, statuses: ['held_travel_rule'], offset: 0, limit: 10 });
    expect(listed.items).toMatchObject([{ status: 'held_travel_rule', reason: 'travel_rule_declaration', amount: '1000' }]);
  });

  it('the depositor reads its own record; another account reads not found', async () => {
    const id = await heldDeposit();
    expect(await alice.custodyDeposit.travelRule.get({ depositId: id })).toEqual({
      depositId: id,
      assetId: 'USDT',
      networkId: 'ethereum',
      amount: '2500',
      threshold: '1000',
      state: 'awaiting_declaration',
      requiredFields: ['originator_name', 'originator_address'],
      walletType: null,
      declaredAt: null,
      waitDeadline: null,
    });
    expect(await refused(bob.custodyDeposit.travelRule.get({ depositId: id }))).toMatchObject({ code: 'NOT_FOUND' });
    expect(await refused(bob.custodyDeposit.travelRule.declare(declaration({ depositId: id })))).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('a declaration missing an asked field, or with no key loaded, stores nothing', async () => {
    const id = await heldDeposit();
    const short = await refused(alice.custodyDeposit.travelRule.declare(declaration({ depositId: id, fields: { originator_name: NAME } })));
    expect(short).toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(short.message).toContain('travel_rule.fields_missing');
    cipher = null;
    const unwired = await refused(alice.custodyDeposit.travelRule.declare(declaration({ depositId: id })));
    expect(unwired).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(unwired.message).toContain('travel_rule.cipher_unwired');
    expect(await record()).toMatchObject({ declared_at: null, declaration_ciphertext: null });
    expect(await states()).toEqual(['awaiting_declaration']);
  });

  it('a declaration is sealed to the deposit, keeps only the asked fields, and moves it to under review', async () => {
    const id = await heldDeposit();
    const view = await alice.custodyDeposit.travelRule.declare(
      declaration({ depositId: id, fields: { ...declaration().fields, transfer_purpose: 'TEST savings' } }),
    );
    expect(view).toMatchObject({ state: 'under_review', walletType: 'exchange', declaredAt: expect.any(String) });
    expect(await row()).toMatchObject({ status: 'held_travel_rule', reason: 'travel_rule_review' });
    const stored = (await record())!;
    expect(Buffer.from(stored.declaration_ciphertext).toString('utf8')).not.toContain(NAME);
    const sealed = {
      keyId: stored.declaration_key_id,
      iv: stored.declaration_iv,
      authTag: stored.declaration_auth_tag,
      ciphertext: stored.declaration_ciphertext,
    };
    expect(JSON.parse(cipher!.open(sealed, `pay.deposit-travel-rule:${id}`).toString('utf8'))).toEqual({
      walletType: 'exchange',
      fields: declaration().fields,
    });
    expect(() => cipher!.open(sealed, `pay.deposit-travel-rule:${randomUUID()}`)).toThrow();
    // A repeat after it was taken answers the record as it stands and writes nothing.
    expect(await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }))).toMatchObject({ state: 'under_review' });
    expect(await states()).toEqual(['awaiting_declaration', 'under_review']);
    expect(posts()).toHaveLength(0);
  });

  it('a founder release of a declared deposit credits once under its usual key; a second release is refused', async () => {
    const id = await heldDeposit();
    const early = await refused(tr().release({ depositId: id, reason: 'TEST release' }));
    expect(early.message).toContain('travel_rule.deposit_state_refused');
    await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }));
    const done = await tr().release({ depositId: id, reason: 'TEST counterparty matched' });
    expect(done).toMatchObject({ credited: true, deposit: { state: 'released', lastActor: FOUNDER } });
    expect(await row()).toMatchObject({ status: 'credited', reason: null });
    expect(posts().map((t) => t.idempotencyKey)).toEqual([KEY]);
    expect(await balance()).toBe(parseAmount('2500'));
    expect(await refused(tr().release({ depositId: id, reason: 'TEST again' }))).toMatchObject({ code: 'CONFLICT' });
    await book().receive(seen({ confirmations: 40 }));
    await book().settleOpen();
    expect(posts()).toHaveLength(1);
  });

  it('before a declaration, neither a wait on the counterparty nor a release is taken', async () => {
    const id = await heldDeposit();
    await db.sql`INSERT INTO pay.travel_rule_wait_limit_events (pending_seconds, repair_seconds, set_by) VALUES (600, 600, 'test')`;
    expect(await refused(tr().markCounterpartyPending({ depositId: id, reason: 'TEST asked the sending exchange' }))).toMatchObject({
      code: 'CONFLICT',
    });
    expect(await refused(tr().release({ depositId: id, reason: 'TEST release' }))).toMatchObject({ code: 'CONFLICT' });
    expect(await row()).toMatchObject({ status: 'held_travel_rule', reason: 'travel_rule_declaration' });
    expect(await states()).toEqual(['awaiting_declaration']);
    // The depositor can still declare.
    expect(await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }))).toMatchObject({ state: 'under_review' });
    expect(posts()).toHaveLength(0);
  });

  it('two expiry passes at once record the expiry once', async () => {
    const id = await heldDeposit();
    await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }));
    await db.sql`INSERT INTO pay.travel_rule_wait_limit_events (pending_seconds, repair_seconds, set_by) VALUES (600, 600, 'test')`;
    await tr().markCounterpartyPending({ depositId: id, reason: 'TEST asked the sending exchange' });
    await db.sql`UPDATE pay.custody_deposit_travel_rule_events SET wait_deadline = now() - interval '1 second' WHERE state = 'counterparty_pending'`;
    const counts = await Promise.all([book().expireTravelRuleWaits(), book().expireTravelRuleWaits(), book().expireTravelRuleWaits()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await states()).toEqual(['awaiting_declaration', 'under_review', 'counterparty_pending', 'blocking_time_expired']);
  });

  it('the founder list puts held records before released ones', async () => {
    const id = await heldDeposit();
    await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }));
    await tr().release({ depositId: id, reason: 'TEST release' });
    await book().receive(seen({ txHash: TX.replace(/1$/, '2') }));
    const listed = await tr().list({ userId: ALICE, limit: 1 });
    expect(listed).toMatchObject([{ state: 'awaiting_declaration' }]);
  });

  it('a counterparty wait refuses with no wait limit; past its deadline it is expired and the deposit stays held', async () => {
    const id = await heldDeposit();
    await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }));
    const unset = await refused(tr().markCounterpartyPending({ depositId: id, reason: 'TEST asked the sending exchange' }));
    expect(unset.message).toContain('travel_rule.wait_limit_unset');
    await db.sql`INSERT INTO pay.travel_rule_wait_limit_events (pending_seconds, repair_seconds, set_by) VALUES (600, 600, 'test')`;
    const waiting = await tr().markCounterpartyPending({ depositId: id, reason: 'TEST asked the sending exchange' });
    expect(waiting).toMatchObject({ state: 'counterparty_pending', waitDeadline: expect.any(String) });
    expect(await alice.custodyDeposit.travelRule.get({ depositId: id })).toMatchObject({ state: 'counterparty_pending' });
    expect(await book().expireTravelRuleWaits()).toBe(0);
    await db.sql`UPDATE pay.custody_deposit_travel_rule_events SET wait_deadline = now() - interval '1 second' WHERE state = 'counterparty_pending'`;
    expect(await book().expireTravelRuleWaits()).toBe(1);
    expect(await states()).toEqual(['awaiting_declaration', 'under_review', 'counterparty_pending', 'blocking_time_expired']);
    expect(await row()).toMatchObject({ status: 'held_travel_rule', reason: 'travel_rule_expired', credit_started_at: null });
    expect(await book().expireTravelRuleWaits()).toBe(0);
    expect(await book().settleOpen()).toBe(0);
    expect(await states()).toHaveLength(4);
    expect(posts()).toHaveLength(0);
    // Only a person releases it.
    expect(await tr().release({ depositId: id, reason: 'TEST reviewed after the wait' })).toMatchObject({ credited: true });
    expect(posts()).toHaveLength(1);
  });

  it('a ledger timeout on release keeps the credit started; the next pass credits once under the same key', async () => {
    const id = await heldDeposit();
    await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }));
    failPost = true;
    expect(await tr().release({ depositId: id, reason: 'TEST release' })).toMatchObject({
      credited: false,
      deposit: { state: 'released' },
    });
    expect(await row()).toMatchObject({ status: 'confirming', credit_started_at: expect.any(Date) });
    failPost = false;
    expect(await book().settleOpen()).toBe(1);
    expect(posts().map((t) => t.idempotencyKey)).toEqual([KEY]);
  });

  it('a release that crashed before its credit is credited by the next pass, once', async () => {
    const id = await heldDeposit();
    await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }));
    // The release committed and the process stopped before the credit: the row is back to be judged with a released record.
    await db.sql.begin(async (tx) => {
      await tx`INSERT INTO pay.custody_deposit_travel_rule_events (deposit_id, state, source, actor, reason) VALUES (${id}, 'released', 'operator', ${FOUNDER}, 'TEST')`;
      await tx`UPDATE pay.custody_deposits SET status = 'confirming', reason = NULL WHERE id = ${id}`;
    });
    expect(await book().settleOpen()).toBe(1);
    expect(await book().settleOpen()).toBe(0);
    expect(posts()).toHaveLength(1);
  });

  it('a held deposit the chain takes back is closed reversed; the record then refuses a declaration and a release', async () => {
    const id = await heldDeposit();
    expect(await book().reverse({ address: ADDRESS, txHash: TX, outputIndex: 0 })).toMatchObject({ status: 'reversed' });
    const declare = await refused(alice.custodyDeposit.travelRule.declare(declaration({ depositId: id })));
    expect(declare).toMatchObject({ code: 'CONFLICT' });
    await db.sql`UPDATE pay.custody_deposit_travel_rule SET wallet_type = 'exchange', declaration_key_id = 'k', declaration_iv = '\\x00', declaration_auth_tag = '\\x00', declaration_ciphertext = '\\x00', declared_at = now()`;
    await db.sql`INSERT INTO pay.custody_deposit_travel_rule_events (deposit_id, state, source, actor) VALUES (${id}, 'under_review', 'customer', ${ALICE})`;
    expect(await refused(tr().release({ depositId: id, reason: 'TEST release' }))).toMatchObject({ code: 'CONFLICT' });
    expect(posts()).toHaveLength(0);
  });

  it('owner rules: one founder sets them, the latest per asset is the rule, and a rule that applies needs a positive threshold', async () => {
    expect(await tr().rules.list({})).toEqual([]);
    await setRule({ threshold: '5000' });
    await setRule({ threshold: '1000' });
    await setRule({ assetId: 'USDC', applies: false, threshold: null, fields: [] });
    expect(await tr().rules.list({})).toMatchObject([
      { assetId: 'USDC', applies: false, threshold: null, setBy: FOUNDER },
      { assetId: 'USDT', applies: true, threshold: '1000', fields: ['originator_name', 'originator_address'] },
    ]);
    expect(await refused(setRule({ threshold: null }))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await refused(setRule({ threshold: '0' }))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await refused(setRule({ applies: false, threshold: '10' }))).toMatchObject({ code: 'BAD_REQUEST' });
    expect(await refused(setRule({ fields: ['originator_name', 'originator_name'] }))).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('the founder list carries no declared value', async () => {
    const id = await heldDeposit();
    await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }));
    const listed = await tr().list({ userId: ALICE });
    expect(listed).toMatchObject([{ depositId: id, state: 'under_review', walletType: 'exchange', amount: '2500' }]);
    expect(JSON.stringify(listed)).not.toContain(NAME);
  });

  it('the invariant: a credited deposit with a record has exactly one released event and one deposit post', async () => {
    const id = await heldDeposit();
    await alice.custodyDeposit.travelRule.declare(declaration({ depositId: id }));
    await Promise.allSettled([
      tr().release({ depositId: id, reason: 'TEST one' }),
      tr().release({ depositId: id, reason: 'TEST two' }),
      book().settleOpen(),
    ]);
    const broken = await db.sql`
      SELECT d.id FROM pay.custody_deposits d JOIN pay.custody_deposit_travel_rule t ON t.deposit_id = d.id
       WHERE d.credited_at IS NOT NULL
         AND (SELECT count(*) FROM pay.custody_deposit_travel_rule_events e WHERE e.deposit_id = d.id AND e.state = 'released') <> 1`;
    expect(broken).toHaveLength(0);
    expect(posts()).toHaveLength(1);
    expect(await row()).toMatchObject({ status: 'credited' });
  });
});
