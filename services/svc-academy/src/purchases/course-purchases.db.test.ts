/**
 * J-academy-07 (AC-commerce-01, AC-access-grants-01) — buying a course's certificate track from the buyer's own wallet,
 * and the staff refund, against the real tables, with a fake chain, ledger and refund signer the test drives. The posts
 * are built by the real ledger-client recipes.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { LedgerError, type LedgerClient } from '@intafaced/ledger-client';
import { CourseRecords } from '../curriculum/courses.js';
import { CoursePreview } from '../curriculum/course-preview.js';
import { CourseLearners } from '../curriculum/course-learners.js';
import type { PaymentChain, TransferFact, TxFact } from './chain.js';
import { CoursePurchases, type PaymentSettings } from './course-purchases.js';
import { purchaseLedger } from './purchase-ledger.js';
import type { RefundSend, RefundSender } from './refund-signer.js';
import type { LinkedWalletsPort } from './linked-wallets.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const MIGRATIONS = readdirSync(drizzle)
  .filter((name) => name.endsWith('.sql') && !name.endsWith('.down.sql'))
  .sort()
  .map((name) => readFileSync(join(drizzle, name), 'utf8'));

function adminUrl(): string {
  const raw = process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/intafaced_test';
  const url = new URL(raw);
  if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
  return url.toString();
}

const db: TestDatabase = await createTestDatabase({ service: 'academy', url: adminUrl(), migrations: MIGRATIONS });
afterAll(async () => {
  await db.drop();
}, 30_000);

const STAFF = '33333333-3333-4333-8333-333333333333';
const L = '55555555-5555-4555-8555-555555555555';
const WALLET = '0x00000000000000000000000000000000000000a1';
const TOKEN = '0x000000000000000000000000000000000000d011';
const RECEIVER = '0x7e57ac4d00000000000000000000000000000007';
const SETTINGS: PaymentSettings = { chainId: 84532, token: TOKEN, decimals: 6, asset: 'USDC', receiver: RECEIVER, confirmations: 2 };
const NOW = new Date('2026-11-12T10:00:00.000Z');
const PAY = `0x${'a'.repeat(64)}`;
const OTHER = `0x${'b'.repeat(64)}`;
const REFUND_TX = `0x${'c'.repeat(64)}`;
const KEY = `academy:purchase:perps-101:${L}:1`;
const REFUND_KEY = `academy:refund:perps-101:${L}:1`;

/** A chain the test writes: mined transactions with their transfers, the head, and reads that can fail. */
class FakeChain implements PaymentChain {
  head = 100n;
  down = false;
  txs = new Map<string, { block: bigint; reverted?: boolean; transfers: TransferFact[] }>();
  mine(hash: string, transfers: Array<Omit<TransferFact, 'txHash' | 'blockNumber'>>, reverted = false) {
    this.head += 1n;
    this.txs.set(hash, { block: this.head, reverted, transfers: transfers.map((t) => ({ ...t, txHash: hash, blockNumber: this.head })) });
  }
  async blockNumber() {
    if (this.down) throw new (await import('./chain.js')).ChainUnreadError('node down');
    return this.head;
  }
  async transaction(hash: string): Promise<TxFact> {
    if (this.down) throw new (await import('./chain.js')).ChainUnreadError('node down');
    const tx = this.txs.get(hash);
    if (!tx) return { state: 'unseen' };
    if (tx.reverted) return { state: 'reverted', blockNumber: tx.block };
    return { state: 'mined', blockNumber: tx.block, confirmations: this.head - tx.block + 1n, transfers: tx.transfers };
  }
  async transfers(input: { from: string; to: string; fromBlock: bigint }) {
    return [...this.txs.values()]
      .filter((tx) => !tx.reverted && tx.block >= input.fromBlock)
      .flatMap((tx) => tx.transfers)
      .filter((t) => t.from === input.from && t.to === input.to);
  }
}

