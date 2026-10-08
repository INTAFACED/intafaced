import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryLedger } from '../memory-ledger.js';
import { formatAmount, parseAmount as amt } from '../money.js';
import { houseFees, insuranceFund, loanCollateralAccount, loanReserve, marketMaker, userAvailable } from '../accounts.js';
import { InvalidEntryError } from '../types.js';
import { recipes } from './index.js';

/**
 * LOAN RECIPES — package-level, no svc-bank.
 *
 * The rewrite that replaced three unusable stubs documented four bugs that
 * still balance the books if they regress:
 *
 *   1. Shared collateral pot across loans (purpose-keyed now).
 *   2. No principal draw — half a loan is not a loan.
 *   3. Liquidation booking the whole seizure as house fees.
 *   4. One liquidation key per loan forever (blocks partial ladder).
 *
 * svc-bank has integration coverage. This file pins the recipe *shape* and
 * conservation laws at the package boundary so a future stub cannot land
 * silently under a green bank suite that never re-imports the pure functions.
 */

const BORROWER = '11111111-1111-4111-8111-111111111111';
const LOAN = 'loan-pkg-1';

let ledger: MemoryLedger;

beforeEach(() => {
  ledger = new MemoryLedger();
});

async function deposit(asset: string, amount: string, tag: string): Promise<void> {
  await ledger.post(
    recipes.deposit({
      userId: BORROWER,
      assetId: asset,
      amount: amt(amount),
      rail: 'test',
      railRef: `dep-${tag}`,
    }),
  );
}

/** Move borrower USDT into house bank fees, then into the loan reserve. */
async function fundReserveFromBorrower(amount: string, tag: string): Promise<void> {
  await deposit('USDT', amount, `rsv-${tag}`);
  await ledger.post(
    recipes.feeCharge({
      chargeId: `fee-${tag}`,
      userId: BORROWER,
      module: 'bank',
      mode: 'asset',
      assetId: 'USDT',
      amount: amt(amount),
    }),
  );
  await ledger.post(recipes.loanReserveFund({ fundingId: tag, debtAssetId: 'USDT', amount: amt(amount) }));
}

