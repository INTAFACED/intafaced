import { describe, expect, it } from 'vitest';
import { refuseUnsupportedPlacementOptions } from './placement-options.js';

const NOW = new Date('2026-10-20T12:00:00.000Z');

describe('create-body options spot does not act on', () => {
  it('passes a body that sets none', () => {
    expect(() => refuseUnsupportedPlacementOptions({}, NOW)).not.toThrow();
  });

  it('refuses a request deadline that has passed or is exactly now', () => {
    for (const requestDeadline of ['2026-10-20T11:59:59.000Z', NOW.toISOString()]) {
      expect(() => refuseUnsupportedPlacementOptions({ requestDeadline }, NOW)).toThrowError(
        expect.objectContaining({ code: 'trade.request_expired' }),
      );
    }
  });

  it('passes a deadline still in the future', () => {
    expect(() => refuseUnsupportedPlacementOptions({ requestDeadline: '2026-10-20T12:00:01.000Z' }, NOW)).not.toThrow();
  });

  it('refuses a self-trade mode the engine does not run, and passes the one it does', () => {
    expect(() => refuseUnsupportedPlacementOptions({ stpMode: 'cancel_both' }, NOW)).toThrowError(
      expect.objectContaining({ code: 'trade.stp_mode_unsupported' }),
    );
    expect(() => refuseUnsupportedPlacementOptions({ stpMode: 'cancel_taker' }, NOW)).toThrowError(
      expect.objectContaining({ code: 'trade.stp_mode_unsupported' }),
    );
    expect(() => refuseUnsupportedPlacementOptions({ stpMode: 'cancel_maker' }, NOW)).not.toThrow();
  });

  it('refuses a tag rather than dropping it', () => {
    expect(() => refuseUnsupportedPlacementOptions({ tag: 'desk-1' }, NOW)).toThrowError(
      expect.objectContaining({ code: 'trade.tag_unsupported' }),
    );
  });

  it('reports the expired deadline first', () => {
    expect(() => refuseUnsupportedPlacementOptions({ requestDeadline: '2026-10-20T11:00:00.000Z', tag: 'x' }, NOW)).toThrowError(
      expect.objectContaining({ code: 'trade.request_expired' }),
    );
  });
});
