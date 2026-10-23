import { SERVER_TIME_PROCEDURE, TOTP_STEP_SECONDS, serverTimeSchema, type ServerTime } from '@intafaced/contracts/identity';

export { SERVER_TIME_PROCEDURE, serverTimeSchema, type ServerTime };

/** A device clock this far from ours, either way, can make codes fail near the change of a code: half a code's life. */
export const DRIFT_LIMIT_SECONDS = TOTP_STEP_SECONDS / 2;

/**
 * How far this device's clock is from the service's, in whole seconds (positive: the device is ahead). The service's time
 * is read at about the middle of the round trip, so the device time compared is the middle of sent and received.
 */
export function clockDriftSeconds(serverNow: string, sentAtMs: number, receivedAtMs: number): number {
  const server = Date.parse(serverNow);
  if (!Number.isFinite(server)) throw new Error('server time unreadable');
  return Math.round((sentAtMs + receivedAtMs) / 2 / 1000 - server / 1000);
}

export type ClockVerdict =
  { readonly kind: 'ahead' | 'behind'; readonly seconds: number } | { readonly kind: 'in-sync'; readonly seconds: number };

export function clockVerdict(drift: number): ClockVerdict {
  const seconds = Math.abs(drift);
  if (seconds < DRIFT_LIMIT_SECONDS) return { kind: 'in-sync', seconds };
  return { kind: drift > 0 ? 'ahead' : 'behind', seconds };
}
