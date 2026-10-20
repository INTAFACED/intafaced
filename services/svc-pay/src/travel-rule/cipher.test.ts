import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMessageCipher, loadMessageCipher, TRAVEL_RULE_KEY_ENV, TRAVEL_RULE_KEY_ID_ENV } from './cipher.js';
import { TravelRuleError } from './errors.js';

describe('travel-rule message cipher', () => {
  const key = randomBytes(32);

  it('round-trips and never leaves the plaintext in the ciphertext', () => {
    const c = createMessageCipher('k1', key);
    const sealed = c.seal(Buffer.from('Ada Lovelace', 'utf8'), 'transfer-1');
    expect(sealed.ciphertext.includes(Buffer.from('Ada'))).toBe(false);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.authTag).toHaveLength(16);
    expect(c.open(sealed, 'transfer-1').toString('utf8')).toBe('Ada Lovelace');
  });

  it('does not open for another transfer, with a tampered body, or under an unknown key id', () => {
    const c = createMessageCipher('k1', key);
    const sealed = c.seal(Buffer.from('payload'), 'transfer-1');
    expect(() => c.open(sealed, 'transfer-2')).toThrow();
    const flipped = Buffer.from(sealed.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => c.open({ ...sealed, ciphertext: flipped }, 'transfer-1')).toThrow();
    expect(() => c.open({ ...sealed, keyId: 'old' }, 'transfer-1')).toThrowError(TravelRuleError);
  });

  it('uses a fresh iv every time', () => {
    const c = createMessageCipher('k1', key);
    const a = c.seal(Buffer.from('x'), 't');
    const b = c.seal(Buffer.from('x'), 't');
    expect(a.iv.equals(b.iv)).toBe(false);
  });

  it('loads from the environment: nothing set is no cipher; half or malformed settings fail boot', () => {
    expect(loadMessageCipher({})).toBeNull();
    expect(loadMessageCipher({ [TRAVEL_RULE_KEY_ENV]: '  ', [TRAVEL_RULE_KEY_ID_ENV]: '' })).toBeNull();
    expect(loadMessageCipher({ [TRAVEL_RULE_KEY_ENV]: key.toString('base64'), [TRAVEL_RULE_KEY_ID_ENV]: 'k1' })?.keyId).toBe('k1');
    expect(() => loadMessageCipher({ [TRAVEL_RULE_KEY_ENV]: key.toString('base64') })).toThrow(/together/);
    expect(() => loadMessageCipher({ [TRAVEL_RULE_KEY_ID_ENV]: 'k1' })).toThrow(/together/);
    expect(() => loadMessageCipher({ [TRAVEL_RULE_KEY_ENV]: randomBytes(16).toString('base64'), [TRAVEL_RULE_KEY_ID_ENV]: 'k1' })).toThrow(
      /32 bytes/,
    );
    expect(() => loadMessageCipher({ [TRAVEL_RULE_KEY_ENV]: 'not base64!!', [TRAVEL_RULE_KEY_ID_ENV]: 'k1' })).toThrow(/32 bytes/);
  });
});
