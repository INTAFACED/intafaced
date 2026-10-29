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
  it('has plain words for an overloaded order door', () => {
    const words = roomWords({ reason: 'error', code: 'trade.system_overload' });
    expect(words.title.length).toBeGreaterThan(0);
    expect(words.body.length).toBeGreaterThan(0);
  });
  it('names a refused scale ladder and an unfinished rollback in plain words', () => {
    expect(roomWords({ code: 'trade.scale_child_refused' }).title).toBe('The ladder was not placed');
    expect(roomWords({ code: 'trade.scale_rollback_incomplete' }).body).toContain('still open');
  });
  it('shows the desk minimum the service names on a below-minimum refusal, and plain words when it is not set', () => {
    const below = roomWords({ reason: 'error', code: 'trade.rfq_below_minimum', message: 'Below the desk minimum of 1000 USDT' });
    expect(below.title).toBe('Below the desk minimum');
    expect(below.body).toBe('Below the desk minimum of 1000 USDT. Ask for a larger size; nothing was priced or held.');
    expect(below.code).toBe('trade.rfq_below_minimum');
    expect(roomWords({ reason: 'error', code: 'trade.rfq_size_not_set' }).title).toBe('The desk minimum is not set');
  });
});
