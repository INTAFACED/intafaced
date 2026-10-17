import { describe, expect, it } from 'vitest';
import { TEST_NOW, TEST_QUOTES } from './fixtures';
import {
  allowedActions,
  buildCsv,
  costOf,
  countdownOf,
  csvCell,
  lifecycleOf,
  noteSymbol,
  operationOf,
  phaseOf,
  chipOf,
  requestBlock,
  verdictOf,
  type RequestDraft,
} from './model';

describe('lifecycle and phase', () => {
  it('reads each lifecycle word and refuses to guess an unknown one', () => {
    expect(lifecycleOf(TEST_QUOTES.open)).toBe('open');
    expect(lifecycleOf(TEST_QUOTES.bound)).toBe('bound');
    expect(lifecycleOf(TEST_QUOTES.settled)).toBe('settled');
    expect(lifecycleOf(TEST_QUOTES.expired)).toBe('expired');
    expect(lifecycleOf({ status: 'weird', lifecycle: undefined })).toBe('unknown');
    expect(lifecycleOf({ status: 'open' })).toBe('open');
  });

  it('allows the right actions per phase', () => {
    expect(allowedActions(phaseOf(TEST_QUOTES.open, TEST_NOW))).toEqual(['accept', 'expire', 'check']);
    expect(allowedActions(phaseOf(TEST_QUOTES.bound, TEST_NOW))).toEqual(['settle', 'check']);
    expect(allowedActions(phaseOf(TEST_QUOTES.settled, TEST_NOW))).toEqual(['check']);
    expect(allowedActions(phaseOf(TEST_QUOTES.expired, TEST_NOW))).toEqual(['check']);
    expect(allowedActions('unknown')).toEqual(['check']);
  });

  it('calls an open quote past its time "open-late" and allows only a re-read', () => {
    const late = TEST_NOW + 31_000;
    expect(phaseOf(TEST_QUOTES.open, late)).toBe('open-late');
    expect(allowedActions('open-late')).toEqual(['check']);
    // A bound quote is settled whatever the clock says: the hold is already placed.
    expect(phaseOf(TEST_QUOTES.bound, late)).toBe('bound');
  });
});

describe('status chip', () => {
  it('says unconfirmed when a lost request names this quote, whatever its stage', () => {
    expect(chipOf(TEST_QUOTES.open, TEST_NOW, TEST_QUOTES.open.quoteId)).toBe('unconfirmed');
    expect(chipOf(TEST_QUOTES.bound, TEST_NOW, TEST_QUOTES.bound.quoteId)).toBe('unconfirmed');
    expect(chipOf(TEST_QUOTES.open, TEST_NOW, 'some-other-quote')).toBe('open');
  });
  it('says time-up for an open quote past its clock, and leaves other stages alone', () => {
    const late = TEST_NOW + 31_000;
    expect(chipOf(TEST_QUOTES.open, late, null)).toBe('time-up');
    expect(chipOf(TEST_QUOTES.bound, late, null)).toBe('bound');
    expect(chipOf(TEST_QUOTES.expired, late, null)).toBe('expired');
  });
});

describe('countdown', () => {
  it('counts down from expiresAt and a given now', () => {
    expect(countdownOf(TEST_QUOTES.open.expiresAt, TEST_NOW)).toEqual({ state: 'firm', msLeft: 30_000, text: '0:30' });
    expect(countdownOf(TEST_QUOTES.open.expiresAt, TEST_NOW - 90_000).text).toBe('2:00');
    expect(countdownOf(TEST_QUOTES.open.expiresAt, TEST_NOW + 29_500).text).toBe('0:01');
  });
  it('is past at the instant and after, and unreadable for a bad date', () => {
    expect(countdownOf(TEST_QUOTES.open.expiresAt, TEST_NOW + 30_000).state).toBe('past');
    expect(countdownOf('nonsense', TEST_NOW)).toEqual({ state: 'unreadable', msLeft: 0, text: '—' });
  });
});

