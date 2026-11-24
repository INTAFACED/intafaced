// garden/no-history-comment: a comment in product code says what the code does now. Three kinds are refused, each
// counted on its own by tooling/ci/lint-ratchet.mjs:
//   [private-record]  an owner-record number or the private state repo, which readers of this public code cannot open;
//   [history]         a PR or issue number, or "formerly", "used to be": git keeps history;
//   [workaround]      a workaround or hack with no link to the outside issue that forces it.
// The rule's fix (oxlint --fix, or tooling/lint/history-comment-codemod.mjs) drops a citation that sits in a list or in
// parentheses, and only when what is left holds no finding; everything else is reworded by hand.

const PRODUCT = /(?:^|\/)(?:apps|services|packages|sdks|sites|plugins)\//u;
const VENDORED = /\/(?:vendor|vendored|node_modules)\//u;
const DIRECTIVE = /^\s*(?:(?:oxlint|eslint)-|@ts-|prettier-ignore|biome-ignore|c8 |istanbul |#(?:end)?region)/u;

const OWNER = String.raw`(?:project-state(?:'s)?\s+)?OWNER(?:\.md)?(?:\s+item)?\s+\d+(?:\s*\(\d+[a-z]?\))?`;
const STATE_REF = String.raw`project-state(?:\s+(?:#\d+|row\s+d\d+|issue\s+#?\d+))?`;
const PRIVATE = new RegExp(String.raw`\bOWNER(?:\.md)?(?:\s+item)?\s+\d+|\bproject-state\b|DEFINITIVE_BUILD`, 'u');
// `owner/repo#123` names an outside tracker and `&#123;` is an entity; a bare `#123` is our own history.
const BARE_REF = String.raw`(?<![\w/&#-])#[1-9]\d{2,4}(?![\w-])`;
const HISTORY_WORDS = /\b(?:formerly|used to be)\b/iu;
const WORKAROUND = /(?<!\bnot an? )\b(?:work-?arounds?|hacks?|hacky|kludge)\b/iu;
const LINK = /https?:\/\/|[\w.-]+\/[\w.-]+#\d+/u;
const CODE_SPAN = /`[^`\n]*`/gu;
// `regression: #123` and `quarantine: #123` test markers exist to carry the number.
const TEST_MARKER = /^\s*(?:regression|quarantine):/u;

const bareRef = () => new RegExp(BARE_REF, 'u');
const outsideSpans = (text) => text.replace(CODE_SPAN, '');

/** The kind a comment's text breaks, or null. */
export function kindOf(text) {
  if (DIRECTIVE.test(text)) return null;
  const prose = outsideSpans(text);
  if (PRIVATE.test(prose)) return 'private-record';
  if (!TEST_MARKER.test(text) && (bareRef().test(prose) || HISTORY_WORDS.test(prose))) return 'history';
  if (WORKAROUND.test(prose) && !LINK.test(prose)) return 'workaround';
  return null;
}

const MESSAGES = {
  'private-record':
    "[private-record] this comment cites a record readers of this public code cannot open (an OWNER number or project-state): say the rule it stands for in the code's own words, or drop it; the PR carries the citation",
  history:
    '[history] this comment tells history (a PR or issue number, "formerly", "used to be"): git keeps that; say what the code does now, or drop it',
  workaround: '[workaround] this comment justifies a workaround: fix the cause, or link the outside issue (a URL) that forces it',
};

// One citation, as the fix removes it: an owner record, a private-repo reference, or a bare PR or issue number.
const CITE = String.raw`(?:${OWNER}|${STATE_REF}|${BARE_REF})`;
const CITES = String.raw`${CITE}(?:\s*[,;]\s*${CITE})*`;
const REWRITES = [
  // `(OWNER 107)`, `(#8305; project-state #2615)`: the whole parenthesis.
  [new RegExp(String.raw`[ \t]*\(${CITES}\)`, 'gu'), ''],
  // `(J-agents-01, OWNER 226)`: the last item of a list in parentheses.
  [new RegExp(String.raw`[ \t]*[,;][ \t]*${CITES}(?=\))`, 'gu'), ''],
  // `(OWNER 226, J-agents-01)`, `(OWNER 226: users pay ...)`: the first item, with its separator.
  [new RegExp(String.raw`(\()${CITES}[ \t]*[,;:][ \t]*`, 'gu'), '$1'],
  // `J-a #1, OWNER 107, D-2`: an item inside a list.
  [new RegExp(String.raw`([,;][ \t]*)${CITES}[ \t]*[,;:][ \t]*`, 'gu'), '$1'],
];

/** The comment text with its citations dropped, or null when that leaves a finding (it then needs words, not a fix). */
export function fixText(text) {
  let out = text;
  for (const [re, to] of REWRITES) out = out.replace(re, to);
  if (out === text || kindOf(out) !== null) return null;
  return out;
}

const noHistoryComment = {
  meta: {
    type: 'suggestion',
    fixable: 'code',
    docs: { description: 'Product comments say what the code does now: no private records, history or workaround sermons.' },
  },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!PRODUCT.test(file) || VENDORED.test(file)) return {};
    const sourceCode = context.sourceCode;
    return {
      Program() {
        for (const c of sourceCode.getAllComments()) {
          const kind = kindOf(c.value);
          if (!kind) continue;
          const fixed = fixText(c.value);
          const open = 2;
          const close = c.type === 'Block' ? 2 : 0;
          context.report({
            loc: c.loc,
            message: MESSAGES[kind],
            ...(fixed === null ? {} : { fix: (fixer) => fixer.replaceTextRange([c.start + open, c.end - close], fixed) }),
          });
        }
      },
    };
  },
};

export const historyCommentRules = { 'no-history-comment': noHistoryComment };
