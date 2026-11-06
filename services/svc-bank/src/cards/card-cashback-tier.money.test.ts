/**
 * J-bank-13 #7 (RC-bank-02): cashback on card spend at the person's rank card tier, paid in IFC, over real rows.
 *
 * One `rewardPay` per capture from the one reward pot, keyed on the authorisation; a retry pays nothing more; value is
 * conserved; a short pot keeps an unpaid row and pays nothing; a tier with no rate refuses by name; the simulator pays only
 * behind its TEST stand-in, which refuses to start outside dev/test.
 *
 * PG-hard: a missing database fails the suite. CI uses TEST_DATABASE_URL; without it, Testcontainers `postgres:16-alpine`.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, parseAmount as amt, recipes, rewardsEngine, userAvailable } from '@intafaced/ledger-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CardService } from './card-service.js';
import { cardSimCashbackFor, parseCashbackRates } from './card-programme.js';
import { cardIssuerFor } from './issuer.js';
import { memoryRankTier, type RankTierPort } from './rank-tier.js';
import { BankError } from '../errors.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const RATES = parseCashbackRates(JSON.stringify({ assetId: 'IFC', rates: { none: 100, metal: 200 } }))!;

async function openAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  return { url: container.getConnectionUri(), stop: async () => void (await container.stop()) };
}

describe('cashback on card spend by rank card tier (J-bank-13 #7, PG-hard)', () => {
  let stop: () => Promise<void> = async () => undefined;
  let db: TestDatabase;
  let sql: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let user: string;

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
    user = randomUUID();
    await ledger.post(recipes.deposit({ userId: user, assetId: 'IFC', amount: amt('100'), rail: 'test', railRef: `fund:${user}` }));
  });

  const service = (opts: { simulatorPays?: boolean; rankTier?: RankTierPort; rates?: typeof RATES | null } = {}) =>
    new CardService(sql, ledger, {
      issuer: cardIssuerFor('card-sim', { APP_ENV: 'test' }),
      cashback: {
        rates: opts.rates === undefined ? RATES : opts.rates,
        rankTier: opts.rankTier ?? memoryRankTier(),
        simulatorPays: opts.simulatorPays ?? true,
      },
    });
  /** TEST revenue the platform earned in IFC, swept into the one reward pot (`sweepFeesToRewards`). */
  async function fundPot(value: string) {
    const payer = randomUUID();
    await ledger.post(recipes.deposit({ userId: payer, assetId: 'IFC', amount: amt(value), rail: 'test', railRef: `fee:${payer}` }));
    await ledger.post(
      recipes.feeCharge({ mode: 'asset', userId: payer, module: 'trade', assetId: 'IFC', amount: amt(value), chargeId: payer }),
    );
    await ledger.post(recipes.sweepFeesToRewards({ windowId: payer, sourceModule: 'trade', assetId: 'IFC', amount: amt(value) }));
  }
  const ifc = async () => (await ledger.balance(userAvailable(user, 'IFC'))).amount;
  const pot = async () => (await ledger.balance(rewardsEngine('IFC'))).amount;
  async function spend(cards: CardService, value: string, ref = randomUUID()) {
    const card = await cards.issue({ cardId: randomUUID(), userId: user, assetId: 'IFC', perAuthorizationLimit: amt('50') });
    await cards.authorize({ cardId: card.id, authorizationRef: ref, amount: amt(value) });
    return { card, ref, captured: await cards.capture({ cardId: card.id, authorizationRef: ref, amount: amt(value) }) };
  }

  it('pays the tier rate in IFC once, from the reward pot, and value is conserved', async () => {
    await fundPot('1');
    const cards = service();
    const { card, ref, captured } = await spend(cards, '4');
    // 1% of 4, floored to the unit: exactly 0.04.
    expect(captured.cashback).toMatchObject({ status: 'paid', amount: amt('0.04') });
    expect(await ifc()).toBe(amt('96.04'));
    expect(await pot()).toBe(amt('0.96'));
    // A redelivered capture is refused and pays nothing more; the recovery pass pays nothing more either.
    await expect(cards.capture({ cardId: card.id, authorizationRef: ref, amount: amt('4') })).rejects.toBeInstanceOf(BankError);
    await cards.resumeSettlements({ cardId: card.id, authorizationRef: ref });
    expect(await ifc()).toBe(amt('96.04'));
    expect(await pot()).toBe(amt('0.96'));
    const rows = await sql<Array<{ rate_bps: number; status: string }>>`
      SELECT cb.rate_bps, cb.status FROM bank.card_cashback cb JOIN bank.card_authorizations a ON a.id = cb.authorization_id
       WHERE a.card_id = ${card.id}`;
    expect(rows).toEqual([{ rate_bps: 100, status: 'settled' }]);
    const summary = await cards.cashbackSummary(user);
    expect(summary).toMatchObject({ tier: 'none', rateBps: 100, assetId: 'IFC', paid: amt('0.04'), unpaid: 0n, paying: true });
    // Double entry holds for every asset: the person's gain is exactly the pot's loss, and nothing was made.
    expect(Object.values(ledger.totalsByAsset()).every((total) => amt(total) === 0n)).toBe(true);
  });

  it('uses the person’s own tier', async () => {
    await fundPot('1');
    const { captured } = await spend(service({ rankTier: memoryRankTier({ [user]: 'metal' }) }), '4');
    expect(captured.cashback).toMatchObject({ status: 'paid', amount: amt('0.08') });
  });

  it('keeps an unpaid row and pays nothing when the pot is short; the capture stands', async () => {
    const { captured } = await spend(service(), '4');
    expect(captured.cashback).toMatchObject({ status: 'refused', reason: 'bank.cashback_pot_unfunded' });
    expect(await ifc()).toBe(amt('96'));
    expect(await service().cashbackSummary(user)).toMatchObject({ unpaid: 0n, refused: amt('0.04') });
  });

  it('refuses by name for a tier with no published rate, and writes no row', async () => {
    await fundPot('1');
    const cards = service({ rankTier: memoryRankTier({ [user]: 'obsidian' }) });
    const { card, captured } = await spend(cards, '4');
    expect(captured.cashback).toMatchObject({ status: 'refused', reason: 'bank.cashback_rate_unset' });
    expect(
      await sql`SELECT 1 FROM bank.card_cashback cb JOIN bank.card_authorizations a ON a.id = cb.authorization_id WHERE a.card_id = ${card.id}`,
    ).toHaveLength(0);
    await expect(service({ rates: null }).cashbackSummary(user)).rejects.toMatchObject({ code: 'bank.cashback_rate_unset' });
  });

  it('earns a cashback the tier read missed at capture, once, when the settlement is resumed', async () => {
    await fundPot('1');
    let down = true;
    const flaky: RankTierPort = {
      async cardTierOf() {
        if (down) throw new BankError('identity did not answer', 'bank.rank_unavailable');
        return 'none';
      },
    };
    const cards = service({ rankTier: flaky });
    const { card, ref, captured } = await spend(cards, '4');
    expect(captured.cashback).toMatchObject({ status: 'refused', reason: 'bank.rank_unavailable' });
    expect(await ifc()).toBe(amt('96'));
    down = false;
    await cards.resumeSettlements({ cardId: card.id, authorizationRef: ref });
    await cards.resumeSettlements({ cardId: card.id, authorizationRef: ref });
    expect(await ifc()).toBe(amt('96.04'));
    expect(await pot()).toBe(amt('0.96'));
  });

  it('pays nothing on the simulator without its TEST stand-in, as before', async () => {
    await fundPot('1');
    const { captured } = await spend(service({ simulatorPays: false }), '4');
    expect(captured.cashback).toMatchObject({ status: 'refused', reason: 'bank.rewards_issuer_unset' });
    expect(await pot()).toBe(amt('1'));
  });

  it('refuses the stand-in at boot outside dev or test', () => {
    expect(cardSimCashbackFor('off', { APP_ENV: 'production' })).toBe(false);
    expect(cardSimCashbackFor('test', { APP_ENV: 'test' })).toBe(true);
    expect(() => cardSimCashbackFor('test', { APP_ENV: 'production' })).toThrow(/refuses to start/);
    expect(() => cardSimCashbackFor('test', { APP_ENV: 'dev', NODE_ENV: 'production' })).toThrow(/refuses to start/);
    expect(() => cardSimCashbackFor('test', {})).toThrow(/refuses to start/);
  });
});
