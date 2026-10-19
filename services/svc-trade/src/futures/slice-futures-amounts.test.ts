import { beforeEach, describe, expect, it } from 'vitest';
import {
  LedgerError,
  MemoryLedger,
  formatAmount,
  parseAmount as amt,
  recipes,
  type AccountRef,
  type LedgerClient,
  type PostRequest,
} from '@intafaced/ledger-client';
import { armCancelAllAfter, expireCancelAllAfter, type CancelAllAfterOrder } from './cancel-all-after.js';
import { cancelAttachedToEntry, stopAfterMarket, type AttachedExit } from './attached-exits.js';
import { entryFromOpeningFills, storedEntryAfterFill } from './position-service.js';
import {
  HAIRCUT_CREDIT_SHORT,
  HAIRCUT_UNSET,
  checkPostedMarginCollateral,
  collateralCredit,
  decideOpenCredit,
  installCollateralHaircutOpen,
  requireOwnerHaircutBps,
} from './collateral-haircut.js';
import { FuturesError, PositionService, type OpenPositionInput } from './position-service.js';
import {
  cancelIncreasingOrdersBeforeRung,
  memoryLiquidationAttemptStore,
  orderIncreasesPosition,
  runLiquidationTick,
  type LiquidationPositionRow,
  type QuotedMarkSource,
} from './liquidation-tick.js';
import { memoryAcceptedMarkStore } from './accepted-mark.js';
import { deepFullCloseLadder } from './ladder-policy.test-harness.js';
import type { Amount, Balance } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import type { CommittedOperationAdmission } from '@intafaced/contracts';
import type { TradingAdmissionPort } from '../controls/trading-controls.js';
import { principalFor } from '../spot/testing.js';
import { closeHoldFailureAction } from '../spot/close-position.js';
import { TEST_MAX_LEVERAGE_AMOUNT } from './initial-margin.test-harness.js';
import { memoryMarkBook } from './mark-source.js';
import { formatAccountRef, profitSourceFromConfig, recipeProfitFundingAccount } from './profit-source.js';
import { LIQUIDATION_NOT_SCHEDULED, presentFuturesJobsHealth } from './futures-jobs-health.js';
import { startFuturesJobs } from './futures-jobs.js';

const PUBLISHED_TIMEOUTS = [0, 10, 120] as const;

describe('S07 haircut credit', () => {
  it('a blank haircut refuses trade.haircut_unset and does not invent 0 or 10', () => {
    const previous = process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    try {
      expect(checkPostedMarginCollateral({})).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
      expect(checkPostedMarginCollateral({ haircutBps: '' })).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
      const blank = checkPostedMarginCollateral({ haircutBps: '   ' });
      expect(blank.ok).toBe(false);
      if (!blank.ok) expect(blank.reason).not.toMatch(/\b0 bps\b|\b10 bps\b/);
    } finally {
      if (previous === undefined) delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
      else process.env.TRADE_COLLATERAL_HAIRCUT_BPS = previous;
    }
  });

  it('100 cash at 1000 bps credits 90, so initial margin 100 is refused and the lock stays 0', () => {
    expect(formatAmount(collateralCredit(amt('100'), 1000))).toBe('90');
    const decision = decideOpenCredit({ postedCash: amt('100'), initialMargin: amt('100'), haircutBps: 1000 });
    expect(decision).toMatchObject({ ok: false, code: HAIRCUT_CREDIT_SHORT, lockAmount: 0n });
  });

  it('a haircut that still covers the margin does not shrink the initial-margin lock', () => {
    const decision = decideOpenCredit({ postedCash: amt('100'), initialMargin: amt('90'), haircutBps: 1000 });
    expect(decision).toMatchObject({ ok: true, lockAmount: amt('90') });
    if (decision.ok) expect(formatAmount(decision.credit)).toBe('90');
  });

  it('a short credit refuses the open before the original open, so no margin is locked', async () => {
    const book = creditBook();
    await fund(book.ledger, '100', 's07-short');
    book.seed('BTC/USDT-PERP', 'm-short', '100');
    await expect(
      book.open({ symbol: 'BTC/USDT-PERP', marketId: 'm-short', price: '100', leverage: '1', clientOpenId: 'haircut-short' }),
    ).rejects.toMatchObject({ name: 'FuturesError', code: HAIRCUT_CREDIT_SHORT });
    expect(lockPosts(book.ledger)).toEqual([]);
  });

  it('a blank haircut on the open wrapper does not call the original open', async () => {
    const locks: string[] = [];
    class Book {
      async open(_input?: OpenPositionInput) {
        locks.push('lock');
        return { id: 'pos' };
      }
    }
    installCollateralHaircutOpen(Book as unknown as typeof PositionService);
    const previous = process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
    try {
      await expect(new Book().open({ haircutBps: '' } as unknown as OpenPositionInput)).rejects.toBeInstanceOf(FuturesError);
      expect(locks).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.TRADE_COLLATERAL_HAIRCUT_BPS;
      else process.env.TRADE_COLLATERAL_HAIRCUT_BPS = previous;
    }
  });
});

