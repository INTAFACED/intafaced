import { describe, expect, it } from 'vitest';
import { readDeskRequest } from '@/lib/desk/approval-packet';
import { listingProblem, listingRequest, parseReasonCodeLines, type ListingForm } from './model';

const POOL = '0xAbCdEf0123456789aBcDeF0123456789abCDef01';
const form = (over: Partial<ListingForm>): ListingForm => ({
  move: 'hide_pool',
  chainId: '84532',
  poolAddress: POOL,
  symbol: ' ifc-usd ',
  reasonCode: 'scam_report',
  ...over,
});

describe('protocol listing form', () => {
  it('holds a pool move until chain id and address are valid', () => {
    expect(listingProblem(form({}))).toBeNull();
    expect(listingProblem(form({ chainId: '0' }))).toMatch(/chain id/);
    expect(listingProblem(form({ chainId: '1.5' }))).toMatch(/chain id/);
    expect(listingProblem(form({ poolAddress: '0x12' }))).toMatch(/pool address/);
  });

  it('holds a market move until the symbol is usable, and a hide or delist until it has a reason code', () => {
    expect(listingProblem(form({ move: 'delist_market' }))).toBeNull();
    expect(listingProblem(form({ move: 'delist_market', symbol: '  ' }))).toMatch(/symbol/);
    expect(listingProblem(form({ reasonCode: 'has space' }))).toMatch(/reason code/);
    expect(listingProblem(form({ move: 'restore_pool', reasonCode: '' }))).toBeNull();
    expect(listingProblem(form({ move: 'restore_market', reasonCode: '' }))).toBeNull();
  });

  it('builds requests the packet reader accepts, with the symbol in the form the service keys', () => {
    const reason = 'TEST reported as a copy of a listed token';
    for (const move of ['hide_pool', 'restore_pool', 'delist_market', 'restore_market'] as const) {
      const request = listingRequest(form({ move }), reason);
      expect(readDeskRequest(request)).toEqual(request);
    }
    expect(listingRequest(form({ move: 'delist_market' }), 'TEST some reason here')).toMatchObject({ symbol: 'IFC-USD' });
    expect(listingRequest(form({ move: 'restore_pool' }), 'ignored')).toEqual({
      kind: 'protocol.pool.restore',
      chainId: 84532,
      poolAddress: POOL,
    });
  });
});

describe('reason code list editor', () => {
  it('reads one code per line, or comma separated, and trims', () => {
    expect(parseReasonCodeLines('scam_or_fraud\n security_incident ,owner_request\n')).toEqual({
      ok: true,
      codes: ['scam_or_fraud', 'security_incident', 'owner_request'],
    });
  });
  it('refuses an empty, duplicated, oddly spelled or oversized list in words', () => {
    for (const text of [
      '',
      '  \n ',
      'a_code\na_code',
      'Bad Code',
      'x',
      '9lives',
      Array.from({ length: 51 }, (_, i) => `code_${i}`).join('\n'),
    ]) {
      const read = parseReasonCodeLines(text);
      expect(read.ok, text).toBe(false);
      if (!read.ok) expect(read.problem).toBeTruthy();
    }
  });
});
