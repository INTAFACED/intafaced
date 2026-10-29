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

function fieldOf(path: ReadonlyArray<PropertyKey>): string {
  return path.length === 0 ? 'body' : path.map(String).join('.');
}

/** One bad field keeps its own code (a bad `tag` is `trade.invalid_tag`); more than one is `trade.validation_failed`. */
const FIELD_CODES: Readonly<Record<string, { code: string; message: string }>> = {
  tag: { code: 'trade.invalid_tag', message: 'tag must be 1 to 16 characters' },
};

export function createBodyRefusal(error: { issues: ReadonlyArray<Issue> }, fallback: string): CreateBodyRefusal {
  // The contract names every bad field, its sign checks included (#6594), so its issues are the whole list.
  const issues: Issue[] = [...error.issues];

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
