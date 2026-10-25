import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { earnPoolReserve, earnStakeAccount, houseFees, subAccountAvailable, userAvailable } from '../accounts.js';
import { InvalidEntryError } from '../types.js';
import { accountKey } from '../client.js';
import { bankTransferKey, legacyBankTransferKey, recoverySweepTransferId } from './bank.js';
import { recipes } from './index.js';

/**
 * BANK RECIPES (transfer + earn) — package-level.
 *
 * Earn interest is not minted: it debits a funded pool reserve. Transfer refuses
 * cross-asset and lock-kind targets. Pool funding refuses a supplied source on
 * a different asset. Occurrence is part of the transfer key so scheduled
 * re-runs cannot silently no-op.
 */

const USER = '22222222-2222-4222-8222-222222222222';
const USER_B = '33333333-3333-4333-8333-333333333333';
const POOL = 'pool-flex-usdt';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

async function deposit(userId: string, amount: string, tag: string): Promise<void> {
  await ledger.post(
    recipes.deposit({
      userId,
      assetId: 'USDT',
      amount: amt(amount),
      rail: 'test',
      railRef: `dep-${tag}`,
    }),
  );
}

describe('businessApprovalHold / settle / release', () => {
  it('holds, settles to destination, and is re-drive safe', async () => {
    await deposit(USER, '100', 'biz-hold');
    const approvalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const from = userAvailable(USER, 'USDT');
    const to = userAvailable(USER_B, 'USDT');
    const held = await ledger.post(recipes.businessApprovalHold({ approvalId, from, amount: amt('40') }));
    const heldAgain = await ledger.post(recipes.businessApprovalHold({ approvalId, from, amount: amt('40') }));
    expect(heldAgain.id).toBe(held.id);
    expect(formatAmount((await ledger.balance(from)).amount)).toBe('60');

    const settled = await ledger.post(recipes.businessApprovalSettle({ approvalId, from, to, amount: amt('40') }));
    const settledAgain = await ledger.post(recipes.businessApprovalSettle({ approvalId, from, to, amount: amt('40') }));
    expect(settledAgain.id).toBe(settled.id);
    expect(formatAmount((await ledger.balance(to)).amount)).toBe('40');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('release returns hold to source', async () => {
    await deposit(USER, '50', 'biz-rel');
    const approvalId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const from = userAvailable(USER, 'USDT');
    await ledger.post(recipes.businessApprovalHold({ approvalId, from, amount: amt('20') }));
    expect(formatAmount((await ledger.balance(from)).amount)).toBe('30');
    await ledger.post(recipes.businessApprovalRelease({ approvalId, from, amount: amt('20') }));
    expect(formatAmount((await ledger.balance(from)).amount)).toBe('50');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });
});

describe('businessPayroll', () => {
  it('pays every recipient in one post or none', async () => {
    await deposit(USER, '100', 'pay-ok');
    const payrollId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const first = await ledger.post(
      recipes.businessPayroll({
        payrollId,
        from: userAvailable(USER, 'USDT'),
        recipients: [
          { to: userAvailable(USER_B, 'USDT'), amount: amt('40') },
          { to: userAvailable('44444444-4444-4444-8444-444444444444', 'USDT'), amount: amt('25') },
        ],
      }),
    );
    const again = await ledger.post(
      recipes.businessPayroll({
        payrollId,
        from: userAvailable(USER, 'USDT'),
        recipients: [
          { to: userAvailable(USER_B, 'USDT'), amount: amt('40') },
          { to: userAvailable('44444444-4444-4444-8444-444444444444', 'USDT'), amount: amt('25') },
        ],
      }),
    );
    expect(again.id).toBe(first.id);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('35');
    expect(formatAmount((await ledger.balance(userAvailable(USER_B, 'USDT'))).amount)).toBe('40');
    expect(formatAmount((await ledger.balance(userAvailable('44444444-4444-4444-8444-444444444444', 'USDT'))).amount)).toBe('25');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses the whole run when the source cannot cover every line', async () => {
    await deposit(USER, '50', 'pay-short');
    await expect(
      ledger.post(
        recipes.businessPayroll({
          payrollId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          from: userAvailable(USER, 'USDT'),
          recipients: [
            { to: userAvailable(USER_B, 'USDT'), amount: amt('40') },
            { to: userAvailable('44444444-4444-4444-8444-444444444444', 'USDT'), amount: amt('20') },
          ],
        }),
      ),
    ).rejects.toThrow();
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('50');
    expect(formatAmount((await ledger.balance(userAvailable(USER_B, 'USDT'))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses empty, cross-asset, and paying the source', () => {
    expect(() => recipes.businessPayroll({ payrollId: 'x', from: userAvailable(USER, 'USDT'), recipients: [] })).toThrow(InvalidEntryError);
    expect(() =>
      recipes.businessPayroll({
        payrollId: 'x',
        from: userAvailable(USER, 'USDT'),
        recipients: [{ to: userAvailable(USER_B, 'EUR'), amount: amt('1') }],
      }),
    ).toThrow(/cannot change asset/);
    expect(() =>
      recipes.businessPayroll({
        payrollId: 'x',
        from: userAvailable(USER, 'USDT'),
        recipients: [{ to: userAvailable(USER, 'USDT'), amount: amt('1') }],
      }),
    ).toThrow(/same account/);
  });
});

describe('bankTransfer', () => {
  it('moves available → available and is re-drive safe per occurrence', async () => {
    await deposit(USER, '100', 't1');
    const body = {
      transferId: 'xfer-1',
      from: userAvailable(USER, 'USDT'),
      to: userAvailable(USER_B, 'USDT'),
      amount: amt('40'),
      kind: 'manual' as const,
      occurrence: 0,
    };
    const first = await ledger.post(recipes.bankTransfer(body));
    const second = await ledger.post(recipes.bankTransfer(body));
    expect(second.id).toBe(first.id);
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('60');
    expect(formatAmount((await ledger.balance(userAvailable(USER_B, 'USDT'))).amount)).toBe('40');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses cross-asset and non-available kinds', () => {
    expect(() =>
      recipes.bankTransfer({
        transferId: 'x',
        from: userAvailable(USER, 'USDT'),
        to: userAvailable(USER_B, 'BTC'),
        amount: amt('1'),
        kind: 'manual',
        occurrence: 0,
      }),
    ).toThrow(/cannot change asset/);

    expect(() =>
      recipes.bankTransfer({
        transferId: 'x',
        from: userAvailable(USER, 'USDT'),
        to: earnStakeAccount(USER_B, 'USDT', 'pos-1'),
        amount: amt('1'),
        kind: 'manual',
        occurrence: 0,
      }),
    ).toThrow(/available accounts only/);
  });

  it('occurrence is part of the key — a second schedule run is a different movement', () => {
    const a = recipes.bankTransfer({
      transferId: 'sched-1',
      from: userAvailable(USER, 'USDT'),
      to: userAvailable(USER_B, 'USDT'),
      amount: amt('1'),
      kind: 'scheduled',
      occurrence: 0,
    });
    const b = recipes.bankTransfer({
      transferId: 'sched-1',
      from: userAvailable(USER, 'USDT'),
      to: userAvailable(USER_B, 'USDT'),
      amount: amt('1'),
      kind: 'scheduled',
      occurrence: 1,
    });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});

describe('earn — stake stays user-owned; interest is not minted', () => {
  it('deposit then withdraw returns the principal to available', async () => {
    await deposit(USER, '200', 'earn1');
    await ledger.post(
      recipes.earnDeposit({
        positionId: 'pos-1',
        poolId: POOL,
        userId: USER,
        assetId: 'USDT',
        amount: amt('200'),
      }),
    );
    expect(formatAmount((await ledger.balance(earnStakeAccount(USER, 'USDT', 'pos-1'))).amount)).toBe('200');
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('0');

    await ledger.post(
      recipes.earnWithdraw({
        positionId: 'pos-1',
        poolId: POOL,
        userId: USER,
        assetId: 'USDT',
        amount: amt('200'),
      }),
    );
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('200');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('interest pays from a funded pool reserve — underfunded fails at the book', async () => {
    await deposit(USER, '100', 'yield-src');
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'yield-fee',
        userId: USER,
        module: 'bank',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('100'),
      }),
    );
    await ledger.post(recipes.earnPoolFund({ poolId: POOL, fundingId: 'day-seed', assetId: 'USDT', amount: amt('100') }));

    await ledger.post(
      recipes.earnInterest({
        poolId: POOL,
        date: '2026-08-09',
        assetId: 'USDT',
        payouts: [{ userId: USER, amount: amt('30') }],
      }),
    );
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('30');
    expect(formatAmount((await ledger.balance(earnPoolReserve(POOL, 'USDT'))).amount)).toBe('70');

    // Same day re-drive is idempotent.
    const again = await ledger.post(
      recipes.earnInterest({
        poolId: POOL,
        date: '2026-08-09',
        assetId: 'USDT',
        payouts: [{ userId: USER, amount: amt('30') }],
      }),
    );
    expect(formatAmount((await ledger.balance(userAvailable(USER, 'USDT'))).amount)).toBe('30');

    // Overdraw the remaining 70.
    await expect(
      ledger.post(
        recipes.earnInterest({
          poolId: POOL,
          date: '2026-08-10',
          assetId: 'USDT',
          payouts: [{ userId: USER, amount: amt('80') }],
        }),
      ),
    ).rejects.toThrow();
    expect(again.id).toBeTruthy();
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('funds one asset: house fees when from is omitted, the source when it matches, and no post when it does not', async () => {
    const amount = amt('40');
    const omitted = recipes.earnPoolFund({
      poolId: POOL,
      fundingId: 'house-seed',
      assetId: 'USDT',
      amount,
    });
    expect(omitted.entries).toEqual([
      { account: houseFees('bank', 'USDT'), direction: 'credit', amount },
      { account: earnPoolReserve(POOL, 'USDT'), direction: 'debit', amount },
    ]);

    const from = userAvailable(USER, 'USDT');
    const matched = recipes.earnPoolFund({
      poolId: POOL,
      fundingId: 'user-seed',
      assetId: 'USDT',
      amount,
      from,
    });
    expect(matched.entries).toEqual([
      { account: from, direction: 'credit', amount },
      { account: earnPoolReserve(POOL, 'USDT'), direction: 'debit', amount },
    ]);

    const fundingId = 'cross-asset';
    expect(() =>
      recipes.earnPoolFund({
        poolId: POOL,
        fundingId,
        assetId: 'USDT',
        amount,
        from: userAvailable(USER, 'BTC'),
      }),
    ).toThrow(InvalidEntryError);
    expect(() =>
      recipes.earnPoolFund({
        poolId: POOL,
        fundingId,
        assetId: 'USDT',
        amount,
        from: userAvailable(USER, 'BTC'),
      }),
    ).toThrow(/cannot change asset/);
    expect(await ledger.getTxByKey(`bank.earn.fund:${POOL}:${fundingId}`)).toBeNull();

    await deposit(USER, '80', 'fund-both');
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'fund-house-fee',
        userId: USER,
        module: 'bank',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('40'),
      }),
    );
    await ledger.post(omitted);
    expect(formatAmount((await ledger.balance(houseFees('bank', 'USDT'))).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(earnPoolReserve(POOL, 'USDT'))).amount)).toBe('40');

    await ledger.post(matched);
    expect(formatAmount((await ledger.balance(from)).amount)).toBe('0');
    expect(formatAmount((await ledger.balance(earnPoolReserve(POOL, 'USDT'))).amount)).toBe('80');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('refuses empty accrual and bad date shape', () => {
    expect(() => recipes.earnInterest({ poolId: POOL, date: '2026-08-09', assetId: 'USDT', payouts: [] })).toThrow(InvalidEntryError);
    expect(() =>
      recipes.earnInterest({
        poolId: POOL,
        date: '09/08/2026',
        assetId: 'USDT',
        payouts: [{ userId: USER, amount: amt('1') }],
      }),
    ).toThrow(/YYYY-MM-DD/);
  });

  it('refuses a nonsense accrual day and keeps a real calendar day in the written key', async () => {
    const payouts = [{ userId: USER, amount: amt('1') }];
    for (const date of ['2026-02-31', '2026-13-40', '2026-02-29']) {
      expect(() => recipes.earnInterest({ poolId: POOL, date, assetId: 'USDT', payouts })).toThrow(InvalidEntryError);
      expect(await ledger.getTxByKey(`bank.interest:${POOL}:${date}`)).toBeNull();
    }

    for (const date of ['2026-07-27', '0001-01-01', '2024-02-29']) {
      const request = recipes.earnInterest({ poolId: POOL, date, assetId: 'USDT', payouts });
      expect(request.idempotencyKey).toBe(`bank.interest:${POOL}:${date}`);
      expect(request.entries.every((entry) => typeof entry.amount === 'bigint')).toBe(true);
    }
  });
});

describe('bankTransfer key spaces (F-2.1)', () => {
  const own = (transferId: string, to = USER_B) => ({
    transferId,
    from: userAvailable(USER, 'USDT'),
    to: userAvailable(to, 'USDT'),
    amount: amt('10'),
    kind: 'manual' as const,
    occurrence: 0,
  });

  it('puts each operation in its own key space', () => {
    expect(bankTransferKey('own', 'T-1', 0)).toBe('bank.transfer.own:T-1:0');
    expect(bankTransferKey('p2p', 'T-1', 0)).toBe('bank.transfer.p2p:T-1:0');
    expect(bankTransferKey('sched', 'T-1', 3)).toBe('bank.transfer.sched:T-1:3');
    expect(bankTransferKey('rail', 'T-1', 1)).toBe('bank.transfer.rail:T-1:1');
    expect(bankTransferKey('recovery', 'T-1', 0)).toBe('bank.transfer.recovery:T-1:0');
    expect(new Set(['own', 'p2p', 'sched', 'rail', 'recovery'].map((s) => bankTransferKey(s as 'own', 'T-1', 0))).size).toBe(5);
  });

  it('a recovery sweep is a manual move between two people, booked once per claim and account', async () => {
    const book = new MemoryLedger({ idempotencyConflict: 'refuse' });
    await seed(book);
    const from = userAvailable(USER, 'USDT');
    const transferId = recoverySweepTransferId('claim-1', from);
    const sweep = { ...own(transferId), amount: amt('100'), keySpace: 'recovery' as const };
    expect(() => recipes.bankTransfer({ ...sweep, kind: 'scheduled' })).toThrow(/does not go with/);
    const request = recipes.bankTransfer(sweep);
    expect(request.idempotencyKey).toBe(`bank.transfer.recovery:claim-1:${accountKey(from)}:0`);
    expect(request.meta).toMatchObject({ keySpace: 'recovery', transferId });
    const first = await book.post(request);
    // A retried claim finds the same posting and moves nothing more.
    const again = await book.post(recipes.bankTransfer(sweep));
    expect(again.id).toBe(first.id);
    // The same key with another amount is a conflict, never a second movement.
    await expect(book.post(recipes.bankTransfer({ ...sweep, amount: amt('1') }))).rejects.toThrow();
    expect(formatAmount((await book.balance(from)).amount)).toBe('0');
    expect(formatAmount((await book.balance(userAvailable(USER_B, 'USDT'))).amount)).toBe('100');
    expect(book.reconcile()).toEqual({ ok: true });
  });

  it('two accounts of one asset are two sweeps, later value is the next occurrence, and an over-sweep moves nothing', async () => {
    const book = new MemoryLedger({ idempotencyConflict: 'refuse' });
    await seed(book);
    const space = subAccountAvailable('44444444-4444-4444-8444-444444444444', 'USDT');
    await book.post(recipes.bankTransfer({ ...own('fund-space'), to: space, amount: amt('40'), keySpace: 'own' }));
    const primary = userAvailable(USER, 'USDT');
    const ids = [recoverySweepTransferId('claim-2', primary), recoverySweepTransferId('claim-2', space)];
    expect(new Set(ids).size).toBe(2);
    const sweep = (from: typeof primary, amount: string, occurrence = 0) =>
      recipes.bankTransfer({
        ...own(recoverySweepTransferId('claim-2', from)),
        from,
        amount: amt(amount),
        occurrence,
        keySpace: 'recovery',
      });
    // More than the account holds is refused by the book, and nothing moves.
    await expect(book.post(sweep(primary, '61'))).rejects.toThrow();
    await book.post(sweep(primary, '60'));
    await book.post(sweep(space, '40'));
    // Value that arrives after the sweep goes in the next occurrence of the same claim and account.
    await book.post(
      recipes.bankTransfer({ ...own('late-refund', USER), from: userAvailable(USER_B, 'USDT'), amount: amt('5'), keySpace: 'p2p' }),
    );
    expect(() => recoverySweepTransferId(' ', primary)).toThrow(InvalidEntryError);
    await book.post(sweep(primary, '5', 1));
    expect(formatAmount((await book.balance(primary)).amount)).toBe('0');
    expect(formatAmount((await book.balance(space)).amount)).toBe('0');
    expect(formatAmount((await book.balance(userAvailable(USER_B, 'USDT'))).amount)).toBe('100');
    expect(book.reconcile()).toEqual({ ok: true });
  });

  it('posts under the key the builder names, so a lookup after a lost reply finds it', () => {
    const request = recipes.bankTransfer({ ...own('transfer-0001'), keySpace: 'p2p' });
    expect(request.idempotencyKey).toBe(bankTransferKey('p2p', 'transfer-0001', 0));
  });

  it('keeps the legacy key for a caller that names no key space', () => {
    const request = recipes.bankTransfer(own('transfer-0001'));
    expect(request.idempotencyKey).toBe(legacyBankTransferKey('transfer-0001', 0));
    expect(request.idempotencyKey).toBe('bank.transfer:transfer-0001:0');
  });

  it('refuses a scheduled firing outside sched, and sched for anything else', () => {
    expect(() => recipes.bankTransfer({ ...own('x'), kind: 'scheduled', keySpace: 'own' })).toThrow(/does not go with/);
    expect(() => recipes.bankTransfer({ ...own('x'), keySpace: 'sched' })).toThrow(/does not go with/);
    expect(recipes.bankTransfer({ ...own('x'), kind: 'scheduled', keySpace: 'sched' }).idempotencyKey).toBe('bank.transfer.sched:x:0');
  });

  it('refuses a blank transfer id, an unknown space and a bad occurrence in a keyed call', () => {
    expect(() => bankTransferKey('own', '  ', 0)).toThrow(InvalidEntryError);
    expect(() => bankTransferKey('nope' as 'own', 'x', 0)).toThrow(/Unknown bank transfer key space/);
    expect(() => bankTransferKey('own', 'x', -1)).toThrow(/non-negative integer/);
    expect(() => bankTransferKey('own', 'x', 1.5)).toThrow(/non-negative integer/);
  });

  const seed = (book: MemoryLedger) =>
    book.post(recipes.deposit({ userId: USER, assetId: 'USDT', amount: amt('100'), rail: 'test', railRef: 'dep-seed' }));

  for (const mode of ['refuse', 'detect'] as const) {
    it(`two operations handed the same id book two transfers and neither is told the other's (${mode} mode)`, async () => {
      const book = new MemoryLedger({ idempotencyConflict: mode });
      await seed(book);
      // An own-space move and a person-to-person payment that reuse one `transferId`.
      const first = await book.post(recipes.bankTransfer({ ...own('shared-id-01'), amount: amt('5'), keySpace: 'own' }));
      const second = await book.post(recipes.bankTransfer({ ...own('shared-id-01'), amount: amt('7'), keySpace: 'p2p' }));
      expect(second.id).not.toBe(first.id);
      expect(first.idempotencyKey).toBe('bank.transfer.own:shared-id-01:0');
      expect(second.idempotencyKey).toBe('bank.transfer.p2p:shared-id-01:0');
      expect(formatAmount((await book.balance(userAvailable(USER_B, 'USDT'))).amount)).toBe('12');
      expect(book.reconcile()).toEqual({ ok: true });
    });
  }

  it('the legacy shared key is the collision: in detect mode the second operation gets the first one back', async () => {
    const book = new MemoryLedger({ idempotencyConflict: 'detect' });
    await seed(book);
    const first = await book.post(recipes.bankTransfer({ ...own('shared-id-01'), amount: amt('5') }));
    const second = await book.post(recipes.bankTransfer({ ...own('shared-id-01'), amount: amt('7') }));
    expect(second.id).toBe(first.id);
  });
});
