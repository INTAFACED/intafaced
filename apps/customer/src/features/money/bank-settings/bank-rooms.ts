/** The bank's rooms, in the order the bank's navigation shows them, and each one's name in the money copy. */
export const bankRooms = ['Overview', 'Spaces', 'Transfers', 'Earn', 'Loans', 'Cards', 'Ramps', 'Analytics', 'Business'] as const;
export type BankRoom = (typeof bankRooms)[number];
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
/** Each bank room's address. */
export const bankRoomHref = (room: BankRoom) => (room === 'Overview' ? '/bank' : `/bank/${room.toLowerCase()}`);
