import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDatabase, postgresAvailable, type TestDatabase } from '@intafaced/db/testing';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTODY_LAYER_OFF_CODE,
  LedgerError,
  MemoryLedger,
  movesCustomerBalance,
  ownFundsPlaceAccount,
  parseAmount,
  recipes,
  rewardOwedAccount,
  userAvailable,
  type LedgerClient,
  type PostRequest,
  type RewardCeiling,
} from '@intafaced/ledger-client';
import type { CampaignParticipant } from '@intafaced/contracts';
import type { CampaignDefinitionInput, CampaignTasks } from '@intafaced/contracts/campaigns-catalogue';
import { CampaignService } from './campaigns.js';
import { PAYOUT_UNAVAILABLE, PayoutSaga, ledgerRewardId } from './payouts.js';
import { FROZEN, NO_WALLET, PAYMENT_NOT_TAKEN, RewardPayer, WALLET_SHORT, unitsOf, type RewardChain } from './reward-payer.js';
import { TaskService } from './tasks.js';
import type { VenueDepositSource } from './venue-deposits.js';

/**
 * Paying an owed reward to the customer's own wallet (J-campaigns-03 #2 #3, #8195) against real Postgres, the in-memory
 * reference ledger with the custodial layer off, and an in-memory TEST chain. Every test ends with the invariant: each
 * paid reward left our wallet on the chain exactly once, to the wallet recorded at its claim, and was booked once under
 * its chain transaction; what is still owed is exactly what the ledger owes; our wallet's place in the book came down by
 * exactly what was paid; and no customer account holds anything.
 */

const adminUrl = process.env.TEST_DATABASE_URL?.trim();
if (!adminUrl && (process.env.REQUIRE_POSTGRES === '1' || process.env.CI === 'true' || process.env.CI === '1')) {
  throw new Error('TEST_DATABASE_URL is required');
}
const available = adminUrl ? await postgresAvailable(adminUrl) : false;
const drizzle = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));
const db: TestDatabase | null =
  available && adminUrl ? await createTestDatabase({ url: adminUrl, service: 'campaigns', migrations }) : null;

afterAll(async () => {
  await db?.drop();
});

const A = 'operator-a';
const B = 'operator-b';
const ME = '00000000-0000-4000-8000-0000000000a1';
const FUNDER = '00000000-0000-4000-8000-0000000000c3';
const HOUR = 3_600_000;
const CEILING: RewardCeiling = { perCampaign: parseAmount('15'), total: parseAmount('25') };
const OURS = '0x00000000000000000000000000000000ce510001';
const MY_WALLET = '0x1111111111111111111111111111111111111111';
const WALLET = { walletId: 'test-chain:rewards', address: OURS, tokenDecimals: 6 };
const VENUE = 'test-venue-sim';

const people = new Map<string, CampaignParticipant>();
const participants = { read: async (userId: string) => people.get(userId) ?? null };
const person = (userId: string): CampaignParticipant => ({ userId, accountType: 'individual', region: 'DE', status: 'active', kycTier: 'full' });

const STEPS: CampaignTasks = {
  steps: [{ title: 'TEST buy BTC', event: 'trade.fill', market: null, side: 'buy', count: 1, streakDays: null }],
  claimWindowSeconds: 3600,
  holdSeconds: 0,
  lock: null,
  kycGate: 'basic',
};
let names = 0;
const definition = (over: Partial<CampaignDefinitionInput> = {}): CampaignDefinitionInput => ({
  name: `TEST paid campaign ${(names += 1)}`,
  type: 'task',
  rules: 'TEST rules',
  startsAt: new Date(Date.now() - HOUR).toISOString(),
  endsAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
  participation: { exclusions: [], regionScope: 'platform', restrictedRegions: null },
  budget: { asset: 'USDC', limit: '100' },
  limits: { perCustomer: { count: 100, periodSeconds: 86_400 }, totalRedemptions: null },
  reward: { asset: 'USDC', amount: '10' },
  tasks: STEPS,
  ...over,
});

