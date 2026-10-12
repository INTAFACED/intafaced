/**
 * MARKETING LANGUAGE BAN (D26-P0-16 / DIRECTION §8.9)
 *
 * "Anything described to a user as audited, insured, or guaranteed" is owner-only.
 * Product copy may not invent those claims. To ship one of those words in a
 * user-facing catalogue line, the line (or the previous line) must carry an
 * owner seal marker — Nitro/Denon signed the claim, not an agent.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS FILE IS
 *
 * Pure helpers for the CI gate (`tooling/ci/marketing-language-scan.mjs`) and for
 * any service that wants to refuse a string before it becomes a response.
 * No I/O. No allowlist of product claims — seals are per-line, not a growing
 * exemption registry.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HONEST USES (not claims)
 *
 * Negations (`not audited`, `unaudited`), status honesty (`audited: false`), and
 * i18n keys that merely LABEL the honesty field (`audited: "…"`) are not
 * marketing invent. An honest pattern excuses only the ban word it covers.
 * It does not excuse a different ban word on the same line, and it does not
 * excuse a later affirmative use of the same word. Affirmative copy
 * ("fully audited", "insured deposits", "guaranteed yield") without
 * `OWNER-SEAL(§8.9)` is refuse.
 */

/** Words DIRECTION §8.9 reserves for owner-sealed product copy. */
export const MARKETING_BAN_WORDS = ['audited', 'insured', 'guaranteed'] as const;

export type MarketingBanWord = (typeof MARKETING_BAN_WORDS)[number];

/**
 * Owner seal marker. Must appear on the hit line or the immediately previous
 * line. Spelling is load-bearing — the gate and these helpers share it.
 */
export const OWNER_SEAL_MARKER = 'OWNER-SEAL(§8.9)' as const;

/** Case-insensitive match for the seal (allows optional spaces inside parens). */
export const OWNER_SEAL_RE = /OWNER-SEAL\s*\(\s*§?\s*8\.9\s*\)/i;

export interface MarketingLanguageHit {
  readonly word: MarketingBanWord;
  readonly reason: string;
}

/** True when `text` carries a §8.9 owner seal. */
export function hasOwnerSeal(text: string): boolean {
  return OWNER_SEAL_RE.test(text);
}

/**
 * Honest mentions that are NOT "described as audited/insured/guaranteed".
 * True means a negation, status-false, or status-field label is present.
 * It is not a whole-line seal — a different ban word can still be a claim.
 */
export function isHonestMarketingLanguageUse(line: string): boolean {
  const l = line.toLowerCase();

  // Status honesty wire / copy: audited: false (with or without space).
  if (/\baudited\s*:\s*false\b/.test(l)) return true;

  // Explicit unaudited / uninsured (and spaced forms).
  if (/\b(?:un|non)[- ]?(?:audited|insured|guaranteed)\b/.test(l)) return true;

  // "not audited", "never insured", "not a guaranteed yield", …
  if (
    /\b(?:not|never|no)\s+(?:a\s+|be\s+|been\s+|an?\s+)?(?:fully\s+|externally\s+|independently\s+)?(?:audited|insured|guaranteed)\b/.test(
      l,
    )
  ) {
    return true;
  }

  // i18n / object key that LABELS the honesty field — value may repeat the word.
  // Does NOT cover `audited: true` (that is the invent we ban).
  if (/^\s*audited\s*:/.test(line) && !/\baudited\s*:\s*true\b/i.test(line)) return true;

  return false;
}

/** Blank honest uses of one ban word. A different ban word on the line stays visible. */
function maskHonestUsesOfBanWord(line: string, word: MarketingBanWord): string {
  const patterns: RegExp[] = [
    new RegExp(`\\b(?:un|non)[- ]?${word}\\b`, 'gi'),
    new RegExp(
      `\\b(?:not|never|no)\\s+(?:a\\s+|be\\s+|been\\s+|an?\\s+)?(?:fully\\s+|externally\\s+|independently\\s+)?${word}\\b`,
      'gi',
    ),
  ];
  if (word === 'audited') patterns.push(/\baudited\s*:\s*false\b/gi);

  let masked = line;
  for (const pattern of patterns) {
    masked = masked.replace(pattern, (match) => ' '.repeat(match.length));
  }

  // Leading `audited:` labels the field. The value may repeat that word.
  // `audited: true` is a claim, not a label.
  if (word === 'audited' && /^\s*audited\s*:/.test(line) && !/\baudited\s*:\s*true\b/i.test(line)) {
    masked = masked.replace(/\baudited\b/gi, (match) => ' '.repeat(match.length));
  }

  return masked;
}

/**
 * Unsealed ban-word hits on a single line.
 * A seal on this line or the previous line clears the whole line.
 * Each ban word is judged alone: an honest use does not clear the rest.
 */
export function findUnsealedMarketingClaims(line: string, previousLine = ''): MarketingLanguageHit[] {
  if (hasOwnerSeal(line) || hasOwnerSeal(previousLine)) return [];

  const hits: MarketingLanguageHit[] = [];
  for (const word of MARKETING_BAN_WORDS) {
    const visible = maskHonestUsesOfBanWord(line, word);
    if (new RegExp(`\\b${word}\\b`, 'i').test(visible)) {
      hits.push({
        word,
        reason: `DIRECTION §8.9 — "${word}" in product copy requires ${OWNER_SEAL_MARKER}`,
      });
    }
  }
  return hits;
}

/**
 * Refuse helper for callers composing user-facing strings.
 * Returns null when allowed; otherwise a stable refuse code + reason.
 */
export function assertMarketingLanguageAllowed(
  line: string,
  previousLine = '',
):
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'refuse.marketing_language_unsealed';
      readonly reason: string;
      readonly words: readonly MarketingBanWord[];
    } {
  const hits = findUnsealedMarketingClaims(line, previousLine);
  if (hits.length === 0) return { ok: true };
  return {
    ok: false,
    code: 'refuse.marketing_language_unsealed',
    reason: hits.map((h) => h.reason).join('; '),
    words: hits.map((h) => h.word),
  };
}
