import { decimal } from '@intafaced/exchange-contract';
import { invalidOrder, type CcxtErrorBody } from './ccxt-errors.js';

/**
 * The 400 body for a create-order body the typed schema refused (DV-errors-01, J-developer-04 #3).
 *
 * One body lists every bad field, so a developer fixes them in one round trip instead of one per call:
 *
 *   { code: 'InvalidOrder', intafacedCode, message, docs: '/developers/errors#<intafacedCode>',
 *     errors: [{ field, message }], issues: [{ path, message }] }
 *
 * `code` stays the CCXT class a client branches on and `intafacedCode` our finer code; `issues` keeps the raw schema
 * paths it carried before. The request id is not set here: Edge stamps it on every proxied error body.
 */
export interface CreateBodyRefusal extends CcxtErrorBody {
  docs: string;
  errors: Array<{ field: string; message: string }>;
  issues: Array<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}

type Issue = { path: ReadonlyArray<PropertyKey>; message: string };

/** The page section that explains a code. */
export function errorDocsLink(intafacedCode: string): string {
  return `/developers/errors#${intafacedCode}`;
}

/** Strictly greater than zero, by characters only (never a JS number), as the contract's own refinement reads it. */
function positiveDecimal(value: string): boolean {
  if (value.startsWith('-')) return false;
  for (const char of value) if (char >= '1' && char <= '9') return true;
  return false;
}

/** The money fields whose sign the contract checks in a refinement, with the words it uses. */
const SIGNED_FIELDS = ['amount', 'price', 'stopPrice'] as const;

/**
 * The contract checks a negative or zero amount, price or stop price in an object refinement, which does not run once
 * any field (a bad `side`, say) has already failed. Those field checks stand on their own, so they are made here for
 * the fields the schema did not reach: one 400 then lists a bad side and a negative amount together.
 */
function unreachedSignIssues(body: unknown, issues: ReadonlyArray<Issue>): Issue[] {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return [];
  const record = body as Record<string, unknown>;
  const named = new Set(issues.map((issue) => String(issue.path[0] ?? '')));
  const found: Issue[] = [];
  for (const field of SIGNED_FIELDS) {
    const value = record[field];
    if (named.has(field) || typeof value !== 'string' || !decimal.safeParse(value).success) continue;
    if (!positiveDecimal(value)) found.push({ path: [field], message: `${field} must be a positive decimal string` });
  }
  return found;
}

function fieldOf(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? 'body' : path.map(String).join('.');
}

export function createBodyRefusal(error: { issues: ReadonlyArray<Issue> }, fallback: string, body?: unknown): CreateBodyRefusal {
  const issues: Issue[] = [...error.issues, ...unreachedSignIssues(body, error.issues)];
  const first = issues[0];
  const typed =
    first?.path[0] === 'tag'
      ? invalidOrder('tag must be 1 to 16 characters', 'trade.invalid_tag').body
      : invalidOrder(first?.message ?? fallback).body;

  // One entry per field: the first thing wrong with it.
  const errors: Array<{ field: string; message: string }> = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const field = fieldOf(issue.path);
    if (seen.has(field)) continue;
    seen.add(field);
    errors.push({ field, message: issue.message });
  }
  const message =
    errors.length > 1 ? `${errors.length} fields are invalid: ${errors.map((entry) => entry.field).join(', ')}` : typed.message;
  const intafacedCode = typed.intafacedCode ?? 'trade.validation_failed';

  return {
    ...typed,
    message,
    intafacedCode,
    docs: errorDocsLink(intafacedCode),
    errors,
    issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
  };
}
