import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MemoryLedger } from './memory-ledger.js';
import { formatAmount } from './money.js';
import { classifyPostOutcome } from './post-outcome.js';
import { LEDGER_ACK_INVALID_MESSAGE } from './http-client.js';
import { recipes } from './recipes/index.js';
import { LedgerError } from './types.js';
import { LEDGER_POST_ALLOWLIST } from './gate/caller-allowlist.js';
import {
  LEDGER_POST_RECIPE,
  POST_RECIPE_NAMES,
  POST_RECIPE_INPUT_INVALID,
  POST_RECIPE_UNKNOWN,
  createHttpRecipePoster,
  postRecipeRequest,
  recipePosterOver,
  type PostRecipeCall,
} from './post-recipe-client.js';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PURCHASE = {
  course: 'perps-101',
  userId: USER,
  n: '3',
  assetId: 'USDC',
  amount: '2.5',
  to: { kind: 'treasury-wallet', walletId: '0x00000000000000000000000000000000000000aa' },
  paymentId: `0x${'ab'.repeat(32)}`,
} as const;
const CALL: PostRecipeCall = { recipe: 'academyPurchase', input: PURCHASE };
const KEY = `academy:purchase:perps-101:${USER}:3`;

function ack(overrides: Record<string, unknown> = {}) {
  return {
    txId: 'tx-1',
    idempotencyKey: KEY,
    module: 'academy',
    reason: 'academy.purchase.posted',
    hash: 'h',
    postedAt: '2026-11-20T00:00:00.000Z',
    entries: [
      { id: '1', txId: 'tx-1', accountId: 'a', assetId: 'USDC', direction: 'debit', amount: '2.5', balanceAfter: '2.5' },
      { id: '2', txId: 'tx-1', accountId: 'b', assetId: 'USDC', direction: 'credit', amount: '2.5', balanceAfter: '-2.5' },
    ],
    ...overrides,
  };
}

function scripted(answers: (() => Response | Promise<Response>)[]) {
  const sent: { url: string; body: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    sent.push({ url: String(input), body: String(init?.body) });
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next();
  };
  return { fetch, sent };
}
const json = (status: number, body: unknown) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const poster = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) =>
  createHttpRecipePoster({
    baseUrl: 'http://ledger.test/',
    sign: () => ({ 'x-signed': '1' }),
    fetch,
    retryBaseDelayMs: 0,
    sleep: async () => {},
    ...extra,
  });

