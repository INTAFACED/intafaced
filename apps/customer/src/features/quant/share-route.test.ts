import { describe, expect, it } from 'vitest';
import { findRoom } from '../../app/navigation';
import { quantRoute } from './QuantRoutes';

// AL-report-03: a share link's address is a room of its own, so a signed-out reader lands on the shared result.
describe('the share link route', () => {
  it('opens the shared result for one token', () => {
    expect(quantRoute('/quant/share/abc123', false, null)?.title).toBe('Shared backtest result');
    expect(findRoom('/quant/share/abc123')?.path).toBe('/quant/share/:token');
  });

  it('opens nothing for a path that is not one token', () => {
    expect(quantRoute('/quant/share/abc/def', false, null)).toBeNull();
    expect(quantRoute('/quant/share/', false, null)).toBeNull();
  });
});