async function joined(over: Partial<CampaignDefinitionInput> = {}) {
  const s = new CampaignService({ sql: db!.sql, timeZone: () => 'UTC', participants });
  const c = await s.create({ definition: definition(over), actor: A });
  await s.transition({ id: c.id, action: 'submit', revision: 1, actor: A });
  await s.transition({ id: c.id, action: 'approve', revision: 1, actor: B });
  await s.transition({ id: c.id, action: 'activate', revision: 1, actor: A });
  await s.join({ campaignId: c.id, accountId: ME });
  return c;
}

/** svc-ledger with the custodial layer off; `frozen` refuses every post; `loseNextReply` lands a post and loses its answer. */
function custodyOff(inner: MemoryLedger) {
  const mode = { frozen: false, loseNextReply: false, posts: [] as string[] };
  const ledger: LedgerClient = {
    post: async (request: PostRequest) => {
      if (mode.frozen) throw new LedgerError('Ledger posting is frozen: TEST freeze', 'ledger.frozen');
      if (movesCustomerBalance(request.entries)) throw new LedgerError('custody layer off', CUSTODY_LAYER_OFF_CODE);
      const tx = await inner.post(request);
      mode.posts.push(request.idempotencyKey);
      if (mode.loseNextReply) {
        mode.loseNextReply = false;
        throw new Error('reply lost after the post landed');
      }
      return tx;
    },
    balance: (ref) => inner.balance(ref),
    balances: (t, id) => inner.balances(t, id),
    getTx: (id) => inner.getTx(id),
    getTxByKey: (key) => inner.getTxByKey(key),
  };
  return { ledger, mode };
}

/** An in-memory TEST chain: token balances, every transfer it took, and a send that can throw after it was taken. */
function testChain() {
  const balances = new Map<string, bigint>();
  const transfers: { hash: string; from: string; to: string; units: bigint; block: bigint }[] = [];
  const mode = { throwAfterTaking: false, revertNext: false, reverted: new Set<string>() };
  let block = 1n;
  const chain: RewardChain = {
    head: async () => block,
    holds: async (from) => balances.get(from) ?? 0n,
    async send(from, to, units) {
      const have = balances.get(from) ?? 0n;
      if (have < units) throw new Error('TEST chain: transfer amount exceeds balance');
      const hash = `0x${(transfers.length + 1).toString(16).padStart(64, 'a')}`;
      block += 1n;
      if (mode.revertNext) {
        mode.revertNext = false;
        mode.reverted.add(hash);
        return hash;
      }
      balances.set(from, have - units);
      balances.set(to, (balances.get(to) ?? 0n) + units);
      transfers.push({ hash, from, to, units, block });
      if (mode.throwAfterTaking) {
        mode.throwAfterTaking = false;
        throw new Error('TEST chain: the answer was lost after the node took it');
      }
      return hash;
    },
    receipt: async (hash) => (mode.reverted.has(hash) ? false : transfers.some((t) => t.hash === hash) ? true : null),
    find: async (from, to, units, fromBlock) =>
      transfers.filter((t) => t.from === from && t.to === to && t.units === units && t.block >= fromBlock).map((t) => t.hash),
  };
  return { chain, balances, transfers, mode };
}

let book: MemoryLedger;
let wire: ReturnType<typeof custodyOff>;
let world: ReturnType<typeof testChain>;
let tasks: TaskService;
let payer: RewardPayer;
let posting: boolean | null;
let clock: Date | null;
let connected: string[] | null;

const wallets: VenueDepositSource = {
  wallets: async (forwarded) => (Object.keys(forwarded).length > 0 ? connected : null),
  deposits: async () => null,
};
const FORWARDED = { 'x-intafaced-principal': 'TEST' };