const PAYEE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SPACE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TRANSFER = {
  transferId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  occurrence: 0,
  from: { ownerType: 'user', ownerId: USER, assetId: 'USDC', kind: 'available' },
  to: { ownerType: 'user', ownerId: PAYEE, assetId: 'USDC', kind: 'available' },
  amount: '12.5',
  kind: 'manual',
  keySpace: 'p2p',
} as const;
const HOLD = { holdId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', userId: PAYEE, assetId: 'USDC', amount: '12.5' } as const;
const refusesInput = (body: unknown) =>
  expect(() => postRecipeRequest(body)).toThrow(expect.objectContaining({ code: POST_RECIPE_INPUT_INVALID }));

describe('who may call the door', () => {
  it("every caller the record names holds a grant for a recipe the door posts (svc-trade's feeCharge goes through post)", () => {
    const granted = Object.entries(LEDGER_POST_ALLOWLIST)
      .filter(([, grants]) => POST_RECIPE_NAMES.some((name) => (grants as Record<string, unknown>)[name]))
      .map(([service]) => service);
    for (const caller of LEDGER_POST_RECIPE.access.callers) expect(granted).toContain(caller);
    expect(LEDGER_POST_RECIPE.access.callers).toContain('svc-bank');
  });
});

describe("postRecipeRequest: svc-bank's recipes are the registry's, key and body", () => {
  it('bankTransfer in every key space svc-bank books is exactly recipes.bankTransfer over the converted inputs', () => {
    const cases = [
      { ...TRANSFER, keySpace: 'own', to: { ownerType: 'subaccount', ownerId: SPACE, assetId: 'USDC', kind: 'available' } },
      TRANSFER,
      { ...TRANSFER, occurrence: 7, kind: 'scheduled', keySpace: 'sched' },
      { ...TRANSFER, keySpace: 'rail', to: { ownerType: 'treasury', ownerId: 'rail:card-sandbox', assetId: 'USDC', kind: 'available' } },
      {
        ...TRANSFER,
        occurrence: 1,
        keySpace: 'rail',
        from: { ownerType: 'treasury', ownerId: 'rail:card-sandbox', assetId: 'USDC', kind: 'available' },
      },
      { ...TRANSFER, transferId: `claim-1:user:${USER}:USDC:available:`, occurrence: 2, keySpace: 'recovery' },
    ] as const;
    for (const input of cases) {
      const { request } = postRecipeRequest({ recipe: 'bankTransfer', input });
      expect(request).toEqual(recipes.bankTransfer({ ...input, amount: 12_500_000_000_000_000_000n }));
      expect(request.idempotencyKey).toBe(`bank.transfer.${input.keySpace}:${input.transferId}:${input.occurrence}`);
      expect(request.entries.map((e) => [e.direction, e.account.ownerId])).toEqual([
        ['credit', input.from.ownerId],
        ['debit', input.to.ownerId],
      ]);
    }
  });

  it('the three holds on received funds are exactly the registry recipes', () => {
    const amount = 12_500_000_000_000_000_000n;
    expect(postRecipeRequest({ recipe: 'payReceivedHold', input: HOLD }).request).toEqual(recipes.payReceivedHold({ ...HOLD, amount }));
    const outcome = { ...HOLD, heldAmount: '12.5' };
    expect(postRecipeRequest({ recipe: 'payReceivedRelease', input: outcome }).request).toEqual(
      recipes.payReceivedRelease({ ...HOLD, amount, heldAmount: amount }),
    );
    expect(postRecipeRequest({ recipe: 'payReceivedReturn', input: { ...outcome, payerUserId: USER } }).request).toEqual(
      recipes.payReceivedReturn({ ...HOLD, amount, heldAmount: amount, payerUserId: USER }),
    );
  });

  it('refuses what the record or the recipe refuses: no key space, a key space with the wrong kind, one account twice, two assets, a lock, a zero amount', () => {
    const { keySpace: _dropped, ...legacy } = TRANSFER;
    refusesInput({ recipe: 'bankTransfer', input: legacy });
    refusesInput({ recipe: 'bankTransfer', input: { ...TRANSFER, kind: 'scheduled' } });
    refusesInput({ recipe: 'bankTransfer', input: { ...TRANSFER, keySpace: 'sched' } });
    refusesInput({ recipe: 'bankTransfer', input: { ...TRANSFER, to: TRANSFER.from } });
    refusesInput({ recipe: 'bankTransfer', input: { ...TRANSFER, to: { ...TRANSFER.to, assetId: 'USDT' } } });
    refusesInput({ recipe: 'bankTransfer', input: { ...TRANSFER, to: { ...TRANSFER.to, kind: 'hold', purpose: 'x' } } });
    refusesInput({ recipe: 'bankTransfer', input: { ...TRANSFER, amount: '0' } });
    refusesInput({ recipe: 'bankTransfer', input: { ...TRANSFER, occurrence: 1.5 } });
  });

  it('refuses a partial release or return, a return to the recipient, and a zero hold', () => {
    refusesInput({ recipe: 'payReceivedHold', input: { ...HOLD, amount: '0' } });
    refusesInput({ recipe: 'payReceivedRelease', input: { ...HOLD, amount: '5', heldAmount: '12.5' } });
    refusesInput({ recipe: 'payReceivedReturn', input: { ...HOLD, amount: '5', heldAmount: '12.5', payerUserId: USER } });
    refusesInput({ recipe: 'payReceivedReturn', input: { ...HOLD, heldAmount: '12.5', payerUserId: PAYEE } });
  });
});

const POOL = '99999999-9999-4999-8999-999999999999';
const POSITION = {
  positionId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  poolId: POOL,
  userId: USER,
  assetId: 'USDT',
  amount: '100',
} as const;
const FUND = { poolId: POOL, fundingId: 'treasury-2026-11', assetId: 'USDT', amount: '50' } as const;
const INTEREST = {
  poolId: POOL,
  date: '2026-11-22',
  assetId: 'USDT',
  payouts: [
    { userId: USER, amount: '0.013698630136986301' },
    { userId: PAYEE, amount: '0.5' },
  ],
} as const;

describe("postRecipeRequest: svc-bank's earn recipes are the registry's, key and body", () => {
  it('earnDeposit and earnWithdraw are exactly the registry recipes, keyed on the position', () => {
    const amount = 100_000_000_000_000_000_000n;
    const deposit = postRecipeRequest({ recipe: 'earnDeposit', input: POSITION }).request;
    expect(deposit).toEqual(recipes.earnDeposit({ ...POSITION, amount }));
    expect(deposit.idempotencyKey).toBe(`bank.earn.deposit:${POSITION.positionId}`);
    const withdraw = postRecipeRequest({ recipe: 'earnWithdraw', input: POSITION }).request;
    expect(withdraw).toEqual(recipes.earnWithdraw({ ...POSITION, amount }));
    expect(withdraw.idempotencyKey).toBe(`bank.earn.withdraw:${POSITION.positionId}`);
  });

  it("earnPoolFund is the registry recipe from the bank's own fee revenue; the wire names no other source", () => {
    const { request } = postRecipeRequest({ recipe: 'earnPoolFund', input: FUND });
    expect(request).toEqual(recipes.earnPoolFund({ ...FUND, amount: 50_000_000_000_000_000_000n }));
    expect(request.idempotencyKey).toBe(`bank.earn.fund:${POOL}:${FUND.fundingId}`);
    expect(request.entries[0]?.account).toEqual({ ownerType: 'house', ownerId: 'fees:bank', assetId: 'USDT', kind: 'available' });
    refusesInput({
      recipe: 'earnPoolFund',
      input: { ...FUND, from: { ownerType: 'user', ownerId: USER, assetId: 'USDT', kind: 'available' } },
    });
  });

  it("earnInterest is the registry recipe: one key per pool and day, the reserve down by the total, each person's payout up", () => {
    const { request } = postRecipeRequest({ recipe: 'earnInterest', input: INTEREST });
    expect(request).toEqual(
      recipes.earnInterest({
        ...INTEREST,
        payouts: [
          { userId: USER, amount: 13_698_630_136_986_301n },
          { userId: PAYEE, amount: 500_000_000_000_000_000n },
        ],
      }),
    );
    expect(request.idempotencyKey).toBe(`bank.interest:${POOL}:2026-11-22`);
    expect(request.entries.map((e) => [e.direction, e.account.ownerId, formatAmount(e.amount)])).toEqual([
      ['credit', `bank:earn:${POOL}`, '0.513698630136986301'],
      ['debit', USER, '0.013698630136986301'],
      ['debit', PAYEE, '0.5'],
    ]);
  });

  it('refuses a zero amount, a day the calendar does not have, no payouts, a zero payout, and a total the book cannot hold', () => {
    refusesInput({ recipe: 'earnDeposit', input: { ...POSITION, amount: '0' } });
    refusesInput({ recipe: 'earnWithdraw', input: { ...POSITION, amount: '0' } });
    refusesInput({ recipe: 'earnPoolFund', input: { ...FUND, amount: '0' } });
    refusesInput({ recipe: 'earnInterest', input: { ...INTEREST, date: '2026-02-31' } });
    refusesInput({ recipe: 'earnInterest', input: { ...INTEREST, date: '2026-2-1' } });
    refusesInput({ recipe: 'earnInterest', input: { ...INTEREST, payouts: [] } });
    refusesInput({
      recipe: 'earnInterest',
      input: {
        ...INTEREST,
        payouts: [
          { userId: USER, amount: '1' },
          { userId: PAYEE, amount: '0' },
        ],
      },
    });
    const max = `${'9'.repeat(20)}.${'9'.repeat(18)}`;
    refusesInput({
      recipe: 'earnInterest',
      input: {
        ...INTEREST,
        payouts: [
          { userId: USER, amount: max },
          { userId: PAYEE, amount: max },
        ],
      },
    });
    // A leap day is a real day.
    expect(postRecipeRequest({ recipe: 'earnInterest', input: { ...INTEREST, date: '2028-02-29' } }).request.idempotencyKey).toBe(
      `bank.interest:${POOL}:2028-02-29`,
    );
  });
});

describe('postRecipeRequest: the post the door books', () => {
  it('is exactly the registry recipe over the converted inputs', () => {
    const { recipe, request } = postRecipeRequest(CALL);
    expect(recipe).toBe('academyPurchase');
    expect(request).toEqual(
      recipes.academyPurchase({
        ...PURCHASE,
        n: 3n,
        amount: 2_500_000_000_000_000_000n,
        to: { kind: 'treasury-wallet', walletId: PURCHASE.to.walletId },
      }),
    );
    expect(request.idempotencyKey).toBe(KEY);
  });

  it('refuses a recipe it does not post, by code', () => {
    for (const body of [{ recipe: 'deposit', input: {} }, { recipe: 'hasOwnProperty' }, null, 'academyPurchase']) {
      expect(() => postRecipeRequest(body)).toThrow(expect.objectContaining({ code: POST_RECIPE_UNKNOWN }));
    }
  });

  it("refuses inputs the record or the recipe refuses, by code: a number amount, a zero amount, an amount the book can't hold", () => {
    for (const input of [
      { ...PURCHASE, amount: 2.5 },
      { ...PURCHASE, amount: '0' },
      { ...PURCHASE, amount: '9'.repeat(60) },
    ]) {
      expect(() => postRecipeRequest({ recipe: 'academyPurchase', input })).toThrow(
        expect.objectContaining({ code: POST_RECIPE_INPUT_INVALID }),
      );
    }
  });

  it('for random valid inputs, books in a fresh book exactly what post(recipes.academyPurchase(input)) books (fixed seed)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 1n, max: 10n ** 30n }), fc.bigInt({ min: 1n, max: 10n ** 18n }), async (amount, n) => {
        const a = new MemoryLedger();
        const b = new MemoryLedger();
        const input = { ...PURCHASE, n: String(n), amount: formatAmount(amount) };
        const viaDoor = await recipePosterOver(a).postRecipe({ recipe: 'academyPurchase', input });
        const viaPost = await b.post(recipes.academyPurchase({ ...PURCHASE, n, amount }));
        const legs = (tx: typeof viaDoor) => tx.entries.map((e) => [e.assetId, e.direction, e.amount, e.balanceAfter]);
        expect(viaDoor.idempotencyKey).toBe(viaPost.idempotencyKey);
        expect(viaDoor.meta).toEqual(viaPost.meta);
        expect(legs(viaDoor)).toEqual(legs(viaPost));
      }),
      { seed: 3343, numRuns: 100 },
    );
  });
});

