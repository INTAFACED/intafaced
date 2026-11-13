/**
 * The outside assistant connections desk (`/more-ops/agents`, J-agents-21 #15; AG-outside-04, AG-control-02): what the
 * desk's one API route accepts. Shared by the page and the route; holds no data.
 */

export type OutsideAction =
  | { readonly action: 'connections' }
  | { readonly action: 'audit' }
  | { readonly action: 'quarantine'; readonly keyId: string; readonly reason: string | null; readonly requestId: string };

/** identity's operator revoke takes a request id of at most 128 characters; svc-trade's desk takes the same id. */
const REQUEST_ID = /^[A-Za-z0-9:_-]{8,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The route's body, checked field by field. A missing reason is passed on, so the services refuse it by their own code. */
export function parseOutsideAction(body: unknown): OutsideAction | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.action === 'connections') return { action: 'connections' };
  if (b.action === 'audit') return { action: 'audit' };
  if (b.action !== 'quarantine') return null;
  const keyId = typeof b.keyId === 'string' && UUID.test(b.keyId) ? b.keyId.toLowerCase() : null;
  const requestId = typeof b.requestId === 'string' && REQUEST_ID.test(b.requestId) ? b.requestId : null;
  if (!keyId || !requestId) return null;
  const reason = typeof b.reason === 'string' && b.reason.trim() !== '' && b.reason.length <= 500 ? b.reason.trim() : null;
  return { action: 'quarantine', keyId, reason, requestId };
}
