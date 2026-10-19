import { describe, expect, it } from 'vitest';
import {
  formatAge,
  hrefWith,
  isUuid,
  one,
  PAGE_LIMIT,
  paidOutTotals,
  parseRiskWindow,
  sectionRequest,
  SCREEN_SECTIONS,
  SECTION_SPECS,
  settlementStatusChip,
  shareAsPercent,
  sumDecimals,
  slugOf,
  statusChip,
  totalOf,
} from './read-model';
import { FOUNDER_MERCHANT_SECTIONS } from '@intafaced/contracts';
import { DRILLDOWN } from './screens';
import { parseTags } from './notes';

const MID = '22222222-2222-4222-8222-222222222222';

describe('every contract section is covered', () => {
  it('has a spec for each of the 17 sections', () => {
    expect([...FOUNDER_MERCHANT_SECTIONS].sort()).toEqual(Object.keys(SECTION_SPECS).sort());
  });
  it('every section appears on at least one F07-F23 page, and every mapped slug is a real drilldown route', () => {
    const shown = new Set(Object.values(SCREEN_SECTIONS).flat());
    for (const section of FOUNDER_MERCHANT_SECTIONS) expect(shown.has(section)).toBe(true);
    const slugs = new Set<string>(DRILLDOWN.map((r) => r[1]));
    for (const slug of Object.keys(SCREEN_SECTIONS)) expect(slugs.has(slug)).toBe(true);
  });
  it('slugOf reads the last route segment', () => {
    expect(slugOf('/merchants/:id/payments')).toBe('payments');
  });
});

describe('sectionRequest', () => {
  it('always sends the page size, never a default the service would have to guess', () => {
    expect(sectionRequest(MID, 'payments', {})).toEqual({ merchantId: MID, section: 'payments', limit: PAGE_LIMIT });
  });
  it('keeps a valid status and search, drops a status the service does not accept, and ignores filters a section lacks', () => {
    expect(sectionRequest(MID, 'refunds', { status_refunds: 'posted', q_refunds: ' abc ' }).filters).toEqual({
      status: 'posted',
      search: 'abc',
    });
    expect(sectionRequest(MID, 'refunds', { status_refunds: 'captured' }).filters).toBeUndefined();
    expect(sectionRequest(MID, 'destinations', { status_destinations: 'x', q_destinations: 'y' }).filters).toBeUndefined();
  });
  it('carries the cursor of its own section only', () => {
    const q = { cursor_payments: 'AAA', cursor_refunds: 'BBB' };
    expect(sectionRequest(MID, 'payments', q).cursor).toBe('AAA');
    expect(sectionRequest(MID, 'refunds', q).cursor).toBe('BBB');
    expect(sectionRequest(MID, 'team', q).cursor).toBeUndefined();
  });
});

describe('query helpers', () => {
  it('one() takes the first value and refuses an oversized one', () => {
    expect(one({ a: ['x', 'y'] }, 'a')).toBe('x');
    expect(one({ a: 'z'.repeat(513) }, 'a')).toBeUndefined();
    expect(one({ a: '' }, 'a')).toBeUndefined();
  });
  it('hrefWith keeps other keys, replaces a key, and removes one set to undefined', () => {
    expect(hrefWith('/p', { a: '1', b: '2' }, { b: undefined, c: '3' })).toBe('/p?a=1&c=3');
    expect(hrefWith('/p', {}, {})).toBe('/p');
  });
  it('isUuid', () => {
    expect(isUuid(MID)).toBe(true);
    expect(isUuid('nope')).toBe(false);
  });
});

describe('display rules', () => {
  it('shareAsPercent moves the decimal point on the string, with no float math', () => {
    expect(shareAsPercent('0.4231')).toBe('42.31');
    expect(shareAsPercent('0.75')).toBe('75');
    expect(shareAsPercent('1')).toBe('100');
    expect(shareAsPercent('0.05')).toBe('5');
    expect(shareAsPercent('0.123456789012345678')).toBe('12.3456789012345678');
    expect(shareAsPercent('nope')).toBeNull();
  });
  it('formatAge treats an empty queue as none, not as zero', () => {
    expect(formatAge(null)).toBe('Nothing waiting');
    expect(formatAge(0)).toBe('0 s');
    expect(formatAge(7200)).toBe('2 h 0 min');
    expect(formatAge(90_000)).toBe('1 d 1 h');
  });
  it('totalOf adds integer counts', () => {
    expect(totalOf([{ count: 2 }, { count: 3 }])).toBe(5);
  });
  it('statusChip never leaves a status without a plain-English hint, and an unknown one says so', () => {
    for (const status of ['captured', 'failed', 'paid_out', 'dead', 'ready', 'invited'])
      expect(statusChip(status).hint.length).toBeGreaterThan(5);
    expect(statusChip('mystery').hint).toContain('no description');
  });
  it('risk window defaults to every projected day', () => {
    expect(parseRiskWindow(undefined)).toBe('all');
    expect(parseRiskWindow('7d')).toBe('7d');
    expect(parseRiskWindow('bogus')).toBe('all');
  });
  it('parseTags de-duplicates and refuses an over-long tag', () => {
    expect(parseTags('a, b, a ,')).toEqual(['a', 'b']);
    expect(parseTags('x'.repeat(41))).toBeNull();
  });
});

describe('settlements are credited, not sent', () => {
  it('words posted as credited and not sent, and only paid_out as sent', () => {
    expect(settlementStatusChip('posted').label).toBe('credited, not sent');
    expect(settlementStatusChip('paid_out').label).toBe('paid out');
    expect(settlementStatusChip('mystery').label).toBe(statusChip('mystery').label);
  });
  it('sums decimal strings exactly and refuses anything else', () => {
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(sumDecimals(['9007199254740993', '1'])).toBe('9007199254740994');
    expect(sumDecimals(['1', 'x'])).toBeNull();
    expect(sumDecimals([])).toBe('0');
  });
  it('counts only paid_out rows, per asset', () => {
    const rows = [
      { assetId: 'a', net: '1.50', status: 'paid_out' },
      { assetId: 'a', net: '2.5', status: 'paid_out' },
      { assetId: 'a', net: '100', status: 'posted' },
      { assetId: 'b', net: '7', status: 'failed' },
    ];
    expect(paidOutTotals(rows)).toEqual([{ assetId: 'a', net: '4.00', settlements: 2 }]);
    expect(paidOutTotals([{ assetId: 'a', net: '5', status: 'posted' }])).toEqual([]);
    expect(paidOutTotals([{ assetId: 'a', net: 'bad', status: 'paid_out' }])).toBeNull();
  });
  it('names the payouts section for what it is', () => {
    expect(SECTION_SPECS.payouts.title).toBe('Settlements credited to the merchant balance');
  });
});