const CREDIT_USER = '11111111-1111-4111-8111-111111111111';
const CREDIT_NOW = new Date('2026-10-17T02:00:00.000Z');

interface MemMarket {
  id: string;
  symbol: string;
  kind: string;
  status: string;
  quote_asset: string;
  futures_contract_style: null;
  futures_expiry_at: null;
  futures_settlement_fixing: null;
}

interface MemPosition {
  id: string;
  user_id: string;
  market_id: string;
  side: string;
  status: string;
  margin_mode: string;
  size: string;
  entry_price: string;
  leverage: string;
  margin_initial: string;
  margin_current: string;
  margin_asset: string;
  funding_paid: string;
  liq_price: null;
  opened_at: Date;
  closed_at: null;
  symbol: string;
  accepted_mark: string | null;
  accepted_mark_at: Date | null;
  closing_reason: null;
  margin_adjust_seq: number;
  margin_adjust_request: string | null;
}

interface MemAdjustment {
  position_id: string;
  client_adjustment_id: string;
  request_fingerprint: string;
  sequence: number;
  status: 'pending' | 'completed';
  result: unknown;
}

function recordingAdmission(): TradingAdmissionPort {
  const parents = new Map<string, { payload: unknown; admission: CommittedOperationAdmission; grantId: string }>();
  return {
    async admit(principal, kind, businessId, payload) {
      const admission: CommittedOperationAdmission = {
        operation: { service: 'svc-trade', kind, userId: principal.userId },
        businessId,
        payloadHash: 'sha256:credit-test',
        status: 'committed',
        admissionId: `adm-${businessId}`,
        admittedAt: CREDIT_NOW.toISOString(),
        identityVersion: '0',
        restrictionVersion: '0',
      };
      parents.set(`${principal.userId}:${businessId}`, { payload, admission, grantId: admission.admissionId });
      return admission;
    },
    async admitStanding() {
      throw new Error('this fixture admits no standing instruction');
    },
    async original(userId, businessId) {
      return parents.get(`${userId}:${businessId}`) ?? null;
    },
    async resolve(userId, businessId) {
      return parents.get(`${userId}:${businessId}`) ?? null;
    },
  };
}

