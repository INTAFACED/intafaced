import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BIP39_ENGLISH } from './bip39-english.js';
import { findCommentSecret } from './comment-secrets.js';

describe('a comment holding a secret (J-support-public-20 #5)', () => {
  it('holds the published BIP39 English list, unchanged', () => {
    expect(BIP39_ENGLISH).toHaveLength(2048);
    const file = `${BIP39_ENGLISH.join('\n')}\n`;
    expect(createHash('sha256').update(file).digest('hex')).toBe('2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda');
  });

  it('finds a card number written together, in spaced groups or in hyphenated groups', () => {
    for (const text of ['card 4111111111111111 ok', 'my card is 4111 1111 1111 1111', '5555-5555-5555-4444', 'amex 378282246310005'])
      expect(findCommentSecret(text), text).toBe('card_number');
  });

  it('leaves alone digits that are not a card number', () => {
    for (const text of [
      'order 4111111111111112 failed', // fails Luhn
      'reference 1234567890123452', // starts with 1
      'amount 0.00041111 BTC at 1698765432', // too short a run
      'tx 0x4111111111111111abc', // inside a hex string
      'call +44 20 7946 0958',
    ])
      expect(findCommentSecret(text), text).toBeNull();
  });

  it('finds a 12-word recovery phrase, numbered or comma separated, in any case', () => {
    const phrase = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    expect(findCommentSecret(`my phrase: ${phrase}`)).toBe('recovery_phrase');
    expect(
      findCommentSecret(
        phrase
          .split(' ')
          .map((w, i) => `${i + 1}. ${w.toUpperCase()}`)
          .join(', '),
      ),
    ).toBe('recovery_phrase');
  });

  it('leaves alone plain sentences and runs shorter than twelve words', () => {
    for (const text of [
      'I would like to know why my withdrawal to my account did not arrive after two days, please help.',
      'abandon ability able about above absent absorb abstract absurd abuse access',
      'Please check the deposit address again because the amount shown is different from what I sent yesterday.',
    ])
      expect(findCommentSecret(text), text).toBeNull();
  });
});
