import { describe, expect, it } from 'vitest';
import { agoText, builderFeeCsv, parseBuilderFeeRecon, posterWords, reconPeriod } from './builder-fee-recon-parse';

const line = {
  fillId: 'f1',
  venueAccount: '0xa1',
  userId: 'u1',
  assetId: 'USDC',
  venueAmount: '0.25',
  ledgerAmount: null,
  ledgerAssetId: null,
  filledAt: '2026-11-09T10:00:00.000Z',
  status: 'not_in_ledger',
  refusalCode: null,
};
const venue = {
  state: 'read',
  venueId: 'test-venue-sim',
  displayName: 'TEST venue',
  test: true,
  asOf: '2026-11-09T10:00:01.000Z',
  result: 'break',
  compared: 1,
  matched: false,
  totals: [{ assetId: 'USDC', venueTotal: '0.25', ledgerTotal: '0', matched: false }],
  lines: [line],
  owed: [{ assetId: 'USDC', amount: '0.25', state: 'owed' }],
  volume: [
    {
      assetId: 'USDC',
      quoteAsset: 'USDC',
      fills: 1,
      volume: '600.1',
      expectedFee: '0.06',
      chargedFee: '0.25',
      gap: '0.19',
      matched: false,
    },
  ],
  volumeGaps: [
    {
      fillId: 'f1',
      symbol: 'BTC-USDC',
      assetId: 'USDC',
      volume: '600.1',
      feeBps: '1',
      expectedFee: '0.06',
      chargedFee: '0.25',
      gap: '0.19',
      reason: 'fee_differs',
    },
  ],
  ledgerRecords: [
    {
      ledgerTxId: 'tx-1',
      idempotencyKey: 'builder-fee:test-venue-sim:0xa1:f1',
      fillId: 'f1',
      venueAccount: '0xa1',
      userId: 'u1',
      assetId: 'USDC',
      amount: '0.25',
      postedAt: '2026-11-09T10:00:02.000Z',
    },
  ],
  poster: { lastCompleteAt: '2026-11-09T09:59:00.000Z', lastStopAt: null, lastStop: null },
};
const recon = { from: '2026-11-02T10:00:00.000Z', to: '2026-11-09T10:00:00.000Z', periodOpen: false, venues: [venue] };

describe('parseBuilderFeeRecon', () => {
  it('reads a recon with a break, keeping amounts as decimal strings', () => {
    expect(parseBuilderFeeRecon(recon)?.venues[0]).toMatchObject({
      state: 'read',
      matched: false,
      lines: [{ status: 'not_in_ledger', venueAmount: '0.25' }],
    });
  });
  it('reads a venue that compared nothing as nothing to compare, and refuses a green that compared nothing (OWNER 288)', () => {
    const empty = {
      ...venue,
      result: 'nothing_to_compare',
      compared: 0,
      matched: false,
      totals: [],
      lines: [],
      volume: [],
      volumeGaps: [],
      ledgerRecords: [],
    };
    expect(parseBuilderFeeRecon({ ...recon, venues: [empty] })?.venues[0]).toMatchObject({
      result: 'nothing_to_compare',
      compared: 0,
      matched: false,
    });
    // The old answer: matched over zero lines. It is not shown as green.
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...empty, result: 'matched', matched: true }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...empty, matched: true }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, result: undefined }] })).toBeNull();
  });
  it('reads a not-our-order line, the venue account, and the poster state; a bad poster state refuses the answer', () => {
    const notOurs = { ...line, fillId: 'f9', status: 'not_our_order' };
    const stop = { venueId: 'test-venue-sim', venueAccount: '0xa1', fillId: 'f1', code: 'ledger.idempotency_conflict', message: 'x' };
    const read = parseBuilderFeeRecon({
      ...recon,
      venues: [{ ...venue, lines: [line, notOurs], poster: { ...venue.poster, lastStopAt: '2026-11-09T10:00:00.000Z', lastStop: stop } }],
    })?.venues[0];
    expect(read).toMatchObject({
      lines: [{ venueAccount: '0xa1' }, { status: 'not_our_order' }],
      poster: { lastCompleteAt: '2026-11-09T09:59:00.000Z', lastStop: stop },
    });
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, poster: undefined }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, poster: { ...venue.poster, lastCompleteAt: 'soon' } }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, poster: { ...venue.poster, lastStop: { code: 1 } } }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, lines: [{ ...line, venueAccount: '' }] }] })).toBeNull();
  });
  it('words the poster line: the time since the last complete run, and a stop newer than it with its account and fill', () => {
    const now = new Date('2026-11-09T12:00:00.000Z');
    expect(agoText('2026-11-09T11:59:00.000Z', now)).toBe('1 minute');
    expect(agoText('2026-11-09T09:00:00.000Z', now)).toBe('3 hours');
    expect(agoText('2026-11-06T12:00:00.000Z', now)).toBe('3 days');
    expect(posterWords({ lastCompleteAt: null, lastStopAt: null, lastStop: null }, now)).toEqual({
      complete: 'The builder-fee poster has no complete run recorded.',
      stop: null,
    });
    const stop = { venueId: 'v', venueAccount: '0xa1', fillId: 't6', code: 'ledger.idempotency_conflict', message: 'x' };
    const stopped = posterWords(
      { lastCompleteAt: '2026-11-09T11:00:00.000Z', lastStopAt: '2026-11-09T11:50:00.000Z', lastStop: stop },
      now,
    );
    expect(stopped.complete).toBe('The builder-fee poster last completed a run 60 minutes ago, at 2026-11-09 11:00:00 UTC.');
    expect(stopped.stop).toBe(
      'Stopped 10 minutes ago (ledger.idempotency_conflict) at account 0xa1, fill t6. Fees after it wait until a run completes.',
    );
    // A stop older than the last complete run is over: not shown.
    expect(
      posterWords({ lastCompleteAt: '2026-11-09T11:55:00.000Z', lastStopAt: '2026-11-09T11:50:00.000Z', lastStop: stop }, now).stop,
    ).toBeNull();
  });
  it('reads an unknown venue', () => {
    const unknown = { state: 'unknown', venueId: null, displayName: null, code: 'venue.venue_down', message: 'down' };
    expect(parseBuilderFeeRecon({ ...recon, venues: [unknown] })?.venues[0]).toMatchObject({ state: 'unknown', code: 'venue.venue_down' });
  });
  it('refuses the whole answer when one field is wrong: a number amount, an unknown status, a missing total', () => {
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, lines: [{ ...line, venueAmount: 0.25 }] }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, lines: [{ ...line, status: 'fine' }] }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, totals: [{ assetId: 'USDC' }] }] })).toBeNull();
  });
});

