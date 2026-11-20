import { VenueRefusalError, isTestVenue, type UserVenue } from '@intafaced/venue-contracts';

/**
 * OUR BUILDER ADDRESS'S ACCOUNT MODE AT EACH VENUE (J-ops-console-28). A venue accrues builder fees only to a builder
 * address in the mode it requires (Hyperliquid: "Builder code addresses must be in standard mode to accrue builder
 * fees"), so our builder fees (J-derivatives-28) stop without a sound when the address leaves it. Each check reads the
 * mode at every venue an order can be routed to and, while the address is out of the required mode, holds one open
 * alert per venue to the owner's named contact: opened once however many checks see it, cleared with the time once a
 * check reads the required mode again. A mode that can't be read, or a venue that publishes no required mode, opens
 * nothing and clears nothing. Read only: nothing here moves money.
 */

export type BuilderModeRead =
  | { readonly status: 'read'; readonly mode: string; readonly asOf: Date }
  | { readonly status: 'unknown'; readonly code: string; readonly message: string };

export type BuilderModeRequired =
  | { readonly status: 'published'; readonly mode: string }
  | { readonly status: 'not_published' }
  /** The read failed, so what the venue requires was not read either. */
  | { readonly status: 'unknown' };

export type BuilderModeVerdict = 'required_mode' | 'not_collected' | 'not_published' | 'unknown';

export interface BuilderModeVenue {
  readonly venueId: string;
  readonly displayName: string | null;
  readonly test: boolean;
  readonly builder: string;
  readonly mode: BuilderModeRead;
  readonly required: BuilderModeRequired;
  readonly verdict: BuilderModeVerdict;
}

export interface BuilderModeAlert {
  readonly id: string;
  readonly venueId: string;
  readonly builder: string;
  readonly modeSeen: string;
  readonly requiredMode: string;
  readonly contact: string;
  readonly openedAt: Date;
  readonly clearedAt: Date | null;
  readonly clearedMode: string | null;
}

export const ALERT_CONTACT_UNSET = 'trade.builder_mode_alert_contact_unset' as const;

export type BuilderModeAlerting =
  | { readonly status: 'on'; readonly contact: string }
  | { readonly status: 'refused'; readonly code: typeof ALERT_CONTACT_UNSET; readonly message: string };

/**
 * One episode per venue and builder address: `open` inserts it unless one is open (a crash or a concurrent check
 * between read and write opens nothing twice) and answers the row only when this call opened it; `clear` closes the
 * open one, if any, and answers it only when this call cleared it.
 */
export interface BuilderModeAlertStore {
  open(alert: {
    venueId: string;
    builder: string;
    modeSeen: string;
    requiredMode: string;
    contact: string;
    at: Date;
  }): Promise<BuilderModeAlert | null>;
  clear(alert: { venueId: string; builder: string; mode: string; at: Date }): Promise<BuilderModeAlert | null>;
  recent(limit: number): Promise<readonly BuilderModeAlert[]>;
}

export interface BuilderModeDoor {
  venue(): Promise<UserVenue>;
  readonly connectedVenueId: string | null;
}

export interface BuilderModeDeps {
  readonly doors: readonly BuilderModeDoor[];
  /** Our builder address, lowercase, or null while the owner's value is blank. */
  readonly builder: string | null;
  /** The owner's named contact for the alert, or null while it is blank. */
  readonly contact: string | null;
  readonly store: BuilderModeAlertStore;
  readonly onOpened: (alert: BuilderModeAlert) => void;
  readonly onCleared: (alert: BuilderModeAlert) => void;
  readonly now: () => Date;
}

export class BuilderModeError extends Error {
  constructor(
    readonly code: 'trade.user_venue_off' | 'trade.builder_address_unset',
    message: string,
  ) {
    super(message);
    this.name = 'BuilderModeError';
  }
}

export interface BuilderModeCheck {
  readonly builder: string;
  readonly venues: readonly BuilderModeVenue[];
  readonly alerting: BuilderModeAlerting;
}

