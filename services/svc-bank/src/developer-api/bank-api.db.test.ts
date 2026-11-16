/**
 * J-bank-24 through the real router (BK-bdev-01, BK-bdev-02): the bank API over the TEST partner bank's record. Accounts are
 * listed with the partner's figures and a typed filter, with spend-today as decimal strings; a locked pot refuses a move; a
 * move on the partner's quote is one partner move per dedupe id, retried after a lost answer on the same key; a payment out is
 * refused `rail.bank` with its intent row kept until the partner carries a rail, then made once per idempotency key; each
 * state change the partner reports is one signed webhook delivery carrying the previous and current state, and a replayed
 * report delivers nothing. The ledger posts nothing. Uses TEST_DATABASE_URL. Does not start Docker.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { createEdgeContext, encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger } from '@intafaced/ledger-client';
import { createBankServices, memoryRecipientState } from '../bank-service.js';
import { memoryLedgerHistory } from '../analytics/ledger-history.js';
import { createBankRouter } from '../router.js';
import { testPartner, type TestPartner } from '../partner/test-partner.js';
import { memoryBusinessDirectory, type DirectoryPerson } from '../business/business-directory.js';

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const SECRET = 'c'.repeat(32);
const SID = '99999999-9999-4999-8999-999999999999';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(1);
const MEMBER = id(2);
const PEOPLE: DirectoryPerson[] = [
  [OWNER, 'owner'],
  [MEMBER, 'member'],
].map(([userId, handle]) => ({ userId: userId!, handle: handle!, email: `${handle}@example.test`, status: 'active' as const }));
const RECIPIENT = { name: 'TEST Supplier Inc', accountNumber: '000123456789', routingNumber: '021000021' };

/** The person signed in with a second factor (`trade:withdraw`), or, `key`, an API key: never more than bank:read and bank:write. */
function principal(userId: string, key = false): Principal {
  return {
    sub: userId,
    userId,
    sid: SID,
    scopes: key ? ['bank:read', 'bank:write'] : ['bank:read', 'bank:write', 'trade:withdraw'],
    tier: 'full',
    mfa: true,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

const codeOf = (err: unknown) => (err as { cause?: { code?: string }; code?: string }).cause?.code ?? (err as { code?: string }).code;
async function refused(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return codeOf(err);
  }
  throw new Error('expected a refusal');
}

describe('the bank API (J-bank-24)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let partner: TestPartner;
  let hook: Server;
  let hookUrl = '';
  let hookStatus = 200;
  const posts: Array<{ headers: Record<string, string | string[] | undefined>; raw: string }> = [];

  beforeAll(async () => {
    const raw = process.env.TEST_DATABASE_URL?.trim();
    if (!raw) throw new Error('TEST_DATABASE_URL is unset. This suite does not start Docker.');
    const url = new URL(raw);
    if (!url.pathname.replace(/^\//, '').endsWith('_test')) url.pathname = '/intafaced_test';
    db = await createTestDatabase({ service: 'bank', url: url.toString(), migrations });
    sql = db.sql;
    hook = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        posts.push({ headers: req.headers, raw: Buffer.concat(chunks).toString('utf8') });
        res.statusCode = hookStatus;
        res.end();
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, '127.0.0.1', resolve));
    const address = hook.address();
    hookUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/hooks`;
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => hook?.close(() => resolve()));
    await db?.drop();
  });

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.api_webhook_deliveries, bank.api_webhook_endpoints, bank.api_transfer_events, bank.api_payments,
               bank.api_moves, bank.api_move_quotes, bank.shared_pot_members, bank.shared_pot_invites, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    partner = testPartner();
    posts.length = 0;
    hookStatus = 200;
  });

  function services() {
    return createBankServices(sql, ledger, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients: memoryRecipientState(),
      testPartner: partner,
      postingFreeze: { postingEnabled: async () => true },
      directory: memoryBusinessDirectory(PEOPLE),
      spaceLimit: '10',
      spaceUnlockWaitHours: '24',
      sharedPotInviteMinutes: '10',
      sharedPotPeopleCap: '5',
      bankApi: { allowLocalHttp: true },
    });
  }
  let bank = services();
  function as(userId: string, key = false) {
    const raw = encodePrincipal(principal(userId, key));
    const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-bank' });
    return createBankRouter(bank).createCaller(
      edge({
        headers: {
          'x-intafaced-principal': raw,
          'x-intafaced-principal-sig': signPrincipalHeader(raw, SECRET, 'DE'),
          'x-intafaced-region': 'DE',
        },
        id: `req-${randomUUID()}`,
      }),
    );
  }

  /** The owner's EUR money at the TEST partner: TEST 100 in the main balance, a savings pot, a pot shared with the member, a locked pot. */
  async function start() {
    bank = services();
    const owner = as(OWNER);
    await owner.testPartner.set({ custody: 'off' });
    await as(MEMBER).testPartner.set({ custody: 'off' });
    await owner.testPartner.fund({ fundId: `fund-${randomUUID()}`, assetId: 'EUR', amount: '100' });
    const savings = await owner.spaces.create({ assetId: 'EUR', name: 'TEST Savings' });
    const joint = await owner.spaces.create({ assetId: 'EUR', name: 'TEST Household' });
    const locked = await owner.spaces.create({
      assetId: 'EUR',
      name: 'TEST Locked',
      lockedUntil: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    });
    const invite = await owner.sharedPots.invite({ inviteId: randomUUID(), spaceId: joint.id, handle: 'member', role: 'contributor' });
    await as(MEMBER).sharedPots.accept({ inviteId: invite.inviteId });
    const accounts = await owner.bankApi.accounts({ limit: 50 });
    const main = accounts.items.find((a) => a.type === 'standard')!;
    return { owner, main, savings, joint, locked };
  }

  it('lists accounts with the partner figures and a typed filter; joint only for the joint filter, spend-today as decimal strings', async () => {
    const { owner, main, savings, joint, locked } = await start();
    const all = (await owner.bankApi.accounts({ limit: 50 })).items;
    expect(all.map((a) => [a.name, a.type]).sort()).toEqual(
      [
        ['Main', 'standard'],
        ['TEST Household', 'joint'],
        ['TEST Locked', 'savings'],
        ['TEST Savings', 'savings'],
      ].sort(),
    );
    expect(main).toMatchObject({ balance: '100', figure: 'known', heldAt: 'TEST partner bank', spendToday: '0', locked: false });
    expect(all.find((a) => a.id === locked.id)).toMatchObject({ locked: true });

    // TEST 12.5 leaves the main balance as a payment: spend-today on the partner's record.
    await owner.testPartner.set({ bankRail: 'test' });
    await owner.bankApi.createPayment({
      idempotencyKey: 'jb24-spend-1',
      fromAccountId: main.id,
      method: 'instant',
      recipient: RECIPIENT,
      amount: '12.5',
    });
    const joints = (await owner.bankApi.accounts({ type: 'joint', limit: 50 })).items;
    expect(joints).toEqual([expect.objectContaining({ id: joint.id, type: 'joint', owner: 'self', balance: '0', spendToday: '0' })]);
    expect((await owner.bankApi.accounts({ type: 'standard', limit: 50 })).items).toEqual([
      expect.objectContaining({ id: main.id, balance: '87.5', spendToday: '12.5' }),
    ]);
    for (const a of all) expect(typeof a.spendToday).toBe('string');
    // The member sees the pot shared with them as a joint account, the owner's.
    expect((await as(MEMBER).bankApi.accounts({ type: 'joint', limit: 50 })).items).toEqual([
      expect.objectContaining({ id: joint.id, owner: 'other' }),
    ]);
    expect(savings.id).toBeTruthy();
    expect(ledger.journal()).toEqual([]);
  });

  it('a locked pot refuses a move; a move on a quote is one partner move per dedupe id, the same reply twice', async () => {
    const { owner, main, savings, locked } = await start();
    expect(await refused(owner.bankApi.quoteMove({ fromAccountId: locked.id, toAccountId: main.id, amount: '1' }))).toBe(
      'bank.space_locked',
    );

    const q = await owner.bankApi.quoteMove({ fromAccountId: main.id, toAccountId: savings.id, amount: '25' });
    expect(q).toMatchObject({ amount: '25', fee: '0', receives: '25', assetId: 'EUR', heldAt: 'TEST partner bank' });
    const once = await owner.bankApi.move({ quoteId: q.quoteId, dedupeId: 'jb24-move-1' });
    const twice = await owner.bankApi.move({ quoteId: q.quoteId, dedupeId: 'jb24-move-1' });
    expect(once).toMatchObject({ state: 'completed', quote: { quoteId: q.quoteId } });
    expect(twice).toEqual(once);
    const record = partner.record(OWNER);
    expect(record.moves.filter((m) => m.key === `bank.api.move:${OWNER}:jb24-move-1`)).toHaveLength(1);
    expect((await owner.bankApi.accounts({ type: 'savings', limit: 50 })).items.find((a) => a.id === savings.id)).toMatchObject({
      balance: '25',
    });

    // The same dedupe id on another quote is a different instruction.
    const q2 = await owner.bankApi.quoteMove({ fromAccountId: main.id, toAccountId: savings.id, amount: '5' });
    expect(await refused(owner.bankApi.move({ quoteId: q2.quoteId, dedupeId: 'jb24-move-1' }))).toBe('bank.idempotency_conflict');

    // A lost answer: the row stays pending, and the retry under the same id makes the move once.
    await owner.testPartner.set({ nextReply: 'lost' });
    expect(await refused(owner.bankApi.move({ quoteId: q2.quoteId, dedupeId: 'jb24-move-2' }))).toBe('bank.partner_reply_lost');
    expect(await owner.bankApi.move({ quoteId: q2.quoteId, dedupeId: 'jb24-move-2' })).toMatchObject({ state: 'completed' });
    expect(partner.record(OWNER).moves.filter((m) => m.key === `bank.api.move:${OWNER}:jb24-move-2`)).toHaveLength(1);

    // An expired quote and an unknown fee are refused by name, with nothing moved.
    await sql`UPDATE bank.api_move_quotes SET valid_until = now() - interval '1 second' WHERE quote_id = ${q2.quoteId}`;
    expect(await refused(owner.bankApi.move({ quoteId: q2.quoteId, dedupeId: 'jb24-move-3' }))).toBe('bank.quote_expired');
    await owner.testPartner.set({ fee: 'unknown' });
    const q3 = await owner.bankApi.quoteMove({ fromAccountId: main.id, toAccountId: savings.id, amount: '5' });
    expect(q3).toMatchObject({ fee: null, receives: null });
    expect(await refused(owner.bankApi.move({ quoteId: q3.quoteId, dedupeId: 'jb24-move-4' }))).toBe('bank.partner_fee_unknown');
    // Only a shared pot's owner takes money out of it.
    const joint = (await as(MEMBER).bankApi.accounts({ type: 'joint', limit: 50 })).items[0]!;
    expect(await refused(as(MEMBER).bankApi.quoteMove({ fromAccountId: joint.id, toAccountId: main.id, amount: '1' }))).toBe(
      'bank.space_forbidden',
    );
    expect(ledger.journal()).toEqual([]);
  });

  it('a payment with no rail is refused rail.bank with its intent row kept; with the rail, instant and ACH are each one partner payment', async () => {
    const { owner, main } = await start();
    const ask = { fromAccountId: main.id, recipient: RECIPIENT, amount: '10' };
    // An API key never sends money off the platform: a payment out takes the person's own session after its second factor.
    expect(await refused(as(OWNER, true).bankApi.createPayment({ ...ask, idempotencyKey: 'jb24-pay-key', method: 'ach' }))).toBe(
      'scope.denied',
    );
    expect((await owner.bankApi.payments({ limit: 10 })).items).toEqual([]);
    expect(await refused(owner.bankApi.createPayment({ ...ask, idempotencyKey: 'jb24-pay-none', method: 'instant' }))).toBe('rail.bank');
    expect(await refused(owner.bankApi.createPayment({ ...ask, idempotencyKey: 'jb24-pay-none', method: 'instant' }))).toBe('rail.bank');
    expect((await owner.bankApi.payments({ limit: 10 })).items).toEqual([
      expect.objectContaining({ idempotencyKey: 'jb24-pay-none', state: 'refused', refusalCode: 'rail.bank' }),
    ]);

    await owner.testPartner.set({ bankRail: 'test' });
    const instant = await owner.bankApi.createPayment({ ...ask, idempotencyKey: 'jb24-pay-instant', method: 'instant' });
    const ach = await owner.bankApi.createPayment({ ...ask, idempotencyKey: 'jb24-pay-ach', method: 'ach' });
    expect(instant).toMatchObject({ method: 'instant', state: 'pending', version: 1, heldAt: 'TEST partner bank' });
    expect(ach).toMatchObject({ method: 'ach', state: 'pending', version: 1 });
    expect(await owner.bankApi.createPayment({ ...ask, idempotencyKey: 'jb24-pay-ach', method: 'ach' })).toMatchObject({ id: ach.id });
    expect(await refused(owner.bankApi.createPayment({ ...ask, amount: '11', idempotencyKey: 'jb24-pay-ach', method: 'ach' }))).toBe(
      'bank.idempotency_conflict',
    );
    expect(partner.record(OWNER).moves.filter((m) => m.key.startsWith(`pay:${OWNER}:`))).toHaveLength(2);
    expect((await owner.bankApi.accounts({ type: 'standard', limit: 5 })).items[0]).toMatchObject({ balance: '80' });
    expect(ledger.journal()).toEqual([]);
  });

  it('each reported state change is one signed delivery with the previous and current state; a replayed report delivers nothing', async () => {
    const { owner, main } = await start();
    const made = await owner.bankApi.createWebhook({ endpointId: randomUUID(), url: hookUrl });
    expect(made.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect((await owner.bankApi.createWebhook({ endpointId: made.id, url: hookUrl })).secret).toBeNull();
    expect(await refused(owner.bankApi.createWebhook({ endpointId: randomUUID(), url: 'http://10.0.0.5/hooks' }))).toBe(
      'bank.webhook_url_invalid',
    );

    await owner.testPartner.set({ bankRail: 'test' });
    const pay = await owner.bankApi.createPayment({
      idempotencyKey: 'jb24-hook-1',
      fromAccountId: main.id,
      method: 'ach',
      recipient: RECIPIENT,
      amount: '3',
    });
    const settled = await owner.testPartner.settlePayment({ paymentId: pay.id });
    expect(settled).toMatchObject({ state: 'completed', version: 2, recorded: true });
    const replay = await owner.testPartner.settlePayment({ paymentId: pay.id });
    expect(replay).toMatchObject({ state: 'completed', version: 2, recorded: false });
    await bank.bankApi.drain();

    const changed = posts.map((p) => JSON.parse(p.raw)).filter((b) => b.transferId === pay.id && b.version === 2);
    expect(changed).toEqual([expect.objectContaining({ previousState: 'pending', currentState: 'completed', amount: '3' })]);
    const post = posts.find((p) => JSON.parse(p.raw).version === 2)!;
    const expected = createHmac('sha256', made.secret!).update(`${post.headers['x-intafaced-timestamp']}.${post.raw}`).digest('hex');
    expect(post.headers['x-intafaced-signature']).toBe(`v1=${expected}`);
    expect(post.headers['x-intafaced-event-id']).toBe(`bank.transfer.state_changed:${pay.id}:2`);
    const log = (await owner.bankApi.deliveries({ paymentId: pay.id, limit: 10 })).items;
    expect(log.map((d) => [d.previous, d.current, d.state, d.attempts])).toEqual([
      ['pending', 'completed', 'delivered', 1],
      [null, 'pending', 'delivered', 1],
    ]);
    expect((await owner.bankApi.payment({ paymentId: pay.id })).state).toBe('completed');

    // An endpoint that does not take a delivery: the attempt is kept with its answer.
    hookStatus = 500;
    const second = await owner.bankApi.createPayment({
      idempotencyKey: 'jb24-hook-2',
      fromAccountId: main.id,
      method: 'instant',
      recipient: RECIPIENT,
      amount: '1',
    });
    await bank.bankApi.drain();
    expect((await owner.bankApi.deliveries({ paymentId: second.id, limit: 10 })).items).toEqual([
      expect.objectContaining({ current: 'pending', state: 'failed', attempts: 1, lastStatus: 500 }),
    ]);
    expect(ledger.journal()).toEqual([]);
  });
});
