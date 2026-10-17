import { describe, expect, it } from 'vitest';
import { roomWords } from './refusals';

describe('roomWords: a write that may have gone through is never called unchanged', () => {
  it('says the outcome is unconfirmed even when a code that reads as "nothing changed" came with it', () => {
    const words = roomWords({ reason: 'uncertain', code: 'trade.matching_unavailable', message: 'x' });
    expect(words.title).toBe("We couldn't confirm that");
    expect(words.body).toContain('Check status before trying again');
    expect(words.body).not.toMatch(/nothing was changed/i);
    expect(words.code).toBe('trade.matching_unavailable');
  });
  it('gives the same words with no code, and no code field', () => {
    const words = roomWords({ reason: 'uncertain' });
    expect(words.title).toBe("We couldn't confirm that");
    expect(words.code).toBeUndefined();
  });
  it('still explains a plain refusal by its code', () => {
    expect(roomWords({ reason: 'error', code: 'trade.matching_unavailable' }).code).toBe('trade.matching_unavailable');
  });
});
