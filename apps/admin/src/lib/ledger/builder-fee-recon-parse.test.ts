import { describe, expect, it } from 'vitest';
import { builderFeeCsv, parseBuilderFeeRecon, reconPeriod } from './builder-fee-recon-parse';

const line = {
  fillId: 'f1',
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
      idempotencyKey: 'builder-fee:test-venue-sim:f1',
      fillId: 'f1',
      userId: 'u1',
      assetId: 'USDC',
      amount: '0.25',
      postedAt: '2026-11-09T10:00:02.000Z',
    },
  ],
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
      'tx-1,builder-fee:test-venue-sim:f1,test-venue-sim,f1,u1,USDC,0.25,2026-11-09T10:00:02.000Z',
      '',
    ]);
    const odd = builderFeeCsv('v', [{ ...venue.ledgerRecords[0]!, fillId: '=HYPERLINK("x")', userId: null }], 'g', 'a', period);
    expect(odd.split('\r\n')[4]).toBe('tx-1,builder-fee:test-venue-sim:f1,v,"\'=HYPERLINK(""x"")",,USDC,0.25,2026-11-09T10:00:02.000Z');
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
