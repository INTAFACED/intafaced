import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEdgeContext, internalWithdrawalTransferId } from '@intafaced/contracts';
import { createTestDatabase, type TestDatabase } from '@intafaced/db';
import { MemoryLedger, formatAmount, parseAmount, recipes, stampPostAttempts, userAvailable } from '@intafaced/ledger-client';
import { createBankRouter } from '../router.js';
import { createBankServices, memoryLedgerHistory, memoryRecipientState, type BankServices } from '../bank-service.js';
import { BankError } from '../errors.js';
import { PersonalPayService } from './personal-pay.js';
import { memoryPartyHandles } from './party-handles.js';

/**
 * W-withdraw-14: svc-pay's withdrawal to another person's platform address, settled by svc-bank as one person-to-person send
 * under `withdraw:<withdrawal id>`. One send per key, the receiver sees the sender, a refusal only when nothing posted, and the
 * door answers svc-pay and nobody else.
 */

const here = dirname(fileURLToPath(import.meta.url));
const drizzle = join(here, '..', '..', 'drizzle');
const migrations = readdirSync(drizzle)
  .filter((f) => f.endsWith('.sql') && !f.endsWith('.down.sql'))
  .sort()
  .map((f) => readFileSync(join(drizzle, f), 'utf8'));

const ADA = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const W1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const W2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const edge = createEdgeContext({ secret: 'a-bank-internal-withdrawal-test-secret-32', serviceName: 'svc-bank' });

