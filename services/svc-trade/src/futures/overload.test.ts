/**
 * TRD-0324: the overload switch refuses new risk on every order kind that reaches the book — a direct
 * place, a copy mirror and a grid level — and still admits a reduce-only or close-position order. The service is the
 * real `TradeService`; its database, ledger and matching engine record any touch, so a refusal is shown to come
 * before anything is read or held.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryEventBus } from '@intafaced/events';
import { parseAmount } from '@intafaced/ledger-client';
import type { LedgerClient } from '@intafaced/ledger-client';
import { TradeService, type PlaceOrderInput } from '../spot/trade-service.js';
import type { MatchingClient } from '../spot/matching-client.js';
import { StubPerks, principalFor } from '../spot/testing.js';
import { SYSTEM_OVERLOAD, assertAdmittedUnderOverload } from './overload.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PAST_DOOR = 'past the overload door: a dependency was touched';

function recording(touched: string[], name: string): never {
  const fail = (path: string) => {
    touched.push(path);
    throw new Error(PAST_DOOR);
  };
  return new Proxy(function () {}, {
    apply: () => fail(name),
    get: (_t, key) => (key === 'then' ? undefined : (..._args: unknown[]) => fail(`${name}.${String(key)}`)),
  }) as never;
}

describe('TRD-0324 overload binds every order kind', () => {
  let touched: string[];
  let trade: TradeService;
  const prev = process.env.TRADE_ORDER_OVERLOAD;
  const principal = principalFor(USER);
  const increasing = {
    symbol: 'BTC/USDT',
    side: 'buy',
    type: 'limit',
    qty: parseAmount('1'),
    price: parseAmount('100'),
  } as PlaceOrderInput;

  beforeEach(() => {
    touched = [];
    trade = new TradeService(
      recording(touched, 'sql'),
      recording(touched, 'ledger') as LedgerClient,
      recording(touched, 'matching') as MatchingClient,
      new StubPerks(),
      new MemoryEventBus('svc-trade'),
    );
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.TRADE_ORDER_OVERLOAD;
    else process.env.TRADE_ORDER_OVERLOAD = prev;
  });

  const kinds: ReadonlyArray<[string, (input: PlaceOrderInput) => Promise<unknown>]> = [
    ['a direct place', (input) => trade.placeOrder(principal, input)],
    ['a copy mirror', (input) => trade.placeCopyMirror(principal, input, 'follow-1')],
    ['a grid level', (input) => trade.placeGridLevel(principal, input, 'bot-1')],
  ];

  for (const [name, place] of kinds) {
    it(`${name} is refused with trade.system_overload while the switch is on, before anything is read or held`, async () => {
      process.env.TRADE_ORDER_OVERLOAD = 'true';
      await expect(place(increasing)).rejects.toMatchObject({ code: SYSTEM_OVERLOAD });
      expect(touched).toEqual([]);
    });

    it(`${name} that is reduce-only or close-position passes the overload door`, async () => {
      process.env.TRADE_ORDER_OVERLOAD = 'true';
      await expect(place({ ...increasing, side: 'sell', reduceOnly: true } as PlaceOrderInput)).rejects.toThrow(PAST_DOOR);
      await expect(place({ ...increasing, closePosition: true } as PlaceOrderInput)).rejects.toThrow(PAST_DOOR);
      expect(touched.length).toBeGreaterThan(0);
    });

    it(`${name} passes the overload door with the switch unset`, async () => {
      delete process.env.TRADE_ORDER_OVERLOAD;
      await expect(place(increasing)).rejects.toThrow(PAST_DOOR);
    });
  }

  it('only the exact value "true" turns the switch on', () => {
    expect(() => assertAdmittedUnderOverload({}, { TRADE_ORDER_OVERLOAD: '1' })).not.toThrow();
    expect(() => assertAdmittedUnderOverload({}, { TRADE_ORDER_OVERLOAD: 'TRUE' })).not.toThrow();
    expect(() => assertAdmittedUnderOverload({}, { TRADE_ORDER_OVERLOAD: 'true' })).toThrow(
      expect.objectContaining({ code: SYSTEM_OVERLOAD }),
    );
  });
});
