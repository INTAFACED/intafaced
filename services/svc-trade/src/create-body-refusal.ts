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
 *
 * Kept only until the exchange-contract-field-errors branch lands: it moves these sign checks onto the fields in
 * `@intafaced/exchange-contract` (and exports `positiveDecimal`), after which the schema always names them and this
 * adds nothing (a field the schema named is skipped). Remove this copy, and the local `positiveDecimal`, then.
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

/** One bad field keeps its own code (a bad `tag` is `trade.invalid_tag`); more than one is `trade.validation_failed`. */
const FIELD_CODES: Readonly<Record<string, { code: string; message: string }>> = {
  tag: { code: 'trade.invalid_tag', message: 'tag must be 1 to 16 characters' },
};

export function createBodyRefusal(error: { issues: ReadonlyArray<Issue> }, fallback: string, body?: unknown): CreateBodyRefusal {
  const issues: Issue[] = [...error.issues, ...unreachedSignIssues(body, error.issues)];

  // One entry per field: the first thing wrong with it.
  const errors: Array<{ field: string; message: string }> = [];
  const seen = new Set<string>();
  for (const issue of issues) {
    const field = fieldOf(issue.path);
    if (seen.has(field)) continue;
    seen.add(field);
    errors.push({ field, message: issue.message });
  }

  // The code depends only on which fields are wrong, never on the order the schema reported them in.
  const only = errors.length === 1 ? errors[0]! : null;
  const specific = only ? FIELD_CODES[only.field] : undefined;
  const typed = specific
    ? invalidOrder(specific.message, specific.code).body
    : invalidOrder(
        only
          ? only.message
          : errors.length > 1
            ? `${errors.length} fields are invalid: ${errors.map((e) => e.field).join(', ')}`
            : fallback,
      ).body;
  const intafacedCode = typed.intafacedCode ?? 'trade.validation_failed';

  return {
    ...typed,
    intafacedCode,
    docs: errorDocsLink(intafacedCode),
    errors,
    issues: issues.map((issue) => ({ path: issue.path, message: issue.message })),
  };
}