function creditBook(options?: { balanceThrows?: boolean }) {
  const markets: MemMarket[] = [];
  const positions: MemPosition[] = [];
  const adjustments: MemAdjustment[] = [];
  let skipInserts = 0;

  const query = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const text = strings.join(' ').replace(/\s+/g, ' ');
    if (text.includes('FROM trade.markets') && text.includes('WHERE symbol')) {
      const symbol = String(values[0]);
      return markets.filter((market) => market.symbol === symbol);
    }
    if (text.includes('SELECT margin_initial, margin_current') && text.includes('trade.positions')) {
      const userId = String(values[0]);
      const asset = String(values[1]);
      return positions.filter(
        (row) => row.user_id === userId && row.margin_asset === asset && (row.status === 'open' || row.status === 'closing'),
      );
    }
    if (text.includes('INSERT INTO trade.positions')) {
      if (skipInserts > 0) {
        skipInserts -= 1;
        return [];
      }
      const marketId = String(values[2]);
      const market = markets.find((row) => row.id === marketId);
      positions.push({
        id: String(values[0]),
        user_id: String(values[1]),
        market_id: marketId,
        side: String(values[3]),
        status: 'open',
        margin_mode: String(values[4]),
        size: String(values[5]),
        entry_price: String(values[6]),
        leverage: String(values[7]),
        margin_initial: String(values[8]),
        margin_current: String(values[9]),
        margin_asset: String(values[10]),
        funding_paid: '0',
        liq_price: null,
        opened_at: values[12] instanceof Date ? values[12] : CREDIT_NOW,
        closed_at: null,
        symbol: market?.symbol ?? '',
        accepted_mark: String(values[11]),
        accepted_mark_at: values[12] instanceof Date ? values[12] : CREDIT_NOW,
        closing_reason: null,
        margin_adjust_seq: 1,
        margin_adjust_request: null,
      });
      return [];
    }
    if (text.includes('liquidation_rungs') || text.includes('liquidation_attempts')) return [];
    if (text.includes('INSERT INTO trade.position_margin_adjustments')) {
      adjustments.push({
        position_id: String(values[0]),
        client_adjustment_id: String(values[1]),
        request_fingerprint: String(values[2]),
        sequence: Number(values[3]),
        status: 'pending',
        result: null,
      });
      return [];
    }
    if (text.includes('FROM trade.position_margin_adjustments')) {
      const positionId = String(values[0]);
      const adjustmentId = String(values[1]);
      const found = adjustments.find((row) => row.position_id === positionId && row.client_adjustment_id === adjustmentId);
      return found ? [{ request_fingerprint: found.request_fingerprint, status: found.status, result: found.result }] : [];
    }
    if (text.includes('DELETE FROM trade.position_margin_adjustments')) {
      const positionId = String(values[0]);
      const adjustmentId = String(values[1]);
      for (let i = adjustments.length - 1; i >= 0; i -= 1) {
        const row = adjustments[i]!;
        if (row.position_id === positionId && row.client_adjustment_id === adjustmentId && row.status === 'pending') {
          adjustments.splice(i, 1);
        }
      }
      return [];
    }
    if (text.includes('UPDATE trade.position_margin_adjustments')) {
      const result = values[0];
      const positionId = String(values[1]);
      const adjustmentId = String(values[2]);
      const found = adjustments.find((row) => row.position_id === positionId && row.client_adjustment_id === adjustmentId);
      if (found && text.includes("status = 'completed'")) {
        found.status = 'completed';
        found.result = result;
      }
      return [];
    }
    if (text.includes('UPDATE trade.positions') && text.includes('SET leverage')) {
      const id = String(values[4]);
      const userId = String(values[5]);
      const row = positions.find((position) => position.id === id && position.user_id === userId && position.status === 'open');
      if (!row) return [];
      row.leverage = String(values[0]);
      row.margin_initial = String(values[1]);
      row.margin_current = String(values[2]);
      row.margin_adjust_seq = Number(values[3]);
      row.margin_adjust_request = null;
      return [row];
    }
    if (text.includes('UPDATE trade.positions') && text.includes('margin_adjust_request = NULL')) {
      const id = String(values[0]);
      const userId = String(values[1]);
      const adjustmentId = String(values[2]);
      const row = positions.find((position) => position.id === id && position.user_id === userId);
      if (row && row.margin_adjust_request === adjustmentId) row.margin_adjust_request = null;
      return [];
    }
    if (text.includes('UPDATE trade.positions') && text.includes('SET margin_adjust_request')) {
      const adjustmentId = String(values[0]);
      const id = String(values[1]);
      const row = positions.find((position) => position.id === id);
      if (row) row.margin_adjust_request = adjustmentId;
      return [];
    }
    if (text.includes('INSERT INTO trade.futures_open_requests')) {
      return [];
    }
    if (text.includes('SELECT p.*')) {
      if (text.includes('m.symbol =')) {
        const userId = String(values[0]);
        const symbol = String(values[1]);
        return positions.filter((row) => row.user_id === userId && row.symbol === symbol && row.status === 'open');
      }
      if (text.includes('p.user_id')) {
        const id = String(values[0]);
        const userId = String(values[1]);
        return positions.filter((row) => row.id === id && row.user_id === userId);
      }
      const id = String(values[0]);
      return positions.filter((row) => row.id === id);
    }
    throw new Error(`unexpected sql: ${text}`);
  };

  const tag = Object.assign(query, {
    begin<T>(fn: (tx: typeof query) => Promise<T>): Promise<T> {
      return fn(tag);
    },
    async unsafe() {
      return [];
    },
    json(value: unknown) {
      return value;
    },
  });

  const marks = memoryMarkBook();
  const ledger = new MemoryLedger();
  const readBalance = ledger.balance.bind(ledger);
  const client: LedgerClient = {
    async post(request: PostRequest) {
      return ledger.post(request);
    },
    async balance(ref: AccountRef) {
      if (options?.balanceThrows) throw new Error('balance down');
      return readBalance(ref);
    },
  } as LedgerClient;

  process.env.TRADE_FUTURES_ENABLED = 'true';
  process.env.TRADE_FUTURES_JOBS_ENABLED = 'true';
  process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '1000';

  const service = new PositionService(tag as unknown as Sql, client, {
    marks: marks.source(),
    profitSource: profitSourceFromConfig(formatAccountRef(recipeProfitFundingAccount('USDT'))),
    maxLeverage: TEST_MAX_LEVERAGE_AMOUNT,
    now: () => CREDIT_NOW,
    accountAdmission: recordingAdmission(),
  });

  return {
    ledger,
    positions,
    service,
    seed(symbol: string, marketId: string, price: string) {
      markets.push({
        id: marketId,
        symbol,
        kind: 'futures',
        status: 'active',
        quote_asset: 'USDT',
        futures_contract_style: null,
        futures_expiry_at: null,
        futures_settlement_fixing: null,
      });
      marks.set({ marketId, symbol, price, quality: 'mid', asOfMs: CREDIT_NOW.getTime() });
    },
    dropNextInsert() {
      skipInserts += 1;
    },
    open(input: { symbol: string; marketId: string; price: string; leverage: string; clientOpenId: string }) {
      marks.set({
        marketId: input.marketId,
        symbol: input.symbol,
        price: input.price,
        quality: 'mid',
        asOfMs: CREDIT_NOW.getTime(),
      });
      return service.open(
        {
          userId: CREDIT_USER,
          symbol: input.symbol,
          side: 'long',
          size: amt('1'),
          leverage: amt(input.leverage),
          clientOpenId: input.clientOpenId,
        },
        principalFor(CREDIT_USER),
      );
    },
  };
}