/** The verdict of one read: a mode that wasn't read is unknown whatever the venue requires. */
export function verdictOf(mode: BuilderModeRead, required: BuilderModeRequired): BuilderModeVerdict {
  if (mode.status === 'unknown' || required.status === 'unknown') return 'unknown';
  if (required.status === 'not_published') return 'not_published';
  return mode.mode === required.mode ? 'required_mode' : 'not_collected';
}

async function readVenue(door: BuilderModeDoor, builder: string): Promise<BuilderModeVenue> {
  let venue: UserVenue;
  try {
    venue = await door.venue();
  } catch (err) {
    return unknownRow({ venueId: door.connectedVenueId ?? 'unreachable', displayName: null, test: false, builder }, err);
  }
  const { id, displayName } = venue.venue;
  const test = isTestVenue(venue.venue);
  const read = venue.builderAccountMode?.bind(venue);
  if (!read) {
    const mode = {
      status: 'unknown',
      code: 'trade.builder_mode_not_read',
      message: 'This venue adapter does not read the account mode',
    } as const;
    return { venueId: id, displayName, test, builder, mode, required: { status: 'unknown' }, verdict: 'unknown' };
  }
  try {
    const answer = await read(builder);
    const mode: BuilderModeRead = answer.value.mode.known
      ? { status: 'read', mode: answer.value.mode.value, asOf: answer.asOf }
      : { status: 'unknown', code: 'trade.builder_mode_not_reported', message: 'The venue did not report the account mode' };
    const required: BuilderModeRequired = answer.value.required.known
      ? { status: 'published', mode: answer.value.required.value }
      : { status: 'not_published' };
    return { venueId: id, displayName, test, builder, mode, required, verdict: verdictOf(mode, required) };
  } catch (err) {
    return unknownRow({ venueId: id, displayName, test, builder }, err);
  }
}

function unknownRow(venue: Pick<BuilderModeVenue, 'venueId' | 'displayName' | 'test' | 'builder'>, err: unknown): BuilderModeVenue {
  const code = err instanceof VenueRefusalError ? err.refusal.code : 'venue_unreadable';
  const message = err instanceof Error ? err.message : String(err);
  return { ...venue, mode: { status: 'unknown', code, message }, required: { status: 'unknown' }, verdict: 'unknown' };
}

/**
 * One check: every venue's mode read, and each venue's alert opened or cleared from what was read. The venues are read
 * one by one; a venue that can't be read is its own unknown row and leaves the others checked.
 */
export async function checkBuilderModes(deps: BuilderModeDeps): Promise<BuilderModeCheck> {
  if (deps.doors.length === 0) throw new BuilderModeError('trade.user_venue_off', 'the user-venue door is off on this deployment');
  if (deps.builder === null) throw new BuilderModeError('trade.builder_address_unset', 'our builder address is not set');
  const builder = deps.builder;
  const alerting: BuilderModeAlerting =
    deps.contact === null
      ? { status: 'refused', code: ALERT_CONTACT_UNSET, message: 'No alert contact is named, so no alert is sent' }
      : { status: 'on', contact: deps.contact };
  const venues: BuilderModeVenue[] = [];
  for (const door of deps.doors) {
    const row = await readVenue(door, builder);
    venues.push(row);
    const at = deps.now();
    if (row.verdict === 'not_collected' && alerting.status === 'on' && row.mode.status === 'read' && row.required.status === 'published') {
      const opened = await deps.store.open({
        venueId: row.venueId,
        builder,
        modeSeen: row.mode.mode,
        requiredMode: row.required.mode,
        contact: alerting.contact,
        at,
      });
      if (opened) deps.onOpened(opened);
    } else if (row.verdict === 'required_mode' && row.mode.status === 'read') {
      const cleared = await deps.store.clear({ venueId: row.venueId, builder, mode: row.mode.mode, at });
      if (cleared) deps.onCleared(cleared);
    }
  }
  return { builder, venues, alerting };
}

/** The owner's named contact: blank is not set. */
export function parseAlertContact(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  return v === '' ? null : v;
}
