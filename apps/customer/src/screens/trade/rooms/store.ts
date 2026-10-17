/**
 * Ids this browser created or opened, kept per signed-in user. The service publishes no list of a person's algo
 * schedules or RFQ quotes (TROPT-BACKEND-NEEDS ALG-1, OTC-1), so the rooms remember the ids they know and re-read
 * every one from the service before showing it. A stored id is a pointer, never a claim about state.
 */
import { z } from 'zod';

export type RoomKind = 'algo' | 'rfq' | 'scaled';
const MAX_KEPT = 50;
const listSchema = z.array(z.string().min(1).max(120));
const keyOf = (kind: RoomKind, userId: string) => `trade-room-ids:${kind}:${userId}`;

export function readIds(kind: RoomKind, userId: string | null): string[] {
  if (!userId) return [];
  try {
    const parsed = listSchema.safeParse(JSON.parse(localStorage.getItem(keyOf(kind, userId)) ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Newest first, no duplicates, bounded. Returns false when the device refuses to store (the caller says so). */
export function rememberId(kind: RoomKind, userId: string | null, id: string): boolean {
  if (!userId) return false;
  try {
    const next = [id, ...readIds(kind, userId).filter((known) => known !== id)].slice(0, MAX_KEPT);
    localStorage.setItem(keyOf(kind, userId), JSON.stringify(next));
    window.dispatchEvent(new Event('trade-room-ids-change'));
    return true;
  } catch {
    return false;
  }
}

export function forgetId(kind: RoomKind, userId: string | null, id: string): void {
  if (!userId) return;
  try {
    localStorage.setItem(keyOf(kind, userId), JSON.stringify(readIds(kind, userId).filter((known) => known !== id)));
    window.dispatchEvent(new Event('trade-room-ids-change'));
  } catch {
    /* nothing stored, nothing to forget */
  }
}
