import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SANCTIONS_REGIONS_ENV, SANCTIONS_SOURCE_ENV, SCREENING_REVIEWED_EMPTY } from '@intafaced/config';
import {
  EDGE_PRINCIPAL_HEADER,
  EDGE_SIGNATURE_HEADER,
  createEdgeContext,
  encodePrincipal,
  signPrincipalHeader,
} from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import { z } from 'zod';
import { OrderBook, RATE_COPY, RESTING_ORDER_COPY } from './order-book.js';
import { runKeeperTick, startTriggerKeeper } from './trigger-keeper.js';
import { minOutForFill, percentString } from './trigger-math.js';
import type { FillPort, FillQuote, FillSend, PricePort, PriceRead } from './trigger-ports.js';
import { FEED_UNWIRED_MESSAGE, RAIL_UNWIRED_MESSAGE, unwiredFillPort } from './trigger-ports.js';
import {
  dexOrderKeeperIntervalField,
  dexOrderMinSizeField,
  dexOrderRestrictedTokensField,
  dexOrderSlippageField,
  parseAddressListEnv,
} from './trigger-settings.js';
import type { TriggerSettings } from './trigger-settings.js';
import { triggerOrderCodes } from './trigger-error.js';
import type { TriggerOrderInput } from './trigger-order.js';
import { createDexRouter } from '../router.js';

const SECRET = 'a-dex-trigger-order-edge-secret-long-enough';
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-23T00:00:00.000Z');
const MAKER = '0x1111111111111111111111111111111111111111';
const TOKEN_IN = '0x2222222222222222222222222222222222222222';
const TOKEN_OUT = '0x3333333333333333333333333333333333333333';
const SIG = `0x${'ab'.repeat(65)}`;

const priorRegions = process.env[SANCTIONS_REGIONS_ENV];
const priorSource = process.env[SANCTIONS_SOURCE_ENV];
beforeAll(() => {
  process.env[SANCTIONS_REGIONS_ENV] = SCREENING_REVIEWED_EMPTY;
  process.env[SANCTIONS_SOURCE_ENV] = 'counsel-memo-ref';
});
afterAll(() => {
  if (priorRegions === undefined) delete process.env[SANCTIONS_REGIONS_ENV];
  else process.env[SANCTIONS_REGIONS_ENV] = priorRegions;
  if (priorSource === undefined) delete process.env[SANCTIONS_SOURCE_ENV];
  else process.env[SANCTIONS_SOURCE_ENV] = priorSource;
});

const edge = createEdgeContext({ secret: SECRET, serviceName: 'svc-dex' });