describe('internal withdrawal settlement (Postgres)', () => {
  let db: TestDatabase | undefined;
  let sql!: TestDatabase['sql'];
  let ledger: MemoryLedger;
  let recipients: ReturnType<typeof memoryRecipientState>;
  let bank: BankServices;
  let locked: boolean;

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL?.trim();
    if (!url) throw new Error('TEST_DATABASE_URL is unset');
    db = await createTestDatabase({ service: 'bank', url, migrations });
    sql = db.sql;
  }, 120_000);

  afterAll(async () => {
    await db?.drop();
  }, 30_000);

  beforeEach(async () => {
    await sql`
      TRUNCATE bank.personal_request_reminds, bank.personal_transfers, bank.personal_requests,
               bank.personal_transfer_terms, bank.spaces
      RESTART IDENTITY CASCADE
    `;
    ledger = new MemoryLedger();
    recipients = memoryRecipientState();
    // As the HTTP ledger client does: a refused post carries its attempt count, so one attempt proves nothing committed.
    const stamped = new Proxy(ledger, {
      get(target, prop, receiver) {
        if (prop !== 'post') return Reflect.get(target, prop, receiver);
        return async (...args: Parameters<MemoryLedger['post']>) => {
          try {
            return await target.post(...args);
          } catch (err) {
            stampPostAttempts(err, 1);
            throw err;
          }
        };
      },
    });
    locked = false;
    bank = createBankServices(sql, stamped, memoryLedgerHistory(ledger), {
      nativeAssetId: 'IFC',
      recipients,
      ramps: { securityLock: { read: async () => ({ locked, unlocksAt: null, selfFrozen: false }) } },
      handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' }),
    });
    await ledger.post(recipes.deposit({ userId: ADA, assetId: 'USDT', amount: parseAmount('100'), rail: 'test', railRef: 'ada-1' }));
    await sql`INSERT INTO bank.personal_transfer_terms (asset_id, per_transfer_limit, daily_limit, fee) VALUES ('USDT', 50, 1000, 0)`;
  });

  const open = { read: async () => ({ locked: false, unlocksAt: null, selfFrozen: false }) };
  const available = async (userId: string) => formatAmount((await ledger.balance(userAvailable(userId, 'USDT'))).amount);
  const sends = () => ledger.journal().filter((tx) => tx.idempotencyKey.startsWith('bank.transfer.p2p:withdraw:'));
  const settle = (withdrawalId: string, amount: string, service = bank.personalPay) =>
    service.settleWithdrawal({
      transferId: internalWithdrawalTransferId(withdrawalId),
      fromUserId: ADA,
      toUserId: BOB,
      assetId: 'USDT',
      amount: parseAmount(amount),
    });

  it('moves the amount from the main account to the receiver once, and the receiver sees who sent it', async () => {
    // Ada has a balance and no main-account row yet: the row is made, the money comes from her own ledger account.
    const first = await settle(W1, '20');
    expect(first).toMatchObject({ state: 'posted', transferId: `withdraw:${W1}` });
    const again = await settle(W1, '20');
    expect(again).toEqual(first);
    expect(sends()).toHaveLength(1);
    expect(await available(ADA)).toBe('80');
    expect(await available(BOB)).toBe('20');
    const [row] = await sql<Array<{ status: string; from_handle: string; to_handle: string }>>`
      SELECT status, from_handle, to_handle FROM bank.personal_transfers WHERE transfer_id = ${`withdraw:${W1}`}
    `;
    expect(row).toEqual({ status: 'posted', from_handle: 'ada', to_handle: 'bob' });
  });

  it('refuses a frozen receiver before anything is reserved or posted', async () => {
    recipients.set(BOB, 'frozen');
    expect(await settle(W1, '20')).toEqual({ state: 'refused', code: 'bank.recipient_cannot_receive' });
    expect(sends()).toHaveLength(0);
    expect(await sql`SELECT 1 FROM bank.personal_transfers`).toHaveLength(0);
    expect(await available(ADA)).toBe('100');
  });

  it('refuses a frozen sender before anything is reserved or posted', async () => {
    recipients.set(ADA, 'frozen');
    expect(await settle(W1, '20')).toEqual({ state: 'refused', code: 'bank.sender_cannot_send' });
    expect(sends()).toHaveLength(0);
    expect(await sql`SELECT 1 FROM bank.personal_transfers`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM bank.spaces WHERE user_id = ${ADA}`).toHaveLength(0);
  });

  it('a refusal while an earlier ask under the key may still post is not a refusal: it throws, and after the bound it is', async () => {
    const at = new Date('2026-10-24T12:00:00.000Z');
    await bank.spaces.ensurePrimary(ADA, 'USDT');
    const from = await bank.spaces.findPrimary(ADA, 'USDT');
    // An earlier ask reserved the send and its post never answered.
    await sql`
      INSERT INTO bank.personal_transfers (transfer_id, from_user_id, from_space_id, to_user_id, asset_id, amount, status, created_at)
      VALUES (${`withdraw:${W1}`}, ${ADA}, ${from!.id}, ${BOB}, 'USDT', 20, 'reserved', ${at})
    `;
    recipients.set(BOB, 'frozen');
    const ask = (minutes: number) =>
      bank.personalPay.settleWithdrawal({
        transferId: internalWithdrawalTransferId(W1),
        fromUserId: ADA,
        toUserId: BOB,
        assetId: 'USDT',
        amount: parseAmount('20'),
        now: new Date(at.getTime() + minutes * 60_000),
      });
    await expect(ask(1)).rejects.toMatchObject({ code: 'bank.recipient_cannot_receive' });
    expect(sends()).toHaveLength(0);
    // The send's refusal path dropped the reservation, so recreate it as the earlier ask left it, past the bound.
    await sql`
      INSERT INTO bank.personal_transfers (transfer_id, from_user_id, from_space_id, to_user_id, asset_id, amount, status, created_at)
      VALUES (${`withdraw:${W1}`}, ${ADA}, ${from!.id}, ${BOB}, 'USDT', 20, 'reserved', ${at})
      ON CONFLICT DO NOTHING
    `;
    expect(await ask(8)).toEqual({ state: 'refused', code: 'bank.recipient_cannot_receive' });
  });

  it('a key already filed for a different send is never a refusal', async () => {
    await settle(W1, '20');
    await expect(settle(W1, '25')).rejects.toMatchObject({ code: 'bank.personal_transfer_conflict' });
    expect(sends()).toHaveLength(1);
  });

  it('refuses while the sender security lock holds, before anything is written; a send that posted before answers as it did', async () => {
    const first = await settle(W1, '20');
    locked = true;
    expect(await settle(W1, '20')).toEqual(first);
    expect(await settle(W2, '10')).toEqual({ state: 'refused', code: 'bank.security_locked' });
    expect(sends()).toHaveLength(1);
    expect(await sql`SELECT 1 FROM bank.personal_transfers WHERE transfer_id = ${`withdraw:${W2}`}`).toHaveLength(0);
  });

  it('with no security lock wired, every withdrawal is refused (never "no lock")', async () => {
    const unwired = createBankServices(sql, ledger, memoryLedgerHistory(ledger), { nativeAssetId: 'IFC', recipients });
    expect(await settle(W1, '20', unwired.personalPay)).toEqual({ state: 'refused', code: 'bank.security_lock_unset' });
    expect(sends()).toHaveLength(0);
  });

  it('keeps the person-to-person limits: above the per-transfer limit is refused and nothing posts', async () => {
    expect(await settle(W1, '60')).toEqual({ state: 'refused', code: 'bank.personal_transfer_limit_exceeded' });
    expect(sends()).toHaveLength(0);
  });

  it('refuses more than the sender holds, and posts nothing', async () => {
    await sql`UPDATE bank.personal_transfer_terms SET per_transfer_limit = 1000`;
    const answer = await settle(W1, '150');
    expect(answer).toEqual({ state: 'refused', code: 'ledger.insufficient_funds' });
    expect(sends()).toHaveLength(0);
    expect(await available(ADA)).toBe('100');
    // Nothing was kept, so the same key can still post once the money is there.
    expect(await settle(W1, '50')).toMatchObject({ state: 'posted' });
  });

  it('a lost answer throws (never a refusal), and the retry with the same key posts once', async () => {
    let posts = 0;
    let lookups = 0;
    const flaky = new PersonalPayService(
      sql,
      {
        getTx: (id) => ledger.getTx(id),
        // Before the send, and in the first read-back after the lost answer, the post is not seen yet (it is still landing).
        getTxByKey: async (key) => (++lookups <= 2 ? null : ledger.getTxByKey(key)),
        balance: (ref) => ledger.balance(ref),
      },
      {
        transferToUser: async (input) => {
          const posted = await bank.transfers.transferToUser(input);
          posts += 1;
          if (posts === 1) throw new Error('timeout');
          return posted;
        },
      },
      bank.spaces,
      { handles: memoryPartyHandles({ [ADA]: 'ada', [BOB]: 'bob' }), securityLock: open },
    );
    await expect(settle(W2, '30', flaky)).rejects.toThrow('timeout');
    expect(sends()).toHaveLength(1);
    const again = await settle(W2, '30', flaky);
    expect(again).toEqual({ state: 'posted', transferId: `withdraw:${W2}`, ledgerTxId: sends()[0]!.id });
    expect(sends()).toHaveLength(1);
    expect(await available(BOB)).toBe('30');
  });

  it('a refusal whose key already holds this very send answers that send, never refused', async () => {
    const first = await settle(W1, '20');
    await sql`DELETE FROM bank.personal_transfers`;
    const refusing = new PersonalPayService(
      sql,
      ledger,
      {
        transferToUser: async () => {
          throw new BankError('cannot receive', 'bank.recipient_cannot_receive');
        },
      },
      bank.spaces,
      { securityLock: open },
    );
    expect(await settle(W1, '20', refusing)).toEqual(first);
    expect(sends()).toHaveLength(1);
  });

  it('serves svc-pay only: another service is forbidden and no service is unauthorized', async () => {
    const call = (service: string | null) =>
      createBankRouter(bank)
        .createCaller({ ...edge({ headers: {}, id: 'req-1' }), service } as never)
        .transfers.settleWithdrawal({
          transferId: internalWithdrawalTransferId(W1),
          fromUserId: ADA,
          toUserId: BOB,
          assetId: 'USDT',
          amount: '20',
        });
    await expect(call('svc-trade')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(call(null)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(sends()).toHaveLength(0);
    await expect(call('svc-pay')).resolves.toMatchObject({ state: 'posted', transferId: `withdraw:${W1}` });
    expect(await available(BOB)).toBe('20');
  });

  it('invariant: every posted send is one ledger transaction under its key, and the books still balance', async () => {
    await settle(W1, '20');
    await settle(W1, '20');
    await settle(W2, '10');
    const rows = await sql<Array<{ transfer_id: string; ledger_tx_id: string }>>`
      SELECT transfer_id, ledger_tx_id FROM bank.personal_transfers WHERE status = 'posted' ORDER BY transfer_id
    `;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const tx = await ledger.getTxByKey(`bank.transfer.p2p:${row.transfer_id}:0`);
      expect(tx?.id).toBe(row.ledger_tx_id);
    }
    expect(parseAmount(await available(ADA)) + parseAmount(await available(BOB))).toBe(parseAmount('100'));
  });
});
