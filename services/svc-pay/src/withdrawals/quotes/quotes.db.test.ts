import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WithdrawalQuoteError, type WithdrawalQuoteErrorCode } from './errors.js';
import { WithdrawalQuoteService } from './service.js';

/** Withdrawal fee quotes against a real Postgres. TEST figures only. */
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
    .withDatabase('intafaced_withdrawal_quotes_test')
    .withUsername('intafaced')
    .withPassword('intafaced')
    .start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const FOUNDER = 'founder-a';
const T0 = new Date('2026-10-20T10:00:00.000Z');
const MINUTE = 60_000;

async function code(p: Promise<unknown>): Promise<WithdrawalQuoteErrorCode> {
  try {
    await p;
  } catch (e) {
    if (e instanceof WithdrawalQuoteError) return e.code;
    throw e;
  }
  throw new Error('expected the call to be refused');
}

describe('withdrawal quotes (real Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db!: TestDatabase;
  let clock = T0;
  let quotes: WithdrawalQuoteService;

  beforeAll(async () => {
    const admin = await openAdmin();
    adminStop = admin.stop;
    db = await createTestDatabase({ service: 'pay', url: admin.url, migrations });
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  const rows = async (table: string): Promise<string | undefined> => {
    const [row] = await db.sql.unsafe<Array<{ n: string }>>(`SELECT count(*)::text AS n FROM ${table}`);
    return row?.n;
  };

  /** A registered network. `fee` null is a blank fee; `source` is the registry's fee source. */
  async function network(
    id: string,
    o: { fee?: string | null; source?: string | null; enabled?: boolean; assets?: string[] } = {},
  ): Promise<void> {
    const source = o.source === undefined ? (o.fee === null ? null : 'fixed') : o.source;
    const fee = o.fee === undefined ? '2.5' : o.fee;
    await db.sql`
      INSERT INTO pay.network_registry (network_id, display_name, asset_codes, enabled, fee_estimate_source, fee_estimate_amount, updated_by)
      VALUES (${id}, ${id}, ${db.sql.json(o.assets ?? ['USDT'])}, ${o.enabled ?? true}, ${source}, ${fee}, ${FOUNDER})
      ON CONFLICT (network_id) DO UPDATE SET asset_codes = EXCLUDED.asset_codes, enabled = EXCLUDED.enabled,
        fee_estimate_source = EXCLUDED.fee_estimate_source, fee_estimate_amount = EXCLUDED.fee_estimate_amount`;
  }

  /** The owner's rules for an asset on a network (W-withdraw-02). The default fits every amount these tests quote. */
  async function rules(
    o: { minimum?: string; maximum?: string; step?: string; assetId?: string; networkId?: string; tag?: 'none' | 'required' } = {},
  ) {
    await db.sql`
      INSERT INTO pay.withdrawal_network_rules (asset_id, network_id, minimum, maximum, step, tag, set_by)
      VALUES (${o.assetId ?? 'USDT'}, ${o.networkId ?? 'tron-test'}, ${o.minimum ?? '0.000000000000000001'},
              ${o.maximum ?? '1000000000'}, ${o.step ?? '0.000000000000000001'}, ${o.tag ?? 'none'}, ${FOUNDER})
      ON CONFLICT (asset_id, network_id) DO UPDATE SET minimum = EXCLUDED.minimum, maximum = EXCLUDED.maximum, step = EXCLUDED.step,
        tag = EXCLUDED.tag`;
  }

  beforeEach(async () => {
    // Append-only tables refuse DELETE; TRUNCATE is the test reset.
    await db.sql`TRUNCATE pay.withdrawal_quotes, pay.withdrawal_quote_acceptances, pay.withdrawal_quote_policy_events RESTART IDENTITY CASCADE`;
    await db.sql`TRUNCATE pay.withdrawal_network_rules`;
    clock = T0;
    quotes = new WithdrawalQuoteService({ sql: db.sql, now: () => clock });
    await network('tron-test', { fee: '2.5' });
    await rules();
  });

  it('refuses an amount outside the network rules, and a pair with no rules, storing nothing', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 300 });
    await rules({ minimum: '10', maximum: '1000', step: '0.5' });
    expect(await code(quotes.quote(USER, ask('q1', '9.5')))).toBe('withdrawal_quote.below_minimum');
    expect(await code(quotes.quote(USER, ask('q2', '1000.5')))).toBe('withdrawal_quote.above_maximum');
    expect(await code(quotes.quote(USER, ask('q3', '10.25')))).toBe('withdrawal_quote.off_step');
    expect(await rows('pay.withdrawal_quotes')).toBe('0');
    // The edges are inside: the minimum, the maximum and a whole number of steps.
    expect(await quotes.quote(USER, ask('q4', '10'))).toMatchObject({ amount: '10' });
    expect(await quotes.quote(USER, ask('q5', '1000'))).toMatchObject({ amount: '1000' });
    expect(await quotes.quote(USER, ask('q6', '10.5'))).toMatchObject({ amount: '10.5' });
    await db.sql`TRUNCATE pay.withdrawal_network_rules`;
    await expect(quotes.quote(USER, ask('q7', '10'))).rejects.toMatchObject({ code: 'withdrawal_network_rules.unset' });
    expect(await rows('pay.withdrawal_quotes')).toBe('3');
  });

  it('refuses a quote on a network that needs a tag or memo, storing nothing (J-wallet-05 #1)', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 300 });
    await rules({ tag: 'required' });
    await expect(quotes.quote(USER, ask('q1', '10'))).rejects.toMatchObject({
      code: 'withdrawal_quote.tag_required',
      message: expect.stringContaining('tron-test needs a tag or memo'),
    });
    expect(await rows('pay.withdrawal_quotes')).toBe('0');
    // The same pair with no tag rule quotes as before.
    await rules({ tag: 'none' });
    expect(await quotes.quote(USER, ask('q1', '10'))).toMatchObject({ amount: '10' });
  });

  const ask = (quoteRef: string, amount = '100', extra: Partial<{ assetId: string; networkId: string }> = {}) => ({
    quoteRef,
    assetId: 'USDT',
    networkId: 'tron-test',
    amount,
    ...extra,
  });

  it('refuses until the owner sets the fee mode and lifetime, and never defaults either', async () => {
    expect(await quotes.policy()).toEqual({ feeMode: null, ttlSeconds: null, setBy: null, setAt: null });
    expect(await code(quotes.quote(USER, ask('q1')))).toBe('withdrawal_quote.policy_unset');
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 60 });
    await quotes.setPolicy(FOUNDER, { feeMode: 'deducted', ttlSeconds: 120 });
    expect(await quotes.policy()).toMatchObject({ feeMode: 'deducted', ttlSeconds: 120, setBy: FOUNDER });
  });

  it('fee on top: the debit is amount plus fee and the destination gets the amount', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 300 });
    const q = await quotes.quote(USER, ask('q1', '100'));
    expect(q).toMatchObject({
      feeMode: 'on_top',
      fees: [{ kind: 'network', amount: '2.5' }],
      feeTotal: '2.5',
      netAmount: '100',
      totalDebit: '102.5',
      feeSource: 'fixed',
      expired: false,
      acceptedBy: null,
      expiresAt: '2026-10-20T10:05:00.000Z',
    });
  });

  it('fee deducted: the debit is the amount and the destination gets amount less fee', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'deducted', ttlSeconds: 300 });
    expect(await quotes.quote(USER, ask('q1', '100'))).toMatchObject({ netAmount: '97.5', totalDebit: '100', feeTotal: '2.5' });
  });

  it('keeps exact decimals to the 18th place', async () => {
    await network('tron-test', { fee: '0.000000000000000001' });
    await quotes.setPolicy(FOUNDER, { feeMode: 'deducted', ttlSeconds: 300 });
    expect(await quotes.quote(USER, ask('q1', '0.1'))).toMatchObject({
      feeTotal: '0.000000000000000001',
      netAmount: '0.099999999999999999',
      totalDebit: '0.1',
    });
  });

  it('a blank fee refuses pay.fee_unset; a stated zero fee is a real fee', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 300 });
    await network('tron-test', { fee: null });
    expect(await code(quotes.quote(USER, ask('q1')))).toBe('pay.fee_unset');
    await network('tron-test', { fee: '0' });
    expect(await quotes.quote(USER, ask('q2'))).toMatchObject({ feeTotal: '0', netAmount: '100', totalDebit: '100' });
  });

  it('a fee source that is not connected here refuses and never invents a figure', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 300 });
    await network('tron-test', { source: 'chain_estimate', fee: null });
    expect(await code(quotes.quote(USER, ask('q1')))).toBe('withdrawal_quote.fee_source_unwired');
    await network('tron-test', { source: 'venue_quote', fee: null });
    expect(await code(quotes.quote(USER, ask('q2')))).toBe('withdrawal_quote.fee_source_unwired');
    expect(await rows('pay.withdrawal_quotes')).toBe('0');
  });

  it('a deducted fee that leaves nothing refuses; one cent of net is enough', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'deducted', ttlSeconds: 300 });
    expect(await code(quotes.quote(USER, ask('q1', '2.5')))).toBe('withdrawal_quote.fee_exceeds_amount');
    expect(await code(quotes.quote(USER, ask('q2', '2')))).toBe('withdrawal_quote.fee_exceeds_amount');
    expect(await quotes.quote(USER, ask('q3', '2.51'))).toMatchObject({ netAmount: '0.01' });
    expect(await code(quotes.quote(USER, ask('q4', '0')))).toBe('withdrawal_quote.amount_invalid');
  });

  it('refuses an unknown network, a switched-off one and an asset the network does not carry', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 300 });
    expect(await code(quotes.quote(USER, ask('q1', '10', { networkId: 'nowhere' })))).toBe('withdrawal_quote.network_unknown');
    await network('tron-test', { enabled: false });
    expect(await code(quotes.quote(USER, ask('q2')))).toBe('withdrawal_quote.network_disabled');
    await network('tron-test', { enabled: true, assets: ['USDC'] });
    expect(await code(quotes.quote(USER, ask('q3')))).toBe('withdrawal_quote.asset_not_on_network');
  });

  it('a retry with the same reference reads the stored quote, even after the registry fee or the policy changed', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 300 });
    const first = await quotes.quote(USER, ask('q1'));
    clock = new Date(T0.getTime() + MINUTE);
    await network('tron-test', { fee: '9' });
    await quotes.setPolicy(FOUNDER, { feeMode: 'deducted', ttlSeconds: 30 });
    const again = await quotes.quote(USER, ask('q1'));
    expect(again).toEqual(first);
    expect(await rows('pay.withdrawal_quotes')).toBe('1');
    // A new reference reads the new terms.
    expect(await quotes.quote(USER, ask('q2'))).toMatchObject({ feeTotal: '9', feeMode: 'deducted', netAmount: '91' });
  });

  it('the same reference with other terms is a conflict; another account has its own reference space', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 300 });
    await quotes.quote(USER, ask('q1', '100'));
    expect(await code(quotes.quote(USER, ask('q1', '101')))).toBe('withdrawal_quote.quote_differs');
    expect(await code(quotes.quote(USER, ask('q1', '100', { assetId: 'USDC' })))).toBe('withdrawal_quote.quote_differs');
    expect(await quotes.quote(OTHER, ask('q1', '55'))).toMatchObject({ amount: '55' });
  });

  it('parallel first calls with one reference store one quote', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 300 });
    const results = await Promise.all(Array.from({ length: 5 }, () => quotes.quote(USER, ask('q1'))));
    expect(new Set(results.map((r) => r.expiresAt)).size).toBe(1);
    expect(await rows('pay.withdrawal_quotes')).toBe('1');
  });

  it('expires at the lifetime and an expired quote cannot be accepted', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 60 });
    await quotes.quote(USER, ask('q1'));
    clock = new Date(T0.getTime() + 60_000 - 1);
    expect((await quotes.get(USER, 'q1')).expired).toBe(false);
    clock = new Date(T0.getTime() + 60_000);
    expect((await quotes.get(USER, 'q1')).expired).toBe(true);
    expect(await code(quotes.accept(USER, { quoteRef: 'q1', clientRef: 'w-1' }))).toBe('withdrawal_quote.expired');
  });

  it('accepts once: the same client reference again is a retry, another is refused', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 60 });
    await quotes.quote(USER, ask('q1'));
    await quotes.quote(USER, ask('q2'));
    expect(await quotes.accept(USER, { quoteRef: 'q1', clientRef: 'w-1' })).toMatchObject({ acceptedBy: 'w-1' });
    clock = new Date(T0.getTime() + 10 * MINUTE);
    expect(await quotes.accept(USER, { quoteRef: 'q1', clientRef: 'w-1' })).toMatchObject({ acceptedBy: 'w-1', expired: true });
    expect(await code(quotes.accept(USER, { quoteRef: 'q1', clientRef: 'w-2' }))).toBe('withdrawal_quote.already_used');
    clock = T0;
    expect(await code(quotes.accept(USER, { quoteRef: 'q2', clientRef: 'w-1' }))).toBe('withdrawal_quote.client_ref_taken');
  });

  it('two parallel accepts with different references accept exactly one', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 60 });
    await quotes.quote(USER, ask('q1'));
    const outcomes = await Promise.allSettled(
      ['w-1', 'w-2', 'w-3', 'w-4'].map((clientRef) => quotes.accept(USER, { quoteRef: 'q1', clientRef })),
    );
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(await rows('pay.withdrawal_quote_acceptances')).toBe('1');
  });

  it("another account's quote reads as not found", async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 60 });
    await quotes.quote(USER, ask('q1'));
    expect(await code(quotes.get(OTHER, 'q1'))).toBe('withdrawal_quote.not_found');
    expect(await code(quotes.accept(OTHER, { quoteRef: 'q1', clientRef: 'w-1' }))).toBe('withdrawal_quote.not_found');
  });

  it('lists quotes newest first, filtered by account and asset', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 60 });
    await quotes.quote(USER, ask('q1'));
    clock = new Date(T0.getTime() + MINUTE);
    await quotes.quote(OTHER, ask('q2'));
    const all = await quotes.list({ limit: 10 });
    expect(all.map((q) => q.quoteRef)).toEqual(['q2', 'q1']);
    expect(await quotes.list({ limit: 10, userId: USER })).toHaveLength(1);
    expect(await quotes.list({ limit: 10, assetId: 'USDC' })).toEqual([]);
  });

  it('never edits or deletes a quote, an acceptance or the policy history', async () => {
    await quotes.setPolicy(FOUNDER, { feeMode: 'on_top', ttlSeconds: 60 });
    await quotes.quote(USER, ask('q1'));
    await quotes.accept(USER, { quoteRef: 'q1', clientRef: 'w-1' });
    await expect(db.sql`UPDATE pay.withdrawal_quotes SET amount = 1`).rejects.toThrow(/not permitted/);
    await expect(db.sql`DELETE FROM pay.withdrawal_quote_acceptances`).rejects.toThrow(/not permitted/);
    await expect(db.sql`UPDATE pay.withdrawal_quote_policy_events SET ttl_seconds = 1`).rejects.toThrow(/not permitted/);
  });
});
