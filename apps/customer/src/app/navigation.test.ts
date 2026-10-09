import { expect, it } from 'vitest';
import { customerRoomHref, safeReturnTo, searchRooms } from './navigation';

it('returns a signed-in customer to a requested room, but refuses external and team redirects', () => {
  expect(safeReturnTo('/bank/spaces')).toBe('/bank/spaces');
  expect(safeReturnTo('//example.com')).toBe('/money');
  expect(safeReturnTo('/ops')).toBe('/money');
});

it('keeps legitimate Money notification links and refuses non-customer destinations', () => {
  expect(customerRoomHref('/money')).toBe('/money');
  expect(customerRoomHref('/portfolio/BTC/repeat-buy')).toBe('/portfolio/BTC/repeat-buy');
  expect(customerRoomHref('/help')).toBe('/help');
  expect(customerRoomHref('/ops')).toBeUndefined();
  expect(customerRoomHref('//external.invalid')).toBeUndefined();
});

it('does not expose merchant, team or parked chain rooms in Personal search', () => {
  expect(searchRooms('', 'Personal').map((room) => room.path)).not.toContain('/pay/merchant');
  expect(searchRooms('chain', 'Personal')).toHaveLength(0);
  expect(searchRooms('operator', 'Personal')).toHaveLength(0);
});

it('finds translated and canonical room labels while preserving customer scope', () => {
  expect(searchRooms('transferencias', 'Personal', 'es').map((room) => room.path)).toContain('/bank/transfers');
  expect(searchRooms('transfers', 'Personal', 'es').map((room) => room.path)).toContain('/bank/transfers');
  expect(searchRooms('sécurité', 'Personal', 'fr').map((room) => room.path)).toContain('/uc/safe');
  expect(searchRooms('paiements entreprise', 'Personal', 'fr')).toHaveLength(0);
  expect(searchRooms('operador', 'Personal', 'es')).toHaveLength(0);
  expect(searchRooms('chaîne', 'Personal', 'fr')).toHaveLength(0);
});
