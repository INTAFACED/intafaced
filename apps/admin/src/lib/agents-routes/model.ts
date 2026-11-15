/**
 * The model routing table's desk on More modules (J-agents-20; AG-usage-02, RC-agents-05): what the page sends and
 * what the desk's one API route accepts. Shared by the page and the route; holds no data.
 */

export type RoutesAction =
  | { readonly action: 'desk' }
  | {
      readonly action: 'propose';
      readonly task: string;
      readonly maxOutputTokens: number;
      readonly inputPerMillion: string | null;
      readonly outputPerMillion: string | null;
      readonly requestId: string;
    }
  | { readonly action: 'withdraw'; readonly changeId: string }
  | { readonly action: 'confirm'; readonly changeId: string };

const REQUEST_ID = /^[A-Za-z0-9:_-]{8,200}$/;
const TASK = /^[A-Za-z0-9._-]{1,120}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A rate as typed: an unsigned decimal. Blank is "not set", passed on as null. */
const RATE = /^\d{1,20}(\.\d{1,18})?$/;

/** A typed rate: null for blank, the string for a decimal, undefined for anything else. */
export function rateOf(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (v === '') return null;
  return RATE.test(v) ? v : undefined;
}

/** The route's body, checked field by field; the service holds every rule beyond the shape. */
export function parseRoutesAction(body: unknown): RoutesAction | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  switch (b.action) {
    case 'desk':
      return { action: 'desk' };
    case 'propose': {
      const input = rateOf(b.inputPerMillion);
      const output = rateOf(b.outputPerMillion);
      if (typeof b.task !== 'string' || !TASK.test(b.task)) return null;
      if (typeof b.requestId !== 'string' || !REQUEST_ID.test(b.requestId)) return null;
      if (!Number.isInteger(b.maxOutputTokens)) return null;
      if (input === undefined || output === undefined) return null;
      return {
        action: 'propose',
        task: b.task,
        maxOutputTokens: b.maxOutputTokens as number,
        inputPerMillion: input,
        outputPerMillion: output,
        requestId: b.requestId,
      };
    }
    case 'withdraw':
    case 'confirm':
      return typeof b.changeId === 'string' && UUID.test(b.changeId) ? { action: b.action, changeId: b.changeId } : null;
    default:
      return null;
  }
}

/** The service's refusals in words. */
export const ROUTE_WORDS: Record<string, string> = {
  'agents.route_not_found': 'svc-agents serves no such task.',
  'agents.route_change_invalid': 'The ceiling must be a whole number from 1 to 1,000,000, and the rates both set or both blank.',
  'agents.route_change_unchanged': 'This is the route as it stands. Nothing was asked.',
  'agents.route_change_pending': 'A change of this route already waits for a second founder.',
  'agents.route_change_not_found': 'svc-agents has no such change.',
  'agents.route_change_not_pending': 'This change was already decided.',
  'agents.route_change_same_founder': 'You asked for this change. A second founder confirms it.',
  'agents.route_change_not_yours': 'Only the founder who asked for this change may withdraw it.',
  'agents.route_change_request_reused': 'This request was already used for another change. Try again.',
  'agents.route_change_person_only': 'Only a founder signed in in person may change a route.',
  'agents.capability_unavailable': 'svc-agents has no database for route changes here.',
  'admin.agents_routes_input': 'The form was not complete.',
};
export const routeSay = (code: string): string => `${ROUTE_WORDS[code] ?? 'The service refused this.'} (${code})`;