function principal(userId: string) {
  return encodePrincipal({
    sub: userId,
    userId,
    sid: '22222222-2222-4222-8222-222222222222',
    scopes: ['protocol:read'],
    tier: 'none',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
    // The header codec checks the wire shape. The cast matches the other dex edge tests.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
}

function request(headers: Record<string, string>) {
  return edge({ headers, id: 'req-trigger' });
}

const anonymous = () => request({ 'x-intafaced-region': 'DE' });

function signed(userId = USER) {
  const raw = principal(userId);
  return request({
    [EDGE_PRINCIPAL_HEADER]: raw,
    [EDGE_SIGNATURE_HEADER]: signPrincipalHeader(raw, SECRET, 'DE'),
    'x-intafaced-region': 'DE',
  });
}

const forged = () => request({ [EDGE_PRINCIPAL_HEADER]: principal(USER), 'x-intafaced-region': 'DE' });

const settings: TriggerSettings = {
  minSize: parseAmount('1'),
  restrictedTokens: [],
  warnTokens: [],
  slippageBps: 50,
  oracleMaxAgeMs: 2_000,
};

function typed(over: Partial<TriggerOrderInput['typedOrder']> = {}): TriggerOrderInput {
  return {
    signature: SIG,
    typedOrder: {
      variant: 'sell_above',
      maker: MAKER,
      tokenIn: TOKEN_IN,
      tokenOut: TOKEN_OUT,
      amountIn: '100',
      triggerPrice: '105',
      minOut: '10',
      expiry: '2026-10-24T00:00:00.000Z',
      ...over,
    },
  };
}

class ScriptPrice implements PricePort {
  result: PriceRead = { status: 'ok', price: parseAmount('104'), observedAt: NOW.toISOString() };
  async read(): Promise<PriceRead> {
    return this.result;
  }
}

class ScriptFill implements FillPort {
  readonly sent: Array<{ key: string; maker: string; take: bigint; minOut: bigint }> = [];
  liquidity: bigint | null = null;
  crashNext = false;
  throwNext = false;
  quoteOf: (amountIn: bigint) => FillQuote = (amountIn) => ({ status: 'ok', take: amountIn, out: parseAmount('10') });
  receipt: (txHash: string, reads: number) => 'pending' | 'success' | 'reverted' | 'unwired' = () => 'success';
  private readonly byKey = new Map<string, string>();
  private reads = 0;

  async quote(input: { amountIn: bigint }): Promise<FillQuote> {
    return this.quoteOf(input.amountIn);
  }

  async send(input: { key: string; maker: string; take: bigint; minOut: bigint }): Promise<FillSend> {
    const existing = this.byKey.get(input.key);
    if (existing) return { status: 'sent', txHash: existing };
    if (this.liquidity !== null && input.take > this.liquidity) return { status: 'rejected', reason: 'insufficient_liquidity' };
    if (this.liquidity !== null) this.liquidity -= input.take;
    const txHash = `0x${createHash('sha256').update(input.key).digest('hex')}`;
    this.byKey.set(input.key, txHash);
    this.sent.push({ key: input.key, maker: input.maker, take: input.take, minOut: input.minOut });
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error('died after the send was recorded');
    }
    if (this.crashNext) {
      this.crashNext = false;
      return { status: 'unknown' };
    }
    return { status: 'sent', txHash };
  }

  async read(txHash: string) {
    this.reads += 1;
    return this.receipt(txHash, this.reads);
  }
}

function harness(opts?: { settings?: TriggerSettings; price?: PricePort; fill?: FillPort; book?: OrderBook }) {
  const clock = { now: NOW };
  const book = opts?.book ?? new OrderBook();
  const price = opts?.price ?? new ScriptPrice();
  const fill = opts?.fill ?? new ScriptFill();
  let venues = 0;
  const dex = createDexRouter({
    venues: () => {
      venues += 1;
      return [];
    },
    now: () => clock.now,
    triggerOrders: { settings: opts?.settings ?? settings, book, price, fill },
  });
  const caller = (userId?: string) => dex.createCaller(userId ? signed(userId) : signed());
  return { clock, book, price, fill, dex, caller, venues: () => venues };
}

async function refused(run: Promise<unknown>) {
  return run.then(
    () => {
      throw new Error('trigger order resolved');
    },
    (err: { code?: string; message?: string; cause?: { code?: string } }) => err,
  );
}

describe('svc-dex price-trigger orders (D-limit-dca-02)', () => {
  it('does not call a service, open a database, or mint an id', () => {
    const files = [
      'trigger-order.ts',
      'trigger-keeper.ts',
      'order-book.ts',
      'trigger-ports.ts',
      'trigger-settings.ts',
      'trigger-math.ts',
      'trigger-error.ts',
    ];
    for (const file of files) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      expect(src).not.toMatch(/svc-identity|INTERNAL_SERVICE_SECRET|DATABASE_URL|fetch\(|randomUUID|ledger\.post/);
      expect(src).not.toMatch(/from\s+['"]@intafaced\/ledger-client\/recipes['"]/);
    }
  });

  it('refuses a missing or forged principal before the book', async () => {
    const { dex, book } = harness();
    const anon = await refused(dex.createCaller(anonymous()).order.createTrigger(typed()));
    const fake = await refused(dex.createCaller(forged()).order.createTrigger(typed()));
    expect(anon.cause?.code).toBe(triggerOrderCodes.principalRequired);
    expect(fake.cause?.code).toBe(triggerOrderCodes.principalRequired);
    expect(book.size).toBe(0);
  });

  it('still screens the region before the order is read', async () => {
    vi.stubEnv(SANCTIONS_REGIONS_ENV, '   ');
    vi.stubEnv(SANCTIONS_SOURCE_ENV, undefined);
    vi.stubEnv('INTAFACED_SCREENING_FAIL_CLOSED', 'true');
    try {
      const { dex } = harness();
      await expect(dex.createCaller(signed()).order.createTrigger(typed())).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: { code: 'denied.screening_unconfigured' },
      });
    } finally {
      vi.unstubAllEnvs();
      process.env[SANCTIONS_REGIONS_ENV] = SCREENING_REVIEWED_EMPTY;
      process.env[SANCTIONS_SOURCE_ENV] = 'counsel-memo-ref';
    }
  });

  it('J-dex-protocol-10 step 2: a price order with no expiry is dex.order.expiry_required', async () => {
    const { caller, book } = harness();
    const err = await refused(caller().order.createTrigger(typed({ expiry: undefined })));
    expect(err.cause?.code).toBe(triggerOrderCodes.expiryRequired);
    expect(err.code).toBe('PRECONDITION_FAILED');
    const past = await refused(caller().order.createTrigger(typed({ expiry: '2026-10-22T00:00:00.000Z' })));
    expect(past.cause?.code).toBe(triggerOrderCodes.expiryInvalid);
    expect(book.size).toBe(0);
  });

  it('refuses a blank minimum, a blank restricted list, and a blank slippage default', async () => {
    const order = typed();
    const min = harness({ settings: {} });
    expect((await refused(min.caller().order.createTrigger(order))).cause?.code).toBe(triggerOrderCodes.minSizeUnset);
    expect(min.book.size).toBe(0);
    const list = harness({ settings: { minSize: parseAmount('1') } });
    expect((await refused(list.caller().order.createTrigger(order))).cause?.code).toBe(triggerOrderCodes.restrictedListUnset);
    const slip = harness({ settings: { minSize: parseAmount('1'), restrictedTokens: [] } });
    const slipErr = await refused(slip.caller().order.createTrigger({ ...order, typedOrder: { ...order.typedOrder, slippageBps: '30' } }));
    expect(slipErr.cause?.code).toBe(triggerOrderCodes.slippageUnset);
    expect(slip.book.size).toBe(0);
  });

  it('refuses an amount under the published minimum and a listed token', async () => {
    const { caller } = harness();
    const small = await refused(caller().order.createTrigger(typed({ amountIn: '0.5' })));
    expect(small.cause?.code).toBe(triggerOrderCodes.belowMinSize);
    expect(small.message).toContain('1');
    expect(small.message).not.toMatch(/USD|10/);
    const listed = harness({
      settings: { ...settings, restrictedTokens: [TOKEN_IN] },
    });
    expect((await refused(listed.caller().order.createTrigger(typed()))).cause?.code).toBe(triggerOrderCodes.restrictedToken);
  });

  it('warns on the warn tier and still stores one order', async () => {
    const { caller, book } = harness({ settings: { ...settings, warnTokens: [TOKEN_OUT] } });
    const created = await caller().order.createTrigger(typed());
    expect(created.replayed).toBe(false);
    expect(created.warnings).toEqual([{ code: 'dex.order.token_warned', token: 'out' }]);
    expect(created.state).toBe('open');
    expect(book.size).toBe(1);
  });

  it('stores one open order, warns instead of refusing an immediate or uneconomic trigger, and does not send', async () => {
    const price = new ScriptPrice();
    price.result = { status: 'ok', price: parseAmount('110'), observedAt: NOW.toISOString() };
    const fill = new ScriptFill();
    fill.quoteOf = () => ({ status: 'ok', take: parseAmount('100'), out: parseAmount('9') });
    const { caller, venues } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed({ triggerPrice: '100' }));
    expect(created.state).toBe('open');
    expect(created.remaining).toBe('100');
    expect(created.sheet.rate).toBe(RATE_COPY);
    expect(created.sheet.resting).toBe(RESTING_ORDER_COPY);
    expect(created.sheet.minOut).toBe('10');
    expect(created.warnings).toEqual([
      { code: 'dex.order.would_fill_immediately', percentage: percentString(parseAmount('10'), parseAmount('100')) },
      { code: 'dex.order.uneconomic', percentage: percentString(parseAmount('1'), parseAmount('10')) },
    ]);
    expect(fill.sent).toHaveLength(0);
    expect(venues()).toBe(0);
    expect(JSON.stringify(created)).not.toContain(SIG);
  });

  it('names feed.market and rail.crypto when the ports are unwired, and still stores the order', async () => {
    const book = new OrderBook();
    const dex = createDexRouter({
      venues: () => [],
      now: () => NOW,
      triggerOrders: { settings, book },
    });
    const created = await dex.createCaller(signed()).order.createTrigger(typed());
    expect(created.notConnected.map((row) => row.code)).toEqual(['feed.market', 'rail.crypto']);
    expect(created.notConnected[0]?.message).toBe(FEED_UNWIRED_MESSAGE);
    expect(created.notConnected[1]?.message).toBe(RAIL_UNWIRED_MESSAGE);
    expect(created.state).toBe('open');
    expect(book.size).toBe(1);
  });

  it('is idempotent for the same economic order and conflicts for another session', async () => {
    const { caller, book } = harness();
    const first = await caller().order.createTrigger(typed({ amountIn: '100.0' }));
    const second = await caller().order.createTrigger(typed({ amountIn: '100' }));
    expect(second.replayed).toBe(true);
    expect(second.orderHash).toBe(first.orderHash);
    expect(book.size).toBe(1);
    const [a, b] = await Promise.all([
      caller().order.createTrigger(typed({ expiry: '2026-10-25T00:00:00.000Z' })),
      caller().order.createTrigger(typed({ expiry: '2026-10-25T00:00:00.000Z' })),
    ]);
    expect(a.orderHash).toBe(b.orderHash);
    expect(book.size).toBe(2);
    const err = await refused(caller(OTHER).order.createTrigger(typed()));
    expect(err.cause?.code).toBe(triggerOrderCodes.conflict);
    expect(err.code).toBe('CONFLICT');
    const hidden = await refused(caller(OTHER).order.get({ orderHash: first.orderHash }));
    expect(hidden.cause?.code).toBe(triggerOrderCodes.notFound);
  });

  it('validate does not store, and a blank field is a typed refusal', async () => {
    const { caller, book } = harness();
    const validated = await caller().order.validate(typed());
    expect(validated.ok).toBe(true);
    expect(book.size).toBe(0);
    expect((await refused(caller().order.createTrigger(typed({ variant: 'market' })))).cause?.code).toBe(triggerOrderCodes.badRequest);
    expect((await refused(caller().order.createTrigger(typed({ amountIn: '' })))).cause?.code).toBe(triggerOrderCodes.amountUnset);
    expect((await refused(caller().order.createTrigger(typed({ triggerPrice: '0' })))).cause?.code).toBe(triggerOrderCodes.triggerInvalid);
    expect((await refused(caller().order.createTrigger(typed({ minOut: '' })))).cause?.code).toBe(triggerOrderCodes.minOutUnset);
    expect((await refused(caller().order.createTrigger({ ...typed(), signature: '0xabcd' }))).cause?.code).toBe(
      triggerOrderCodes.signatureInvalid,
    );
    expect((await refused(caller().order.createTrigger({ ...typed(), signature: '  ' }))).cause?.code).toBe(
      triggerOrderCodes.signatureRequired,
    );
    expect((await refused(caller().order.createTrigger(typed({ tokenOut: TOKEN_IN })))).cause?.code).toBe(triggerOrderCodes.badRequest);
    expect((await refused(caller().order.createTrigger(typed({ slippageBps: '1.5' })))).cause?.code).toBe(
      triggerOrderCodes.slippageInvalid,
    );
    expect(book.size).toBe(0);
  });

  it('J-dex-protocol-10 step 3: sell-above stays open at 104 and fills once at 106', async () => {
    const price = new ScriptPrice();
    const fill = new ScriptFill();
    const { caller, book } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed());
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'below');
    expect(fill.sent).toHaveLength(0);
    const open = await caller().order.get({ orderHash: created.orderHash });
    expect(open.state).toBe('open');
    expect(open.remaining).toBe('100');
    const attempts = await caller().order.attempts({ orderHash: created.orderHash });
    expect(attempts.attempts.map((row) => row.reason)).toEqual(['predicate_false']);

    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'cross');
    const filled = await caller().order.get({ orderHash: created.orderHash });
    expect(filled.state).toBe('filled');
    expect(filled.remaining).toBe('0');
    expect(filled.fills).toHaveLength(1);
    expect(filled.fills[0]?.amountOut).toBe('10');
    expect(filled.fills[0]?.minOut).toBe('10');
    expect(fill.sent[0]?.maker).toBe(MAKER);
    expect(fill.sent[0]?.key).toBe(`dex.order.fill:${created.orderHash}:1`);
    expect(fill.sent[0]?.minOut).toBe(parseAmount('10'));
  });

  it('fills each variant only on its own side of the trigger', async () => {
    const cases = [
      ['buy_above', '99', false],
      ['buy_above', '100', true],
      ['buy_below', '101', false],
      ['buy_below', '100', true],
      ['sell_above', '104', false],
      ['sell_above', '105', true],
      ['sell_below', '101', false],
      ['sell_below', '100', true],
    ] as const;
    for (const [variant, px, fills] of cases) {
      const price = new ScriptPrice();
      price.result = { status: 'ok', price: parseAmount(px), observedAt: NOW.toISOString() };
      const fill = new ScriptFill();
      const { caller, book } = harness({ price, fill });
      const created = await caller().order.createTrigger(
        typed({ variant, triggerPrice: variant.startsWith('sell_above') ? '105' : '100' }),
      );
      await runKeeperTick(book, { now: () => NOW, settings, price, fill }, variant + px);
      const view = await caller().order.get({ orderHash: created.orderHash });
      expect(view.state).toBe(fills ? 'filled' : 'open');
      expect(fill.sent).toHaveLength(fills ? 1 : 0);
    }
  });

  it('a partial fill of 40 leaves 60 and the next fill cannot exceed it', async () => {
    const price = new ScriptPrice();
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    const fill = new ScriptFill();
    let quotedRemaining = 0;
    fill.quoteOf = (amountIn) => {
      if (amountIn === parseAmount('100')) return { status: 'ok', take: parseAmount('40'), out: parseAmount('4') };
      quotedRemaining += 1;
      if (quotedRemaining === 1) return { status: 'ok', take: parseAmount('70'), out: parseAmount('100') };
      return { status: 'ok', take: amountIn, out: parseAmount('6') };
    };
    const { caller, book } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed());
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'part');
    expect((await caller().order.get({ orderHash: created.orderHash })).remaining).toBe('60');
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'too-big');
    const held = await caller().order.get({ orderHash: created.orderHash });
    expect(held.remaining).toBe('60');
    expect(held.state).toBe('open');
    expect(fill.sent).toHaveLength(1);
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'rest');
    const done = await caller().order.get({ orderHash: created.orderHash });
    expect(done.remaining).toBe('0');
    expect(done.state).toBe('filled');
    expect(fill.sent[1]?.take).toBe(parseAmount('60'));
    expect(fill.sent[1]?.key).toBe(`dex.order.fill:${created.orderHash}:2`);
  });

  it('order.fill.never-below-minOut', async () => {
    const floor = minOutForFill(parseAmount('100'), parseAmount('100'), parseAmount('10'));
    expect(floor).toBe(parseAmount('10'));
    expect(minOutForFill(parseAmount('40'), parseAmount('100'), parseAmount('10'))).toBe(parseAmount('4'));
    const partial = minOutForFill(parseAmount('1'), parseAmount('3'), parseAmount('1'));
    expect(partial * parseAmount('3') >= parseAmount('1') * parseAmount('1')).toBe(true);

    const price = new ScriptPrice();
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    const fill = new ScriptFill();
    fill.quoteOf = () => ({ status: 'ok', take: parseAmount('100'), out: parseAmount('9') });
    const { caller, book } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed());
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'under');
    expect(fill.sent).toHaveLength(0);
    const view = await caller().order.get({ orderHash: created.orderHash });
    expect(view.state).toBe('open');
    expect(view.remaining).toBe('100');
    const attempts = await caller().order.attempts({ orderHash: created.orderHash });
    expect(attempts.attempts.map((row) => row.reason)).toContain('insufficient_liquidity');
  });

  it('a stale or disagreeing oracle leaves the order open', async () => {
    const price = new ScriptPrice();
    price.result = { status: 'stale' };
    const fill = new ScriptFill();
    const { caller, book } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed());
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'stale');
    price.result = { status: 'disagree' };
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'disagree');
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: '2026-10-22T00:00:00.000Z' };
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'old');
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: '2026-10-23T00:00:10.000Z' };
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'future');
    const view = await caller().order.get({ orderHash: created.orderHash });
    expect(view.state).toBe('open');
    expect(fill.sent).toHaveLength(0);
    const reasons = (await caller().order.attempts({ orderHash: created.orderHash })).attempts.map((row) => row.reason);
    expect(reasons).toEqual(['oracle_stale', 'oracle_disagree', 'oracle_stale', 'oracle_stale']);
  });

  it('does not fill when the freshness bound or the feed or the rail is blank', async () => {
    const price = new ScriptPrice();
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    const fill = new ScriptFill();
    const loose = { ...settings, oracleMaxAgeMs: undefined };
    const { caller, book } = harness({ price, fill, settings: loose });
    const created = await caller().order.createTrigger(typed());
    await runKeeperTick(book, { now: () => NOW, settings: loose, price, fill }, 'no-age');
    price.result = { status: 'unwired' };
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'no-feed');
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    await runKeeperTick(book, { now: () => NOW, settings, price, fill: unwiredFillPort }, 'no-rail');
    expect(fill.sent).toHaveLength(0);
    const reasons = (await caller().order.attempts({ orderHash: created.orderHash })).attempts.map((row) => row.reason);
    expect(reasons).toEqual(['dex.order.oracle_max_age_unset', 'feed.market', 'rail.crypto']);
  });

  it('order.crash-after-send.reconciles-by-hash', async () => {
    const price = new ScriptPrice();
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    const fill = new ScriptFill();
    fill.crashNext = true;
    const { caller, book } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed());
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'send');
    const mid = await caller().order.get({ orderHash: created.orderHash });
    expect(mid.state).toBe('executing');
    expect(mid.pendingFill?.txHash).toBeNull();
    expect(fill.sent).toHaveLength(1);
    price.result = { status: 'stale' };
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'reconcile');
    const done = await caller().order.get({ orderHash: created.orderHash });
    expect(done.state).toBe('filled');
    expect(done.remaining).toBe('0');
    expect(fill.sent).toHaveLength(1);
    expect(done.fills[0]?.key).toBe(fill.sent[0]?.key);
  });

  it('a thrown send is reconciled by the same key, and a pending receipt does not send twice', async () => {
    const price = new ScriptPrice();
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    const fill = new ScriptFill();
    fill.throwNext = true;
    const { caller, book } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed());
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'throw');
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'after-throw');
    expect((await caller().order.get({ orderHash: created.orderHash })).state).toBe('filled');
    expect(fill.sent).toHaveLength(1);

    const pending = new ScriptFill();
    let reads = 0;
    pending.receipt = () => {
      reads += 1;
      return reads === 1 ? 'pending' : 'success';
    };
    const second = harness({ price, fill: pending });
    const row = await second.caller().order.createTrigger(typed());
    await runKeeperTick(second.book, { now: () => NOW, settings, price, fill: pending }, 'pend');
    expect((await second.caller().order.get({ orderHash: row.orderHash })).state).toBe('executing');
    await runKeeperTick(second.book, { now: () => NOW, settings, price, fill: pending }, 'mined');
    expect((await second.caller().order.get({ orderHash: row.orderHash })).state).toBe('filled');
    expect(pending.sent).toHaveLength(1);
  });

  it('a reverted fill returns to open and the next fill uses the next round', async () => {
    const price = new ScriptPrice();
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    const fill = new ScriptFill();
    let reads = 0;
    fill.receipt = () => {
      reads += 1;
      return reads === 1 ? 'reverted' : 'success';
    };
    const { caller, book } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed());
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'revert');
    const open = await caller().order.get({ orderHash: created.orderHash });
    expect(open.state).toBe('open');
    expect(open.remaining).toBe('100');
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'again');
    const done = await caller().order.get({ orderHash: created.orderHash });
    expect(done.state).toBe('filled');
    expect(fill.sent.map((row) => row.key)).toEqual([`dex.order.fill:${created.orderHash}:1`, `dex.order.fill:${created.orderHash}:2`]);
  });

  it('expires without filling, and two ticks cannot both take the remaining size', async () => {
    const price = new ScriptPrice();
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    const fill = new ScriptFill();
    const { caller, book, clock } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed());
    clock.now = new Date('2026-10-24T00:00:01.000Z');
    await runKeeperTick(book, { now: () => clock.now, settings, price, fill }, 'expired');
    expect((await caller().order.get({ orderHash: created.orderHash })).state).toBe('expired');
    expect(fill.sent).toHaveLength(0);

    const livePrice = new ScriptPrice();
    livePrice.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    const liveFill = new ScriptFill();
    const live = harness({ price: livePrice, fill: liveFill });
    await live.caller().order.createTrigger(typed());
    await Promise.all([
      runKeeperTick(live.book, { now: () => NOW, settings, price: livePrice, fill: liveFill }, 'c1'),
      runKeeperTick(live.book, { now: () => NOW, settings, price: livePrice, fill: liveFill }, 'c2'),
    ]);
    expect(liveFill.sent).toHaveLength(1);
    expect(live.book.size).toBe(1);
  });

  it('two orders that together exceed pool liquidity admit only what fits', async () => {
    const price = new ScriptPrice();
    price.result = { status: 'ok', price: parseAmount('106'), observedAt: NOW.toISOString() };
    const fill = new ScriptFill();
    fill.liquidity = parseAmount('100');
    const { caller, book } = harness({ price, fill });
    await caller().order.createTrigger(typed());
    await caller().order.createTrigger(typed({ expiry: '2026-10-25T00:00:00.000Z' }));
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'cap');
    expect(fill.sent).toHaveLength(1);
    expect(fill.sent[0]?.take).toBe(parseAmount('100'));
    expect(fill.liquidity).toBe(0n);
    const reasons = book.ids().flatMap((id) => book.attempts(id).map((row) => row.reason));
    expect(reasons).toContain('insufficient_liquidity');
  });

  it('repeats one attempt for one tick id and does not start a keeper when the interval is blank', async () => {
    const price = new ScriptPrice();
    const fill = new ScriptFill();
    const { caller, book } = harness({ price, fill });
    const created = await caller().order.createTrigger(typed());
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'same');
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'same');
    await runKeeperTick(book, { now: () => NOW, settings, price, fill }, 'other');
    expect((await caller().order.attempts({ orderHash: created.orderHash })).attempts).toHaveLength(2);
    await expect(runKeeperTick(book, { now: () => NOW, settings, price, fill }, '  ')).rejects.toMatchObject({
      code: triggerOrderCodes.tickUnset,
    });

    const spy = vi.spyOn(global, 'setInterval');
    const stop = startTriggerKeeper({ book, deps: { now: () => NOW, settings, price, fill }, intervalMs: undefined });
    expect(spy).not.toHaveBeenCalled();
    stop();
    const running = startTriggerKeeper({ book, deps: { now: () => NOW, settings, price, fill }, intervalMs: 60_000 });
    expect(spy).toHaveBeenCalledTimes(1);
    running();
    spy.mockRestore();
  });

  it('limitOrder on the same router still does not place', async () => {
    const { dex } = harness();
    const err = await refused(
      dex.createCaller(signed()).limitOrder({
        symbol: 'IFC-USD',
        side: 'sell',
        price: '105',
        size: '100',
        window: { startsAt: '2026-10-23T00:00:00.000Z', endsAt: '2026-10-24T00:00:00.000Z' },
      }),
    );
    expect(err.cause?.code).toBe('dex.order.not_placed');
  });

  it('parses owner bounds without inventing them', () => {
    const min = z.object({ DEX_ORDER_MIN_SIZE: dexOrderMinSizeField });
    expect(min.parse({}).DEX_ORDER_MIN_SIZE).toBeUndefined();
    expect(min.parse({ DEX_ORDER_MIN_SIZE: '  ' }).DEX_ORDER_MIN_SIZE).toBeUndefined();
    expect(min.parse({ DEX_ORDER_MIN_SIZE: '1.5' }).DEX_ORDER_MIN_SIZE).toBe(parseAmount('1.5'));
    expect(min.safeParse({ DEX_ORDER_MIN_SIZE: 'nope' }).success).toBe(false);
    expect(min.safeParse({ DEX_ORDER_MIN_SIZE: '-1' }).success).toBe(false);

    const list = z.object({ DEX_ORDER_RESTRICTED_TOKENS: dexOrderRestrictedTokensField });
    expect(list.parse({}).DEX_ORDER_RESTRICTED_TOKENS).toBeUndefined();
    expect(list.parse({ DEX_ORDER_RESTRICTED_TOKENS: '[]' }).DEX_ORDER_RESTRICTED_TOKENS).toEqual([]);
    const addr = `0x${'ab'.repeat(20)}`;
    expect(parseAddressListEnv(JSON.stringify([addr, addr.toUpperCase()]), 'DEX_ORDER_RESTRICTED_TOKENS')).toEqual([addr]);
    expect(list.safeParse({ DEX_ORDER_RESTRICTED_TOKENS: '["nope"]' }).success).toBe(false);

    const bps = z.object({ DEX_ORDER_SLIPPAGE_BPS: dexOrderSlippageField });
    expect(bps.parse({ DEX_ORDER_SLIPPAGE_BPS: '' }).DEX_ORDER_SLIPPAGE_BPS).toBeUndefined();
    expect(bps.parse({ DEX_ORDER_SLIPPAGE_BPS: '0' }).DEX_ORDER_SLIPPAGE_BPS).toBe(0);
    expect(bps.safeParse({ DEX_ORDER_SLIPPAGE_BPS: '10001' }).success).toBe(false);

    const interval = z.object({ DEX_ORDER_KEEPER_INTERVAL_MS: dexOrderKeeperIntervalField });
    expect(interval.parse({}).DEX_ORDER_KEEPER_INTERVAL_MS).toBeUndefined();
    expect(interval.parse({ DEX_ORDER_KEEPER_INTERVAL_MS: '2000' }).DEX_ORDER_KEEPER_INTERVAL_MS).toBe(2000);
    expect(interval.safeParse({ DEX_ORDER_KEEPER_INTERVAL_MS: '0' }).success).toBe(false);
  });
});