async function fund(ledger: MemoryLedger, amount: string, railRef: string): Promise<void> {
  await ledger.post(
    recipes.deposit({
      userId: CREDIT_USER,
      assetId: 'USDT',
      amount: amt(amount),
      rail: 'test',
      railRef,
    }),
  );
}

function lockPosts(ledger: MemoryLedger): PostRequest[] {
  return ledger.journal().filter((tx) => tx.reason === 'futures.margin.lock') as unknown as PostRequest[];
}

function postsFor(ledger: MemoryLedger, reason: string): unknown[] {
  return ledger.journal().filter((tx) => tx.reason === reason);
}

function positionIdOf(position: { id: string | null }): string {
  if (position.id == null || position.id.length === 0) throw new Error('open returned no position id');
  return position.id;
}

describe('aggregate haircut credit inside open', () => {
  beforeEach(() => {
    process.env.TRADE_FUTURES_ENABLED = 'true';
    process.env.TRADE_FUTURES_JOBS_ENABLED = 'true';
    process.env.TRADE_COLLATERAL_HAIRCUT_BPS = '1000';
  });

  it('a retry with the same clientOpenId returns the same position and leaves one lock', async () => {
    const book = creditBook();
    await fund(book.ledger, '100', 'retry-open');
    book.seed('BTC/USDT-PERP', 'm-retry', '60');
    const first = await book.open({
      symbol: 'BTC/USDT-PERP',
      marketId: 'm-retry',
      price: '60',
      leverage: '1',
      clientOpenId: 'same-open',
    });
    const second = await book.open({
      symbol: 'BTC/USDT-PERP',
      marketId: 'm-retry',
      price: '60',
      leverage: '1',
      clientOpenId: 'same-open',
    });
    expect(second.id).toBe(first.id);
    expect(lockPosts(book.ledger)).toHaveLength(1);
    expect(book.positions).toHaveLength(1);
  });

  it('a lost lock reply still completes the position on retry and does not strand the lock', async () => {
    const book = creditBook();
    await fund(book.ledger, '100', 'lost-lock');
    book.seed('BTC/USDT-PERP', 'm-lost', '60');
    book.dropNextInsert();
    await expect(
      book.open({ symbol: 'BTC/USDT-PERP', marketId: 'm-lost', price: '60', leverage: '1', clientOpenId: 'lost-open' }),
    ).rejects.toThrow();
    expect(book.positions).toHaveLength(0);
    expect(lockPosts(book.ledger)).toHaveLength(1);
    const recovered = await book.open({
      symbol: 'BTC/USDT-PERP',
      marketId: 'm-lost',
      price: '60',
      leverage: '1',
      clientOpenId: 'lost-open',
    });
    expect(recovered.id).toBeTruthy();
    expect(book.positions).toHaveLength(1);
    expect(lockPosts(book.ledger)).toHaveLength(1);
  });

  it('a second market whose initial margin fits free cash but not aggregate credit is refused with one lock', async () => {
    const book = creditBook();
    await fund(book.ledger, '100', 'split');
    book.seed('BTC/USDT-PERP', 'm-a', '90');
    book.seed('ETH/USDT-PERP', 'm-b', '9');
    await book.open({ symbol: 'BTC/USDT-PERP', marketId: 'm-a', price: '90', leverage: '1', clientOpenId: 'open-a' });
    await expect(
      book.open({ symbol: 'ETH/USDT-PERP', marketId: 'm-b', price: '9', leverage: '1', clientOpenId: 'open-b' }),
    ).rejects.toMatchObject({ name: 'FuturesError', code: HAIRCUT_CREDIT_SHORT });
    expect(lockPosts(book.ledger)).toHaveLength(1);
    expect(book.positions).toHaveLength(1);
  });

  it('setLeverage from 10x to 1x that would raise total initial margin above credit posts nothing', async () => {
    const book = creditBook();
    await fund(book.ledger, '100', 'lev-up-im');
    book.seed('BTC/USDT-PERP', 'm-lev', '100');
    const opened = await book.open({
      symbol: 'BTC/USDT-PERP',
      marketId: 'm-lev',
      price: '100',
      leverage: '10',
      clientOpenId: 'lev-open',
    });
    await expect(
      book.service.setLeverage(
        {
          userId: CREDIT_USER,
          symbol: 'BTC/USDT-PERP',
          leverage: amt('1'),
          positionId: positionIdOf(opened),
          clientAdjustmentId: 'to-1x',
        },
        principalFor(CREDIT_USER),
      ),
    ).rejects.toMatchObject({ name: 'FuturesError', code: HAIRCUT_CREDIT_SHORT });
    expect(postsFor(book.ledger, 'futures.margin.add')).toHaveLength(0);
    expect(lockPosts(book.ledger)).toHaveLength(1);
  });

  it('a balance read that throws refuses the open and locks nothing', async () => {
    const book = creditBook({ balanceThrows: true });
    book.seed('BTC/USDT-PERP', 'm-throw', '60');
    await expect(
      book.open({ symbol: 'BTC/USDT-PERP', marketId: 'm-throw', price: '60', leverage: '1', clientOpenId: 'balance-down' }),
    ).rejects.toBeInstanceOf(FuturesError);
    expect(lockPosts(book.ledger)).toHaveLength(0);
    expect(book.positions).toHaveLength(0);
  });

  it("haircut '10001' refuses trade.haircut_unset", () => {
    expect(() => requireOwnerHaircutBps('10001')).toThrow(expect.objectContaining({ code: HAIRCUT_UNSET }));
    expect(checkPostedMarginCollateral({ haircutBps: '10001' })).toMatchObject({ ok: false, code: HAIRCUT_UNSET });
  });

  it('closeHoldFailureAction deletes only a LedgerError in the definite set', () => {
    expect(closeHoldFailureAction(new LedgerError('owner space', 'ledger.owner_identity_space'))).toBe('delete_intent');
    expect(closeHoldFailureAction({ code: 'ledger.insufficient_funds' })).toBe('keep_recovery');
  });

  it('an open is refused when TRADE_FUTURES_ENABLED is off, and the refusal names that flag', async () => {
    const book = creditBook();
    await fund(book.ledger, '100', 'flag-enabled');
    book.seed('BTC/USDT-PERP', 'm-flag-en', '60');
    process.env.TRADE_FUTURES_ENABLED = 'false';
    process.env.TRADE_FUTURES_JOBS_ENABLED = 'true';
    await expect(
      book.open({ symbol: 'BTC/USDT-PERP', marketId: 'm-flag-en', price: '60', leverage: '1', clientOpenId: 'flag-en' }),
    ).rejects.toMatchObject({ name: 'FuturesError', code: 'trade.futures_disabled' });
    await expect(
      book.open({ symbol: 'BTC/USDT-PERP', marketId: 'm-flag-en', price: '60', leverage: '1', clientOpenId: 'flag-en' }),
    ).rejects.toThrow(/TRADE_FUTURES_ENABLED/);
    expect(lockPosts(book.ledger)).toHaveLength(0);
  });

  it('an open is refused when TRADE_FUTURES_JOBS_ENABLED is off, and the refusal names that flag', async () => {
    const book = creditBook();
    await fund(book.ledger, '100', 'flag-jobs');
    book.seed('BTC/USDT-PERP', 'm-flag-jobs', '60');
    process.env.TRADE_FUTURES_ENABLED = 'true';
    process.env.TRADE_FUTURES_JOBS_ENABLED = 'false';
    await expect(
      book.open({ symbol: 'BTC/USDT-PERP', marketId: 'm-flag-jobs', price: '60', leverage: '1', clientOpenId: 'flag-jobs' }),
    ).rejects.toThrow(/TRADE_FUTURES_JOBS_ENABLED/);
    expect(lockPosts(book.ledger)).toHaveLength(0);
  });

  it('setLeverage that adds margin is refused when either flag is off and posts nothing', async () => {
    const book = creditBook();
    await fund(book.ledger, '100', 'flag-lev');
    book.seed('BTC/USDT-PERP', 'm-flag-lev', '100');
    const opened = await book.open({
      symbol: 'BTC/USDT-PERP',
      marketId: 'm-flag-lev',
      price: '100',
      leverage: '10',
      clientOpenId: 'flag-lev-open',
    });
    process.env.TRADE_FUTURES_JOBS_ENABLED = 'false';
    await expect(
      book.service.setLeverage(
        {
          userId: CREDIT_USER,
          symbol: 'BTC/USDT-PERP',
          leverage: amt('1'),
          positionId: positionIdOf(opened),
          clientAdjustmentId: 'jobs-off',
        },
        principalFor(CREDIT_USER),
      ),
    ).rejects.toMatchObject({ code: 'trade.futures_disabled' });
    expect(postsFor(book.ledger, 'futures.margin.add')).toHaveLength(0);

    process.env.TRADE_FUTURES_JOBS_ENABLED = 'true';
    process.env.TRADE_FUTURES_ENABLED = 'false';
    await expect(
      book.service.setLeverage(
        {
          userId: CREDIT_USER,
          symbol: 'BTC/USDT-PERP',
          leverage: amt('1'),
          positionId: positionIdOf(opened),
          clientAdjustmentId: 'enabled-off',
        },
        principalFor(CREDIT_USER),
      ),
    ).rejects.toThrow(/TRADE_FUTURES_ENABLED/);
    expect(postsFor(book.ledger, 'futures.margin.add')).toHaveLength(0);
  });

  it('lowering margin stays allowed when both flags are off', async () => {
    const book = creditBook();
    await fund(book.ledger, '200', 'flag-reduce');
    book.seed('BTC/USDT-PERP', 'm-reduce', '100');
    const opened = await book.open({
      symbol: 'BTC/USDT-PERP',
      marketId: 'm-reduce',
      price: '100',
      leverage: '1',
      clientOpenId: 'reduce-open',
    });
    process.env.TRADE_FUTURES_ENABLED = 'false';
    process.env.TRADE_FUTURES_JOBS_ENABLED = 'false';
    const reduced = await book.service.setLeverage(
      {
        userId: CREDIT_USER,
        symbol: 'BTC/USDT-PERP',
        leverage: amt('10'),
        positionId: positionIdOf(opened),
        clientAdjustmentId: 'release-while-off',
      },
      principalFor(CREDIT_USER),
    );
    expect(reduced.leverage).toBe('10');
    expect(postsFor(book.ledger, 'futures.margin.release')).toHaveLength(1);
  });
});

