import { describe, expect, it } from 'vitest';
import { NO_TIER_LAWS, parseTierLaws, TierLawsInvalidError } from './tier-laws.js';

describe('stored tier law (AG-sessions-01)', () => {
  it('a blank or unset AGENTS_TIER_LAWS is no published law for any door', () => {
    expect(parseTierLaws(undefined)).toEqual(NO_TIER_LAWS);
    expect(parseTierLaws('  ')).toEqual(NO_TIER_LAWS);
  });

  it('reads each published door law and leaves a missing door unpublished', () => {
    const laws = parseTierLaws(
      JSON.stringify({
        scanner: { published: true, matrix: { basic: { maxSignals: 5, tools: ['trade.ticker.read'] } } },
        support: { published: false },
      }),
    );
    expect(laws).toEqual({
      scanner: { published: true, matrix: { basic: { maxSignals: 5, tools: ['trade.ticker.read'] } } },
      navigator: null,
      support: { published: false },
    });
  });

  it('refuses a malformed law with agents.tier_laws_invalid rather than opening or closing a door', () => {
    for (const raw of [
      '{not json',
      JSON.stringify({ desk: { published: false } }),
      JSON.stringify({ navigator: { published: true, matrix: { basic: 'trade.quote' } } }),
      JSON.stringify({ scanner: { published: true, matrix: { basic: { maxSignals: 101, tools: [] } } } }),
      JSON.stringify({ support: { published: false, matrix: {} } }),
    ]) {
      expect(() => parseTierLaws(raw), raw).toThrow(TierLawsInvalidError);
      expect(() => parseTierLaws(raw), raw).toThrow(expect.objectContaining({ code: 'agents.tier_laws_invalid' }));
    }
  });
});