describe('createHttpRecipePoster: the same transport as post', () => {
  it('posts the record body to /trpc/postRecipe and returns the receipt with real entries', async () => {
    const { fetch, sent } = scripted([json(200, ack())]);
    const tx = await poster(fetch).postRecipe(CALL);
    expect(sent.map((s) => s.url)).toEqual([`http://ledger.test${LEDGER_POST_RECIPE.path}`]);
    expect(JSON.parse(sent[0]!.body)).toEqual(CALL);
    expect(tx).toMatchObject({ id: 'tx-1', idempotencyKey: KEY, module: 'academy' });
    expect(tx.entries.map((e) => e.amount)).toEqual([2_500_000_000_000_000_000n, 2_500_000_000_000_000_000n]);
  });

  it('retries a lost answer and a 503 with the same bytes, then takes the answer', async () => {
    const { fetch, sent } = scripted([
      () => Promise.reject(new TypeError('fetch failed')),
      json(503, { code: 'ledger.writes_blocked_store_unavailable', message: 'x' }),
      json(200, ack()),
    ]);
    await expect(poster(fetch).postRecipe(CALL)).resolves.toMatchObject({ id: 'tx-1' });
    expect(new Set(sent.map((s) => s.body)).size).toBe(1);
    expect(sent).toHaveLength(3);
  });

  it('never retries a refusal; the code comes back, frozen reads as refused, a conflict as unknown', async () => {
    const frozen = scripted([json(412, { code: 'ledger.frozen', message: 'frozen' })]);
    const err = await poster(frozen.fetch)
      .postRecipe(CALL)
      .catch((e: unknown) => e);
    expect(frozen.sent).toHaveLength(1);
    expect((err as LedgerError).code).toBe('ledger.frozen');
    expect(classifyPostOutcome(err)).toBe('refused');

    const conflict = scripted([json(409, { code: 'ledger.idempotency_conflict', message: 'taken' })]);
    const err2 = await poster(conflict.fetch)
      .postRecipe(CALL)
      .catch((e: unknown) => e);
    expect(classifyPostOutcome(err2)).toBe('unknown');
  });

  it('stops at its deadline: no attempt outlives the budget', async () => {
    const { fetch, sent } = scripted([json(503, { code: 'ledger.writes_blocked_store_unavailable' }), json(200, ack())]);
    let now = 0;
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const advanceClock = async (ms: number) => {
        now += ms + 1_000;
      };
      const err = await poster(fetch, { deadlineMs: 500, retryBaseDelayMs: 100, sleep: advanceClock })
        .postRecipe(CALL)
        .catch((e: unknown) => e);
      expect((err as LedgerError).code).toBe('ledger.writes_blocked_store_unavailable');
      expect(sent).toHaveLength(1);
    } finally {
      Date.now = realNow;
    }
  });

  it('refuses invalid inputs before sending anything', async () => {
    const { fetch, sent } = scripted([]);
    await expect(poster(fetch).postRecipe({ recipe: 'academyPurchase', input: { ...PURCHASE, amount: '0' } })).rejects.toMatchObject({
      code: POST_RECIPE_INPUT_INVALID,
    });
    await expect(poster(fetch).postRecipe({ recipe: 'deposit' } as never)).rejects.toMatchObject({ code: POST_RECIPE_UNKNOWN });
    expect(sent).toEqual([]);
  });

  it('a receipt for another key, module or reason, or a malformed one, is an unknown outcome, never a success', async () => {
    for (const bad of [
      ack({ idempotencyKey: 'academy:purchase:other' }),
      ack({ module: 'bank' }),
      ack({ reason: 'x' }),
      ack({ txId: '' }),
      { ok: true },
    ]) {
      const { fetch } = scripted([json(200, bad)]);
      const err = await poster(fetch)
        .postRecipe(CALL)
        .catch((e: unknown) => e);
      expect((err as Error).message).toBe(LEDGER_ACK_INVALID_MESSAGE);
      expect(classifyPostOutcome(err)).toBe('unknown');
    }
  });
});
