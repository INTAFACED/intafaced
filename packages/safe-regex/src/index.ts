/**
 * FH-SEC-01 — ReDoS-safe regex for untrusted strings.
 *
 * Hot parsers (method ids, labels, admin free-text filters) must not use
 * backtracking-vulnerable JS RegExp on attacker-controlled input. This package
 * wraps RE2-class matching (re2js) and enforces an input length cap so a single
 * call stays linear-time and bounded.
 *
 * Law: docs/INTERNET-LEVERAGE-LAW.md · FH-SEC-01 full-horizon row.
 *
 * Does NOT touch Denon open P2P PR paths — consumers opt in; Stage-1 lands the
 * shared library + method-id helper + suite.
 */

import { RE2JS } from 're2js';

/** Default max input length for untrusted strings (bytes/UTF-16 code units). */
export const DEFAULT_MAX_INPUT_LEN = 4096;

export type SafeMatchOptions = {
  /** Max input length; longer inputs refuse without matching. */
  maxInputLen?: number;
};

export type SafeMatchOk = {
  readonly ok: true;
  readonly matched: boolean;
  readonly groups: readonly (string | null)[];
};

export type SafeMatchRefuse = {
  readonly ok: false;
  readonly reason: 'input_too_long' | 'pattern_invalid';
};

export type SafeMatchResult = SafeMatchOk | SafeMatchRefuse;

/**
 * Compile a pattern once with RE2 semantics (no backreferences / lookaround
 * that enable classic ReDoS). Throws if the pattern is not RE2-safe.
 */
export function compileSafe(pattern: string, flags = ''): RE2JS {
  // re2js flags mirror a subset of JS flags; we only use i/m when callers need them.
  return RE2JS.compile(pattern, flagsToInt(flags));
}

function flagsToInt(flags: string): number {
  let f = 0;
  // re2js: CASE_INSENSITIVE = 2, MULTILINE = 8, DOTALL = 32 (mirrors Java Pattern)
  if (flags.includes('i')) f |= 2;
  if (flags.includes('m')) f |= 8;
  if (flags.includes('s')) f |= 32;
  return f;
}

/**
 * Match `input` against a RE2 pattern with a hard length cap.
 *
 * Refuses (does not throw) when input exceeds maxInputLen — callers treat that
 * as validation failure, not as a soft false match.
 */
export function safeTest(pattern: string | RE2JS, input: string, options: SafeMatchOptions = {}): SafeMatchResult {
  const max = options.maxInputLen ?? DEFAULT_MAX_INPUT_LEN;
  if (input.length > max) {
    return { ok: false, reason: 'input_too_long' };
  }
  let re: RE2JS;
  try {
    re = typeof pattern === 'string' ? compileSafe(pattern) : pattern;
  } catch {
    return { ok: false, reason: 'pattern_invalid' };
  }
  const matcher = re.matcher(input);
  const matched = matcher.matches();
  if (!matched) {
    return { ok: true, matched, groups: [] };
  }
  const groups: (string | null)[] = [];
  const count = matcher.groupCount();
  for (let i = 1; i <= count; i += 1) {
    groups.push(matcher.group(i));
  }
  return { ok: true, matched, groups };
}

/**
 * Full-string match helper for method / slug ids (anchored).
 * Pattern is fixed by the library — not caller-supplied untrusted regex.
 */
const METHOD_ID_RE = compileSafe('^[a-z][a-z0-9_-]{0,63}$');

/**
 * Validate a payment-method / rail id string from untrusted input.
 * Linear-time RE2 + length cap. Never invents a method when invalid.
 */
export function isSafeMethodId(input: string, options: SafeMatchOptions = {}): boolean {
  const max = options.maxInputLen ?? 64;
  if (input.length === 0 || input.length > max) return false;
  const r = safeTest(METHOD_ID_RE, input, { maxInputLen: max });
  return r.ok && r.matched;
}

/** Escape a literal for inclusion in a RE2 pattern (no metachar meaning). */
export function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
