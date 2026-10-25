import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { createTestDb, rewriteSchemaSql, type TestDb } from '@intafaced/db';
import {
  campaignLockAccount,
  formatAmount,
  parseAmount as amt,
  recipes,
  rewardsEngine,
  userAvailable,
  type CampaignLockInput,
  type PostRequest,
} from '@intafaced/ledger-client';
import { PostgresLedger } from './ledger/postgres-ledger.js';
import { CAMPAIGN_LOCK_UNBOUND_CODE } from './campaign-lock-binding.js';
import { handleS2sPost } from './s2s-http.js';
import type { LedgerService } from './service.js';

/**
 * CM-payouts-ledger-01 / CM-rewards-hub-02: the ledger door lets a locked campaign reward out only as the outcome of
 * its own posted lock. Real Postgres ledger, through the S2S post handler. Another reward's pot always holds more than
 * enough, so a refusal is the binding's, never an empty pot.
 *
 * H8a PG-hard: this file never skips. CI uses TEST_DATABASE_URL. Local without that env starts Testcontainers.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzleDir = join(here, '..', 'drizzle');

const migrations = readdirSync(drizzleDir)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzleDir, f), 'utf8'))
  .map((body) => (schema: string) => rewriteSchemaSql(body, 'ledger', schema));

if (migrations.length === 0) throw new Error(`No migrations found in ${drizzleDir}`);

const H8A_IMAGE = 'postgres:16-alpine';

async function openH8aAdmin(): Promise<{ url: string; stop: () => Promise<void> }> {
  const envUrl = process.env.TEST_DATABASE_URL?.trim();
  if (envUrl) return { url: envUrl, stop: async () => undefined };
  try {
    const container = await new PostgreSqlContainer(H8A_IMAGE)
      .withDatabase('intafaced_campaign_lock_test')
      .withUsername('intafaced')
      .withPassword('intafaced')
      .start();
    return { url: container.getConnectionUri(), stop: async () => container.stop().then(() => undefined) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `H8a: locked campaign rewards are PG-hard (no skip-green). TEST_DATABASE_URL unset and Testcontainers could not start ${H8A_IMAGE}: ${msg}`,
    );
  }
}

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const PAYER = '44444444-4444-4444-8444-444444444444';
const keyOf = (n: string, user = CUSTOMER) => `task:55555555-5555-4555-8555-55555555555${n}:${user}:once`;

type Wire = {
  idempotencyKey: string;
  module: string;
  reason: string;
  meta?: Record<string, unknown>;
  entries: { account: PostRequest['entries'][number]['account']; direction: string; amount: string }[];
};

const toWire = (post: PostRequest): Wire => ({
  idempotencyKey: post.idempotencyKey,
  module: post.module,
  reason: post.reason,
  ...(post.meta ? { meta: post.meta } : {}),
  entries: post.entries.map((e) => ({ account: e.account, direction: e.direction, amount: formatAmount(e.amount) })),
});

describe('locked campaign reward bound to its posted lock (Postgres)', () => {
  let adminStop: () => Promise<void> = async () => undefined;
  let db: TestDb | undefined;
  let engine: PostgresLedger;
  let door: LedgerService;

  beforeAll(async () => {
    const admin = await openH8aAdmin();
    adminStop = admin.stop;
    db = await createTestDb({ service: 'ledger_campaign_lock', url: admin.url, migrations });
    engine = new PostgresLedger(db.sql);
    door = {
      post: (req: PostRequest) => engine.post(req),
      getTxByKey: (key: string) => engine.getTxByKey(key),
      balance: (ref: Parameters<PostgresLedger['balance']>[0]) => engine.balance(ref),
    } as unknown as LedgerService;
    // A rewards engine funded the way production funds it, and another reward's pot holding 500.
    await engine.post(recipes.deposit({ userId: PAYER, assetId: 'USDT', amount: amt('5000'), rail: 'test', railRef: 'pot' }));
    await engine.post(
      recipes.feeCharge({ chargeId: 'pot', userId: PAYER, module: 'campaigns', mode: 'asset', assetId: 'USDT', amount: amt('5000') }),
    );
    await engine.post(recipes.sweepFeesToRewards({ windowId: 'pot', sourceModule: 'campaigns', assetId: 'USDT', amount: amt('5000') }));
    await handleS2sPost(door, toWire(recipes.campaignRewardLock(reward('0', '500'))));
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
    await adminStop();
  }, 30_000);

  function reward(n: string, amount = '100', userId = CUSTOMER): CampaignLockInput {
    return { rewardKey: keyOf(n, userId), userId, assetId: 'USDT', amount: amt(amount) };
  }

  const bal = async (ref: Parameters<PostgresLedger['balance']>[0]) => formatAmount((await engine.balance(ref)).amount);
  const unbound = expect.objectContaining({ code: CAMPAIGN_LOCK_UNBOUND_CODE });
  const lock = (input: CampaignLockInput) => handleS2sPost(door, toWire(recipes.campaignRewardLock(input)));

  it('unlocks the whole lock to its customer once, and the other outcome is then refused', async () => {
    const input = reward('1');
    await lock(input);
    const first = await handleS2sPost(door, toWire(recipes.campaignRewardUnlock(input)));
    const again = await handleS2sPost(door, toWire(recipes.campaignRewardUnlock(input)));
    expect(again.txId).toBe(first.txId);
    expect(await bal(userAvailable(CUSTOMER, 'USDT'))).toBe('100');
    expect(await bal(campaignLockAccount(input.rewardKey, 'USDT'))).toBe('0');
    await expect(handleS2sPost(door, toWire(recipes.campaignRewardForfeit(input)))).rejects.toThrow();
    expect(await engine.getTxByKey(`campaigns:forfeit:${input.rewardKey}`)).toBeNull();
  });

  it('forfeits the whole lock back to the rewards engine once', async () => {
    const input = reward('2');
    await lock(input);
    const before = await bal(rewardsEngine('USDT'));
    await handleS2sPost(door, toWire(recipes.campaignRewardForfeit(input)));
    expect(amt(await bal(rewardsEngine('USDT'))) - amt(before)).toBe(amt('100'));
    await expect(handleS2sPost(door, toWire(recipes.campaignRewardUnlock(input)))).rejects.toThrow();
  });

  it('refuses an outcome for a reward that was never locked, although another pot could pay it', async () => {
    const input = reward('3');
    const wire = toWire(recipes.campaignRewardUnlock(input));
    const fromOtherPot = {
      ...wire,
      entries: wire.entries.map((e) => (e.account.ownerType === 'module' ? { ...e, account: campaignLockAccount(keyOf('0'), 'USDT') } : e)),
    };
    await expect(handleS2sPost(door, wire)).rejects.toEqual(unbound);
    await expect(handleS2sPost(door, fromOtherPot)).rejects.toEqual(unbound);
    expect(await bal(campaignLockAccount(keyOf('0'), 'USDT'))).toBe('500');
  });

  it('refuses a partial unlock and a partial forfeit, so no remainder is left for the other outcome', async () => {
    const input = reward('4', '300');
    await lock(input);
    await expect(handleS2sPost(door, toWire(recipes.campaignRewardUnlock({ ...input, amount: amt('100') })))).rejects.toEqual(unbound);
    await expect(handleS2sPost(door, toWire(recipes.campaignRewardForfeit({ ...input, amount: amt('200') })))).rejects.toEqual(unbound);
    expect(await bal(campaignLockAccount(input.rewardKey, 'USDT'))).toBe('300');
  });

  it('refuses an unlock to anyone but the customer the lock names', async () => {
    const input = reward('5');
    await lock(input);
    await expect(handleS2sPost(door, toWire(recipes.campaignRewardUnlock({ ...input, userId: OTHER })))).rejects.toEqual(unbound);
    const wire = toWire(recipes.campaignRewardUnlock(input));
    const toOther = {
      ...wire,
      entries: wire.entries.map((e) => (e.account.ownerType === 'user' ? { ...e, account: userAvailable(OTHER, 'USDT') } : e)),
    };
    await expect(handleS2sPost(door, toOther)).rejects.toEqual(unbound);
    expect(await bal(userAvailable(OTHER, 'USDT'))).toBe('0');
  });

  it('refuses a key or a meta that names another reward', async () => {
    const input = reward('6');
    await lock(input);
    const wire = toWire(recipes.campaignRewardForfeit(input));
    await expect(handleS2sPost(door, { ...wire, idempotencyKey: `campaigns:forfeit:${keyOf('0')}` })).rejects.toEqual(unbound);
    await expect(handleS2sPost(door, { ...wire, meta: { ...wire.meta, rewardKey: keyOf('0') } })).rejects.toEqual(unbound);
    const locked = toWire(recipes.campaignRewardLock(reward('7')));
    await expect(handleS2sPost(door, { ...locked, idempotencyKey: `campaigns:lock:${keyOf('8')}` })).rejects.toEqual(unbound);
  });

  it('refuses to lock a reward rewardPay already paid', async () => {
    const input = reward('9');
    await handleS2sPost(
      door,
      toWire(
        recipes.rewardPay({
          rewardId: input.rewardKey,
          userId: CUSTOMER,
          assetId: 'USDT',
          amount: amt('100'),
          reason: 'campaigns.task.reward',
        }),
      ),
    );
    await expect(lock(input)).rejects.toEqual(unbound);
    expect(await engine.getTxByKey(`campaigns:lock:${input.rewardKey}`)).toBeNull();
  });
});
