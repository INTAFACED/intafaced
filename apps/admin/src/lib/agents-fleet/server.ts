import 'server-only';
import { founderCall, type FounderCallContext } from '@/lib/desk/founder-call';
import { refusalOf, resolveCustomer } from '@/lib/agents-log/server';
import { customerReference } from '@/lib/agents-log/model';
import type { FleetAction } from './model';

/**
 * The agent fleet desk's hops (AG-registry-01, AG-control-02), always as the signed-in founder through svc-edge:
 * svc-agents reads the registry and runs each switch, writing its own audit row; identity names the accounts the page
 * shows (owners, publishers and the operators who set a switch) by handle, in one audited lookup per read. Nothing is
 * cached or kept here.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const nullableString = (v: unknown): boolean => v === null || isString(v);

const isSwitch = (v: unknown): boolean =>
  v === null || (isObject(v) && isString(v.reason) && isString(v.setBy) && isString(v.setAt) && nullableString(v.restoreRequestedBy));

const isRow = (v: unknown): boolean =>
  isObject(v) &&
  isString(v.ref) &&
  nullableString(v.name) &&
  isString(v.kind) &&
  nullableString(v.ownerId) &&
  nullableString(v.publisherId) &&
  (v.channels === null || (Array.isArray(v.channels) && v.channels.every(isString))) &&
  Array.isArray(v.riskSignals) &&
  v.riskSignals.every(isString) &&
  isString(v.status) &&
  nullableString(v.lastRunAt) &&
  isSwitch(v.quarantine) &&
  isSwitch(v.kindSwitch);

const parseRegistry = (raw: unknown): Json | null =>
  isObject(raw) && isObject(raw.counts) && Array.isArray(raw.rows) && raw.rows.every(isRow) && isInt(raw.filtered) && isInt(raw.limit)
    ? raw
    : null;
const parseExport = (raw: unknown): Json | null =>
  isObject(raw) && isString(raw.csv) && isInt(raw.rows) && isInt(raw.auditRows) ? raw : null;
const parseAny = (raw: unknown): Json | null => (isObject(raw) ? raw : null);
const parseHandles = (raw: unknown): { id: string; handle: string }[] | null =>
  isObject(raw) && Array.isArray(raw.rows) && raw.rows.every((r) => isObject(r) && isString(r.id) && isString(r.handle))
    ? (raw.rows as { id: string; handle: string }[])
    : null;

export type FleetAnswer =
  { readonly kind: 'ok'; readonly data: unknown } | { readonly kind: 'refused'; readonly code: string; readonly status: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identity takes at most this many ids in one lookup. */
const HANDLES_CAP = 200;

/** The handles of the accounts a registry page names. An id identity does not answer for stays an id on the page. */
async function handlesFor(ctx: FounderCallContext, rows: readonly Json[]): Promise<Record<string, string> | FleetAnswer> {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const id of [row.ownerId, row.publisherId]) if (isString(id) && UUID.test(id)) ids.add(id.toLowerCase());
    for (const sw of [row.quarantine, row.kindSwitch])
      if (isObject(sw)) for (const id of [sw.setBy, sw.restoreRequestedBy]) if (isString(id) && UUID.test(id)) ids.add(id.toLowerCase());
  }
  const all = [...ids];
  const handles: Record<string, string> = {};
  for (let at = 0; at < all.length; at += HANDLES_CAP) {
    const result = await founderCall(
      ctx,
      'identity',
      'accountDirectory.handles',
      'GET',
      { ids: all.slice(at, at + HANDLES_CAP) },
      parseHandles,
    );
    if (result.kind !== 'ok') return refusalOf(result);
    for (const row of result.data) handles[row.id.toLowerCase()] = row.handle;
  }
  return handles;
}

const filterOf = (action: Extract<FleetAction, { action: 'registry' | 'export' }>) => ({
  ...(action.riskSignal ? { riskSignal: action.riskSignal } : {}),
});

/** One desk action as the founder. A refusal keeps the service's code. */
export async function runFleet(ctx: FounderCallContext, action: FleetAction): Promise<FleetAnswer> {
  switch (action.action) {
    case 'registry': {
      const result = await founderCall(ctx, 'agents', 'fleet.registry', 'GET', filterOf(action), parseRegistry);
      if (result.kind !== 'ok') return refusalOf(result);
      const handles = await handlesFor(ctx, result.data.rows as Json[]);
      if ('kind' in handles && (handles.kind === 'refused' || handles.kind === 'ok')) return handles as FleetAnswer;
      return { kind: 'ok', data: { ...result.data, handles, me: ctx.session.userId.toLowerCase() } };
    }
    case 'export': {
      const result = await founderCall(
        ctx,
        'agents',
        'fleet.export',
        'POST',
        { ...filterOf(action), requestId: action.requestId },
        parseExport,
      );
      return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
    }
    case 'quarantine': {
      const input = { ref: action.ref, requestId: action.requestId, ...(action.reason ? { reason: action.reason } : {}) };
      const result = await founderCall(ctx, 'agents', 'fleet.quarantine', 'POST', input, parseAny);
      return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
    }
    case 'restore': {
      const result = await founderCall(ctx, 'agents', 'fleet.restore', 'POST', { ref: action.ref, requestId: action.requestId }, parseAny);
      return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
    }
    case 'killKind': {
      const input = { kind: action.kind, requestId: action.requestId, ...(action.reason ? { reason: action.reason } : {}) };
      const result = await founderCall(ctx, 'agents', 'fleet.killKind', 'POST', input, parseAny);
      return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
    }
    case 'restoreKind': {
      const result = await founderCall(
        ctx,
        'agents',
        'fleet.restoreKind',
        'POST',
        { kind: action.kind, requestId: action.requestId },
        parseAny,
      );
      return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
    }
    case 'reassign': {
      const ref = customerReference(action.owner);
      if ('error' in ref) return { kind: 'refused', code: 'admin.agents_log_customer_invalid', status: 400 };
      const owner = await resolveCustomer(ctx, ref);
      if (owner.kind !== 'ok') return owner;
      const input = { ref: action.ref, ownerId: owner.userId, requestId: action.requestId };
      const result = await founderCall(ctx, 'agents', 'fleet.reassign', 'POST', input, parseAny);
      return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
    }
  }
}
