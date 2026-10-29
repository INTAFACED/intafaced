/**
 * The queue's filter, search and saved view, as the page address carries them (SP-desk-01).
 *
 * `?filter=<field>:<value>` is one clause, `?q=<words>` searches subject, body and requester, `?view=<id>` opens a
 * saved view. The field is sent to svc-support as it was typed: svc-support decides which fields exist and refuses
 * any other by `support.filter_invalid`, so the console never keeps its own list of what is allowed. Pure.
 */

/** The fields offered in the picker. A field not listed here can still be typed in the address; svc-support judges it. */
export const FILTER_FIELDS = [
  { id: 'category', label: 'Category' },
  { id: 'status', label: 'Status' },
  { id: 'priority', label: 'Priority' },
  { id: 'type', label: 'Type' },
  { id: 'labels', label: 'Label' },
  { id: 'waiting_on', label: 'Waiting on' },
] as const;

export interface FilterClause {
  readonly field: string;
  readonly op: 'eq';
  readonly value: string;
}

export interface QueueQuery {
  readonly filter: FilterClause | null;
  readonly q: string;
  readonly viewId: string | null;
}

export const EMPTY_QUERY: QueueQuery = { filter: null, q: '', viewId: null };

const FIELD_RE = /^[a-z_]{1,40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Q_MAX = 200;
const VALUE_MAX = 200;

/** One `field:value` clause, or null when the text is not one. */
export function parseFilterText(text: string | null | undefined): FilterClause | null {
  if (typeof text !== 'string') return null;
  const at = text.indexOf(':');
  if (at <= 0) return null;
  const field = text.slice(0, at).trim().toLowerCase();
  const value = text.slice(at + 1).trim();
  if (!FIELD_RE.test(field) || value === '' || value.length > VALUE_MAX) return null;
  return { field, op: 'eq', value };
}

type Params = { get(name: string): string | null } | Record<string, string | string[] | undefined>;

function read(params: Params, name: string): string | null {
  if (typeof (params as { get?: unknown }).get === 'function') return (params as { get(n: string): string | null }).get(name);
  const raw = (params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(raw) ? (raw[0] ?? null) : (raw ?? null);
}

/** The query in a page address or a BFF request. Anything unreadable is left out, never guessed. */
export function readQueueQuery(params: Params): QueueQuery {
  const q = (read(params, 'q') ?? '').trim().slice(0, Q_MAX);
  const view = read(params, 'view');
  return { filter: parseFilterText(read(params, 'filter')), q, viewId: view !== null && UUID.test(view) ? view : null };
}

/** The address part for a query, without the leading `?`; empty for the plain queue. */
export function queueQueryString(query: QueueQuery): string {
  const out = new URLSearchParams();
  if (query.viewId) out.set('view', query.viewId);
  if (query.filter) out.set('filter', `${query.filter.field}:${query.filter.value}`);
  if (query.q) out.set('q', query.q);
  return out.toString();
}

export const isQueryEmpty = (query: QueueQuery): boolean => !query.filter && !query.q && !query.viewId;

/** A saved view's filter as one clause the picker can show, or null when it is a tree the picker cannot draw. */
export function clauseOf(filter: unknown): FilterClause | null {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null;
  const f = filter as Record<string, unknown>;
  if (typeof f.field !== 'string' || f.op !== 'eq' || typeof f.value !== 'string') return null;
  return { field: f.field, op: 'eq', value: f.value };
}
