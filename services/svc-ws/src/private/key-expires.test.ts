import { describe, expect, it } from 'vitest';
import { assertKeyNotExpired, keyPastExpiresAt, optionalExpiresAt, requireNow, KeyExpiresError } from './key-expires.js';

const PAST = new Date('2020-01-01T00:00:00.000Z');
const FUTURE = new Date('2099-01-01T00:00:00.000Z');
const NOW = new Date('2026-08-25T00:00:00.000Z');

describe('requireNow', () => {
  it('refuses a missing clock and does not invent one', () => {
    expect(() => requireNow(undefined)).toThrow(KeyExpiresError);
    expect(() => requireNow(null)).toThrowError(/clock is required/);
    expect(() => requireNow('')).toThrowError(/clock is required/);
    expect(() => requireNow('not-a-date')).toThrowError(/clock is required/);
    expect(requireNow(NOW).getTime()).toBe(NOW.getTime());
  });
});

describe('optionalExpiresAt', () => {
  it('reads expiresAt or expires_at; never invents', () => {
    expect(optionalExpiresAt({ expiresAt: PAST.toISOString() })).toEqual(PAST);
    expect(optionalExpiresAt({ expires_at: FUTURE.toISOString() })).toEqual(FUTURE);
    expect(optionalExpiresAt({ id: 'k' })).toBeUndefined();
    expect(optionalExpiresAt({ expiresAt: 'nope' })).toBeUndefined();
    expect(optionalExpiresAt({ expiresAt: '' })).toBeUndefined();
    expect(optionalExpiresAt(null)).toBeUndefined();
  });
});

describe('keyPastExpiresAt', () => {
  it('drops after expiresAt; missing expiry stays open', () => {
    expect(keyPastExpiresAt(PAST, NOW)).toBe(true);
    expect(keyPastExpiresAt(FUTURE, NOW)).toBe(false);
    expect(keyPastExpiresAt(undefined, NOW)).toBe(false);
    expect(keyPastExpiresAt(null, NOW)).toBe(false);
    expect(keyPastExpiresAt('', NOW)).toBe(false);
  });

  it('refuses when the clock is missing', () => {
    expect(() => keyPastExpiresAt(FUTURE, undefined)).toThrowError(/clock is required/);
    expect(() => keyPastExpiresAt(undefined, undefined)).toThrowError(/clock is required/);
  });
});

describe('assertKeyNotExpired', () => {
  it('throws auth.api_key_expired after expiresAt', () => {
    expect(() => assertKeyNotExpired(PAST, NOW)).toThrowError(/past expiresAt/);
    try {
      assertKeyNotExpired(PAST, NOW);
    } catch (err) {
      expect(err).toMatchObject({ code: 'auth.api_key_expired' });
    }
    expect(() => assertKeyNotExpired(FUTURE, NOW)).not.toThrow();
    expect(() => assertKeyNotExpired(undefined, NOW)).not.toThrow();
  });
});
