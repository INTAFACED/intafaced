import { expect, it } from 'vitest';
import { safeReturnTo, searchRooms } from './navigation';

it('returns a signed-in customer to a requested room, but refuses external and team redirects', () => {
  expect(safeReturnTo('/bank/spaces')).toBe('/bank/spaces');
  expect(safeReturnTo('//example.com')).toBe('/money');
  expect(safeReturnTo('/ops')).toBe('/money');
});

it('does not expose merchant, team or parked chain rooms in Personal search', () => {
  expect(searchRooms('', 'Personal').map((room) => room.path)).not.toContain('/pay/merchant');
  expect(searchRooms('chain', 'Personal')).toHaveLength(0);
  expect(searchRooms('operator', 'Personal')).toHaveLength(0);
});