let seeds = 0;
/** TEST USDC in the rewards engine and in our rewards wallet, set up on the reference book and the TEST chain directly. */
async function seed(engine: string, wallet: string) {
  const ref = `seed-${(seeds += 1)}`;
  await book.post(recipes.deposit({ userId: FUNDER, assetId: 'USDC', amount: parseAmount(engine), rail: 'test', railRef: ref }));
  await book.post(recipes.feeCharge({ chargeId: ref, userId: FUNDER, module: 'trade', mode: 'asset', assetId: 'USDC', amount: parseAmount(engine) }));
  await book.post(recipes.sweepFeesToRewards({ windowId: ref, sourceModule: 'trade', assetId: 'USDC', amount: parseAmount(engine) }));
  await fundWallet(wallet);
}
/** Our builder fees collected at the venue and moved to our rewards wallet: in the book and on the chain. */
async function fundWallet(amount: string) {
  const ref = `move-${(seeds += 1)}`;
  const a = parseAmount(amount);
  await book.post(recipes.builderFeeEarn({ venueId: VENUE, venueAccount: '0xowner', fillId: `f-${ref}`, assetId: 'USDC', amount: a, userId: FUNDER }));
  await book.post(recipes.builderFeeReceive({ venueId: VENUE, claimId: ref, assetId: 'USDC', amount: a }));
  await book.post(
    recipes.ownFundsMove({
      from: { kind: 'venue-builder-account', venueId: VENUE },
      to: { kind: 'treasury-wallet', walletId: WALLET.walletId },
      assetId: 'USDC',
      amount: a,
      reference: `0x${ref}`,
    }),
  );
  world.balances.set(OURS, (world.balances.get(OURS) ?? 0n) + unitsOf(a, 6)!);
}

async function complete(campaignId: string) {
  await db!.sql`
    INSERT INTO campaigns.task_completions (campaign_id, account_id, completed_at) VALUES (${campaignId}, ${ME}, now())
    ON CONFLICT DO NOTHING`;
}

async function claimed(over: Partial<CampaignDefinitionInput> = {}) {
  const c = await joined(over);
  await complete(c.id);
  return (await tasks.claim({ campaignId: c.id, accountId: ME, forwarded: FORWARDED })).reward;
}

const recordOf = async (key: string) => (await tasks.myRewards({ accountId: ME })).rewards.find((r) => r.rewardKey === key)!;
const ourPlace = async () => (await book.balance(ownFundsPlaceAccount({ kind: 'treasury-wallet', walletId: WALLET.walletId }, 'USDC'))).amount;

/** The invariant (see the file's comment). `funded` is what was moved to our wallet in all. */
async function reconciles(funded: string) {
  const rows = await db!.sql<{ reward_key: string; campaign_id: string; amount: string; state: string; pay_to_wallet: string | null }[]>`
    SELECT reward_key, campaign_id, amount::text AS amount, state, pay_to_wallet FROM campaigns.reward_intents`;
  let paidUnits = 0n;
  for (const r of rows) {
    const key = ledgerRewardId(r.campaign_id, r.reward_key);
    const amount = parseAmount(r.amount);
    expect((await book.balance(rewardOwedAccount(key))).amount, r.reward_key).toBe(r.state === 'owed' ? amount : 0n);
    const sent = world.transfers.filter((t) => t.from === OURS && t.to === r.pay_to_wallet && t.units === unitsOf(amount, 6));
    const bookings = wire.mode.posts.filter((k) => k.startsWith(`campaigns:reward-paid:${key}:`));
    if (r.state === 'paid') {
      expect(sent, r.reward_key).toHaveLength(1);
      expect(new Set(bookings), r.reward_key).toEqual(new Set([`campaigns:reward-paid:${key}:${sent[0]!.hash}`]));
      paidUnits += sent[0]!.units;
    } else {
      expect(bookings, r.reward_key).toEqual([]);
    }
  }
  expect(world.transfers.filter((t) => t.from === OURS).reduce((n, t) => n + t.units, 0n)).toBe(paidUnits);
  // Our wallet's place in the book (negative: ours is there) came back by exactly what was paid.
  expect(-(await ourPlace())).toBe(parseAmount(funded) - paidUnits * 10n ** 12n);
  expect((await book.balance(userAvailable(ME, 'USDC'))).amount).toBe(0n);
  expect(book.reconcile()).toEqual({ ok: true });
}

