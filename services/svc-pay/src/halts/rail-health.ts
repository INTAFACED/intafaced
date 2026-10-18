/**
 * Which rail results may feed auto-trip.
 *
 * Only the rail being unhealthy counts: it is down, it timed out, it returned
 * a server error, or it refused the platform's own credentials. A destination
 * or customer result (a declined card, a bad address, not enough at the
 * destination) is ordinary traffic and must not halt payouts.
 *
 * An adapter throw is not a code. Callers count that separately. This function
 * never moves money.
 */
const CUSTOMER_CODES = new Set([
  'card.declined',
  'card.expired',
  'card.invalid',
  'card.stolen',
  'bank.rejected',
  'invalid_address',
  'destination.invalid',
  'destination.invalid_address',
  'address.invalid',
  'destination.insufficient',
  'insufficient_funds',
]);

export function isRailHealthFailureCode(code: string | null | undefined): boolean {
  if (code == null) return false;
  const normalized = code.trim().toLowerCase();
  if (normalized === '') return false;
  if (CUSTOMER_CODES.has(normalized)) return false;
  if (normalized.includes('declin')) return false;
  if (normalized.includes('address')) return false;
  if (normalized.includes('insufficient')) return false;
  if (normalized.includes('destination')) return false;
  // Chain payment results (underpaid, wrong asset, confirmations) describe the
  // transfer, not a rail that has stopped answering.
  if (normalized.startsWith('chain.')) return false;
  if (
    normalized === 'rail.down' ||
    normalized === 'rail.unavailable' ||
    normalized === 'rail.timeout' ||
    normalized === 'rail.auth_failed' ||
    normalized === 'rail.health_stale' ||
    normalized === 'rail.probe_failed' ||
    normalized === 'rail.marked_down' ||
    normalized === 'acquirer.unavailable'
  ) {
    return true;
  }
  if (normalized.includes('unavailable')) return true;
  if (normalized.includes('timeout') || normalized.includes('timedout') || normalized.includes('timed_out')) return true;
  if (/^5\d\d$/.test(normalized) || normalized.includes('5xx') || /(?:^|[._-])5\d\d(?:$|[._-])/.test(normalized)) return true;
  if (normalized.includes('auth') && (normalized.includes('fail') || normalized.includes('denied') || normalized.includes('unauthor'))) {
    return true;
  }
  return false;
}
