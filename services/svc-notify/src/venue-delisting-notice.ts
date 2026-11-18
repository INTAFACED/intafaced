import { isMessageKey } from '@intafaced/i18n';
import type { NotifyService } from './notify-service.js';

/**
 * One audience-all inbox notice when two operators schedule the date a venue market leaves INTAFACED's routed list
 * (J-cex-spot-16 #8, `trade.venue_delisting.created`). The notice is dated: it names the market and the day it goes,
 * and that after it new orders through INTAFACED refuse (closing ones and cancels still go).
 *
 * Filed under the event's own business key (`venue-delisting:<venueId>:<symbol>:<delistsAt>`), so a republish or a
 * redelivery writes no second row. The venue id stays in the key only: customer copy names no partner or venue.
 */

export const VENUE_DELISTING_SUBJECT = 'intafaced.trade.venue_delisting.created';
export const VENUE_DELISTING_KIND = 'trade.venue_delisting';
export const VENUE_DELISTING_KEYS = {
  title: 'notify.trade.venue_delisting.title',
  body: 'notify.trade.venue_delisting.body',
} as const;
export const VENUE_DELISTING_COPY_UNSET = 'notify.venue_delisting_copy_unset' as const;

/** The copy keys are not in the catalog: nothing is written, and the event is redelivered. */
export class VenueDelistingCopyUnsetError extends Error {
  readonly code = VENUE_DELISTING_COPY_UNSET;
  constructor(readonly keys: readonly string[]) {
    super(`${VENUE_DELISTING_COPY_UNSET}: ${keys.join(', ')}`);
    this.name = 'VenueDelistingCopyUnsetError';
  }
}

export interface VenueDelisting {
  readonly symbol: string;
  readonly delistsAt: string;
  readonly noticeKey: string;
}

export async function noticeVenueDelisting(
  notify: NotifyService,
  delisting: VenueDelisting,
  hasCopy: (key: string) => boolean = isMessageKey,
): Promise<{ inserted: boolean }> {
  const missing = [VENUE_DELISTING_KEYS.title, VENUE_DELISTING_KEYS.body].filter((k) => !hasCopy(k));
  if (missing.length > 0) throw new VenueDelistingCopyUnsetError(missing);
  return notify.createSystemNotice({
    kind: VENUE_DELISTING_KIND,
    titleKey: VENUE_DELISTING_KEYS.title,
    bodyKey: VENUE_DELISTING_KEYS.body,
    params: { symbol: delisting.symbol, delistsAt: delisting.delistsAt },
    href: null,
    severity: 'action',
    sourceSubject: VENUE_DELISTING_SUBJECT,
    sourceIdempotencyKey: delisting.noticeKey,
  });
}
