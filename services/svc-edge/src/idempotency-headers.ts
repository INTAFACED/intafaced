/**
 * The two idempotency answers svc-trade's user-venue door gives an order sent with an `Idempotency-Key` (J-developer-05;
 * services/svc-trade/src/venue/user-venue-rest.ts), passed through on the venue door's own paths only. Edge forwards an
 * allowlist of upstream response headers (README "Response headers are an allowlist"):
 *
 *   · `idempotent-replayed: true` — this is the stored answer of an earlier request with the same key; nothing new was
 *     placed. Only the literal `true` passes.
 *   · `retry-after` — on `409 idempotency.in_progress`, how many whole seconds to wait before retrying the same key. Only
 *     a whole number of seconds passes.
 */
export const VENUE_DOOR_PREFIX = '/api/v1/venue/';

export function idempotencyHeaders(pathname: string, upstream: { get(name: string): string | null }): Record<string, string> {
  if (!pathname.startsWith(VENUE_DOOR_PREFIX)) return {};
  const out: Record<string, string> = {};
  if (upstream.get('idempotent-replayed') === 'true') out['idempotent-replayed'] = 'true';
  const retry = upstream.get('retry-after');
  if (retry !== null && /^\d{1,4}$/.test(retry)) out['retry-after'] = retry;
  return out;
}
