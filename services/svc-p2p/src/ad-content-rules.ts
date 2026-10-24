/**
 * P-ads-merchant-05. THE CONTENT RULES AN AD'S TERMS ARE SCREENED AGAINST.
 *
 * The list is compliance's data, published as `P2P_AD_CONTENT_RULES`: rule classes (for example `messenger`,
 * `contact`, `link`), each a list of phrases an ad may not carry. Text that carries one is refused with its rule class
 * and never the matched phrase, so a refusal cannot be used to read the list one guess at a time.
 *   · blank: no list is published, so the filter is off (the spec's own rule). Nothing is invented.
 *   · anything that is not a complete list: every post refuses `p2p.content_rules_invalid`, because a half-read list
 *     would let through the phrases it failed to read.
 *
 * Matching is case-insensitive on NFKC-folded text. A phrase that starts or ends with a letter or digit matches only
 * as a whole word there (`signal` does not refuse "signalling"); one that starts or ends with a sign (`https://`)
 * matches anywhere.
 */

const CLASS = /^[a-z][a-z_]{0,31}$/;
const WORD_EDGE = /[\p{L}\p{N}]/u;

export interface AdContentRule {
  readonly ruleClass: string;
  readonly pattern: RegExp;
}

export type AdContentRules = { status: 'absent' } | { status: 'invalid' } | { status: 'active'; rules: readonly AdContentRule[] };

const fold = (text: string) => text.normalize('NFKC').toLocaleLowerCase('en');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

function phrasePattern(phrase: string): RegExp {
  const lead = WORD_EDGE.test(phrase[0]!) ? '(?<![\\p{L}\\p{N}])' : '';
  const tail = WORD_EDGE.test(phrase[phrase.length - 1]!) ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${lead}${escape(phrase)}${tail}`, 'u');
}

/** Blank or omitted is absent. A JSON object of rule class to a non-empty list of phrases is the list; anything else is invalid. */
export function parseAdContentRules(raw: string | undefined): AdContentRules {
  if (raw === undefined || raw.trim() === '') return { status: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { status: 'invalid' };
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'invalid' };
  const rules: AdContentRule[] = [];
  const classes = Object.entries(parsed as Record<string, unknown>);
  if (classes.length === 0) return { status: 'invalid' };
  for (const [ruleClass, phrases] of classes) {
    if (!CLASS.test(ruleClass) || !Array.isArray(phrases) || phrases.length === 0) return { status: 'invalid' };
    for (const phrase of phrases) {
      if (typeof phrase !== 'string') return { status: 'invalid' };
      const folded = fold(phrase.trim());
      if (folded.length < 2 || folded.length > 64) return { status: 'invalid' };
      rules.push({ ruleClass, pattern: phrasePattern(folded) });
    }
  }
  return { status: 'active', rules };
}

/** The first rule class the text breaks, or null. An invalid list is the caller's refusal, not a match. */
export function brokenRuleClass(rules: AdContentRules, text: string): string | null {
  if (rules.status !== 'active' || text.trim() === '') return null;
  const folded = fold(text);
  return rules.rules.find((rule) => rule.pattern.test(folded))?.ruleClass ?? null;
}
