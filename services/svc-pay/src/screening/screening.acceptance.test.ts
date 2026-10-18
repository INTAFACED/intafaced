import type { Sql } from 'postgres';
import { describe, expect, it } from 'vitest';
import {
  FRESH,
  settleGuardRefusal,
  type PartialPayGuards,
  type PayoutExecuteContext,
  type UserMoneyWithdrawalContext,
} from '../seams/guards.js';
import { buildPayGuards } from '../seams/registry.js';
import { createW9ScreeningGuards } from '../seams/slots/w9-screening.js';
import { screeningSubjectKey, type ScreeningAnswer, type ScreeningCaseStore, type ScreeningScreener } from './guard.js';
import { createMemoryScreeningCaseStore } from './store.js';

/**
 * S14 acceptance (OPS-0028, OPS-0031, PAY-0129).
 *
 * The custodial send is the guard hook the money path already calls, and the
 * ledger post is the next step in that path (payment-service payout execute,
 * user-money withdrawal claim). A refusal must happen before that post.
 * Amounts and addresses here are TEST fixtures, not live balances.
 */

const TEST_AMOUNT = 1n;
const SETTLEMENT = '11111111-1111-4111-8111-111111111111';
const MERCHANT = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';

function payoutCtx(over: Partial<PayoutExecuteContext> = {}): PayoutExecuteContext {
  return {
    sql: {} as Sql,
    settlementId: SETTLEMENT,
    merchantId: MERCHANT,
    assetId: 'USDT',
    amount: TEST_AMOUNT,
    railId: 'crypto-native',
    destination: { kind: 'crypto', ref: '0x0000000000000000000000000000000000000f01' },
    attempt: 0,
    replay: FRESH,
    ...over,
  };
}

function withdrawalCtx(over: Partial<UserMoneyWithdrawalContext> = {}): UserMoneyWithdrawalContext {
  return {
    tx: {} as Sql,
    userId: USER,
    assetId: 'USDT',
    amount: TEST_AMOUNT,
    rail: 'card-sandbox',
    destination: { kind: 'bank', ref: 'DE89370400440532013000' },
    clientRef: 'test-withdrawal-1',
    replay: FRESH,
    ...over,
  };
}

function guardsFor(options: {
  screener?: ScreeningScreener;
  listPosture?: 'blank' | 'named';
  timeoutMs?: number;
  store?: ScreeningCaseStore & { size(): number };
}) {
  const store = options.store ?? createMemoryScreeningCaseStore();
  const guards = createW9ScreeningGuards({
    sql: {} as Sql,
    store,
    screener: options.screener ?? (async () => null),
    listPosture: options.listPosture ?? 'named',
    timeoutMs: options.timeoutMs,
  });
  return { guards, store };
}

/** Same order as the service: settle the refusal, then the error still refuses the send. */
async function submitPayout(guards: PartialPayGuards, posts: string[], ctx = payoutCtx()): Promise<void> {
  try {
    await guards.beforePayoutExecute!(ctx);
    posts.push('ledger-payout');
  } catch (error) {
    await settleGuardRefusal(error);
    throw error;
  }
}

async function submitWithdrawal(guards: PartialPayGuards, posts: string[], ctx = withdrawalCtx()): Promise<void> {
  try {
    await guards.beforeUserMoneyWithdrawal!(ctx);
    posts.push('ledger-hold');
  } catch (error) {
    await settleGuardRefusal(error);
    throw error;
  }
}

