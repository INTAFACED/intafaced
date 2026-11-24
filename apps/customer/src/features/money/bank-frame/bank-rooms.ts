import { isHiddenPath } from '../../../app/feature-registry';

/** The Bank's nine rooms, in the order its navigation lists them, with the copy key of each one's name. */
export const bankRooms = ['Overview', 'Spaces', 'Transfers', 'Earn', 'Loans', 'Cards', 'Ramps', 'Analytics', 'Business'] as const;
export const bankLabels = {
  Overview: 'nav.overview',
  Spaces: 'nav.spaces',
  Transfers: 'nav.transfers',
  Earn: 'nav.earn',
  Loans: 'nav.loans',
  Cards: 'nav.cards',
  Ramps: 'nav.ramps',
  Analytics: 'nav.analytics',
  Business: 'nav.business',
} as const;
export const bankRoomHref = (room: (typeof bankRooms)[number]) => (room === 'Overview' ? '/bank' : `/bank/${room.toLowerCase()}`);
/** The Bank's rooms its navigation shows: the open one, and each other one the build's menus keep (app/beta-volt.ts). */
export const shownBankRooms = (current?: string) => bankRooms.filter((room) => room === current || !isHiddenPath(bankRoomHref(room)));
