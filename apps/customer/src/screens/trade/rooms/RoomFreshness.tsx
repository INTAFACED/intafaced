/**
 * The freshness chip of a polled room region. It stays on the old kit's chip: the Volt kit's
 * Freshness has no Refused state, which these rooms show when the service said no.
 */
import { StatusChip } from './ui';
import { STALE_AFTER_MS } from './read';

/** Freshness of a polled region. `asOf` null means no good answer (unknown), `refused` means the service said no. */
export function Freshness({ asOf, refused = false, now }: { asOf: number | null; refused?: boolean; now?: number }) {
  return <StatusChip asOf={asOf} refused={refused} staleAfterMs={STALE_AFTER_MS} now={now} showAsOf={asOf !== null} />;
}
