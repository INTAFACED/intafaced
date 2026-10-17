import type { FounderControlAuditListInput, founderControlAuditListSchema, founderLimitRequestListSchema } from '@intafaced/contracts';
import { isUuid, one, PAGE_LIMIT, type Query } from './read-model';

/** Pure rules for the audit filters (F64). Nothing here reads a service. */

export type ControlAuditList = ReturnType<typeof founderControlAuditListSchema.parse>;
export type LimitRequestList = ReturnType<typeof founderLimitRequestListSchema.parse>;

export interface AuditFilter {
  readonly merchant: string;
  readonly kind: string;
  readonly from: string;
  readonly to: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR = /^\d{1,19}$/;
const MAX_CURSOR = 9223372036854775807n;

function validDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** What the page asked for, as the text the filter form shows back. Values that are not valid stay visible next to their message. */
export function auditFilterOf(query: Query | undefined): AuditFilter {
  return {
    merchant: one(query, 'merchant')?.trim() ?? '',
    kind: one(query, 'kind')?.trim() ?? '',
    from: one(query, 'from') ?? '',
    to: one(query, 'to') ?? '',
  };
}

export type AuditInput = { ok: true; input: FounderControlAuditListInput } | { ok: false; errors: string[] };

/** The service request for a query, or plain-English reasons it cannot be sent. A reversed range is refused here, not read as empty. */
export function auditInput(query: Query | undefined): AuditInput {
  const f = auditFilterOf(query);
  const errors: string[] = [];
  if (f.merchant && !isUuid(f.merchant))
    errors.push('The merchant id must be the full id, for example 11111111-1111-4111-8111-111111111111.');
  if (f.kind.length > 128) errors.push('The action name is too long.');
  if (f.from && !validDay(f.from)) errors.push('The “from” date must be a real date.');
  if (f.to && !validDay(f.to)) errors.push('The “to” date must be a real date.');
  if (errors.length === 0 && f.from && f.to && f.from > f.to) errors.push('The “from” date is after the “to” date.');
  if (errors.length > 0) return { ok: false, errors };
  const cursor = one(query, 'cursor');
  return {
    ok: true,
    input: {
      limit: PAGE_LIMIT,
      ...(cursor && CURSOR.test(cursor) && BigInt(cursor) <= MAX_CURSOR ? { cursor } : {}),
      ...(f.merchant ? { merchantId: f.merchant.toLowerCase() } : {}),
      ...(f.kind ? { kind: f.kind } : {}),
      ...(f.from ? { from: `${f.from}T00:00:00.000Z` } : {}),
      ...(f.to ? { to: `${f.to}T23:59:59.999Z` } : {}),
    },
  };
}

export const hasAuditFilter = (f: AuditFilter): boolean => Boolean(f.merchant || f.kind || f.from || f.to);

const SENSITIVE_KEY = /destination|iban|account|address|secret|token|password|beneficiary|wallet|^ref$/i;
const MAX_PREVIEW = 1200;

/** A stored before/after value as readable text. Money stays the strings the service stored; any non-null value under a key that looks like a destination is hidden, objects and arrays included. */
export function jsonPreview(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = JSON.stringify(
    value,
    (key, v: unknown) => (key !== '' && SENSITIVE_KEY.test(key) && v !== null && v !== undefined ? '[hidden]' : v),
    2,
  );
  if (text === undefined) return '';
  return text.length > MAX_PREVIEW ? `${text.slice(0, MAX_PREVIEW)}\n… shortened` : text;
}
