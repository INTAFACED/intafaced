import { TradeService } from '../controls/test-admission.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import { type PlaceOrderInput } from './trade-service.js';
import {
  COMBO_DISAGREES,
  COMBO_LEGS_MISSING,
  COMBO_UNSUPPORTED,
  RATIO_MISSING,
  bindCombo,
  comboDoubleHoldRefuse,
  comboIntentRefuse,
  comboLegsRefuse,
  installComboPlace,
  matchingComboRefuse,
  matchingSubmitComboRefuse,
  readCombo,
  readLegs,
} from './combo-place.js';
import type { EngineSubmitRequest, EngineSubmitResult } from './matching-client.js';
import type { Principal } from '@intafaced/auth';
import { toCcxtError } from '../ccxt-errors.js';
import { TradeError } from './types.js';

installComboPlace(TradeService);

const EXPIRY = '2026-12-31T00:00:00.000Z';

function namedLegs(over: Record<string, unknown>[] = []) {
  const base = [
    { name: 'call', ratio: amt('1'), strike: amt('100'), expiry: EXPIRY },
    { name: 'put', ratio: amt('-1'), strike: amt('100'), expiry: EXPIRY },
  ];
  return base.map((leg, i) => ({ ...leg, ...(over[i] ?? {}) }));
}

type ComboInput = PlaceOrderInput & {
  combo?: boolean | null;
  legs?: ReturnType<typeof namedLegs> | null;
};

