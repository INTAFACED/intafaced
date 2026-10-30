import { describe, expect, it } from 'vitest';
import { findRoom } from '../../app/navigation';
import { shareToken } from './SharedResultRoute';

// AL-report-03: a share link's address is a public room of its own, so a signed-out reader lands on the shared result.
describe('the share link route', () => {
  it('is a public room for one token', () => {
    expect(findRoom('/quant/share/abc123')).toMatchObject({ path: '/quant/share/:token', area: 'public' });
    expect(shareToken('/quant/share/abc123')).toBe('abc123');
  });

  it('reads no token from a path that is not one token', () => {
    expect(shareToken('/quant/share/abc/def')).toBeNull();
    expect(shareToken('/quant/share/')).toBeNull();
    expect(shareToken('/quant/backtest')).toBeNull();
  });

  it('keeps a token with a broken escape instead of throwing', () => {
    expect(shareToken('/quant/share/abc%E0')).toBe('abc%E0');
  });
});
