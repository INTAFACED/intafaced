import { describe, expect, it } from 'vitest';
import { TokenError } from './token-service.js';
import { defaultEmissionsTickMs, readEmissionsTickMs, requireEmissionsTickMsForAutoTick } from './emissions-tick.js';

describe('readEmissionsTickMs', () => {
  it('blank / missing / garbage is unset — 86400000 is only owner-present', () => {
    expect(readEmissionsTickMs(undefined)).toBeUndefined();
    expect(readEmissionsTickMs('')).toBeUndefined();
    expect(readEmissionsTickMs('  ')).toBeUndefined();
    expect(readEmissionsTickMs('0')).toBeUndefined();
    expect(readEmissionsTickMs('999')).toBeUndefined();
    expect(readEmissionsTickMs('86400000.0')).toBeUndefined();
    expect(readEmissionsTickMs('1d')).toBeUndefined();
    expect(readEmissionsTickMs('86400000')).toBe(86_400_000);
    expect(readEmissionsTickMs('1000')).toBe(1_000);
  });
});

describe('requireEmissionsTickMsForAutoTick', () => {
  it('auto-tick off does not invent 86400000', () => {
    expect(requireEmissionsTickMsForAutoTick(false, undefined)).toBeUndefined();
    expect(requireEmissionsTickMsForAutoTick(false, '')).toBeUndefined();
    expect(requireEmissionsTickMsForAutoTick(false, '86400000')).toBe(86_400_000);
  });

  it('auto-tick on refuses unset — never invents 86400000', () => {
    expect(() => requireEmissionsTickMsForAutoTick(true, undefined)).toThrow(TokenError);
    expect(() => requireEmissionsTickMsForAutoTick(true, '')).toThrow(TokenError);
    expect(() => requireEmissionsTickMsForAutoTick(true, '999')).toThrow(TokenError);
    try {
      requireEmissionsTickMsForAutoTick(true, undefined);
      throw new Error('expected refuse');
    } catch (e) {
      expect(e).toBeInstanceOf(TokenError);
      expect((e as TokenError).code).toBe('token.emissions_tick_unset');
    }
  });

  it('auto-tick on accepts owner-published 86400000', () => {
    expect(requireEmissionsTickMsForAutoTick(true, '86400000')).toBe(86_400_000);
  });
});

describe('poll fallback from the epoch length', () => {
  it('blank / missing tick falls back when a fallback is given — the epoch length lives in EMISSIONS_EPOCH_MS', () => {
    expect(requireEmissionsTickMsForAutoTick(true, undefined, 60_000)).toBe(60_000);
    expect(requireEmissionsTickMsForAutoTick(true, '  ', 60_000)).toBe(60_000);
  });

  it('an explicit tick wins over the fallback', () => {
    expect(requireEmissionsTickMsForAutoTick(true, '5000', 60_000)).toBe(5_000);
  });

  it('a typo is never silently replaced by the fallback', () => {
    expect(() => requireEmissionsTickMsForAutoTick(true, '1d', 60_000)).toThrow(TokenError);
    expect(() => requireEmissionsTickMsForAutoTick(true, '999', 60_000)).toThrow(TokenError);
  });

  it('default poll is the epoch length capped at one minute (a tick == epoch length would lose a whole epoch to a few ms of drift)', () => {
    expect(defaultEmissionsTickMs(86_400_000)).toBe(60_000);
    expect(defaultEmissionsTickMs(5_000)).toBe(5_000);
  });
});
