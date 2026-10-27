/** The owner's level-to-capability mapping (IDENTITY_KYC_CAPABILITIES_BY_LEVEL, I-kyc-compliance-07): NO DEFAULT. */
import { describe, expect, it } from 'vitest';
import { capabilitiesOfLevel, parseKycCapabilitiesByLevel } from './capabilities.js';

const parse = (value: unknown) => parseKycCapabilitiesByLevel(JSON.stringify(value));

describe('parseKycCapabilitiesByLevel', () => {
  it('unset or blank is no mapping, never a default one', () => {
    expect(parseKycCapabilitiesByLevel(undefined).size).toBe(0);
    expect(parseKycCapabilitiesByLevel(' ').size).toBe(0);
  });

  it('keeps each level with its own capabilities', () => {
    const map = parse({ basic: ['custody_crypto', 'trade_crypto'], full: ['custody_fiat'] });
    expect(map.get('basic')).toEqual(['custody_crypto', 'trade_crypto']);
    expect(map.get('full')).toEqual(['custody_fiat']);
    expect(map.has('institutional')).toBe(false);
  });

  it('stops the service on anything malformed', () => {
    for (const bad of [
      '{',
      '{}',
      '[]',
      JSON.stringify({ none: ['custody_crypto'] }),
      JSON.stringify({ gold: ['custody_crypto'] }),
      JSON.stringify({ basic: [] }),
      JSON.stringify({ basic: 'custody_crypto' }),
      JSON.stringify({ basic: ['fly'] }),
      JSON.stringify({ basic: ['custody_crypto', 'custody_crypto'] }),
      JSON.stringify({ basic: ['custody_crypto'], full: ['custody_crypto'] }),
    ])
      expect(() => parseKycCapabilitiesByLevel(bad), bad).toThrow(/IDENTITY_KYC_CAPABILITIES_BY_LEVEL/);
  });
});

describe('capabilitiesOfLevel', () => {
  const map = parse({ basic: ['custody_crypto', 'trade_crypto'], full: ['custody_fiat', 'transfer_fiat'] });
  it('a level grants its own and every lower level capability', () => {
    expect(capabilitiesOfLevel(map, 'none')).toEqual([]);
    expect(capabilitiesOfLevel(map, 'basic')).toEqual(['custody_crypto', 'trade_crypto']);
    expect(capabilitiesOfLevel(map, 'full')).toEqual(['custody_crypto', 'trade_crypto', 'custody_fiat', 'transfer_fiat']);
    expect(capabilitiesOfLevel(map, 'institutional')).toEqual(capabilitiesOfLevel(map, 'full'));
  });
  it('no mapping grants nothing at any level', () => {
    expect(capabilitiesOfLevel(new Map(), 'institutional')).toEqual([]);
  });
});
