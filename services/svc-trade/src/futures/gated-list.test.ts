import { describe, expect, it } from 'vitest';
import type { Market } from '../spot/types.js';
import { readGatedList, type GatedListDeps } from './gated-list.js';
import { EligibilityError } from './derivatives-eligibility.js';

const perp = (symbol: string, status: Market['status'] = 'active') =>
  ({ id: `id-${symbol}`, symbol, kind: 'futures', status, baseAsset: 'BTC', quoteAsset: 'USDT' }) as unknown as Market;
const spot = { id: 'id-spot', symbol: 'BTC/USDT', kind: 'spot', status: 'active' } as unknown as Market;
const subject = { userId: 'u1', tier: 'full', region: 'XX' };

function deps(over: Partial<GatedListDeps> = {}): GatedListDeps {
  return {
    markets: async () => [perp('ETH/USDT:USDT'), perp('BTC/USDT:USDT'), spot],
    planeRefusal: () => null,
    orderPathRefusal: () => null,
    orderable: () => true,
    emailProved: async () => true,
    checkAccess: async () => {},
    ...over,
  };
}

describe('per-account gated list', () => {
  it('every futures contract open when every gate passes; spot is not listed', async () => {
    const list = await readGatedList(deps(), subject);
    expect(list.map((c) => [c.symbol, c.open, c.code])).toEqual([
      ['BTC/USDT:USDT', true, null],
      ['ETH/USDT:USDT', true, null],
    ]);
  });

  it('an unproved email and a low identity level block every contract, and every other reason is listed too', async () => {
    const list = await readGatedList(
      deps({
        checkAccess: async () => {
          throw new EligibilityError('trade.identity_level_insufficient', 'Your verification level is below what derivatives need.');
        },
        emailProved: async () => false,
      }),
      subject,
    );
    for (const contract of list) {
      expect(contract.open).toBe(false);
      expect(contract.code).toBe('trade.email_proof_required');
      expect(contract.blockers.map((b) => b.code)).toEqual(['trade.email_proof_required', 'trade.identity_level_insufficient']);
    }
  });

  it('a contract halted by an operator shows market_halted; a contract that takes no orders says so; the plane comes first', async () => {
    const halted = await readGatedList(
      deps({
        markets: async () => [perp('BTC/USDT:USDT', 'halted'), perp('ETH/USDT:USDT')],
        orderable: (m) => m.symbol !== 'ETH/USDT:USDT',
      }),
      subject,
    );
    expect(halted.map((c) => c.code)).toEqual(['trade.market_halted', 'trade.market_not_orderable']);
    const off = await readGatedList(
      deps({ planeRefusal: () => ({ code: 'trade.futures_disabled', message: 'futures exposure cannot increase' }) }),
      subject,
    );
    expect(off.every((c) => c.code === 'trade.futures_disabled' && !c.open)).toBe(true);
  });

  it('a deployment whose book is switched off or whose price band is unset lists every contract blocked by it', async () => {
    const list = await readGatedList(
      deps({ orderPathRefusal: () => ({ code: 'trade.futures_price_band_unset', message: 'the futures price band is unset' }) }),
      subject,
    );
    expect(list.map((c) => [c.open, c.code])).toEqual([
      [false, 'trade.futures_price_band_unset'],
      [false, 'trade.futures_price_band_unset'],
    ]);
  });

  it('a check that cannot be read blocks as unknown, never as open', async () => {
    const list = await readGatedList(
      deps({
        checkAccess: async () => {
          throw new Error('connection reset');
        },
        emailProved: async () => {
          throw new Error('identity unavailable');
        },
      }),
      subject,
    );
    expect(list[0]).toMatchObject({ open: false, code: 'trade.gated_list_unknown' });
    expect(list[0]!.blockers.map((b) => b.code)).toEqual(['trade.gated_list_unknown', 'trade.gated_list_unknown']);
  });
});