describe('all-in cost', () => {
  it('buy pays the value; spread cost is value minus mid value', () => {
    const cost = costOf(TEST_QUOTES.open);
    expect(cost).toMatchObject({
      value: '30060',
      midValue: '30000',
      spreadCost: '60',
      agrees: true,
      spreadBps: 20,
      feeBps: '0',
      direction: 'pay',
    });
  });
  it('sell receives the value; spread cost is mid value minus value', () => {
    const cost = costOf(TEST_QUOTES.sell);
    expect(cost).toMatchObject({ spreadCost: '60', agrees: true, direction: 'receive' });
  });
  it('shows a gap instead of hiding it when the service figure disagrees', () => {
    const cost = costOf({ ...TEST_QUOTES.open, spreadNotional: '59' });
    expect(cost.agrees).toBe(false);
    expect(cost.spreadCost).toBe('60');
  });
  it('is unknown, not zero, when a value cannot be read', () => {
    const cost = costOf({ ...TEST_QUOTES.open, userNotional: 'x' });
    expect(cost.spreadCost).toBeNull();
    expect(cost.agrees).toBe(false);
  });
});

describe('status check verdicts', () => {
  it('releases the note only when the service proves the outcome', () => {
    expect(verdictOf('accept', 'bound')).toBe('done');
    expect(verdictOf('accept', 'settled')).toBe('done');
    expect(verdictOf('accept', 'expired')).toBe('not-done');
    expect(verdictOf('accept', 'open')).toBe('unresolved');
    expect(verdictOf('settle', 'settled')).toBe('done');
    expect(verdictOf('settle', 'bound')).toBe('unresolved');
    expect(verdictOf('expire', 'expired')).toBe('done');
    expect(verdictOf('expire', 'bound')).toBe('not-done');
    expect(verdictOf('expire', 'open')).toBe('unresolved');
    expect(verdictOf('accept', 'unknown')).toBe('unresolved');
    expect(verdictOf('request', 'open')).toBe('unresolved');
  });
  it('keeps the operation in the device note', () => {
    expect(operationOf(noteSymbol('settle', 'BTC/USDT'))).toBe('settle');
    expect(operationOf('BTC/USDT')).toBeNull();
  });
});

describe('request form reasons', () => {
  const ready: RequestDraft = { signedIn: true, desk: 'open', pair: 'BTC/USDT', qty: '0.5', lot: '0.001', locked: false, busy: false };
  it('is enabled when everything holds', () => {
    expect(requestBlock(ready)).toBeNull();
  });
  it('names the first thing to fix', () => {
    expect(requestBlock({ ...ready, signedIn: false, desk: 'closed' })).toBe('signed-out');
    expect(requestBlock({ ...ready, desk: 'loading' })).toBe('desk-loading');
    expect(requestBlock({ ...ready, desk: 'unreadable' })).toBe('desk-unreadable');
    expect(requestBlock({ ...ready, desk: 'closed', qty: '' })).toBe('desk-closed');
    expect(requestBlock({ ...ready, locked: true })).toBe('locked');
    expect(requestBlock({ ...ready, pair: '' })).toBe('no-pair');
    expect(requestBlock({ ...ready, qty: '' })).toBe('bad-size');
    expect(requestBlock({ ...ready, qty: '0' })).toBe('bad-size');
    expect(requestBlock({ ...ready, qty: '-1' })).toBe('bad-size');
    expect(requestBlock({ ...ready, qty: '0.0005' })).toBe('off-lot');
    expect(requestBlock({ ...ready, busy: true })).toBe('busy');
  });
});

describe('csv', () => {
  it('builds exact strings, header first, CRLF', () => {
    const csv = buildCsv([{ quote: TEST_QUOTES.settled, readAt: TEST_NOW }]);
    expect(csv).toBe(
      'quoteId,lifecycle,side,baseAsset,quoteAsset,qty,quotedPrice,midPrice,valueIncludingSpread,midValue,spreadBps,counterparty,counterpartyId,createdAt,expiresAt,acceptedAt,fillPrice,readAt\r\n' +
        'TEST-quote-settled-0003,settled,buy,BTC,USDT,0.5,60120,60000,30060,30000,20,TEST desk,TEST-cp-1,2026-10-17T09:59:30.000Z,2026-10-17T10:00:30.000Z,2026-10-17T09:58:10.000Z,60120,2026-10-17T10:00:00.000Z\r\n',
    );
  });
  it('leaves unknown cells empty and quotes awkward text', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)', true)).toBe("'=SUM(A1)");
  });
  it('is just the header for no quotes', () => {
    expect(buildCsv([]).split('\r\n')).toHaveLength(2);
  });
});
