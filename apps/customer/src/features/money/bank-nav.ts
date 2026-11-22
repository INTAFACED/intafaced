import { copy } from './copy';

/**
 * The bank's rooms, in the order the bank's room row shows them, with their labels. `BankNavigation` in rooms.tsx
 * draws them for the rooms not in Volt; a room in Volt draws the same links with the kit's Tabs (volt/flow, #9570).
 */
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
export const bankRoomHref = (room: BankRoom) => (room === 'Overview' ? '/bank' : `/bank/${room.toLowerCase()}`);

/** The room row's links, the label of the row, and the href of the open room, for the kit's Tabs. */
export function useBankNav(current: string) {
  const { t } = copy.useCopy();
  return {
    label: t('rooms.bank.rooms'),
    items: bankRooms.map((room) => ({ label: t(bankLabels[room]), href: bankRoomHref(room) })),
    current: (bankRooms as readonly string[]).includes(current) ? bankRoomHref(current as BankRoom) : '',
    /** The bank's name above the room title, and the way back to the overview. */
    eyebrow: t('rooms.money.bank'),
    overview: t('rooms.bank.overview'),
  };
}