describe('S08 entry, attached exits, cancel-all-after', () => {
  it('a long of 1 at 100 plus 1 at 120 stores entry 110, and a reducing fill leaves it', () => {
    const opened = entryFromOpeningFills(
      [
        { qty: amt('1'), price: amt('100') },
        { qty: amt('1'), price: amt('120') },
      ],
      amt('999'),
    );
    expect(formatAmount(opened.size)).toBe('2');
    expect(formatAmount(opened.entryPrice)).toBe('110');
    const reduced = storedEntryAfterFill(opened, { effect: 'reduce', qty: amt('0.5'), price: amt('80') });
    expect(formatAmount(reduced.size)).toBe('1.5');
    expect(formatAmount(reduced.entryPrice)).toBe('110');
  });

  it('a caller-supplied price with no fill is not stored as the entry', () => {
    expect(() => entryFromOpeningFills([], amt('100'))).toThrow(/not stored as the entry/);
  });

  it('cancelling an unfilled entry cancels its take-profit and stop-loss, and a later price cannot fire them', () => {
    const exits: AttachedExit[] = [
      { id: 'tp', kind: 'take_profit', trigger: amt('120'), qty: amt('1'), status: 'open' },
      { id: 'sl', kind: 'stop_loss', trigger: amt('90'), qty: amt('1'), status: 'open' },
    ];
    const first = cancelAttachedToEntry({ entryStatus: 'unfilled', filledQty: 0n as Amount, exits });
    expect(first.cancelledIds).toEqual(['tp', 'sl']);
    expect(first.exits.map((leg) => leg.status)).toEqual(['cancelled', 'cancelled']);
    const second = cancelAttachedToEntry({ entryStatus: 'unfilled', filledQty: 0n as Amount, exits: first.exits });
    expect(second.cancelledIds).toEqual([]);
    const stop = second.exits[1]!;
    const after = stopAfterMarket({
      trigger: stop.trigger,
      last: amt('80'),
      printedAtOrThroughTrigger: true,
      printPrice: amt('80'),
      positionSize: amt('1'),
      status: stop.status,
    });
    expect(after).toMatchObject({ status: 'open', positionSize: amt('1'), fillPrice: null });
  });

  it('a filled entry leaves the attached stop, and a partial fill keeps it sized to the fill', () => {
    const exits: AttachedExit[] = [{ id: 'sl', kind: 'stop_loss', trigger: amt('90'), qty: amt('1'), status: 'open' }];
    const filled = cancelAttachedToEntry({ entryStatus: 'filled', filledQty: amt('1'), exits });
    expect(filled.cancelledIds).toEqual([]);
    expect(filled.exits[0]!.status).toBe('open');
    const partial = cancelAttachedToEntry({ entryStatus: 'partial', filledQty: amt('0.4'), exits });
    expect(formatAmount(partial.exits[0]!.qty)).toBe('0.4');
    expect(partial.exits[0]!.status).toBe('open');
  });

  it('a stop at 90 with last 100 and no print through 90 stays open and the position is unchanged', () => {
    const after = stopAfterMarket({
      trigger: amt('90'),
      last: amt('100'),
      printedAtOrThroughTrigger: false,
      printPrice: null,
      positionSize: amt('1'),
      status: 'open',
    });
    expect(after).toEqual({ status: 'open', positionSize: amt('1'), fillPrice: null });
  });

  it('a print through the stop may fill away from the trigger', () => {
    const after = stopAfterMarket({
      trigger: amt('90'),
      last: amt('85'),
      printedAtOrThroughTrigger: true,
      printPrice: amt('85'),
      positionSize: amt('1'),
      status: 'open',
    });
    expect(after.fillPrice).toEqual(amt('85'));
    expect(after.fillPrice).not.toEqual(amt('90'));
  });

  it('cancel-all-after at the published minimum cancels only that caller, once', () => {
    const minimum = Math.min(...PUBLISHED_TIMEOUTS.filter((n) => n > 0));
    expect(minimum).toBe(10);
    const armed = armCancelAllAfter({
      callerId: 'alice',
      timeoutSec: minimum,
      publishedTimeouts: PUBLISHED_TIMEOUTS,
      nowMs: 0,
      countdownId: 'caa-1',
    });
    expect(armed.ok).toBe(true);
    if (!armed.ok || armed.armed == null) throw new Error('expected an armed countdown');
    const orders: CancelAllAfterOrder[] = [
      { orderId: 'alice-gtc', callerId: 'alice', status: 'open', holdAmount: amt('25') },
      { orderId: 'bob-gtc', callerId: 'bob', status: 'open', holdAmount: amt('40') },
    ];
    const first = expireCancelAllAfter({
      armed: armed.armed,
      nowMs: armed.armed.deadlineMs,
      orders,
      alreadyExpiredIds: new Set(),
    });
    expect(first.cancelledIds).toEqual(['alice-gtc']);
    expect(formatAmount(first.releasedHold)).toBe('25');
    expect(first.orders.find((order) => order.orderId === 'bob-gtc')!.status).toBe('open');
    const second = expireCancelAllAfter({
      armed: armed.armed,
      nowMs: armed.armed.deadlineMs + 1_000,
      orders,
      alreadyExpiredIds: new Set([armed.armed.countdownId]),
    });
    expect(second.cancelledIds).toEqual([]);
    expect(formatAmount(second.releasedHold)).toBe('0');
  });

  it('a timeout outside the published set is rejected and orders stay', () => {
    const orders: CancelAllAfterOrder[] = [{ orderId: 'alice-gtc', callerId: 'alice', status: 'open', holdAmount: amt('25') }];
    const armed = armCancelAllAfter({
      callerId: 'alice',
      timeoutSec: 7,
      publishedTimeouts: PUBLISHED_TIMEOUTS,
      nowMs: 0,
      countdownId: 'caa-bad',
    });
    expect(armed).toMatchObject({ ok: false, code: 'trade.cancel_all_after_rejected' });
    expect(orders[0]!.status).toBe('open');
  });

  it('timeout 0 does not cancel, including after the session drops', () => {
    const armed = armCancelAllAfter({
      callerId: 'alice',
      timeoutSec: 0,
      publishedTimeouts: PUBLISHED_TIMEOUTS,
      nowMs: 0,
      countdownId: 'caa-off',
    });
    expect(armed).toMatchObject({ ok: true, armed: null });
    if (!armed.ok) throw new Error('expected disarm');
    const expired = expireCancelAllAfter({
      armed: armed.armed,
      nowMs: 86_400_000,
      orders: [{ orderId: 'alice-gtc', callerId: 'alice', status: 'open', holdAmount: amt('25') }],
      alreadyExpiredIds: new Set(),
    });
    expect(expired.cancelledIds).toEqual([]);
    expect(expired.orders[0]!.status).toBe('open');
  });
});