if (!db) {
  describe.skip('reward payments (Postgres unavailable)', () => {
    it('skipped', () => undefined);
  });
} else {
  describe('paying owed rewards to the customer wallet (Postgres)', () => {
    beforeEach(async () => {
      await db.sql`TRUNCATE campaigns.reward_payments, campaigns.redemption_attempts, campaigns.reward_intents,
        campaigns.task_progress, campaigns.task_completions, campaigns.pot_fundings, campaigns.participations,
        campaigns.eligibility_reviews, campaigns.audit_log, campaigns.campaigns CASCADE`;
      people.clear();
      people.set(ME, person(ME));
      book = new MemoryLedger();
      wire = custodyOff(book);
      world = testChain();
      posting = true;
      clock = null;
      connected = [MY_WALLET];
      const saga = new PayoutSaga({ sql: db.sql, ledger: wire.ledger, reconcileAfterSeconds: 1, rewardCeiling: CEILING });
      tasks = new TaskService({
        sql: db.sql,
        participants,
        saga,
        markets: null,
        timeZone: () => 'UTC',
        rollbackWindowSeconds: 86_400,
        venueDeposits: wallets,
        now: () => clock ?? new Date(),
      });
      payer = new RewardPayer({
        sql: db.sql,
        ledger: wire.ledger,
        chain: world.chain,
        wallet: WALLET,
        postingEnabled: async () => posting,
        now: () => clock ?? new Date(),
      });
    });

    it('pays an owed reward once to the wallet connected at its claim, books it under its chain transaction, and it reads paid', async () => {
      await seed('50', '20');
      const reward = await claimed();
      expect(reward).toMatchObject({ state: 'owed', reason: PAYOUT_UNAVAILABLE, payout: null });
      expect(await payer.pass()).toEqual({ sent: 1, paid: 1 });
      const paid = await recordOf(reward.rewardKey);
      expect(paid).toMatchObject({ state: 'paid', status: 'paid', reason: null, payout: { toWallet: MY_WALLET } });
      expect(paid.payout!.chainTx).toBe(world.transfers[0]!.hash);
      expect(paid.ledgerTxId).toBeTruthy();
      expect(paid.attempts.filter((a) => a.outcome === 'paid')).toHaveLength(1);
      expect(world.balances.get(MY_WALLET)).toBe(10_000_000n);
      // Later passes send and book nothing more.
      expect(await payer.pass()).toEqual({ sent: 0, paid: 0 });
      expect((await tasks.myRewards({ accountId: ME })).totals).toEqual([{ status: 'paid', asset: 'USDC', amount: '10', count: 1 }]);
      await reconciles('20');
    });

    it('sends nothing under the posting freeze: it stays owed with reason ledger.frozen, logged once, and is paid once after it lifts', async () => {
      await seed('50', '20');
      const reward = await claimed();
      posting = false;
      await payer.pass();
      await payer.pass();
      const held = await recordOf(reward.rewardKey);
      expect(held).toMatchObject({ state: 'owed', reason: FROZEN, payout: null });
      expect(held.attempts.filter((a) => a.outcome === 'refused')).toEqual([expect.objectContaining({ reason: FROZEN })]);
      expect(world.transfers).toEqual([]);
      // Unread freeze state: nothing is sent either.
      posting = null;
      expect(await payer.pass()).toEqual({ sent: 0, paid: 0 });
      posting = true;
      expect(await payer.pass()).toEqual({ sent: 1, paid: 1 });
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'paid', reason: null });
      await reconciles('20');
    });

    it('waits, owed, while our wallet cannot cover it, and pays once it can', async () => {
      await seed('50', '4');
      const reward = await claimed();
      await payer.pass();
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'owed', reason: WALLET_SHORT });
      expect(world.transfers).toEqual([]);
      await fundWallet('6');
      await payer.pass();
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'paid' });
      await reconciles('10');
    });

    it('waits for a connected wallet: none at the claim and nothing is sent; one connected later is recorded on the next read and paid', async () => {
      await seed('50', '20');
      connected = [];
      const reward = await claimed();
      await payer.pass();
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'owed', reason: NO_WALLET });
      expect(world.transfers).toEqual([]);
      connected = [MY_WALLET];
      await tasks.myRewards({ accountId: ME, forwarded: FORWARDED });
      await payer.pass();
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'paid', payout: { toWallet: MY_WALLET } });
      // The wallet a reward was given stays its wallet: another connected later changes nothing.
      connected = ['0x2222222222222222222222222222222222222222'];
      await tasks.myRewards({ accountId: ME, forwarded: FORWARDED });
      expect((await recordOf(reward.rewardKey)).payout?.toWallet).toBe(MY_WALLET);
      await reconciles('20');
    });

    it('pays a held reward only once its hold ends with the account active', async () => {
      await seed('50', '20');
      const reward = await claimed({ tasks: { ...STEPS, holdSeconds: 3600 } });
      await payer.pass();
      expect(world.transfers).toEqual([]);
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'owed', status: 'on_hold' });
      clock = new Date(Date.now() + 2 * HOUR);
      await tasks.releaseHolds();
      await payer.pass();
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'paid' });
      await reconciles('20');
    });

    it('a send whose answer was lost after the chain took it is found on the chain, never sent again, and paid once', async () => {
      await seed('50', '20');
      const reward = await claimed();
      world.mode.throwAfterTaking = true;
      expect(await payer.pass()).toEqual({ sent: 1, paid: 1 });
      expect(world.transfers).toHaveLength(1);
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'paid', payout: { chainTx: world.transfers[0]!.hash } });
      await payer.pass();
      expect(world.transfers).toHaveLength(1);
      await reconciles('20');
    });

    it('a send the chain never took is given up after the wait, never sent again, and the reward stays owed for a person', async () => {
      await seed('50', '20');
      const reward = await claimed();
      const send = world.chain.send;
      world.chain.send = async () => {
        throw new Error('TEST chain: the node never took it');
      };
      await payer.pass();
      world.chain.send = send;
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'owed' });
      clock = new Date(Date.now() + 2 * 60_000);
      await payer.pass();
      await payer.pass();
      expect(world.transfers).toEqual([]);
      const after = await recordOf(reward.rewardKey);
      expect(after).toMatchObject({ state: 'owed', reason: PAYMENT_NOT_TAKEN, payout: null });
      expect(after.attempts.filter((a) => a.reason === PAYMENT_NOT_TAKEN)).toHaveLength(1);
      await reconciles('20');
    });

    it('a lost booking answer leaves it owed and sent; the next pass books the same key once and it reads paid', async () => {
      await seed('50', '20');
      const reward = await claimed();
      wire.mode.loseNextReply = true;
      expect(await payer.pass()).toEqual({ sent: 1, paid: 0 });
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'owed', reason: 'ledger.answer_lost' });
      expect(await payer.pass()).toEqual({ sent: 0, paid: 1 });
      expect(world.transfers).toHaveLength(1);
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'paid', reason: null });
      await reconciles('20');
    });

    it('a booking the ledger refuses (frozen after the send) is booked once after it lifts; nothing is sent twice', async () => {
      await seed('50', '20');
      const reward = await claimed();
      // The freeze reads off before the send, then the ledger freezes before the booking.
      const post = wire.ledger.post;
      let first = true;
      wire.ledger.post = async (request) => {
        if (first && request.idempotencyKey.startsWith('campaigns:reward-paid:')) {
          first = false;
          throw new LedgerError('Ledger posting is frozen: TEST freeze', 'ledger.frozen');
        }
        return post(request);
      };
      await payer.pass();
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'owed', reason: FROZEN });
      await payer.pass();
      expect(await recordOf(reward.rewardKey)).toMatchObject({ state: 'paid' });
      expect(world.transfers).toHaveLength(1);
      await reconciles('20');
    });

    it('never pays a reward that is not owed: locked, closed or still open rewards send nothing', async () => {
      await seed('50', '20');
      // Past the ceiling: never owed, so never paid.
      const open = await claimed({ reward: { asset: 'USDC', amount: '20' }, budget: { asset: 'USDC', limit: '100' } });
      expect(open.state).toBe('pending_retry');
      await payer.pass();
      expect(world.transfers).toEqual([]);
      await reconciles('20');
    });
  });
}
