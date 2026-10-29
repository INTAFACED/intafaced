import 'server-only';
import { founderCall, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { customerReference, OUTCOMES, type AgentsLogAction, type CustomerReference } from './model';

/**
 * The agent action log desk's hops, always as the signed-in founder through svc-edge: identity resolves a handle to its
 * account (its own audited search), then svc-agents reads the log, its export or one transcript, writing its own audit
 * row for each read. Nothing is cached or kept here.
 */

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => Number.isInteger(v);
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);
const nullableString = (v: unknown): boolean => v === null || isString(v);

interface SearchPage {
  readonly rows: readonly { readonly id: string; readonly handle: string | null }[];
  readonly nextCursor: string | null;
}

function parseSearchPage(raw: unknown): SearchPage | null {
  if (!isObject(raw) || !Array.isArray(raw.rows)) return null;
  const rows: { id: string; handle: string | null }[] = [];
  for (const row of raw.rows) {
    if (!isObject(row) || !isString(row.id) || !nullableString(row.handle ?? null)) return null;
    rows.push({ id: row.id, handle: (row.handle as string | null | undefined) ?? null });
  }
  const next = raw.nextCursor ?? null;
  return isString(next) || next === null ? { rows, nextCursor: next } : null;
}

/** Identity pages a handle prefix oldest first; the exact handle is looked for on at most this many pages. */
const MAX_PAGES = 5;

export type Resolved =
  { readonly kind: 'ok'; readonly userId: string } | { readonly kind: 'refused'; readonly code: string; readonly status: number };

export async function resolveCustomer(ctx: FounderCallContext, ref: CustomerReference): Promise<Resolved> {
  if (ref.kind === 'id') return { kind: 'ok', userId: ref.value };
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: FounderCallResult<SearchPage> = await founderCall(
      ctx,
      'identity',
      'accountDirectory.search',
      'GET',
      { handle: ref.value, ...(cursor ? { cursor } : {}) },
      parseSearchPage,
    );
    if (result.kind !== 'ok') return refusalOf(result);
    const exact = result.data.rows.find((row) => row.handle?.toLowerCase() === ref.value.toLowerCase());
    if (exact) return { kind: 'ok', userId: exact.id };
    cursor = result.data.nextCursor;
    if (!cursor) break;
  }
  return { kind: 'refused', code: 'admin.agents_log_customer_not_found', status: 404 };
}

export function refusalOf(result: Exclude<FounderCallResult<unknown>, { kind: 'ok' }>): { kind: 'refused'; code: string; status: number } {
  switch (result.kind) {
    case 'forbidden':
      return { kind: 'refused', code: result.refusal.code ?? 'admin.forbidden', status: result.refusal.status };
    case 'refused':
      return { kind: 'refused', code: result.refusal.code ?? result.refusal.message, status: result.refusal.status };
    case 'not_built':
      return { kind: 'refused', code: 'admin.not_built', status: 501 };
    case 'unavailable':
      return { kind: 'refused', code: 'admin.upstream_unavailable', status: 503 };
    case 'invalid':
      return { kind: 'refused', code: 'admin.upstream_invalid', status: 502 };
  }
}

/** The owner's reason list, read for the form. A blank list is the service's own refusal code. */
export async function readReasons(
  ctx: FounderCallContext,
): Promise<{ kind: 'ok'; reasons: string[] } | { kind: 'refused'; code: string; status: number }> {
  const result = await founderCall(ctx, 'agents', 'opsLog.reasons', 'GET', undefined, (raw) =>
    isObject(raw) && isStrings(raw.reasons) ? { reasons: raw.reasons } : null,
  );
  return result.kind === 'ok' ? { kind: 'ok', reasons: result.data.reasons } : refusalOf(result);
}

const OUTCOME_SET: readonly unknown[] = OUTCOMES;

function isActionRow(v: unknown): boolean {
  return (
    isObject(v) &&
    isString(v.id) &&
    isString(v.occurredAt) &&
    isString(v.kind) &&
    isString(v.tool) &&
    OUTCOME_SET.includes(v.outcome) &&
    nullableString(v.refusalCode) &&
    nullableString(v.inputDigest)
  );
}

const parseActions = (raw: unknown): Json | null =>
  isObject(raw) &&
  Array.isArray(raw.items) &&
  raw.items.every(isActionRow) &&
  isStrings(raw.tools) &&
  typeof raw.more === 'boolean' &&
  isInt(raw.limit) &&
  isInt(raw.auditRows)
    ? raw
    : null;

const parseExport = (raw: unknown): Json | null =>
  isObject(raw) && isString(raw.csv) && isInt(raw.rows) && typeof raw.more === 'boolean' && isInt(raw.auditRows) ? raw : null;

const parseTranscript = (raw: unknown): Json | null =>
  isObject(raw) &&
  isString(raw.actionId) &&
  isString(raw.userId) &&
  isString(raw.text) &&
  isString(raw.digest) &&
  nullableString(raw.inputDigest) &&
  isString(raw.storedAt) &&
  isString(raw.expiresAt) &&
  isInt(raw.auditRows)
    ? raw
    : null;

export type AgentsLogAnswer =
  { readonly kind: 'ok'; readonly data: unknown } | { readonly kind: 'refused'; readonly code: string; readonly status: number };

/** One desk action as the founder: the customer reference is resolved first, except for a transcript, which names its action. */
export async function runAgentsLog(ctx: FounderCallContext, action: AgentsLogAction): Promise<AgentsLogAnswer> {
  if (action.action === 'transcript') {
    const result = await founderCall(
      ctx,
      'agents',
      'opsLog.transcript',
      'POST',
      { actionId: action.actionId, requestId: action.requestId, ...(action.reason ? { reason: action.reason } : {}) },
      parseTranscript,
    );
    return result.kind === 'ok' ? { kind: 'ok', data: result.data } : refusalOf(result);
  }
  const ref = customerReference(action.customer);
  if ('error' in ref) return { kind: 'refused', code: 'admin.agents_log_customer_invalid', status: 400 };
  const customer = await resolveCustomer(ctx, ref);
  if (customer.kind !== 'ok') return customer;
  const input = {
    userId: customer.userId,
    requestId: action.requestId,
    ...(action.reason ? { reason: action.reason } : {}),
    ...(action.outcome ? { outcome: action.outcome } : {}),
    ...(action.tool ? { tool: action.tool } : {}),
  };
  const result =
    action.action === 'actions'
      ? await founderCall(ctx, 'agents', 'opsLog.actions', 'POST', input, parseActions)
      : await founderCall(ctx, 'agents', 'opsLog.export', 'POST', input, parseExport);
  return result.kind === 'ok' ? { kind: 'ok', data: { ...result.data, userId: customer.userId } } : refusalOf(result);
}