describe('S08 liquidation pulls increasing orders before the rung posts', () => {
  const user = '11111111-1111-4111-8111-111111111111';

  function underwater(): LiquidationPositionRow {
    return {
      positionId: 'pos-1',
      userId: user,
      side: 'long',
      size: amt('1'),
      entryPrice: amt('100'),
      margin: amt('10'),
      marginAsset: 'USDT',
      marketId: 'm1',
      symbol: 'BTC/USDT-PERP',
    };
  }

  function marks(price: string): QuotedMarkSource {
    return {
      async markPrice() {
        return price;
      },
      async quote({ marketId, symbol, at }) {
        return { marketId, symbol, price: amt(price), asOf: at, quality: 'mid' };
      },
    };
  }

  function ledger() {
    const posts: PostRequest[] = [];
    return {
      posts,
      ledger: {
        async post(req: PostRequest) {
          posts.push(req);
          return { id: `tx-${posts.length}`, idempotencyKey: req.idempotencyKey } as never;
        },
        async balance(ref: AccountRef): Promise<Balance> {
          const amount = ref.ownerType === 'house' && ref.ownerId === 'insurance-fund' ? amt('1000000') : amt('1000000');
          return { account: ref, accountId: 'acct', amount };
        },
      },
    };
  }

  it('a resting buy is cancelled and its hold released; a reduce-only sell stays', async () => {
    expect(orderIncreasesPosition('long', { side: 'buy' })).toBe(true);
    expect(orderIncreasesPosition('long', { side: 'sell', reduceOnly: true })).toBe(false);
    const released: string[] = [];
    const { posts, ledger: book } = ledger();
    const result = await runLiquidationTick({
      marks: marks('80'),
      positions: {
        async listOpen() {
          return [underwater()];
        },
      },
      closer: { async markLiquidated() {} },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger: book,
      ladder: deepFullCloseLadder(),
      increasingOrders: {
        async list() {
          return [
            { orderId: 'bid', side: 'buy' },
            { orderId: 'stop-sell', side: 'sell', reduceOnly: true },
          ];
        },
        async cancelAndRelease(_marketId, orderId) {
          released.push(orderId);
          return 'released';
        },
      },
    });
    expect(released).toEqual(['bid']);
    expect(result.liquidated).toBe(1);
    expect(posts.length).toBeGreaterThan(0);
  });

  it('a cancel timeout leaves the rung unposted', async () => {
    const { posts, ledger: book } = ledger();
    const result = await runLiquidationTick({
      marks: marks('80'),
      positions: {
        async listOpen() {
          return [underwater()];
        },
      },
      closer: {
        async markLiquidated() {
          throw new Error('rung posted');
        },
      },
      attempts: memoryLiquidationAttemptStore(),
      acceptedMarks: memoryAcceptedMarkStore(),
      ledger: book,
      ladder: deepFullCloseLadder(),
      increasingOrders: {
        async list() {
          return [{ orderId: 'bid', side: 'buy' }];
        },
        async cancelAndRelease() {
          return 'timeout';
        },
      },
    });
    expect(result.liquidated).toBe(0);
    expect(result.items[0]).toMatchObject({
      outcome: 'errored',
      reason: 'trade.liquidation_increasing_cancel_timeout',
    });
    expect(posts).toHaveLength(0);
    const pulled = await cancelIncreasingOrdersBeforeRung(
      {
        async list() {
          return [{ orderId: 'bid', side: 'buy' }];
        },
        async cancelAndRelease() {
          return 'timeout';
        },
      },
      { marketId: 'm1', userId: user, side: 'long' },
    );
    expect(pulled.ok).toBe(false);
  });
});