describe('combo place — one instrument hold/fill, never per-leg money', () => {
  it('missing flags are not a combo; false is not set', () => {
    expect(readCombo({})).toBe(false);
    expect(readCombo({ combo: null })).toBe(false);
    expect(readCombo({ combo: false })).toBe(false);
    expect(readCombo({ combo: true })).toBe(true);
    expect(readLegs({})).toBeNull();
    expect(readLegs({ legs: null })).toEqual([]);
    expect(readLegs({ legs: namedLegs() })).toHaveLength(2);
  });

  it('combo:true without named legs refuses — no invented combo book', () => {
    expect(comboLegsRefuse(null)?.code).toBe('trade.missing_combo_legs');
    expect(comboLegsRefuse([])?.code).toBe('trade.missing_combo_legs');
    expect(comboLegsRefuse([{ name: 'call', ratio: amt('1') }])?.code).toBe('trade.missing_combo_legs');
    expect(comboIntentRefuse({ combo: true })?.code).toBe('trade.missing_combo_legs');
    expect(comboIntentRefuse({})).toBeNull();
    expect(comboIntentRefuse({ combo: false })).toBeNull();
    expect(comboIntentRefuse({ combo: false, legs: namedLegs() })).toBeNull();
  });

  it('missing ratio / strike / expiry refuses — never invented', () => {
    expect(comboIntentRefuse({ combo: true, legs: namedLegs([{ ratio: null }]) })?.code).toBe('trade.missing_ratio');
    expect(comboIntentRefuse({ combo: true, legs: namedLegs([{ strike: null }]) })?.code).toBe('trade.missing_strike');
    expect(comboIntentRefuse({ combo: true, legs: namedLegs([{ expiry: null }]) })?.code).toBe('trade.missing_expiry');
    expect(comboIntentRefuse({ combo: true, legs: namedLegs() })).toBeNull();
  });

  it('legs with per-leg qty/amount/hold refuse — would double-hold', () => {
    expect(comboDoubleHoldRefuse(namedLegs([{ qty: amt('1') }]))?.code).toBe('trade.combo_double_hold');
    expect(comboDoubleHoldRefuse(namedLegs([{ amount: '10' }]))?.code).toBe('trade.combo_double_hold');
    expect(comboDoubleHoldRefuse(namedLegs([{ hold: '10' }]))?.code).toBe('trade.combo_double_hold');
    expect(comboDoubleHoldRefuse(namedLegs([{ side: 'buy' }]))?.code).toBe('trade.combo_double_hold');
    expect(comboDoubleHoldRefuse(namedLegs())).toBeNull();
    expect(comboIntentRefuse({ combo: true, legs: namedLegs([{ qty: '1' }]) })?.code).toBe('trade.combo_double_hold');
  });

  it('matching combo refuses wrap as trade.*; other codes do not', () => {
    expect(COMBO_LEGS_MISSING).toBe('missing_combo_legs');
    expect(RATIO_MISSING).toBe('missing_ratio');
    expect(COMBO_DISAGREES).toBe('combo_disagrees');
    expect(COMBO_UNSUPPORTED).toBe('combo_unsupported');
    expect(matchingComboRefuse(null)).toBeNull();
    expect(matchingComboRefuse({ code: 'self_trade' })).toBeNull();
    expect(matchingComboRefuse({ code: 'missing_combo_legs' })).toMatchObject({ code: 'trade.missing_combo_legs' });
    expect(matchingComboRefuse({ code: 'missing_ratio' })).toMatchObject({ code: 'trade.missing_ratio' });
    expect(matchingComboRefuse({ code: 'combo_disagrees' })).toMatchObject({ code: 'trade.combo_disagrees' });
    expect(matchingComboRefuse({ code: 'combo_unsupported' })).toMatchObject({ code: 'trade.combo_unsupported' });
    expect(matchingSubmitComboRefuse({ rejected: { code: 'combo_disagrees' } })).toMatchObject({
      code: 'trade.combo_disagrees',
    });
  });

  it('place that returns matching combo_disagrees throws — no silent rest', async () => {
    class Door {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'take', status: 'rejected', rejectCode: 'combo_disagrees' };
      }
    }
    installComboPlace(Door as unknown as typeof TradeService);
    await expect(new Door().placeOrder({} as Principal, {})).rejects.toMatchObject({ code: 'trade.combo_disagrees' });
  });

  it('combo submit with fills plus combo_disagrees is refused — not swallowed as a fill', async () => {
    class Door {
      async placeOrder(_principal: Principal, _input: unknown) {
        return { id: 'take', status: 'filled', rejectCode: null };
      }
      async applySubmitResult(_market: unknown, _orderId: unknown, result: EngineSubmitResult) {
        if (result.fills.length > 0) {
          throw new Error('should have been converted before orig apply saw a fill');
        }
        expect(result.accepted).toBe(false);
        expect(result.rejected?.code).toBe('combo_disagrees');
      }
    }
    installComboPlace(Door as unknown as typeof TradeService);
    const door = new Door();
    const fill = {
      sequence: 1,
      makerOrderId: 'rest',
      makerAccountId: 'alice',
      takerOrderId: 'take',
      takerAccountId: 'bob',
      takerSide: 'buy' as const,
      price: '99',
      qty: '2',
    };
    await expect(
      door.applySubmitResult({}, 'take', {
        accepted: true,
        sequence: 1,
        fills: [fill],
        resting: null,
        rejected: {
          code: 'combo_disagrees',
          message: 'a combo takes a resting combo with the same named legs and ratios; trade does not invent a match',
        },
        cancellations: [],
        triggered: [],
      }),
    ).rejects.toMatchObject({ code: 'trade.combo_disagrees' });
  });

  it('maps combo refuses as InvalidOrder — not a fill, not a dropped symbol', () => {
    const missing = toCcxtError(new TradeError('a combo requires named legs', 'trade.missing_combo_legs'));
    expect(missing!.status).toBe(400);
    expect(missing!.body.code).toBe('InvalidOrder');
    expect(missing!.body.intafacedCode).toBe('trade.missing_combo_legs');
    const double = toCcxtError(new TradeError('combo legs would each take a hold', 'trade.combo_double_hold'));
    expect(double!.body.code).toBe('InvalidOrder');
    expect(double!.body.intafacedCode).toBe('trade.combo_double_hold');
  });

  it('place with combo:true and named legs reaches matching as one instrument; missing stays unset', async () => {
    class Door {
      async placeOrder(_principal: Principal, input: PlaceOrderInput) {
        return { id: 'order', status: 'open', input };
      }
      toEngineRequest(...args: unknown[]): EngineSubmitRequest {
        const input = args[2] as ComboInput;
        return { orderId: 'order', accountId: 'alice', type: 'limit', side: 'buy', qty: formatAmount(input.qty), tif: 'GTC' };
      }
    }
    installComboPlace(Door as unknown as typeof TradeService);
    const door = new Door();
    const origPlace = Door.prototype.placeOrder;
    let placed: PlaceOrderInput | null = null;
    Door.prototype.placeOrder = async function (this: Door, principal: Principal, input: PlaceOrderInput) {
      placed = input;
      return origPlace.call(this, principal, input);
    };

    await door.placeOrder(
      {} as Principal,
      {
        side: 'buy',
        type: 'limit',
        qty: amt('2'),
        price: amt('99'),
        clientOrderId: 'cmb-unit',
        combo: true,
        legs: namedLegs(),
      } as ComboInput,
    );
    const forwarded = door.toEngineRequest('order', 'alice', placed);
    expect(forwarded.combo).toBe(true);
    expect(forwarded.legs).toEqual([
      { name: 'call', ratio: '1', strike: '100', expiry: EXPIRY },
      { name: 'put', ratio: '-1', strike: '100', expiry: EXPIRY },
    ]);
    expect(typeof forwarded.legs?.[0]?.ratio).toBe('string');
    expect(typeof forwarded.legs?.[1]?.ratio).toBe('string');

    await expect(
      door.placeOrder(
        {} as Principal,
        {
          side: 'buy',
          type: 'limit',
          qty: amt('2'),
          price: amt('99'),
          clientOrderId: 'cmb-miss-unit',
          combo: true,
        } as ComboInput,
      ),
    ).rejects.toMatchObject({ code: 'trade.missing_combo_legs' });

    const falseBound = bindCombo({
      side: 'buy',
      type: 'limit',
      qty: amt('1'),
      price: amt('99'),
      clientOrderId: 'cmb-plain',
    });
    expect(readCombo(falseBound)).toBe(false);
    expect((falseBound as ComboInput).legs).toBeUndefined();
  });

  it('combo-place never posts ledger money itself — one orig place/fill, no per-leg recipes', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, 'combo-place.ts'), 'utf8');
    expect(src).not.toMatch(/recipes\.orderHold/);
    expect(src).not.toMatch(/recipes\.tradeFill/);
    expect(src).toMatch(/combo: true/);
  });
});
