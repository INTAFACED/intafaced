import { doorLabel, roomDescription, roomTitle, rooms, type Door, type Room } from '../../app/navigation';
import type { UiLocale } from '../../shared/i18n';

export interface CatalogueEntry {
  path: string;
  title: string;
  description: string;
}

const SIGNED_IN_AREAS: ReadonlySet<Room['area']> = new Set(['money', 'trade', 'pay', 'more']);

/**
 * The rooms behind one door, read from the app's own room list, so the landing and About pages describe what exists and never
 * a hand-written list that drifts. Aliases, detail pages, business-only rooms and anything outside the four doors are left out.
 */
export function roomsForDoor(door: PublicDoor, locale?: UiLocale): CatalogueEntry[] {
  const seen = new Set<string>();
  const entries: CatalogueEntry[] = [];
  for (const room of rooms) {
    if (room.door !== door || room.alias || room.hidden || room.business || !SIGNED_IN_AREAS.has(room.area)) continue;
    if (seen.has(room.path)) continue;
    seen.add(room.path);
    entries.push({ path: room.path, title: roomTitle(room, locale), description: roomDescription(room, locale) });
  }
  return entries;
}

/** The public pages group rooms by the app's own doors, Home aside. */
export type PublicDoor = Exclude<Door, 'Home'>;
export const DOOR_ORDER = ['Money', 'Trade', 'Pay', 'More'] as const satisfies readonly PublicDoor[];

export interface DoorSummary {
  door: PublicDoor;
  label: string;
  count: number;
  entries: CatalogueEntry[];
}

export function doorSummaries(locale?: UiLocale): DoorSummary[] {
  return DOOR_ORDER.map((door) => {
    const entries = roomsForDoor(door, locale);
    return { door, label: doorLabel(door, locale), count: entries.length, entries };
  });
}