describe('loan recipes — the four bugs the rewrite exists to keep dead', () => {
  it('two loans in one asset have separate collateral pots (bug 1)', async () => {
    await deposit('BTC', '2', 'col-2');
    await ledger.post(
      recipes.loanCollateralLock({
        loanId: 'loan-a',
        userId: BORROWER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 0,
      }),
    );
    await ledger.post(
      recipes.loanCollateralLock({
        loanId: 'loan-b',
        userId: BORROWER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 0,
      }),
    );

    expect(formatAmount((await ledger.balance(loanCollateralAccount(BORROWER, 'BTC', 'loan-a'))).amount)).toBe('1');
    expect(formatAmount((await ledger.balance(loanCollateralAccount(BORROWER, 'BTC', 'loan-b'))).amount)).toBe('1');
    expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('0');

    // Releasing A must not unsecure B.
    await ledger.post(
      recipes.loanCollateralRelease({
        loanId: 'loan-a',
        userId: BORROWER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 1,
      }),
    );
    expect(formatAmount((await ledger.balance(loanCollateralAccount(BORROWER, 'BTC', 'loan-b'))).amount)).toBe('1');
    expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'BTC'))).amount)).toBe('1');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('draw moves principal from reserve to borrower (bug 2 — half a loan is not a loan)', async () => {
    await deposit('BTC', '1', 'btc-draw');
    await fundReserveFromBorrower('5000', 'draw');

    await ledger.post(
      recipes.loanCollateralLock({
        loanId: LOAN,
        userId: BORROWER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 0,
      }),
    );
    await ledger.post(recipes.loanDraw({ loanId: LOAN, userId: BORROWER, debtAssetId: 'USDT', principal: amt('5000') }));

    expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5000');
    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('liquidation does NOT book the whole seizure as house fees (bug 3)', async () => {
    await deposit('BTC', '1', 'btc-liq');
    await fundReserveFromBorrower('5000', 'liq-rsv');
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('6000'), seedId: 'mm-liq' }));

    await ledger.post(
      recipes.loanCollateralLock({
        loanId: LOAN,
        userId: BORROWER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 0,
      }),
    );
    await ledger.post(recipes.loanDraw({ loanId: LOAN, userId: BORROWER, debtAssetId: 'USDT', principal: amt('5000') }));

    // proceeds 5500 = principal 5000 + interest 100 + penalty 200 + surplus 200
    await ledger.post(
      recipes.loanLiquidate({
        loanId: LOAN,
        userId: BORROWER,
        tranche: 0,
        collateralAssetId: 'BTC',
        debtAssetId: 'USDT',
        collateralSold: amt('1'),
        proceeds: amt('5500'),
        principalRepaid: amt('5000'),
        interestRepaid: amt('100'),
        penalty: amt('200'),
        surplusToBorrower: amt('200'),
        buyer: {
          collateralTo: marketMaker('BTC'),
          proceedsFrom: marketMaker('USDT'),
        },
        markPrice: amt('5500'),
      }),
    );

    // House only gets interest + penalty = 300, never the whole 5500 or the BTC.
    expect(formatAmount((await ledger.balance(houseFees('bank', 'USDT'))).amount)).toBe('300');
    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('5000');
    // draw 5000 + surplus 200
    expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('5200');
    expect(formatAmount((await ledger.balance(marketMaker('BTC'))).amount)).toBe('1');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('partial ladder: two liquidation tranches have distinct keys (bug 4)', () => {
    const base = {
      loanId: LOAN,
      userId: BORROWER,
      collateralAssetId: 'BTC' as const,
      debtAssetId: 'USDT' as const,
      collateralSold: amt('0.5'),
      proceeds: amt('2500'),
      principalRepaid: amt('2500'),
      interestRepaid: amt('0'),
      penalty: amt('0'),
      surplusToBorrower: amt('0'),
      buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
      markPrice: amt('5000'),
    };
    const a = recipes.loanLiquidate({ ...base, tranche: 0 });
    const b = recipes.loanLiquidate({ ...base, tranche: 1 });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(a.idempotencyKey).toBe(`bank.loan.liquidate:${LOAN}:0`);
    expect(b.idempotencyKey).toBe(`bank.loan.liquidate:${LOAN}:1`);
  });
});

