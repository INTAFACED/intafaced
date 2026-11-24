import type { VenueDepositRoute } from '../../protocol';

/** The venue door's status as the move reads it: its deposit route only when the door is on and the venue is up. */
type DoorStatus = { enabled: boolean; available?: boolean; deposit?: VenueDepositRoute | null };
type Read = { ok: true; data: DoorStatus } | { ok: false };

/** The deposit route a status publishes; null when the door is off, the venue is down or it names none. */
export function routeOf(status: DoorStatus | null | undefined): VenueDepositRoute | null {
  return status && status.enabled && status.available ? (status.deposit ?? null) : null;
}

/**
 * The route the wallet's deposit is sent to, read from the venue when the deposit starts (J-derivatives-25 #2): the
 * room's polled status can be older than the move (read before the venue was up, and read again only every 30 s), and
 * a move whose partner leg is already sent is never refused on that old read. A fresh read that fails falls back to the
 * polled route; a fresh read that names no route refuses, as the venue says.
 */
export async function depositRoute(polled: VenueDepositRoute | null, readNow: () => Promise<Read>): Promise<VenueDepositRoute | null> {
  const now = await readNow().catch((): Read => ({ ok: false }));
  return now.ok ? routeOf(now.data) : polled;
}
