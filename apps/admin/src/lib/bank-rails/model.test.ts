import { describe, expect, it } from 'vitest';
import { parseSalaryRails } from './model';

describe('the bank rails desk reads svc-bank whole or not at all (J-bank-30 #8)', () => {
  const line = {
    currency: 'USD',
    network: { credits: '2500', reversals: '500' },
    app: { credits: '2500', reversals: '500' },
    matches: true,
    difference: '0',
  };

  it('reads matching and differing lines, and no network as no data', () => {
    expect(parseSalaryRails({ partner: { label: 'TEST', asOf: '2026-11-17T00:00:00.000Z', lines: [line] } })).toEqual({
      partner: { label: 'TEST', asOf: '2026-11-17T00:00:00.000Z', lines: [line] },
    });
    const off = { ...line, matches: false, difference: '-7' };
    expect(parseSalaryRails({ partner: { label: 'TEST', asOf: 'x', lines: [off] } })?.partner?.lines[0]).toEqual(off);
    expect(parseSalaryRails({ partner: null })).toEqual({ partner: null });
  });

  it('keeps a network figure that is not known as not known, never zero', () => {
    const unknown = { ...line, network: null, matches: null, difference: null };
    expect(parseSalaryRails({ partner: { label: 'TEST', asOf: 'x', lines: [unknown] } })?.partner?.lines[0]?.network).toBeNull();
  });

  it('refuses a shape it does not understand', () => {
    expect(parseSalaryRails({})).toBeNull();
    expect(parseSalaryRails({ partner: { label: 'TEST', asOf: 'x', lines: [{ ...line, app: { credits: 2500 } }] } })).toBeNull();
    expect(parseSalaryRails({ partner: { label: 'TEST', asOf: 'x', lines: [{ ...line, matches: null }] } })).toBeNull();
  });
});