/** A ledger that books each key once, as svc-ledger does, and can lose its answer or refuse. */
class FakeLedger {
  booked = new Map<string, { id: string; request: unknown }>();
  calls: string[] = [];
  next: 'ok' | 'lost' | 'refuse' = 'ok';
  readonly client: Pick<LedgerClient, 'post'> = {
    post: async (request) => {
      const key = request.idempotencyKey;
      this.calls.push(key);
      const mode = this.next;
      this.next = 'ok';
      if (mode === 'refuse') throw new LedgerError('refused', 'ledger.frozen');
      const existing = this.booked.get(key);
      const tx = existing ?? { id: `tx-${this.booked.size + 1}`, request };
      this.booked.set(key, tx);
      if (mode === 'lost') throw new TypeError('fetch failed');
      return { id: tx.id } as never;
    },
  };
}

class FakeRefunds implements RefundSender {
  sends: RefundSend[] = [];
  answer: 'hash' | 'lost' = 'hash';
  /** While set, a send waits for it: the test holds a send in flight. */
  hold: Promise<void> | null = null;
  async send(input: RefundSend) {
    this.sends.push(input);
    if (this.hold) await this.hold;
    return this.answer === 'hash' ? REFUND_TX : null;
  }
}

let chain: FakeChain;
let ledger: FakeLedger;
let refunds: FakeRefunds;
/** Identity's linked wallets as the test sets them: the learner L links WALLET; null is identity unread. */
let links: Map<string, string[]> | null;
const wallets: LinkedWalletsPort = {
  read: async (userId) =>
    links === null
      ? null
      : { state: 'usable', wallets: (links.get(userId) ?? []).map((address) => ({ address, linkedAt: NOW.toISOString() })) },
};
let purchases: CoursePurchases;
let learners: CourseLearners;

async function paidCourse(price: string | null = '2.5', asset = 'USDC', slug = 'perps-101') {
  const records = new CourseRecords(db.sql, { maxSections: 5, maxItems: 3 });
  const course = await records.create({
    slug,
    title: slug === 'perps-101' ? 'Perps 101' : `TEST ${slug}`,
    summary: null,
    thumbnailUrl: null,
    pricing: 'paid',
    price: '2.5',
    priceAsset: 'USDC',
    operatorId: STAFF,
    now: NOW,
  });
  await db.sql`UPDATE academy.courses SET state = 'published', price_asset = ${asset} WHERE id = ${course.id}`;
  // Staff withdrew the price after publishing: the only way a published paid course has none (courses_published_price_chk).
  if (price === null)
    await db.sql`UPDATE academy.courses SET price = NULL, price_asset = NULL, price_withdrawn_at = ${NOW} WHERE id = ${course.id}`;
  return course;
}

const make = (settings: PaymentSettings | null = SETTINGS) => {
  purchases = new CoursePurchases(db.sql, { settings, chain, ledger: purchaseLedger(ledger.client), refunds, wallets });
  learners = new CourseLearners(db.sql, new CoursePreview(db.sql), purchases);
};
const pay = (hash = PAY, amount = 2_500_000n, from = WALLET, to = RECEIVER) => chain.mine(hash, [{ from, to, amount }]);
const rows = () => db.sql<Array<{ purchase_key: string; state: string; tx_hash: string | null }>>`
  SELECT purchase_key, state, tx_hash FROM academy.course_purchases ORDER BY n`;
const grants = () => db.sql<Array<{ state: string; source: string }>>`SELECT state, source FROM academy.access_grants`;
const events = () =>
  db.sql<Array<{ kind: string; key: string; reason: string | null; actor_id: string | null }>>`
    SELECT kind, key, reason, actor_id FROM academy.access_grant_events ORDER BY n`;

beforeEach(async () => {
  await db.truncateAll();
  chain = new FakeChain();
  ledger = new FakeLedger();
  refunds = new FakeRefunds();
  links = new Map([[L, [WALLET]]]);
  make();
});