describe('a custodial send with no screening result is refused', () => {
  it('refuses the payout with a typed unavailable code and posts nothing', async () => {
    const posts: string[] = [];
    const { guards, store } = guardsFor({ screener: async () => null, listPosture: 'named' });
    await expect(submitPayout(guards, posts)).rejects.toMatchObject({
      code: 'pay.guard_screening_unavailable',
      kind: 'unavailable',
      message: 'pay.guard_screening_unavailable',
    });
    expect(posts).toEqual([]);
    const saved = await store.read('payout', screeningSubjectKey('payout', [SETTLEMENT, '0']));
    expect(saved?.status).toBe('unavailable');
    expect(saved?.factors).toEqual([{ code: 'no_result' }]);
  });

  it('a second submit of the same payout still posts nothing', async () => {
    const posts: string[] = [];
    const { guards, store } = guardsFor({ screener: async () => null, listPosture: 'named' });
    await expect(submitPayout(guards, posts)).rejects.toMatchObject({ code: 'pay.guard_screening_unavailable' });
    await expect(submitPayout(guards, posts)).rejects.toMatchObject({ code: 'pay.guard_screening_unavailable' });
    expect(posts).toEqual([]);
    expect(store.size()).toBe(1);
    const saved = await store.read('payout', screeningSubjectKey('payout', [SETTLEMENT, '0']));
    expect(saved?.status).toBe('unavailable');
  });

  it('a provider that throws is unavailable, and a retry does not become clear', async () => {
    const posts: string[] = [];
    const { guards, store } = guardsFor({
      listPosture: 'named',
      screener: async () => {
        throw new Error('screener socket down');
      },
    });
    const first = submitPayout(guards, posts).catch((error: unknown) => error);
    const error = await first;
    expect(error).toMatchObject({
      code: 'pay.guard_screening_unavailable',
      kind: 'unavailable',
      message: 'pay.guard_screening_unavailable',
    });
    expect(JSON.stringify(error)).not.toContain('socket');
    await expect(submitPayout(guards, posts)).rejects.toMatchObject({ code: 'pay.guard_screening_unavailable' });
    expect(posts).toEqual([]);
    const saved = await store.read('payout', screeningSubjectKey('payout', [SETTLEMENT, '0']));
    expect(saved?.status).toBe('unavailable');
    expect(saved?.factors).toEqual([{ code: 'provider_down' }]);
  });

  it('a screener that does not answer in time is unavailable, not clear', async () => {
    const posts: string[] = [];
    const { guards, store } = guardsFor({
      listPosture: 'named',
      timeoutMs: 30,
      screener: () => new Promise<ScreeningAnswer>(() => undefined),
    });
    await expect(submitPayout(guards, posts)).rejects.toMatchObject({ code: 'pay.guard_screening_unavailable', kind: 'unavailable' });
    expect(posts).toEqual([]);
    const saved = await store.read('payout', screeningSubjectKey('payout', [SETTLEMENT, '0']));
    expect(saved?.status).toBe('unavailable');
    expect(saved?.factors).toEqual([{ code: 'provider_down' }]);
  });

  it('a blank list is the same refusal even when the screener says clear', async () => {
    const posts: string[] = [];
    const { guards, store } = guardsFor({
      listPosture: 'blank',
      screener: async () => ({ category: 'clear', factors: [{ code: 'provider_clear' }] }),
    });
    await expect(submitPayout(guards, posts)).rejects.toMatchObject({
      code: 'pay.guard_screening_unavailable',
      kind: 'unavailable',
    });
    expect(posts).toEqual([]);
    const saved = await store.read('payout', screeningSubjectKey('payout', [SETTLEMENT, '0']));
    expect(saved?.status).toBe('unavailable');
    expect(saved?.status).not.toBe('clear');
    expect(saved?.factors).toEqual([{ code: 'blank_list' }]);
  });

  it('an unknown category is stored as unavailable, not clear', async () => {
    const posts: string[] = [];
    const { guards, store } = guardsFor({
      listPosture: 'named',
      screener: async () => ({ category: 'unknown', factors: [{ code: 'provider_clear' }] }),
    });
    await expect(submitPayout(guards, posts)).rejects.toMatchObject({ code: 'pay.guard_screening_unavailable' });
    expect(posts).toEqual([]);
    const saved = await store.read('payout', screeningSubjectKey('payout', [SETTLEMENT, '0']));
    expect(saved?.status).toBe('unavailable');
    expect(saved?.factors).toEqual([{ code: 'unknown' }]);
  });

  it('stores clear, review, refuse, or unavailable, and only clear posts', async () => {
    const cases: Array<{ category: 'clear' | 'review' | 'refuse' | 'unavailable'; code: string | null; kind?: 'refused' | 'unavailable' }> =
      [
        { category: 'clear', code: null },
        { category: 'review', code: 'pay.guard_screening_review', kind: 'unavailable' },
        { category: 'refuse', code: 'pay.guard_screening_refuse', kind: 'refused' },
        { category: 'unavailable', code: 'pay.guard_screening_unavailable', kind: 'unavailable' },
      ];
    for (const [index, item] of cases.entries()) {
      const posts: string[] = [];
      const { guards, store } = guardsFor({
        listPosture: 'named',
        screener: async () => ({ category: item.category }),
      });
      const ctx = payoutCtx({ attempt: index });
      if (item.code === null) {
        await submitPayout(guards, posts, ctx);
        expect(posts).toEqual(['ledger-payout']);
      } else {
        await expect(submitPayout(guards, posts, ctx)).rejects.toMatchObject({ code: item.code, kind: item.kind });
        expect(posts).toEqual([]);
      }
      const saved = await store.read('payout', screeningSubjectKey('payout', [SETTLEMENT, String(index)]));
      expect(saved?.status).toBe(item.category);
    }
  });

  it('a withdrawal with no category stays unsent and the case is unavailable', async () => {
    const posts: string[] = [];
    const { guards, store } = guardsFor({
      listPosture: 'named',
      screener: async () => ({ category: 'no-category' }),
    });
    await expect(submitWithdrawal(guards, posts)).rejects.toMatchObject({
      code: 'pay.guard_screening_unavailable',
      kind: 'unavailable',
    });
    expect(posts).toEqual([]);
    const saved = await store.read('withdrawal', screeningSubjectKey('withdrawal', [USER, 'test-withdrawal-1']));
    expect(saved?.status).toBe('unavailable');
    expect(saved?.factors).toEqual([{ code: 'unknown' }]);
  });

  it('a recovery that would still send is refused when screening has no result', async () => {
    const posts: string[] = [];
    const { guards } = guardsFor({ screener: async () => null, listPosture: 'named' });
    await expect(
      submitPayout(guards, posts, payoutCtx({ replay: { kind: 'recovery', reason: 'payout_hold_booked' } })),
    ).rejects.toMatchObject({ code: 'pay.guard_screening_unavailable' });
    expect(posts).toEqual([]);
  });

  it('a repeat of a withdrawal that already left is not refused again', async () => {
    const { guards, store } = guardsFor({ screener: async () => null, listPosture: 'named' });
    await expect(
      guards.beforeUserMoneyWithdrawal!(withdrawalCtx({ replay: { kind: 'replay', reason: 'withdrawal_already_sent' } })),
    ).resolves.toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('the pay guard registry refuses a fresh payout when the slot has no result', async () => {
    const readableSql = (async () => []) as unknown as Sql;
    const guards = buildPayGuards({ sql: readableSql, merchantControls: 'off' });
    await expect(guards.beforePayoutExecute(payoutCtx({ sql: readableSql }))).rejects.toMatchObject({
      code: 'pay.guard_screening_unavailable',
      kind: 'unavailable',
    });
  });
});
