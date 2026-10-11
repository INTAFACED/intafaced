import { expect, it } from 'vitest';
import { customerRoomHref, safeReturnTo, searchRooms } from './navigation';

it('returns a signed-in customer to a requested room, but refuses external and team redirects', () => {
  expect(safeReturnTo('/bank/spaces')).toBe('/bank/spaces');
  expect(safeReturnTo('//example.com')).toBe('/money');
  expect(safeReturnTo('/ops')).toBe('/money');
});

it('preserves the validated authenticated destination query and fragment, including fragment-only links', () => {
  for (const destination of [
    '/blueprint?section=owner#identity-profile',
    '/blueprint#identity-profile',
    '/bank/transfers?tab=history#original',
  ])
    expect(safeReturnTo(destination)).toBe(destination);
});

it('never attaches a refused destination fragment to the fallback or accepts external authority', () => {
  for (const destination of [
    'https://outside.invalid/blueprint#private',
    '//outside.invalid/blueprint#private',
    '/\t/outside.invalid/blueprint#private',
    '/\\outside.invalid/blueprint#private',
    'javascript:alert(1)#private',
    '/login?redirect=%2Fblueprint#private',
    '/register#private',
    '/ops#private',
    '/platform#private',
    '/chain#private',
    '/money/../ops#private',
    '/unknown-room#private',
  ])
    expect(safeReturnTo(destination)).toBe('/money');
});

it('keeps notification href shape and auth return room validation separate', () => {
  expect(customerRoomHref('/blueprint?section=owner#identity-profile')).toBe('/blueprint?section=owner');
  expect(customerRoomHref('/blueprint#identity-profile')).toBe('/blueprint');
  const destination = '/blueprint?next=https%3A%2F%2Foutside.invalid%2F#identity-profile';
  expect(safeReturnTo(destination)).toBe(destination);
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