describe('course purchases', () => {
  it('tracks: no price closes the paid track no_price; payments off closes it payments_off; priced and set up opens it', async () => {
    await paidCourse(null);
    expect((await learners.terms({ userId: L, slug: 'perps-101' })).tracks[1]).toEqual({
      track: 'certificate',
      free: false,
      closed: 'no_price',
    });
    await expect(purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET })).rejects.toMatchObject({ code: 'academy.price_unset' });
    await db.sql`UPDATE academy.courses SET price = '2.5', price_asset = 'USDC'`;
    expect((await learners.terms({ userId: L, slug: 'perps-101' })).tracks[1]!.closed).toBeNull();
    // Priced in an asset the payment token is not: not sold.
    await db.sql`UPDATE academy.courses SET price_asset = 'USDT'`;
    expect((await learners.terms({ userId: L, slug: 'perps-101' })).tracks[1]!.closed).toBe('payments_off');
    make(null);
    await db.sql`UPDATE academy.courses SET price_asset = 'USDC'`;
    expect((await learners.terms({ userId: L, slug: 'perps-101' })).tracks[1]!.closed).toBe('payments_off');
    await expect(purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET })).rejects.toMatchObject({ code: 'academy.payments_off' });
    expect(await rows()).toHaveLength(0);
  });

  it("a payer must be the buyer's own linked wallet: another person's payment is never counted for someone else", async () => {
    await paidCourse();
    const B = '66666666-6666-4666-8666-666666666666';
    // B names L's wallet: refused, so no intent of B's can ever match L's transfer.
    await expect(purchases.buy({ userId: B, slug: 'perps-101', wallet: WALLET })).rejects.toMatchObject({
      code: 'academy.wallet_not_linked',
    });
    expect(await rows()).toHaveLength(0);
    // L pays; the reconciler counts it for L only, and B has nothing to claim it with.
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    pay();
    chain.head += 1n;
    await purchases.reconcile();
    expect(await rows()).toEqual([{ purchase_key: KEY, state: 'posted', tx_hash: PAY }]);
    await expect(purchases.submitPayment({ userId: B, key: KEY, txHash: PAY })).rejects.toMatchObject({
      code: 'academy.purchase_not_found',
    });
    // A wallet linked to nobody, an inactive account, and identity unread all refuse, and open nothing.
    await expect(purchases.buy({ userId: B, slug: 'perps-101', wallet: OTHER.slice(0, 42) })).rejects.toMatchObject({
      code: 'academy.wallet_not_linked',
    });
    links = null;
    await expect(purchases.buy({ userId: B, slug: 'perps-101', wallet: WALLET })).rejects.toMatchObject({ code: 'academy.wallet_unread' });
    expect(await rows()).toHaveLength(1);
  });

  it('enrolling on the paid track needs a recorded purchase', async () => {
    await paidCourse();
    await expect(learners.enrol({ userId: L, slug: 'perps-101', track: 'certificate', now: NOW })).rejects.toMatchObject({
      code: 'academy.payment_required',
    });
    expect((await learners.enrol({ userId: L, slug: 'perps-101', track: 'audit', now: NOW })).enrolment?.track).toBe('audit');
  });

  it('Buy stores the intent and asks for one signature; a second Buy answers the same purchase with no request', async () => {
    await paidCourse();
    await expect(purchases.buy({ userId: L, slug: 'perps-101', wallet: 'not-a-wallet' })).rejects.toMatchObject({
      code: 'academy.wallet_invalid',
    });
    const first = await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET.toUpperCase().replace('0X', '0x') });
    expect(first.request).toEqual({
      chainId: 84532,
      to: TOKEN,
      data: `0xa9059cbb${RECEIVER.slice(2).padStart(64, '0')}${(2_500_000).toString(16).padStart(64, '0')}`,
    });
    expect(first.purchase).toMatchObject({
      key: KEY,
      state: 'awaiting_signature',
      amount: '2.5',
      asset: 'USDC',
      payer: WALLET,
      grant: null,
    });
    const twice = await Promise.all([1, 2].map(() => purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET })));
    for (const again of twice) expect(again).toMatchObject({ request: null, purchase: { key: KEY, state: 'awaiting_signature' } });
    expect(await rows()).toHaveLength(1);
  });

  it('two first presses at once open one intent, and only one answer carries the request', async () => {
    await paidCourse();
    const answers = await Promise.all([1, 2, 3].map(() => purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET })));
    expect(answers.filter((a) => a.request !== null)).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it('a rejected signature leaves no purchase; Buy again reopens the same key and asks once more', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    const gone = await purchases.abandon({ userId: L, key: KEY });
    expect(gone.purchase).toBeNull();
    const again = await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    expect(again.request).not.toBeNull();
    expect(again.purchase?.key).toBe(KEY);
    expect(await rows()).toEqual([{ purchase_key: KEY, state: 'awaiting_signature', tx_hash: null }]);
    // Another learner cannot touch it.
    await expect(purchases.abandon({ userId: STAFF, key: KEY })).rejects.toMatchObject({ code: 'academy.purchase_not_found' });
  });

  it('a set-aside intent whose payment did go out is found on the chain, never left abandoned', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    pay();
    const view = await purchases.abandon({ userId: L, key: KEY });
    expect(view.purchase).toMatchObject({ state: 'submitted', txHash: PAY });
  });

  it('a payment sent but not yet mined when the intent was set aside is found by the reconciler once mined, and posted once', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    // The wallet sent it, its answer was lost, and the learner set the intent aside before it was mined.
    expect((await purchases.abandon({ userId: L, key: KEY })).purchase).toBeNull();
    expect(await rows()).toEqual([{ purchase_key: KEY, state: 'abandoned', tx_hash: null }]);
    pay();
    chain.head += 1n;
    await purchases.reconcile();
    expect(await rows()).toEqual([{ purchase_key: KEY, state: 'posted', tx_hash: PAY }]);
    expect(ledger.calls).toEqual([KEY]);
    expect(await grants()).toEqual([{ state: 'granted', source: 'purchase' }]);
    await purchases.reconcile();
    expect(ledger.calls).toEqual([KEY]);
  });

  it('a reopened intent keeps its first block, so a payment sent before it was set aside is still found for it', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    const first = (await db.sql<Array<{ from_block: string }>>`SELECT from_block FROM academy.course_purchases`)[0]!.from_block;
    await purchases.abandon({ userId: L, key: KEY });
    // Blocks pass, then Buy again: one intent, the same key and the same first block.
    chain.head += 5n;
    const again = await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    expect(again.request).not.toBeNull();
    const reopened = (await db.sql<Array<{ from_block: string }>>`SELECT from_block FROM academy.course_purchases`)[0]!.from_block;
    expect(reopened).toBe(first);
    // The first send is mined at a block before the reopen would have started: it is found and counted once.
    chain.txs.set(PAY, {
      block: BigInt(first) + 1n,
      transfers: [{ from: WALLET, to: RECEIVER, amount: 2_500_000n, txHash: PAY, blockNumber: BigInt(first) + 1n }],
    });
    chain.head += 1n;
    await purchases.reconcile();
    expect(await rows()).toEqual([{ purchase_key: KEY, state: 'posted', tx_hash: PAY }]);
    expect(ledger.calls).toEqual([KEY]);
  });

  it('the grant appears only after the payment confirmed and posted, once, under the purchase key', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    // Sent, not yet mined: waits.
    expect((await purchases.submitPayment({ userId: L, key: KEY, txHash: PAY })).purchase).toMatchObject({
      state: 'submitted',
      grant: null,
    });
    pay();
    // One confirmation of the owner's two: still waiting, nothing posted, no grant.
    expect((await purchases.view({ userId: L, slug: 'perps-101' })).purchase).toMatchObject({ state: 'submitted', grant: null });
    expect(ledger.calls).toEqual([]);
    expect(await grants()).toEqual([]);
    chain.head += 1n;
    const posted = (await purchases.view({ userId: L, slug: 'perps-101' })).purchase;
    expect(posted).toMatchObject({ state: 'posted', grant: 'granted', txHash: PAY });
    expect(ledger.calls).toEqual([KEY]);
    const booked = ledger.booked.get(KEY)!.request as {
      entries: Array<{ direction: string; amount: bigint }>;
      meta: Record<string, unknown>;
    };
    expect(booked.entries.map((e) => [e.direction, e.amount])).toEqual([
      ['debit', 2_500_000_000_000_000_000n],
      ['credit', 2_500_000_000_000_000_000n],
    ]);
    expect(await grants()).toEqual([{ state: 'granted', source: 'purchase' }]);
    expect(await events()).toEqual([{ kind: 'granted', key: `purchase:${KEY}`, reason: null, actor_id: L }]);
    expect((await learners.enrol({ userId: L, slug: 'perps-101', track: 'certificate', now: NOW })).enrolment?.track).toBe('certificate');
    // Read again and reconciled again: no second post.
    await purchases.reconcile();
    await purchases.view({ userId: L, slug: 'perps-101' });
    expect(ledger.calls).toEqual([KEY]);
    expect((await purchases.staffRead(KEY)).ledgerTxId).toBe('tx-1');
  });

  it('a lost report of the sent payment is settled from the chain: one purchase, one post', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    pay();
    chain.head += 1n;
    expect(await purchases.reconcile()).toBe(1);
    expect(await rows()).toEqual([{ purchase_key: KEY, state: 'posted', tx_hash: PAY }]);
    expect(ledger.calls).toEqual([KEY]);
    // The hash reported late changes nothing.
    expect((await purchases.submitPayment({ userId: L, key: KEY, txHash: PAY })).purchase?.state).toBe('posted');
    expect(ledger.calls).toEqual([KEY]);
  });

  it('a transfer of another amount, or one already counted, is not taken for the payment', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    pay(OTHER, 1_000_000n);
    await purchases.reconcile();
    expect((await rows())[0]!.state).toBe('awaiting_signature');
  });

  it('a reverted payment or one that paid something else fails, with no grant; Buy then opens the same key again', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    chain.mine(PAY, [], true);
    expect((await purchases.submitPayment({ userId: L, key: KEY, txHash: PAY })).purchase).toMatchObject({
      state: 'failed',
      failure: 'payment_reverted',
      grant: null,
    });
    const again = await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    expect(again.request).not.toBeNull();
    pay(OTHER, 2_500_000n, WALLET, '0x00000000000000000000000000000000000000ee');
    chain.head += 2n;
    expect((await purchases.submitPayment({ userId: L, key: KEY, txHash: OTHER })).purchase).toMatchObject({
      state: 'failed',
      failure: 'payment_mismatch',
    });
    expect(ledger.calls).toEqual([]);
    expect(await grants()).toEqual([]);
  });

  it('one purchase whose read fails is reported with its key; the others still move', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    await purchases.submitPayment({ userId: L, key: KEY, txHash: PAY });
    const broken = chain.transaction.bind(chain);
    chain.transaction = async () => {
      throw new Error('the node answered nonsense');
    };
    const failed: string[] = [];
    expect(await purchases.reconcile(100, (key) => failed.push(key))).toBe(1);
    expect(failed).toEqual([KEY]);
    chain.transaction = broken;
    expect((await rows())[0]!.state).toBe('submitted');
  });

  it('an unreadable node is not "no payment": the purchase stays where it was', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    await purchases.submitPayment({ userId: L, key: KEY, txHash: PAY });
    chain.down = true;
    expect((await purchases.view({ userId: L, slug: 'perps-101' })).purchase?.state).toBe('submitted');
    await expect(purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET })).resolves.toMatchObject({ request: null });
  });

  it('a lost ledger answer is posted again on the same key and booked once; a refusal is posted again after the deadline', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    pay();
    chain.head += 1n;
    ledger.next = 'lost';
    expect((await purchases.submitPayment({ userId: L, key: KEY, txHash: PAY })).purchase).toMatchObject({
      state: 'confirmed',
      grant: null,
    });
    expect(await grants()).toEqual([]);
    await purchases.reconcile();
    expect(ledger.calls).toEqual([KEY, KEY]);
    expect(ledger.booked.size).toBe(1);
    expect((await rows())[0]!.state).toBe('posted');

    await db.truncateAll();
    ledger = new FakeLedger();
    make();
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    pay(OTHER);
    chain.head += 1n;
    ledger.next = 'refuse';
    expect((await purchases.submitPayment({ userId: L, key: KEY, txHash: OTHER })).purchase).toMatchObject({
      state: 'confirmed',
      failure: 'ledger.frozen',
      grant: null,
    });
    // Within the post deadline it is not posted again; after it (the freeze lifted), it is, once, on the same key.
    await purchases.reconcile();
    expect(ledger.calls).toEqual([KEY]);
    await db.sql`UPDATE academy.course_purchases SET updated_at = now() - interval '5 minutes'`;
    await purchases.reconcile();
    expect(ledger.calls).toEqual([KEY, KEY]);
    expect(ledger.booked.size).toBe(1);
    expect(await rows()).toEqual([{ purchase_key: KEY, state: 'posted', tx_hash: OTHER }]);
  });

  it('a crash while posting is taken again only after the post deadline', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    pay();
    chain.head += 1n;
    await db.sql`UPDATE academy.course_purchases SET state = 'confirmed', tx_hash = ${PAY}, post_state = 'posting', updated_at = now()`;
    await purchases.reconcile();
    expect(ledger.calls).toEqual([]);
    await db.sql`UPDATE academy.course_purchases SET updated_at = now() - interval '5 minutes'`;
    await purchases.reconcile();
    expect(ledger.calls).toEqual([KEY]);
    expect((await rows())[0]!.state).toBe('posted');
  });

  it('a staff refund: stored with its reason and who, sent once under its key, posted once as the reverse, and the grant revoked', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    pay();
    chain.head += 1n;
    await purchases.submitPayment({ userId: L, key: KEY, txHash: PAY });
    await learners.enrol({ userId: L, slug: 'perps-101', track: 'certificate', now: NOW });

    await expect(purchases.refund({ key: KEY, reason: '  ', actorId: STAFF })).rejects.toMatchObject({ code: 'academy.reason_required' });
    await expect(purchases.refund({ key: 'academy:purchase:nope', reason: 'r', actorId: STAFF })).rejects.toMatchObject({
      code: 'academy.purchase_not_found',
    });
    refunds.answer = 'lost';
    const refunding = await purchases.refund({ key: KEY, reason: 'asked within the window', actorId: STAFF });
    expect(refunding).toMatchObject({ state: 'refunding', refund: { txHash: null, reason: 'asked within the window' } });
    // The signer's answer was lost: asked again under the same key, which answers the same transaction.
    refunds.answer = 'hash';
    await purchases.reconcile();
    expect(refunds.sends).toEqual([
      { key: REFUND_KEY, chainId: 84532, token: TOKEN, to: WALLET, amount: 2_500_000n },
      { key: REFUND_KEY, chainId: 84532, token: TOKEN, to: WALLET, amount: 2_500_000n },
    ]);
    // Sent, not yet confirmed twice: no reverse post, the grant stands.
    expect((await purchases.staffRead(KEY)).state).toBe('refunding');
    expect(ledger.calls).toEqual([KEY]);
    chain.mine(REFUND_TX, [{ from: RECEIVER, to: WALLET, amount: 2_500_000n }]);
    chain.head += 1n;
    const refunded = await purchases.staffRead(KEY);
    expect(refunded).toMatchObject({
      state: 'refunded',
      grant: 'revoked',
      refund: { txHash: REFUND_TX, reason: 'asked within the window' },
    });
    expect(refunded.refundLedgerTxId).toBe('tx-2');
    expect(ledger.calls).toEqual([KEY, REFUND_KEY]);
    const reverse = ledger.booked.get(REFUND_KEY)!.request as { entries: Array<{ direction: string }> };
    expect(reverse.entries.map((e) => e.direction)).toEqual(['credit', 'debit']);
    expect(await grants()).toEqual([{ state: 'revoked', source: 'purchase' }]);
    expect((await events()).at(-1)).toEqual({
      kind: 'revoked',
      key: `refund:${REFUND_KEY}`,
      reason: 'asked within the window',
      actor_id: STAFF,
    });
    expect((await learners.terms({ userId: L, slug: 'perps-101' })).enrolment).toBeNull();
    await expect(learners.enrol({ userId: L, slug: 'perps-101', track: 'certificate', now: NOW })).rejects.toMatchObject({
      code: 'academy.payment_required',
    });
    // A repeat answers the same refund; nothing is sent or posted again.
    expect((await purchases.refund({ key: KEY, reason: 'again', actorId: STAFF })).state).toBe('refunded');
    await purchases.reconcile();
    expect(refunds.sends).toHaveLength(2);
    expect(ledger.calls).toEqual([KEY, REFUND_KEY]);
    // Bought again after the refund: a new purchase, n = 2.
    const next = await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    expect(next.purchase?.key).toBe(`academy:purchase:perps-101:${L}:2`);
  });

  it('a refund is sent by one caller at a time: a staff read, a view and the reconciler arriving mid-send send nothing more', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    pay();
    chain.head += 1n;
    await purchases.submitPayment({ userId: L, key: KEY, txHash: PAY });
    let release!: () => void;
    refunds.hold = new Promise((resolve) => (release = resolve));
    const first = purchases.refund({ key: KEY, reason: 'asked within the window', actorId: STAFF });
    await expect.poll(() => refunds.sends.length).toBe(1);
    // While the first send is in flight, every other way in reaches the refund and sends nothing.
    await Promise.all([purchases.reconcile(), purchases.staffRead(KEY), purchases.view({ userId: L, slug: 'perps-101' })]);
    expect(refunds.sends).toHaveLength(1);
    release();
    expect(await first).toMatchObject({ state: 'refunding', refund: { txHash: REFUND_TX } });
    refunds.hold = null;
    await purchases.reconcile();
    expect(refunds.sends).toHaveLength(1);
  });

  it('a transfer two open intents of the same wallet could both have paid is taken for neither until the wallet reports its hash', async () => {
    await paidCourse();
    await paidCourse('2.5', 'USDC', 'perps-102');
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    await purchases.buy({ userId: L, slug: 'perps-102', wallet: WALLET });
    pay();
    chain.head += 1n;
    await purchases.reconcile();
    expect((await rows()).map((r) => r.state)).toEqual(['awaiting_signature', 'awaiting_signature']);
    expect(ledger.calls).toEqual([]);
    // The wallet's reported hash says which course it paid: that one only.
    const KEY_102 = `academy:purchase:perps-102:${L}:1`;
    await purchases.submitPayment({ userId: L, key: KEY_102, txHash: PAY });
    await purchases.reconcile();
    const states = await db.sql<Array<{ purchase_key: string; state: string; tx_hash: string | null }>>`
      SELECT purchase_key, state, tx_hash FROM academy.course_purchases ORDER BY purchase_key`;
    expect(states).toEqual([
      { purchase_key: KEY, state: 'awaiting_signature', tx_hash: null },
      { purchase_key: KEY_102, state: 'posted', tx_hash: PAY },
    ]);
    expect(ledger.calls).toEqual([KEY_102]);
  });

  it('a purchase not yet recorded cannot be refunded; a refund transaction that sends something else is stopped, never sent again', async () => {
    await paidCourse();
    await purchases.buy({ userId: L, slug: 'perps-101', wallet: WALLET });
    await expect(purchases.refund({ key: KEY, reason: 'r', actorId: STAFF })).rejects.toMatchObject({ code: 'academy.purchase_state' });
    pay();
    chain.head += 1n;
    await purchases.submitPayment({ userId: L, key: KEY, txHash: PAY });
    await purchases.refund({ key: KEY, reason: 'r', actorId: STAFF });
    chain.mine(REFUND_TX, [{ from: RECEIVER, to: WALLET, amount: 1n }]);
    chain.head += 1n;
    await purchases.reconcile();
    await purchases.reconcile();
    expect((await purchases.staffRead(KEY)).state).toBe('refunding');
    expect(refunds.sends).toHaveLength(1);
    expect(ledger.calls).toEqual([KEY]);
    expect(await grants()).toEqual([{ state: 'granted', source: 'purchase' }]);
  });

  it('with no refund signer, a refund refuses by name and nothing changes', async () => {
    await paidCourse();
    purchases = new CoursePurchases(db.sql, { settings: SETTINGS, chain, ledger: purchaseLedger(ledger.client), refunds: null, wallets });
    await expect(purchases.refund({ key: KEY, reason: 'r', actorId: STAFF })).rejects.toMatchObject({
      code: 'academy.refund_sender_unset',
    });
  });
});
