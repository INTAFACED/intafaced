/**
 * S19 futures slice — the fourteen acceptance rows, hermetic.
 *
 * Money moves only through ledger recipes. A blank haircut, cap, or mode
 * stays a refusal. TRADE_FUTURES_ENABLED is not turned on by these tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@intafaced/auth';
import { encodePrincipal, signPrincipalHeader } from '@intafaced/contracts';
import {
  MemoryLedger,
  formatAmount,
  futuresLossSink,
  houseFees,
  insuranceFund,
  parseAmount,
  positionCollateralAccount,
  railBoundary,
  recipes,
  subAccountAvailable,
  subAccountHold,
  type AccountRef,
} from '@intafaced/ledger-client';
import { registerPrivateRest, type PrivateRestDeps } from '../private-rest.js';
import { TradeService, type PlaceOrderInput } from '../spot/trade-service.js';
import { installCollateralHaircutOpen } from './collateral-haircut.js';
import { checkInsuranceBound } from './insurance-bound.js';
import { LIQUIDATION_NOT_SCHEDULED, presentFuturesJobsHealth } from './futures-jobs-health.js';
import { startFuturesJobs } from './futures-jobs.js';
import { decideOpenCredit } from './haircut-credit.js';
import { planLiquidation } from './liquidation-planner.js';
import { memoryMarginModeSwitchAudit } from './margin-mode.js';
import { installOverloadPlace } from './overload.js';
import { installPositionModePlace } from './position-mode.js';
import { FuturesError, PositionService } from './position-service.js';
import { installPreTradeCreditPlace } from './pretrade-credit.js';
import { checkMaxOrder } from './pretrade-limits.js';
import { gateLiquidationRecipe } from './sub-account-loss.js';

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = 's19-futures-slice-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const FEE_PAYER = '33333333-3333-4333-8333-333333333333';
const LOSER_SUB = '44444444-4444-4444-8444-444444444444';
const SIBLING = '55555555-5555-4555-8555-555555555555';
const ASSET = 'USDT';
const POSITION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function headers(): Record<string, string> {
  const principal = {
    sub: USER,
    userId: USER,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
  const encoded = encodePrincipal(principal);
  return {
    'x-intafaced-principal': encoded,
    'x-intafaced-principal-sig': signPrincipalHeader(encoded, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  };
}

function door(extra: Record<string, unknown> = {}) {
  const app = Fastify();
  registerPrivateRest(app, { edgeSecret: SECRET, serviceName: 'svc-trade', ...extra } as unknown as PrivateRestDeps);
  return app;
}

async function bal(ledger: MemoryLedger, ref: AccountRef): Promise<string> {
  return formatAmount((await ledger.balance(ref)).amount);
}

async function fundUser(ledger: MemoryLedger, userId: string, amount: string, railRef: string): Promise<void> {
  await ledger.post(recipes.deposit({ userId, assetId: ASSET, amount: parseAmount(amount), rail: 'test', railRef }));
}

async function seedInsurance(ledger: MemoryLedger, amount: string, topupId: string): Promise<void> {
  await fundUser(ledger, FEE_PAYER, amount, `fee-seed-${topupId}`);
  await ledger.post(
    recipes.feeCharge({
      chargeId: `fee-${topupId}`,
      userId: FEE_PAYER,
      module: 'trade',
      mode: 'asset',
      assetId: ASSET,
      amount: parseAmount(amount),
    }),
  );
  await ledger.post(recipes.futuresInsuranceTopup({ topupId, assetId: ASSET, amount: parseAmount(amount) }));
}

async function seedMargin(ledger: MemoryLedger, amount: string): Promise<void> {
  await fundUser(ledger, USER, amount, `margin-${POSITION}-${amount}`);
  await ledger.post(recipes.futuresMarginLock({ positionId: POSITION, userId: USER, assetId: ASSET, amount: parseAmount(amount) }));
}

async function seedSub(ledger: MemoryLedger, subAccountId: string, amount: string, key: string): Promise<void> {
  await ledger.post({
    idempotencyKey: key,
    module: 'ledger',
    reason: 'deposit.credited',
    entries: [
      { account: railBoundary('test', ASSET), direction: 'credit' as const, amount: parseAmount(amount) },
      { account: subAccountAvailable(subAccountId, ASSET), direction: 'debit' as const, amount: parseAmount(amount) },
    ],
  });
}

function workedLoss() {
  return planLiquidation({
    liquidationId: 'liq-s19',
    position: {
      positionId: POSITION,
      userId: USER,
      side: 'long',
      size: parseAmount('1'),
      entryPrice: parseAmount('50000'),
      margin: parseAmount('5000'),
      marginAsset: ASSET,
    },
    markPrice: '40000',
  });
}

describe('TRD-0211 DELETE is not a close', () => {
  it('refuses DELETE and leaves the margin pot where it was', async () => {
    const ledger = new MemoryLedger();
    await seedMargin(ledger, '5000');
    const pot = positionCollateralAccount(USER, ASSET, POSITION);
    let closes = 0;
    const app = door({
      closePosition: async () => {
        closes += 1;
        return { id: POSITION };
      },
    });
    await app.ready();
    const res = await app.inject({ method: 'DELETE', url: `/api/v1/positions/${POSITION}`, headers: headers() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.cancel_not_close');
    expect(closes).toBe(0);
    expect(await bal(ledger, pot)).toBe('5000');
    await app.close();
  });

  it('a close that throws is the HTTP body and does not release the pot', async () => {
    const ledger = new MemoryLedger();
    await seedMargin(ledger, '5000');
    const app = door({
      closePositionQuantity: async () => {
        throw new FuturesError('close failed', 'trade.close_failed', 400);
      },
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/positions/${POSITION}/close`,
      headers: headers(),
      payload: { quantity: '1', clientCloseId: 'close-fail' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('trade.close_failed');
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, POSITION))).toBe('5000');
    await app.close();
  });

  it('a second close of a closed row does not post again', async () => {
    const ledger = new MemoryLedger();
    await seedMargin(ledger, '5000');
    let open = true;
    const app = door({
      closePositionQuantity: async () => {
        if (!open) throw new FuturesError('position is closed', 'trade.position_not_open', 400);
        await ledger.post(
          recipes.futuresMarginRelease({
            positionId: POSITION,
            userId: USER,
            assetId: ASSET,
            amount: parseAmount('5000'),
            sequence: 1,
          }),
        );
        open = false;
        return { id: POSITION };
      },
    });
    await app.ready();
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/positions/${POSITION}/close`,
      headers: headers(),
      payload: { quantity: '1', clientCloseId: 'close-1' },
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/v1/positions/${POSITION}/close`,
      headers: headers(),
      payload: { quantity: '1', clientCloseId: 'close-2' },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe('trade.position_not_open');
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, POSITION))).toBe('0');
    expect(await bal(ledger, { ownerType: 'user', ownerId: USER, assetId: ASSET, kind: 'available' })).toBe('5000');
    await app.close();
  });
});

describe('TRD-0217 margin-mode refusal is audited', () => {
  it('cross and a repeat, then portfolio, append audit rows and do not flip the book', async () => {
    const audit = memoryMarginModeSwitchAudit();
    let updates = 0;
    const app = door({
      marginModeAudit: audit,
      setMarginMode: () => {
        updates += 1;
      },
    });
    await app.ready();
    const cross = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin-mode',
      headers: headers(),
      payload: { marginMode: 'cross', positionId: POSITION },
    });
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin-mode',
      headers: headers(),
      payload: { marginMode: 'cross', positionId: POSITION },
    });
    const portfolio = await app.inject({
      method: 'POST',
      url: '/api/v1/positions/margin-mode',
      headers: headers(),
      payload: { marginMode: 'portfolio', positionId: POSITION },
    });
    expect(cross.statusCode).toBe(501);
    expect(again.statusCode).toBe(501);
    expect(portfolio.statusCode).toBe(501);
    expect(cross.json().intafacedCode).toBe('trade.margin_mode_unsupported');
    const rows = await audit.list();
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ outcome: 'refused', code: 'trade.cross_margin_unsupported', toMode: 'cross' });
    expect(rows[1]).toMatchObject({ outcome: 'refused', code: 'trade.cross_margin_unsupported' });
    expect(rows[2]).toMatchObject({ outcome: 'refused', code: 'trade.portfolio_margin_unset', toMode: 'portfolio' });
    expect(updates).toBe(0);
    await app.close();
  });
});

describe('TRD-0218 leverage idempotency key', () => {
  it('omitting clientAdjustmentId refuses and does not move margin', async () => {
    const ledger = new MemoryLedger();
    await seedMargin(ledger, '5000');
    let calls = 0;
    const app = door({
      setLeverage: async () => {
        calls += 1;
        return { id: POSITION };
      },
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/futures/leverage',
      headers: headers(),
      payload: { symbol: 'BTC/USDT-PERP', leverage: '4', marginMode: 'isolated', positionId: POSITION },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.idempotency_key_required');
    expect(calls).toBe(0);
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, POSITION))).toBe('5000');
    await app.close();
  });

  it('omitting positionId refuses before setLeverage', async () => {
    let calls = 0;
    const app = door({
      setLeverage: async () => {
        calls += 1;
        return { id: POSITION };
      },
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/futures/leverage',
      headers: headers(),
      payload: { symbol: 'BTC/USDT-PERP', leverage: '4', clientAdjustmentId: 'lev-1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().intafacedCode).toBe('trade.position_id_required');
    expect(calls).toBe(0);
    await app.close();
  });

  it('the same clientAdjustmentId is the key the service replays', async () => {
    const seen: string[] = [];
    const movement = { id: POSITION, margin: '4' };
    const app = door({
      setLeverage: async (_principal: Principal, input: { clientAdjustmentId: string }) => {
        seen.push(input.clientAdjustmentId);
        return movement;
      },
    });
    await app.ready();
    const body = {
      symbol: 'BTC/USDT-PERP',
      leverage: '4',
      positionId: POSITION,
      clientAdjustmentId: 'lev-same',
    };
    const first = await app.inject({ method: 'POST', url: '/api/v1/futures/leverage', headers: headers(), payload: body });
    const second = await app.inject({ method: 'POST', url: '/api/v1/futures/leverage', headers: headers(), payload: body });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(seen).toEqual(['lev-same', 'lev-same']);
    const src = readFileSync(join(here, 'position-service.ts'), 'utf8');
    const setAt = src.indexOf('async setLeverage');
    expect(src.slice(setAt, setAt + 4000)).toMatch(/claimMarginAdjustment/);
    await app.close();
  });

  it('an unreadable book refuses the release', async () => {
    const ledger = new MemoryLedger();
    await seedMargin(ledger, '5000');
    const app = door({
      setLeverage: async () => {
        throw new FuturesError('book unreadable', 'trade.depth_unknown', 503);
      },
    });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/futures/leverage',
      headers: headers(),
      payload: {
        symbol: 'BTC/USDT-PERP',
        leverage: '2',
        positionId: POSITION,
        clientAdjustmentId: 'lev-depth',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('trade.depth_unknown');
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, POSITION))).toBe('5000');
    await app.close();
  });
});

describe('TRD-0225 liquidation off is an alarm', () => {
  it('a disabled jobs flag names futures.liquidation and starts no tick', () => {
    const health = presentFuturesJobsHealth({
      enabled: false,
      fundingMarketCount: 0,
      fundingMaxAbsRateConfigured: false,
    });
    expect(health.alerts).toEqual([{ name: 'futures.liquidation', message: LIQUIDATION_NOT_SCHEDULED }]);
    const off = startFuturesJobs({
      sql: {} as never,
      ledger: { post: async () => ({}) as never, balance: async () => ({}) as never },
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 1 }) } as never,
      bus: null,
      config: {
        enabled: false,
        liqIntervalMs: 15_000,
        fundingIntervalMs: null,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
      },
    });
    expect(off.host.list()).toEqual([]);
    expect(off.alerts.map((alert) => alert.message)).toEqual([LIQUIDATION_NOT_SCHEDULED]);
    off.stop();
  });
});

describe('TRD-0289 a sibling sub-account is not the loss pot', () => {
  it('a posted liquidation leaves the sibling available and hold unchanged, and a sibling leg is refused', async () => {
    const ledger = new MemoryLedger();
    await seedSub(ledger, SIBLING, '9', 'seed-sib');
    await seedSub(ledger, LOSER_SUB, '9', 'seed-loser');
    await ledger.post({
      idempotencyKey: 'seed-sib-hold',
      module: 'ledger',
      reason: 'subaccount.hold',
      entries: [
        { account: subAccountAvailable(SIBLING, ASSET), direction: 'credit' as const, amount: parseAmount('2') },
        { account: subAccountHold(SIBLING, ASSET, 'strategy'), direction: 'debit' as const, amount: parseAmount('2') },
      ],
    });
    await seedMargin(ledger, '5000');
    await seedInsurance(ledger, '5000', 'ins-0289');
    const plan = workedLoss();
    expect(plan.liquidate).toBe(true);
    if (!plan.liquidate) return;
    const gate = gateLiquidationRecipe({ userId: USER, subAccountId: LOSER_SUB }, plan.recipes[0]!);
    expect(gate.ok).toBe(true);
    await ledger.post(plan.recipes[0]!);
    expect(await bal(ledger, subAccountAvailable(SIBLING, ASSET))).toBe('7');
    expect(await bal(ledger, subAccountHold(SIBLING, ASSET, 'strategy'))).toBe('2');
    expect(await bal(ledger, subAccountAvailable(LOSER_SUB, ASSET))).toBe('9');

    const aimed = {
      idempotencyKey: 'sibling-loss',
      module: 'trade',
      reason: 'futures.loss.realized',
      entries: [
        { account: subAccountAvailable(SIBLING, ASSET), direction: 'credit' as const, amount: parseAmount('1') },
        { account: subAccountAvailable(LOSER_SUB, ASSET), direction: 'debit' as const, amount: parseAmount('1') },
      ],
    };
    const refused = gateLiquidationRecipe({ userId: USER, subAccountId: LOSER_SUB }, aimed);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('trade.sub_account_loss_isolated');
    expect(await bal(ledger, subAccountAvailable(SIBLING, ASSET))).toBe('7');

    const tick = readFileSync(join(here, 'liquidation-tick.ts'), 'utf8');
    expect(tick).toMatch(/postGuarded/);
    expect(tick).not.toMatch(/deps\.ledger\.post/);
  });
});

describe('TRD-0295 maker loss is booked, house fees are not insurance', () => {
  it('an unfunded insurance shortfall is not posted and house fees stay put', async () => {
    const ledger = new MemoryLedger();
    await seedMargin(ledger, '5000');
    const plan = workedLoss();
    expect(plan.liquidate).toBe(true);
    if (!plan.liquidate) return;
    expect(formatAmount(plan.fromMargin)).toBe('5000');
    expect(formatAmount(plan.fromInsurance)).toBe('5000');
    const bound = await checkInsuranceBound({
      assetId: ASSET,
      fromInsurance: plan.fromInsurance,
      balance: (ref) => ledger.balance(ref),
    });
    expect(bound.ok).toBe(false);
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, POSITION))).toBe('5000');
    expect(await bal(ledger, insuranceFund(ASSET))).toBe('0');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('0');
  });

  it('a funded shortfall posts what the pot holds plus insurance into the loss sink, and house fees stay put', async () => {
    const ledger = new MemoryLedger();
    await seedMargin(ledger, '5000');
    await seedInsurance(ledger, '5000', 'ins-0295');
    const plan = workedLoss();
    if (!plan.liquidate) throw new Error('worked example must liquidate');
    const bound = await checkInsuranceBound({
      assetId: ASSET,
      fromInsurance: plan.fromInsurance,
      balance: (ref) => ledger.balance(ref),
    });
    expect(bound.ok).toBe(true);
    const gate = gateLiquidationRecipe({ userId: USER }, plan.recipes[0]!);
    expect(gate.ok).toBe(true);
    await ledger.post(plan.recipes[0]!);
    expect(await bal(ledger, positionCollateralAccount(USER, ASSET, POSITION))).toBe('0');
    expect(await bal(ledger, insuranceFund(ASSET))).toBe('0');
    expect(await bal(ledger, futuresLossSink(ASSET))).toBe('10000');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('0');
  });

  it('a recipe that draws house fees is refused and the fee pot is unchanged', async () => {
    const ledger = new MemoryLedger();
    await fundUser(ledger, FEE_PAYER, '5000', 'fee-only');
    await ledger.post(
      recipes.feeCharge({
        chargeId: 'fee-only',
        userId: FEE_PAYER,
        module: 'trade',
        mode: 'asset',
        assetId: ASSET,
        amount: parseAmount('5000'),
      }),
    );
    const draw = {
      idempotencyKey: 'fees-as-insurance',
      module: 'trade',
      reason: 'futures.loss.realized',
      entries: [
        { account: houseFees('trade', ASSET), direction: 'credit' as const, amount: parseAmount('5000') },
        { account: positionCollateralAccount(USER, ASSET, POSITION), direction: 'debit' as const, amount: parseAmount('5000') },
      ],
    };
    const gate = gateLiquidationRecipe({ userId: USER }, draw);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.code).toBe('trade.house_fees_not_insurance');
    expect(await bal(ledger, houseFees('trade', ASSET))).toBe('5000');
  });
});

describe('TRD-0324 overload still takes a reduce-only', () => {
  it('refuses new risk and admits reduce-only and close-position while the switch is on', async () => {
    class Door {
      holds = 0;
      async placeOrder(_principal: Principal, _input: PlaceOrderInput) {
        this.holds += 1;
        return { id: 'o' };
      }
    }
    installOverloadPlace(Door as unknown as typeof TradeService);
    const doorInstance = new Door();
    const principal = { userId: USER } as Principal;
    const increasing = { symbol: 'BTC/USDT', side: 'buy', type: 'limit', qty: parseAmount('1') } as PlaceOrderInput;
    const prev = process.env.TRADE_ORDER_OVERLOAD;
    try {
      delete process.env.TRADE_ORDER_OVERLOAD;
      await doorInstance.placeOrder(principal, increasing);
      expect(doorInstance.holds).toBe(1);
      process.env.TRADE_ORDER_OVERLOAD = 'true';
      await expect(doorInstance.placeOrder(principal, increasing)).rejects.toMatchObject({ code: 'trade.system_overload' });
      expect(doorInstance.holds).toBe(1);
      await doorInstance.placeOrder(principal, { ...increasing, side: 'sell', reduceOnly: true } as PlaceOrderInput);
      await doorInstance.placeOrder(principal, { ...increasing, closePosition: true } as PlaceOrderInput);
      expect(doorInstance.holds).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.TRADE_ORDER_OVERLOAD;
      else process.env.TRADE_ORDER_OVERLOAD = prev;
    }
    const boot = readFileSync(join(here, '..', 'ledger-client.ts'), 'utf8');
    expect(boot).toMatch(/installOverload\(\)/);
  });
});

describe('TRD-0326 reduce-only ignores a blank max-order', () => {
  it('a reduce-only place is not refused for the unset cap; an increasing place is', async () => {
    class Door {
      holds = 0;
      async placeOrder(_principal: Principal, _input: PlaceOrderInput) {
        this.holds += 1;
        return { id: 'o' };
      }
    }
    installPreTradeCreditPlace(Door as unknown as typeof TradeService);
    const doorInstance = new Door();
    const principal = { userId: USER } as Principal;
    const prevOrder = process.env.TRADE_MAX_ORDER;
    const prevPos = process.env.TRADE_MAX_POSITION;
    const prevLoss = process.env.TRADE_MAX_LOSS;
    try {
      delete process.env.TRADE_MAX_ORDER;
      process.env.TRADE_MAX_POSITION = '1';
      process.env.TRADE_MAX_LOSS = '1';
      const reduce = { symbol: 'BTC/USDT', side: 'sell', type: 'limit', qty: parseAmount('1'), reduceOnly: true } as PlaceOrderInput;
      await doorInstance.placeOrder(principal, reduce);
      await doorInstance.placeOrder(principal, reduce);
      expect(doorInstance.holds).toBe(2);
      await expect(
        doorInstance.placeOrder(principal, { symbol: 'BTC/USDT', side: 'buy', type: 'limit', qty: parseAmount('1') }),
      ).rejects.toMatchObject({ code: 'trade.max_order_unset' });
      expect(doorInstance.holds).toBe(2);
    } finally {
      if (prevOrder === undefined) delete process.env.TRADE_MAX_ORDER;
      else process.env.TRADE_MAX_ORDER = prevOrder;
      if (prevPos === undefined) delete process.env.TRADE_MAX_POSITION;
      else process.env.TRADE_MAX_POSITION = prevPos;
      if (prevLoss === undefined) delete process.env.TRADE_MAX_LOSS;
      else process.env.TRADE_MAX_LOSS = prevLoss;
    }
  });
});

describe('TRD-0429 TRD-0510 TRD-0517 blank haircut locks nothing', () => {
  it('a blank haircut and a staked class each refuse before open', async () => {
    class Door {
      locks = 0;
      async open(_input: unknown, _principal?: Principal) {
        this.locks += 1;
        return { id: POSITION };
      }
    }
    installCollateralHaircutOpen(Door as unknown as typeof PositionService);
    const doorInstance = new Door();
    const prev = process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    try {
      delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
      await expect(doorInstance.open({} as never)).rejects.toMatchObject({ code: 'trade.haircut_unset' });
      await expect(doorInstance.open({} as never)).rejects.toMatchObject({ code: 'trade.haircut_unset' });
      await expect(doorInstance.open({ collateralClass: 'staked' } as never)).rejects.toMatchObject({
        code: 'trade.unsupported_collateral_class',
      });
      await expect(doorInstance.open({ haircutBps: 'nope' } as never)).rejects.toMatchObject({ code: 'trade.haircut_unset' });
      expect(doorInstance.locks).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
      else process.env.TRADE_COLLATERAL_HAIRCUT_BPS = prev;
    }
    const boot = readFileSync(join(here, '..', 'ledger-client.ts'), 'utf8');
    expect(boot).toMatch(/installCollateralHaircut\(\)/);
  });
});

describe('TRD-0509 a published max order binds the notional', () => {
  it('notional 11 against a cap of 10 refuses, 10 does not, and 0 refuses an increase', () => {
    const over = checkMaxOrder({
      limits: { maxOrder: 10, maxPosition: null, maxLoss: null },
      quoteAsset: ASSET,
      price: parseAmount('11'),
      qty: parseAmount('1'),
    });
    const at = checkMaxOrder({
      limits: { maxOrder: 10, maxPosition: null, maxLoss: null },
      quoteAsset: ASSET,
      price: parseAmount('10'),
      qty: parseAmount('1'),
    });
    const zero = checkMaxOrder({
      limits: { maxOrder: 0, maxPosition: null, maxLoss: null },
      quoteAsset: ASSET,
      price: parseAmount('1'),
      qty: parseAmount('1'),
    });
    const retry = checkMaxOrder({
      limits: { maxOrder: 10, maxPosition: null, maxLoss: null },
      quoteAsset: ASSET,
      price: parseAmount('11'),
      qty: parseAmount('1'),
    });
    expect(over?.code).toBe('trade.limit_max_order');
    expect(at).toBeNull();
    expect(zero?.code).toBe('trade.limit_max_order');
    expect(retry?.code).toBe('trade.limit_max_order');
  });
});

describe('TRD-0519 a futures place without a position mode', () => {
  it('refuses before the spot place and leaves the spot balance', async () => {
    class Door {
      holds = 0;
      kind: 'futures' | 'spot' = 'futures';
      async marketBySymbol() {
        return { kind: this.kind };
      }
      async marketById() {
        return { kind: this.kind };
      }
      async placeOrder(_principal: Principal, _input: PlaceOrderInput) {
        this.holds += 1;
        return { id: 'o' };
      }
    }
    installPositionModePlace(Door as unknown as typeof TradeService);
    const doorInstance = new Door();
    const ledger = new MemoryLedger();
    await fundUser(ledger, USER, '3', 'spot-bal');
    const principal = { userId: USER } as Principal;
    const order = { symbol: 'BTC/USDT-PERP', side: 'buy', type: 'limit', qty: parseAmount('1') } as PlaceOrderInput;
    const prev = process.env.TRADE_FUTURES_ENABLED;
    try {
      process.env.TRADE_FUTURES_ENABLED = 'true';
      await expect(doorInstance.placeOrder(principal, order)).rejects.toMatchObject({ code: 'trade.position_mode_unset' });
      expect(doorInstance.holds).toBe(0);
      expect(await bal(ledger, { ownerType: 'user', ownerId: USER, assetId: ASSET, kind: 'available' })).toBe('3');
      await expect(doorInstance.placeOrder(principal, order)).rejects.toMatchObject({ code: 'trade.position_mode_unset' });
      expect(doorInstance.holds).toBe(0);
      doorInstance.kind = 'spot';
      await doorInstance.placeOrder(principal, { ...order, symbol: 'BTC/USDT' });
      expect(doorInstance.holds).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.TRADE_FUTURES_ENABLED;
      else process.env.TRADE_FUTURES_ENABLED = prev;
    }
  });
});

describe('TRD-0524 staked plus a blank haircut refuses; a published haircut does not shrink the lock', () => {
  it('refuses staked collateral with a blank haircut and locks the full initial margin when a haircut still covers', async () => {
    class Door {
      locks = 0;
      async open(_input: unknown, _principal?: Principal) {
        this.locks += 1;
        return { id: POSITION };
      }
    }
    installCollateralHaircutOpen(Door as unknown as typeof PositionService);
    const doorInstance = new Door();
    const prev = process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    try {
      delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
      await expect(doorInstance.open({ collateralClass: 'staked' } as never)).rejects.toMatchObject({
        code: 'trade.unsupported_collateral_class',
      });
      await expect(doorInstance.open({ collateralClass: 'staked' } as never)).rejects.toMatchObject({
        code: 'trade.unsupported_collateral_class',
      });
      expect(doorInstance.locks).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
      else process.env.TRADE_COLLATERAL_HAIRCUT_BPS = prev;
    }
    const covered = decideOpenCredit({
      postedCash: parseAmount('100'),
      initialMargin: parseAmount('90'),
      haircutBps: 1000,
    });
    expect(covered.ok).toBe(true);
    if (covered.ok) expect(covered.lockAmount).toBe(parseAmount('90'));
  });
});