describe('loan recipe refusals — balanced lies are still refused', () => {
  it('refuses a same-asset "liquidation" (would invent a trade)', () => {
    expect(() =>
      recipes.loanLiquidate({
        loanId: LOAN,
        userId: BORROWER,
        tranche: 0,
        collateralAssetId: 'USDT',
        debtAssetId: 'USDT',
        collateralSold: amt('1'),
        proceeds: amt('1'),
        principalRepaid: amt('1'),
        interestRepaid: amt('0'),
        penalty: amt('0'),
        surplusToBorrower: amt('0'),
        buyer: { collateralTo: marketMaker('USDT'), proceedsFrom: marketMaker('USDT') },
        markPrice: amt('1'),
      }),
    ).toThrow(InvalidEntryError);
  });

  it('refuses proceeds that do not fully allocate', () => {
    expect(() =>
      recipes.loanLiquidate({
        loanId: LOAN,
        userId: BORROWER,
        tranche: 0,
        collateralAssetId: 'BTC',
        debtAssetId: 'USDT',
        collateralSold: amt('1'),
        proceeds: amt('100'),
        principalRepaid: amt('50'),
        interestRepaid: amt('0'),
        penalty: amt('0'),
        surplusToBorrower: amt('0'),
        buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
        markPrice: amt('100'),
      }),
    ).toThrow(/fully allocated/);
  });

  it('refuses a zero or negative mark and still posts a positive mark', async () => {
    await deposit('BTC', '1', 'btc-mark');
    await fundReserveFromBorrower('5000', 'mark-rsv');
    await ledger.post(recipes.marketMakerSeedFund({ assetId: 'USDT', amount: amt('6000'), seedId: 'mm-mark' }));
    await ledger.post(
      recipes.loanCollateralLock({
        loanId: LOAN,
        userId: BORROWER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 0,
      }),
    );
    await ledger.post(recipes.loanDraw({ loanId: LOAN, userId: BORROWER, debtAssetId: 'USDT', principal: amt('5000') }));

    const base = {
      loanId: LOAN,
      userId: BORROWER,
      tranche: 0,
      collateralAssetId: 'BTC' as const,
      debtAssetId: 'USDT' as const,
      collateralSold: amt('1'),
      proceeds: amt('5500'),
      principalRepaid: amt('5000'),
      interestRepaid: amt('100'),
      penalty: amt('200'),
      surplusToBorrower: amt('200'),
      buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
    };
    const key = `bank.loan.liquidate:${LOAN}:0`;

    for (const markPrice of [0n, -1n]) {
      expect(() => recipes.loanLiquidate({ ...base, markPrice })).toThrow(InvalidEntryError);
      expect(() => recipes.loanLiquidate({ ...base, markPrice })).toThrow(/mark price must be positive/);
      expect(await ledger.getTxByKey(key)).toBeNull();
    }
    expect(ledger.journal().some((tx) => tx.reason === 'loan.liquidated')).toBe(false);

    const markPrice = amt('1');
    const posted = await ledger.post(recipes.loanLiquidate({ ...base, markPrice }));
    expect(posted.meta.markPrice).toBe(markPrice.toString());
    const collateralLegs = posted.entries.filter((entry) => entry.assetId === 'BTC');
    const proceedsLeg = posted.entries.find((entry) => entry.assetId === 'USDT' && entry.direction === 'credit');
    expect(collateralLegs.every((entry) => entry.amount === base.collateralSold)).toBe(true);
    expect(proceedsLeg?.amount).toBe(base.proceeds);
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('bad debt draws insurance → reserve; empty fund fails at the book', async () => {
    // Top-up insurance from house trade fees.
    await deposit('USDT', '100', 'ins');
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'ins-fee',
        userId: BORROWER,
        module: 'trade',
        mode: 'asset',
        assetId: 'USDT',
        amount: amt('100'),
      }),
    );
    await ledger.post(recipes.futuresInsuranceTopup({ topupId: 't1', assetId: 'USDT', amount: amt('100') }));

    await ledger.post(recipes.loanBadDebt({ loanId: LOAN, debtAssetId: 'USDT', shortfall: amt('40') }));
    expect(formatAmount((await ledger.balance(insuranceFund('USDT'))).amount)).toBe('60');
    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('40');

    await expect(ledger.post(recipes.loanBadDebt({ loanId: 'other', debtAssetId: 'USDT', shortfall: amt('100') }))).rejects.toThrow();
  });

  it('repay splits principal to reserve and interest to house', async () => {
    await deposit('BTC', '1', 'btc-repay');
    // 1000 for reserve + 50 for interest payment after draw
    await fundReserveFromBorrower('1000', 'repay-rsv');
    await deposit('USDT', '50', 'interest-cash');

    await ledger.post(
      recipes.loanCollateralLock({
        loanId: LOAN,
        userId: BORROWER,
        collateralAssetId: 'BTC',
        amount: amt('1'),
        sequence: 0,
      }),
    );
    await ledger.post(recipes.loanDraw({ loanId: LOAN, userId: BORROWER, debtAssetId: 'USDT', principal: amt('1000') }));
    // available = 50 (interest cash) + 1000 (draw) = 1050
    await ledger.post(
      recipes.loanRepay({
        loanId: LOAN,
        userId: BORROWER,
        debtAssetId: 'USDT',
        principal: amt('1000'),
        interest: amt('50'),
        sequence: 0,
      }),
    );
    expect(formatAmount((await ledger.balance(loanReserve('USDT'))).amount)).toBe('1000');
    expect(formatAmount((await ledger.balance(houseFees('bank', 'USDT'))).amount)).toBe('50');
    expect(formatAmount((await ledger.balance(userAvailable(BORROWER, 'USDT'))).amount)).toBe('0');
    expect(ledger.reconcile()).toEqual({ ok: true });
  });

  it('collateral lock sequence is part of the key — a top-up is not a silent no-op', () => {
    const a = recipes.loanCollateralLock({
      loanId: LOAN,
      userId: BORROWER,
      collateralAssetId: 'BTC',
      amount: amt('1'),
      sequence: 0,
    });
    const b = recipes.loanCollateralLock({
      loanId: LOAN,
      userId: BORROWER,
      collateralAssetId: 'BTC',
      amount: amt('0.5'),
      sequence: 1,
    });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });
});