describe('owed, routed volume and the export (J-derivatives-17 #3 #4 #5)', () => {
  it('reads them, and refuses the whole answer when one of them is wrong', () => {
    expect(parseBuilderFeeRecon(recon)?.venues[0]).toMatchObject({
      owed: [{ assetId: 'USDC', amount: '0.25', state: 'owed' }],
      volume: [{ gap: '0.19', matched: false }],
      volumeGaps: [{ reason: 'fee_differs', feeBps: '1' }],
      ledgerRecords: [{ ledgerTxId: 'tx-1' }],
    });
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, owed: [{ assetId: 'USDC', amount: 0.25, state: 'owed' }] }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, owed: [{ assetId: 'USDC', amount: '0.25' }] }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, volume: undefined }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, volumeGaps: [{ ...venue.volumeGaps[0], reason: 'odd' }] }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, ledgerRecords: [{ ledgerTxId: 'tx-1' }] }] })).toBeNull();
  });
  it('the export has one row per ledger record, with its time lines, and no cell a spreadsheet would run', () => {
    const period = { from: '2026-11-02T10:00:00.000Z', to: '2026-11-09T10:00:00.000Z' };
    const csv = builderFeeCsv('test-venue-sim', venue.ledgerRecords, '2026-11-09T10:00:05.000Z', '2026-11-09T10:00:01.000Z', period);
    expect(csv.split('\r\n')).toEqual([
      '# Generated at 2026-11-09T10:00:05.000Z',
      '# Data as of 2026-11-09T10:00:01.000Z',
      '# Builder fees the ledger records as earned on test-venue-sim, fills from 2026-11-02T10:00:00.000Z to 2026-11-09T10:00:00.000Z',
      'ledger_tx_id,idempotency_key,venue_id,fill_id,user_id,asset,amount,posted_at',
      'tx-1,builder-fee:test-venue-sim:0xa1:f1,test-venue-sim,f1,u1,USDC,0.25,2026-11-09T10:00:02.000Z',
      '',
    ]);
    const odd = builderFeeCsv('v', [{ ...venue.ledgerRecords[0]!, fillId: '=HYPERLINK("x")', userId: null }], 'g', 'a', period);
    expect(odd.split('\r\n')[4]).toBe(
      'tx-1,builder-fee:test-venue-sim:0xa1:f1,v,"\'=HYPERLINK(""x"")",,USDC,0.25,2026-11-09T10:00:02.000Z',
    );
  });
});

describe('reconPeriod', () => {
  const now = new Date('2026-11-09T10:00:00.000Z');
  it('takes a given ISO period, else the last 7 days to now', () => {
    expect(reconPeriod('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', now)).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
    });
    expect(reconPeriod('yesterday', undefined, now)).toEqual({ from: '2026-11-02T10:00:00.000Z', to: '2026-11-09T10:00:00.000Z' });
  });
});
