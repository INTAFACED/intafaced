import { describe, expect, it } from 'vitest';
import { parseAmount as A } from '@intafaced/ledger-client';
import {
  OI_LIMIT,
  OI_LIMIT_UNSET,
  OI_SHARE_LIMIT,
  openInterestRefusal,
  openInterestRoom,
  openInterestUnsetRefusal,
  readOpenInterestLimits,
} from './open-interest-limits.js';

describe('open-interest limits (D-margin-05)', () => {
  it('reads the operator pair, and a blank or malformed value as unset', () => {
    expect(readOpenInterestLimits({ oiLimit: '1000', oiShareBps: '1000' })).toEqual({ limit: A('1000'), shareBps: 1000 });
    expect(readOpenInterestLimits(null)).toBeNull();
    expect(readOpenInterestLimits({ oiLimit: null, oiShareBps: '1000' })).toBeNull();
    expect(readOpenInterestLimits({ oiLimit: '1000', oiShareBps: null })).toBeNull();
    for (const oiShareBps of ['0', '10001', '1.5', '-5', 'x']) expect(readOpenInterestLimits({ oiLimit: '1000', oiShareBps })).toBeNull();
    expect(readOpenInterestLimits({ oiLimit: 'lots', oiShareBps: '1000' })).toBeNull();
  });

  it('a blank limit refuses with its own code', () => {
    expect(openInterestUnsetRefusal('BTC-PERP')).toMatchObject({ code: OI_LIMIT_UNSET, status: 503 });
    expect(openInterestUnsetRefusal('BTC-PERP').message).toContain('no open-interest limit is published for BTC-PERP');
  });

  it('a cap of 1000 at 10% lets one account hold 100: an open to 110 refuses with the room left', () => {
    const room = openInterestRoom({
      limits: { limit: A('1000'), shareBps: 1000 },
      marketCommitted: A('300'),
      accountCommitted: A('60'),
      lotSize: A('0.001'),
    });
    expect(room).toMatchObject({ accountCap: A('100'), room: A('40'), binding: 'account' });
    // Exactly at the cap is allowed.
    expect(openInterestRefusal(room, A('40'), 'BTC')).toBeNull();
    const over = openInterestRefusal(room, A('50'), 'BTC');
    expect(over).toMatchObject({ code: OI_SHARE_LIMIT, status: 422 });
    expect(over!.message).toBe(
      "this order would take your open interest on this market to 110 BTC, past the 100 BTC one account may hold (10% of the market's limit of 1000 BTC); room left 40 BTC",
    );
    // One unit past the cap refuses too.
    expect(openInterestRefusal(room, A('40.000000000000000001'), 'BTC')).toMatchObject({ code: OI_SHARE_LIMIT });
  });

  it('the market limit refuses when it leaves less room than the share, and names that room', () => {
    const room = openInterestRoom({
      limits: { limit: A('1000'), shareBps: 5000 },
      marketCommitted: A('990'),
      accountCommitted: A('10'),
      lotSize: null,
    });
    expect(room).toMatchObject({ accountCap: A('500'), room: A('10'), binding: 'market' });
    const over = openInterestRefusal(room, A('11'), 'BTC');
    expect(over).toMatchObject({ code: OI_LIMIT, status: 422 });
    expect(over!.message).toBe(
      "this order would take the market's open interest to 1001 BTC, past its limit of 1000 BTC; room left 10 BTC",
    );
    // Past both: the code is the one whose room is named.
    expect(openInterestRefusal(room, A('600'), 'BTC')).toMatchObject({ code: OI_LIMIT });
  });

  it('the room is cut to the lot and never below zero', () => {
    const cut = openInterestRoom({
      limits: { limit: A('1'), shareBps: 3333 },
      marketCommitted: A('0'),
      accountCommitted: A('0.1'),
      lotSize: A('0.01'),
    });
    // 0.3333 cap, 0.2333 left, 0.23 in lots.
    expect(cut).toMatchObject({ accountCap: A('0.3333'), room: A('0.23') });
    const lowered = openInterestRoom({
      limits: { limit: A('100'), shareBps: 100 },
      marketCommitted: A('50'),
      accountCommitted: A('5'),
      lotSize: A('0.001'),
    });
    // A lowered limit leaves a position above its cap: no room, and any open refuses.
    expect(lowered.room).toBe(0n);
    expect(openInterestRefusal(lowered, A('0.001'), 'BTC')!.message).toContain('room left 0 BTC');
  });

  it('a share in fractions of a percent reads as such', () => {
    const room = openInterestRoom({
      limits: { limit: A('1000'), shareBps: 250 },
      marketCommitted: 0n,
      accountCommitted: 0n,
      lotSize: null,
    });
    expect(openInterestRefusal(room, A('26'), 'BTC')!.message).toContain("(2.50% of the market's limit of 1000 BTC)");
  });
});
