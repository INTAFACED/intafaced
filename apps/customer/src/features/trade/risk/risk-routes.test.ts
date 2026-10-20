import { describe, expect, it } from 'vitest';
import { findRoom, searchRooms } from '../../../app/navigation';

describe('risk control address', () => {
  it('is a Trade room that search finds, with no screen of its own and never hidden', () => {
    const room = findRoom('/trade/risk');
    expect(room?.path).toBe('/trade/risk');
    expect(room?.door).toBe('Trade');
    expect(room?.screen).toBeUndefined();
    expect(room?.hidden).not.toBe(true);
    expect(searchRooms('risk control', 'Personal').map((entry) => entry.path)).toContain('/trade/risk');
  });
});