describe('TRADEV4-0005 liquidation off alert', () => {
  it('jobs disabled raises an alert that futures.liquidation is not scheduled', () => {
    const health = presentFuturesJobsHealth({
      enabled: false,
      fundingMarketCount: 0,
      fundingMaxAbsRateConfigured: false,
    });
    expect(health.liquidationArmed).toBe(false);
    expect(health.alerts).toEqual([{ name: 'futures.liquidation', message: LIQUIDATION_NOT_SCHEDULED }]);
    expect(health.alerts[0]!.message).toContain('futures.liquidation is not scheduled');
  });

  it('the explicit off switch stays off in the jobs handle, and enabling clears the alert', () => {
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

    const on = startFuturesJobs({
      sql: {} as never,
      ledger: { post: async () => ({}) as never, balance: async () => ({}) as never },
      matching: { depth: async () => ({ bids: [], asks: [], sequence: 1 }) } as never,
      bus: null,
      config: {
        enabled: true,
        liqIntervalMs: 60_000,
        fundingIntervalMs: null,
        fundingMarketIds: [],
        fundingMaxAbsRate: null,
      },
      setIntervalFn: (() => 0) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });
    expect(on.host.list()).toContain('futures.liquidation');
    expect(on.alerts).toEqual([]);
    on.stop();
  });
});
