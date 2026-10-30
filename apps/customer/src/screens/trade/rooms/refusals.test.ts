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
  it('shows the provider cap the service names, and plain words for a blank provider list or no pick (CB-otc-01)', () => {
    const over = roomWords({
      reason: 'error',
      code: 'trade.otc_provider_cap',
      message: 'At most 3 providers can be picked for one request (got 4)',
    });
    expect(over.title).toBe('Too many providers');
    expect(over.body).toBe('At most 3 providers can be picked for one request (got 4). Pick fewer; nothing was priced or held.');
    expect(over.code).toBe('trade.otc_provider_cap');
    expect(roomWords({ reason: 'error', code: 'trade.otc_makers_unset' }).title).toBe('No providers set');
    expect(roomWords({ reason: 'error', code: 'trade.otc_provider_required' }).title).toBe('Pick a provider');
    const unknown = roomWords({
      reason: 'error',
      code: 'trade.otc_provider_unknown',
      message: 'Provider test-lp-9 is not in the provider list',
    });
    expect(unknown.title).toBe('Provider not on the list');
    expect(unknown.body).not.toContain('test-lp-9');
    expect(roomWords({ reason: 'error', code: 'trade.otc_assets_unset' }).title).toBe('No assets set');
    expect(roomWords({ reason: 'error', code: 'trade.otc_level_unset' }).title).toBe('Verification level not set');
    expect(roomWords({ reason: 'error', code: 'trade.convert_bounds_not_set' }).title).toBe('Desk size range not set');
    expect(
      roomWords({ reason: 'error', code: 'trade.convert_out_of_bounds', message: 'Amount 11 is outside the convert bounds 0.1–5' }).body,
    ).toBe('Amount 11 is outside the convert bounds 0.1–5. Pick a size inside the range; nothing was priced or held.');
    const low = roomWords({
      reason: 'error',
      code: 'trade.otc_level_insufficient',
      message: 'The desk prices for full verification and above. Your account is at none.',
    });
    expect(low.title).toBe('Verification level too low');
    expect(low.body).toBe(
      'The desk prices for full verification and above. Your account is at none. Complete verification to ask the desk; nothing was priced or held.',
    );
    const unlisted = roomWords({ reason: 'error', code: 'trade.otc_asset_unlisted', message: "ETH is not on the desk's asset list (BTC)" });
    expect(unlisted.title).toBe('Asset not on the desk');
    expect(unlisted.body).toBe(
      "ETH is not on the desk's asset list (BTC). Pick a pair whose asset the desk lists; nothing was priced or held.",
    );
  });
});
