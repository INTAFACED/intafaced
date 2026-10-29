import { describe, expect, it } from 'vitest';
import {
  bridgeBoundary,
  burnAccount,
  formatAmount,
  houseFees,
  loanReserve,
  marketMaker,
  merchantClearing,
  parseAmount as amt,
  railBoundary,
  recipes,
  rewardsEngine,
  subAccountAvailable,
  userAvailable,
  type PostRequest,
} from '@intafaced/ledger-client';
import { RECIPE_REQUIRED_CODE, assertKnownRecipePost, recipeCandidates, recipeGateSamples, unsampledRecipeNames } from './recipe-gate.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER3 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const SUB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SUB2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function toWire(req: PostRequest) {
  return {
    module: req.module,
    reason: req.reason,
    entries: req.entries.map((e) => ({
      account: e.account,
      direction: e.direction,
      amount: formatAmount(e.amount),
    })),
  };
}

describe('recipe-gate', () => {
  it('samples every registry recipe so the allowlist cannot silently drop one', () => {
    expect(unsampledRecipeNames()).toEqual([]);
  });

  it('keeps each sample name among the candidates for that sample', () => {
    for (const sample of recipeGateSamples()) {
      expect(recipeCandidates(sample.post), sample.name).toContain(sample.name);
    }
  });

  it('accepts a deposit recipe post', () => {
    expect(() =>
      assertKnownRecipePost(
        toWire(
          recipes.deposit({
            userId: USER,
            assetId: 'USDT',
            amount: amt('10'),
            rail: 'crypto-native',
            railRef: 'tx-1',
          }),
        ),
      ),
    ).not.toThrow();
  });

  it('accepts a returned withdrawal only with its own shape: rail boundary back to the person', () => {
    const returned = toWire(
      recipes.withdrawReturned({ userId: USER, assetId: 'USDT', amount: amt('10'), rail: 'crypto-native', withdrawalId: 'w1:0' }),
    );
    expect(() => assertKnownRecipePost(returned)).not.toThrow();
    // The same reason from one person to another is not a recipe.
    expect(() =>
      assertKnownRecipePost({
        ...returned,
        entries: [
          { account: userAvailable(USER2, 'USDT'), direction: 'credit' },
          { account: userAvailable(USER, 'USDT'), direction: 'debit' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: RECIPE_REQUIRED_CODE }));
    // Nor is the return taken from the person back to the boundary.
    expect(() =>
      assertKnownRecipePost({
        ...returned,
        entries: returned.entries.map((e) => ({ ...e, direction: e.direction === 'credit' ? 'debit' : 'credit' })),
      }),
    ).toThrow(expect.objectContaining({ code: RECIPE_REQUIRED_CODE }));
  });

  it('refuses assembled entries that are not a known recipe', () => {
    expect(() =>
      assertKnownRecipePost({
        module: 'evil',
        reason: 'second.book',
        entries: [
          { account: userAvailable(USER, 'USDT'), direction: 'credit' },
          { account: userAvailable(USER2, 'USDT'), direction: 'debit' },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        code: RECIPE_REQUIRED_CODE,
      }),
    );
  });

  it('refuses a stolen deposit.credited reason with user-to-user legs', () => {
    expect(() =>
      assertKnownRecipePost({
        module: 'ledger',
        reason: 'deposit.credited',
        entries: [
          { account: userAvailable(USER, 'USDT'), direction: 'credit' },
          { account: userAvailable(USER2, 'USDT'), direction: 'debit' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: RECIPE_REQUIRED_CODE }));
  });

  it('refuses a two-leg trade.fill (the fill recipe is at least four legs)', () => {
    expect(() =>
      assertKnownRecipePost({
        module: 'trade',
        reason: 'trade.fill',
        entries: [
          { account: userAvailable(USER, 'USDT'), direction: 'debit' },
          { account: userAvailable(USER2, 'USDT'), direction: 'credit' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: RECIPE_REQUIRED_CODE }));
  });

  it('accepts a withdrawal settle with its quoted fee leg, and only to houseFees', () => {
    const w = { userId: USER, assetId: 'USDT', amount: amt('25'), fee: amt('1.5'), rail: 'crypto-native', withdrawalId: 'w1:0' };
    for (const post of [recipes.withdrawHold(w), recipes.withdrawSettle(w), recipes.withdrawReverse(w)]) {
      expect(() => assertKnownRecipePost(toWire(post))).not.toThrow();
    }
    const settle = toWire(recipes.withdrawSettle(w));
    // The fee leg sent to another person instead of the house fee pot is not a recipe.
    const stolen = {
      ...settle,
      entries: settle.entries.map((e) => (e.account.ownerType === 'house' ? { ...e, account: userAvailable(USER2, 'USDT') } : e)),
    };
    expect(() => assertKnownRecipePost(stolen)).toThrow(expect.objectContaining({ code: RECIPE_REQUIRED_CODE }));
  });

  it('accepts feeCharge with a caller-chosen reason', () => {
    expect(() =>
      assertKnownRecipePost(
        toWire(
          recipes.feeCharge({
            chargeId: 'c1',
            userId: USER,
            module: 'agents',
            mode: 'asset',
            assetId: 'USDT',
            amount: amt('1'),
            reason: 'agents.usage.metered',
          }),
        ),
      ),
    ).not.toThrow();
  });

  it('accepts rewardPay with a caller-chosen reason', () => {
    expect(() =>
      assertKnownRecipePost({
        module: 'token',
        reason: 'bank.card.cashback',
        entries: [
          { account: rewardsEngine('USDT'), direction: 'credit' },
          { account: userAvailable(USER, 'USDT'), direction: 'debit' },
        ],
      }),
    ).not.toThrow();
  });

  it('does not treat a house-fees credit as feeCharge', () => {
    expect(() =>
      assertKnownRecipePost({
        module: 'evil',
        reason: 'steal',
        entries: [
          { account: houseFees('trade', 'USDT'), direction: 'credit' },
          { account: userAvailable(USER, 'USDT'), direction: 'debit' },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: RECIPE_REQUIRED_CODE }));
  });

  it('refuses a flex-reason post that debits treasury and credits an arbitrary account', () => {
    const treasury = railBoundary('card-sandbox', 'USDT');
    const arbitrary = { ...userAvailable(USER2, 'USDT'), purpose: 'not-a-recipe' };
    // Leg counts sit at the sampled minimum so a maxLegs cap alone does not
    // catch them — the signature has to. The emission case adds one extra leg.
    const raids: ReadonlyArray<{ module: string; reason: string; legs: number }> = [
      { module: 'trade', reason: 'trade.fill', legs: 4 },
      { module: 'pay', reason: 'pay.settled', legs: 2 },
      { module: 'bank', reason: 'loan.repaid', legs: 2 },
      { module: 'token', reason: 'token.emission', legs: 2 },
      { module: 'market', reason: 'market.purchase', legs: 2 },
      { module: 'trade', reason: 'trade.fill.mm_maker', legs: 4 },
      { module: 'p2p', reason: 'p2p.escrow.release', legs: 2 },
      { module: 'trade', reason: 'futures.loss.realized', legs: 2 },
      { module: 'pay', reason: 'pay.chargeback.opened', legs: 2 },
      { module: 'pay', reason: 'pay.chargeback.won', legs: 2 },
      { module: 'bank', reason: 'bank.transfer.manual', legs: 2 },
      { module: 'bank', reason: 'bank.transfer.scheduled', legs: 2 },
      { module: 'bank', reason: 'bank.business.approval.held', legs: 2 },
      { module: 'bank', reason: 'bank.business.approval.released', legs: 2 },
      { module: 'bank', reason: 'bank.business.approval.settled', legs: 2 },
      { module: 'bank', reason: 'bank.business.payroll.settled', legs: 2 },
      { module: 'bank', reason: 'bank.earn.interest', legs: 2 },
      { module: 'bank', reason: 'bank.earn.pool.funded', legs: 2 },
      { module: 'bank', reason: 'loan.reserve.funded', legs: 2 },
      { module: 'bank', reason: 'loan.liquidated', legs: 4 },
      { module: 'token', reason: 'token.burn', legs: 2 },
      { module: 'token', reason: 'token.emission', legs: 3 },
    ];
    for (const raid of raids) {
      const entries = Array.from({ length: raid.legs }, (_, index) =>
        index % 2 === 0 ? { account: treasury, direction: 'debit' as const } : { account: arbitrary, direction: 'credit' as const },
      );
      let threw = false;
      try {
        assertKnownRecipePost({ module: raid.module, reason: raid.reason, entries });
      } catch (err) {
        threw = true;
        expect(err).toMatchObject({ code: RECIPE_REQUIRED_CODE });
      }
      if (!threw) {
        expect.fail(`${raid.module}/${raid.reason} accepted a treasury debit and an arbitrary credit`);
      }
    }
  });

  it('refuses bank.earn.interest that credits loanReserve or merchantClearing and debits users', () => {
    const userDebits = [USER, USER2].map((userId) => ({
      account: userAvailable(userId, 'USDT'),
      direction: 'debit' as const,
    }));
    for (const creditAccount of [loanReserve('USDT'), merchantClearing('m1', 'USDT')]) {
      expect(() =>
        assertKnownRecipePost({
          module: 'bank',
          reason: 'bank.earn.interest',
          entries: [{ account: creditAccount, direction: 'credit' }, ...userDebits],
        }),
      ).toThrow(expect.objectContaining({ name: 'LedgerError', code: RECIPE_REQUIRED_CODE }));
    }
  });

  it('refuses token.emission that credits a rail or bridge boundary instead of the mint', () => {
    for (const creditAccount of [railBoundary('card-sandbox', 'USDT'), bridgeBoundary('eth', 'USDT')]) {
      expect(() =>
        assertKnownRecipePost({
          module: 'token',
          reason: 'token.emission',
          entries: [
            { account: creditAccount, direction: 'credit' },
            { account: userAvailable(USER, 'USDT'), direction: 'debit' },
          ],
        }),
      ).toThrow(expect.objectContaining({ name: 'LedgerError', code: RECIPE_REQUIRED_CODE }));
    }
  });

  it('refuses pay.settled that credits loanReserve instead of merchant clearing', () => {
    expect(() =>
      assertKnownRecipePost({
        module: 'pay',
        reason: 'pay.settled',
        entries: [
          { account: loanReserve('USDT'), direction: 'credit' },
          { account: userAvailable(USER, 'USDT'), direction: 'debit' },
        ],
      }),
    ).toThrow(expect.objectContaining({ name: 'LedgerError', code: RECIPE_REQUIRED_CODE }));
  });

  it('refuses loan.reserve.funded that debits merchant clearing instead of loanReserve', () => {
    expect(() =>
      assertKnownRecipePost({
        module: 'bank',
        reason: 'loan.reserve.funded',
        entries: [
          { account: houseFees('bank', 'USDT'), direction: 'credit' },
          { account: merchantClearing('m1', 'USDT'), direction: 'debit' },
        ],
      }),
    ).toThrow(expect.objectContaining({ name: 'LedgerError', code: RECIPE_REQUIRED_CODE }));
  });

  it('refuses a house pot that is not the recipe account', () => {
    expect(() =>
      assertKnownRecipePost({
        module: 'bank',
        reason: 'loan.bad_debt.covered',
        entries: [
          { account: burnAccount('USDT'), direction: 'credit' },
          { account: loanReserve('USDT'), direction: 'debit' },
        ],
      }),
    ).toThrow(expect.objectContaining({ name: 'LedgerError', code: RECIPE_REQUIRED_CODE }));

    expect(() =>
      assertKnownRecipePost({
        module: 'token',
        reason: 'token.burn',
        entries: [
          { account: rewardsEngine('IFC'), direction: 'credit' },
          { account: houseFees('trade', 'IFC'), direction: 'debit' },
        ],
      }),
    ).toThrow(expect.objectContaining({ name: 'LedgerError', code: RECIPE_REQUIRED_CODE }));
  });

  it('accepts a futures fill and a futures release that pay a trading fee, and refuses the fee to another pot', () => {
    const accept = (req: PostRequest) => {
      expect(() => assertKnownRecipePost(toWire(req))).not.toThrow();
    };
    const apply = { orderId: 'o9', userId: USER, assetId: 'USDT', positionId: 'pos9', fillId: 'm9:3:pos9', amount: amt('12') };
    accept(recipes.futuresOrderMarginApply({ ...apply, fee: amt('0.02') }));
    accept(recipes.futuresOrderMarginApply({ ...apply, releaseAmount: amt('1'), fee: amt('0.02') }));
    accept(recipes.futuresOrderMarginApply({ ...apply, releaseAmount: amt('1'), fee: amt('0.02'), subAccountId: SUB }));
    const release = { positionId: 'pos9', userId: USER, assetId: 'USDT' };
    accept(recipes.futuresMarginRelease({ ...release, amount: amt('5'), fee: amt('0.02') }));
    accept(recipes.futuresMarginRelease({ ...release, amount: 0n, fee: amt('0.02') }));
    accept(recipes.futuresMarginRelease({ ...release, amount: amt('5'), fee: amt('0.02'), subAccountId: SUB }));

    // The same shape with the fee paid to the rewards engine instead of house fees is not a recipe.
    const wire = toWire(recipes.futuresMarginRelease({ ...release, amount: amt('5'), fee: amt('0.02') }));
    const feeLeg = wire.entries.findIndex((e) => e.account.ownerType === 'house');
    const forged = { ...wire, entries: wire.entries.map((e, i) => (i === feeLeg ? { ...e, account: rewardsEngine('USDT') } : e)) };
    expect(() => assertKnownRecipePost(forged)).toThrow(expect.objectContaining({ name: 'LedgerError', code: RECIPE_REQUIRED_CODE }));
  });

  it('accepts registry recipe posts for reasons whose leg shape varies', () => {
    const fill = {
      fillId: 'f1',
      makerId: USER2,
      takerId: USER,
      makerOrderId: 'mo',
      takerOrderId: 'to',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      qty: amt('10'),
      quoteAmount: amt('100'),
      takerSide: 'buy' as const,
    };
    const accept = (req: PostRequest) => {
      expect(() => assertKnownRecipePost(toWire(req))).not.toThrow();
    };

    accept(recipes.tradeFill({ ...fill, makerFeeBps: 0, takerFeeBps: 0 }));
    accept(recipes.tradeFill({ ...fill, makerFeeBps: 10, takerFeeBps: 0 }));
    accept(recipes.tradeFill({ ...fill, makerFeeBps: 0, takerFeeBps: 10 }));
    accept(recipes.tradeFill({ ...fill, makerFeeBps: 10, takerFeeBps: 10 }));
    accept(recipes.tradeFillMakerRebate({ ...fill, makerFeeBps: 0, takerFeeBps: 10, makerRebateBps: 5 }));
    accept(recipes.tradeFillMakerRebate({ ...fill, takerSide: 'sell', makerFeeBps: 0, takerFeeBps: 20, makerRebateBps: 3 }));
    accept(recipes.marketMakerMakerFill({ ...fill, makerFeeBps: 10, takerFeeBps: 0 }));
    accept(
      recipes.merchantSettlement({
        merchantId: 'm1',
        merchantUserId: USER,
        window: '2026-07-27',
        assetId: 'USDT',
        gross: amt('100'),
        fee: 0n,
      }),
    );
    accept(
      recipes.merchantSettlement({
        merchantId: 'm1',
        merchantUserId: USER,
        window: '2026-07-27',
        assetId: 'USDT',
        gross: amt('100'),
        fee: amt('10'),
      }),
    );
    accept(
      recipes.merchantSettlement({
        merchantId: 'm-other',
        merchantUserId: USER2,
        window: '2026-07-28',
        assetId: 'USDT',
        gross: amt('100'),
        fee: 0n,
      }),
    );
    accept(recipes.loanRepay({ loanId: 'ln1', userId: USER, debtAssetId: 'USDT', principal: amt('10'), interest: 0n, sequence: 1 }));
    accept(recipes.loanRepay({ loanId: 'ln1', userId: USER, debtAssetId: 'USDT', principal: 0n, interest: amt('10'), sequence: 1 }));
    accept(recipes.loanRepay({ loanId: 'ln1', userId: USER, debtAssetId: 'USDT', principal: amt('10'), interest: amt('10'), sequence: 1 }));
    accept(recipes.mintEmission({ epoch: 1, assetId: 'IFC', amount: amt('10'), destination: userAvailable(USER, 'IFC') }));
    accept(recipes.mintEmission({ epoch: 2, assetId: 'IFC', amount: amt('10'), destination: rewardsEngine('IFC') }));
    accept(
      recipes.marketPurchase({
        purchaseId: 'mp1',
        listingId: 'l1',
        buyerId: USER,
        vendorUserId: USER2,
        assetId: 'USDT',
        price: amt('100'),
        commissionBps: 0,
      }),
    );
    accept(
      recipes.marketPurchase({
        purchaseId: 'mp2',
        listingId: 'l1',
        buyerId: USER,
        vendorUserId: USER2,
        assetId: 'USDT',
        price: amt('100'),
        commissionBps: 10,
      }),
    );
    accept(recipes.burn({ runId: 'b1', assetId: 'IFC', amount: amt('10'), from: rewardsEngine('IFC') }));
    accept(recipes.sweepFeesToRewards({ windowId: 'w-bank', sourceModule: 'bank', assetId: 'USDT', amount: amt('10') }));
    accept(recipes.sweepFeesToRewards({ windowId: 'w-pay', sourceModule: 'pay', assetId: 'USDT', amount: amt('10') }));
    accept(
      recipes.futuresRealizeLoss({
        positionId: 'pos1',
        userId: USER,
        assetId: 'USDT',
        fromMargin: amt('10'),
        fromInsurance: amt('10'),
        lossId: 'l-both',
      }),
    );
    accept(
      recipes.earnInterest({
        poolId: 'pool1',
        date: '2026-07-27',
        assetId: 'USDT',
        payouts: [
          { userId: USER, amount: amt('10') },
          { userId: USER2, amount: amt('10') },
          { userId: USER3, amount: amt('10') },
        ],
      }),
    );
    accept(
      recipes.earnInterest({
        poolId: 'pool-other',
        date: '2026-07-28',
        assetId: 'USDT',
        payouts: [{ userId: USER, amount: amt('10') }],
      }),
    );
    accept(
      recipes.businessPayroll({
        payrollId: 'pr-mix',
        from: userAvailable(USER, 'USDT'),
        recipients: [
          { to: userAvailable(USER2, 'USDT'), amount: amt('10') },
          { to: subAccountAvailable(SUB, 'USDT'), amount: amt('10') },
          { to: userAvailable(USER3, 'USDT'), amount: amt('10') },
        ],
      }),
    );
    accept(
      recipes.bankTransfer({
        transferId: 'tr-sub',
        occurrence: 0,
        from: subAccountAvailable(SUB, 'USDT'),
        to: subAccountAvailable(SUB2, 'USDT'),
        amount: amt('10'),
        kind: 'manual',
      }),
    );
    accept(
      recipes.loanLiquidate({
        loanId: 'ln1',
        userId: USER,
        tranche: 0,
        collateralAssetId: 'BTC',
        collateralSold: amt('10'),
        debtAssetId: 'USDT',
        proceeds: amt('10'),
        principalRepaid: 0n,
        interestRepaid: amt('10'),
        penalty: 0n,
        surplusToBorrower: 0n,
        buyer: { collateralTo: marketMaker('BTC'), proceedsFrom: marketMaker('USDT') },
        markPrice: amt('100'),
      }),
    );
    accept(recipes.marketMakerMakerFill({ ...fill, makerFeeBps: 0, takerFeeBps: 10 }));
    accept(recipes.marketMakerMakerFill({ ...fill, makerFeeBps: 10, takerFeeBps: 10 }));
    const opened = {
      disputeId: 'd1',
      paymentId: 'p1',
      merchantId: 'm1',
      merchantUserId: USER,
      assetId: 'USDT',
      rail: 'card-sandbox',
      fromClearing: amt('10'),
      fromMerchantBalance: amt('10'),
    };
    accept(recipes.chargebackOpen(opened));
    accept(recipes.chargebackWon(opened));
    accept(recipes.chargebackWon({ ...opened, fromClearing: 0n, fromMerchantBalance: amt('10') }));
    accept(recipes.businessApprovalHold({ approvalId: 'ap-sub', from: subAccountAvailable(SUB, 'USDT'), amount: amt('10') }));
    accept(recipes.businessApprovalRelease({ approvalId: 'ap-sub', from: subAccountAvailable(SUB, 'USDT'), amount: amt('10') }));
    accept(
      recipes.businessApprovalSettle({
        approvalId: 'ap-sub',
        from: subAccountAvailable(SUB, 'USDT'),
        to: userAvailable(USER2, 'USDT'),
        amount: amt('10'),
      }),
    );
    accept(recipes.loanReserveFund({ fundingId: 'f1', debtAssetId: 'USDT', amount: amt('10') }));
    accept(
      recipes.loanReserveFund({
        fundingId: 'f-user',
        debtAssetId: 'USDT',
        amount: amt('10'),
        from: userAvailable(USER, 'USDT'),
      }),
    );
    accept(
      recipes.bankTransfer({
        transferId: 'tr-sched',
        occurrence: 1,
        from: subAccountAvailable(SUB, 'USDT'),
        to: userAvailable(USER2, 'USDT'),
        amount: amt('10'),
        kind: 'scheduled',
      }),
    );

    // A rebate leaves house trade fees only: the same two legs from another house account are not a recipe.
    const rebate = toWire(recipes.tradeFillMakerRebate({ ...fill, makerFeeBps: 0, takerFeeBps: 10, makerRebateBps: 5 }));
    const fromInsurance = {
      ...rebate,
      entries: rebate.entries.map((e) =>
        e.account.ownerType === 'house' ? { ...e, account: { ...e.account, ownerId: 'insurance-fund' } } : e,
      ),
    };
    expect(() => assertKnownRecipePost(fromInsurance)).toThrow(expect.objectContaining({ code: RECIPE_REQUIRED_CODE }));
    // Nor is a rebate inside the fill itself.
    expect(() => assertKnownRecipePost({ ...rebate, reason: 'trade.fill' })).toThrow(
      expect.objectContaining({ code: RECIPE_REQUIRED_CODE }),
    );

    // Locked campaign rewards: only the rewards engine into a campaigns:lock pot, and out of one only to the customer or the engine.
    const rewardKey = `task:${USER2}:${USER}:once`;
    const reward = { rewardKey, userId: USER, assetId: 'USDT', amount: amt('2') };
    accept(recipes.campaignRewardLock({ ...reward, assetId: 'BTC' }));
    accept(recipes.campaignRewardUnlock({ ...reward, assetId: 'BTC' }));
    accept(recipes.campaignRewardForfeit({ ...reward, assetId: 'BTC' }));
    const refuse = (post: ReturnType<typeof toWire>) =>
      expect(() => assertKnownRecipePost(post)).toThrow(expect.objectContaining({ code: RECIPE_REQUIRED_CODE }));
    const swap = (post: ReturnType<typeof toWire>, from: (e: (typeof post.entries)[number]) => boolean, account: object) => ({
      ...post,
      entries: post.entries.map((e) => (from(e) ? { ...e, account: { ...e.account, ...account } } : e)),
    });
    const isPot = (e: { account: { ownerType: string } }) => e.account.ownerType === 'module';
    const isHouse = (e: { account: { ownerType: string } }) => e.account.ownerType === 'house';
    const locked = toWire(recipes.campaignRewardLock(reward));
    const unlocked = toWire(recipes.campaignRewardUnlock(reward));
    const forfeited = toWire(recipes.campaignRewardForfeit(reward));
    // Into another module pot, or out of house fees instead of the rewards engine.
    refuse(swap(locked, isPot, { ownerId: 'pay:clearing:m1' }));
    refuse(swap(locked, isHouse, { ownerId: 'fees:trade' }));
    // Out of a merchant's clearing instead of a lock pot.
    refuse(swap(unlocked, isPot, { ownerId: 'pay:clearing:m1' }));
    refuse(swap(forfeited, isPot, { ownerId: 'pay:clearing:m1' }));
    // A customer's own funds into the rewards engine is never a forfeit.
    refuse(swap(forfeited, isPot, { ownerType: 'user', ownerId: USER }));
    // Nor into house fees.
    refuse(swap(forfeited, isHouse, { ownerId: 'fees:trade' }));
    refuse({ ...forfeited, reason: 'campaigns.reward.unlocked' });
    refuse({ ...unlocked, module: 'token' });

    const bare = toWire(recipes.tradeFill({ ...fill, makerFeeBps: 0, takerFeeBps: 0 }));
    const last = bare.entries[bare.entries.length - 1];
    expect(() => assertKnownRecipePost({ ...bare, entries: [...bare.entries, last!] })).toThrow(
      expect.objectContaining({ code: RECIPE_REQUIRED_CODE }),
    );
    const liquidated = toWire(
      recipes.loanLiquidate({
        loanId: 'ln1',
        userId: USER,
        tranche: 0,
        collateralAssetId: 'BTC',
        collateralSold: amt('10'),
        debtAssetId: 'USDT',
        proceeds: amt('100'),
        principalRepaid: amt('100'),
        interestRepaid: 0n,
        penalty: 0n,
        surplusToBorrower: 0n,
        buyer: { collateralTo: userAvailable(USER2, 'BTC'), proceedsFrom: userAvailable(USER2, 'USDT') },
        markPrice: amt('100'),
      }),
    );
    const liquidatedLast = liquidated.entries[liquidated.entries.length - 1];
    expect(() => assertKnownRecipePost({ ...liquidated, entries: [...liquidated.entries, liquidatedLast!] })).toThrow(
      expect.objectContaining({ code: RECIPE_REQUIRED_CODE }),
    );
  });

  it('accepts an inventory late fill with no merchant credit and refuses one that pays the merchant', () => {
    const inventory = recipes.fxConversionLateFill({
      auditId: 'audit-gate-i',
      conversionId: 'cv-gate-i',
      merchantId: 'm1',
      merchantUserId: USER,
      venueId: 'binance-spot',
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: amt('10'),
      toAmount: amt('7'),
      feeAmount: amt('2'),
      spreadAmount: amt('1'),
      funding: 'inventory',
    });
    expect(inventory.entries.some((entry) => entry.account.ownerType === 'user' || entry.account.ownerId?.startsWith('fees:'))).toBe(false);
    expect(() => assertKnownRecipePost(toWire(inventory))).not.toThrow();

    const merchant = recipes.fxConversionLateFill({
      auditId: 'audit-gate-m',
      conversionId: 'cv-gate-m',
      merchantId: 'm1',
      merchantUserId: USER,
      venueId: 'binance-spot',
      fromAsset: 'USD',
      toAsset: 'USDT',
      fromAmount: amt('10'),
      toAmount: amt('10'),
      feeAmount: 0n,
      spreadAmount: 0n,
      funding: 'merchant',
    });
    expect(() =>
      assertKnownRecipePost({
        module: merchant.module,
        reason: 'pay.conversion.late_shortfall',
        entries: merchant.entries.map((entry) => ({ account: entry.account, direction: entry.direction })),
      }),
    ).toThrow(expect.objectContaining({ code: RECIPE_REQUIRED_CODE }));
  });
});
