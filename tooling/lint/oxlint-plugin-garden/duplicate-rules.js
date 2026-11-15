// The four duplicate kinds the regex DUPLICATE RATCHET in tooling/ci/boundary-scan.mjs counted (R-scale, R-unwrap,
// R-parse, R-fetch), as lint rules with the same patterns and the same scope, so the lint ratchet holds them per rule and a
// moved function no longer fails. Counted on the text with comments blanked, exactly as the scan counted.
const repoPath = (context) => {
  const file = String(context.filename ?? context.getFilename())
    .split('\\')
    .join('/');
  const m = /\/((?:services|packages|apps)\/.*)$/u.exec(file);
  return m ? m[1] : null;
};
// The scan's walk: services and packages (apps were never counted), no test files, none of its skipped folders.
const SKIP_DIRS = /\/(?:node_modules|dist|\.next|\.turbo|coverage|build|target|\.git|drizzle|testing|tests|vendored)\//u;
const TEST = /\.(?:test|spec|fixture)\.(?:[cm]?[jt]sx?)$/u;
export const inDuplicateScope = (path) =>
  !!path && /^(?:services|packages)\//u.test(path) && !SKIP_DIRS.test(`/${path}`) && !TEST.test(path);

/** boundary-scan's stripComments, keeping every offset (comments become spaces), so a count has a line to report. */
export function blankComments(src) {
  const blank = (m) => m.replace(/[^\n]/gu, ' ');
  return src.replace(/\/\*[\s\S]*?\*\//gu, blank).replace(/(^|[^:'"`\\])(\/\/[^\n]*)/gu, (_, a, b) => a + blank(b));
}

const KIND = {
  'no-local-scale': {
    applies: (p) => !p.startsWith('packages/ledger-client/'),
    pattern: /\b10n\s*\*\*\s*18n\b/gu,
    message: 'local `10n ** 18n` scale: import the scale from @intafaced/ledger-client (money.ts)',
  },
  'no-hand-decimal-parse': {
    applies: (p) => !p.startsWith('packages/ledger-client/'),
    pattern: /\.padEnd\(\s*[\w.]+\s*,\s*['"]0['"]\s*\)/gu,
    message: "hand-rolled decimal parse (`.padEnd(n, '0')`): use @intafaced/ledger-client's money parsing",
  },
  'no-hand-trpc-unwrap': {
    applies: (p) => p.startsWith('services/'),
    pattern: /\bresult\??\.data\b/gu,
    message: 'hand-rolled tRPC reply unwrap (`result?.data`): use `unwrapTrpcData` from @intafaced/contracts',
  },
  'no-fetch-without-timeout': {
    applies: (p) => p.startsWith('services/'),
    fileExempt: (code) => /AbortSignal|timeoutMs|\bsignal\s*[:,}]|timeout/iu.test(code),
    pattern: /(?<![.\w])(?:globalThis\.)?fetch\(/gu,
    message: 'fetch with no timeout or signal in this file: pass `signal: AbortSignal.timeout(ms)`',
  },
};

/** The offsets each kind counts in one file, as the regex scan counted them. */
export function duplicateHits(path, text) {
  const out = {};
  if (!inDuplicateScope(path)) return out;
  const code = blankComments(text);
  for (const [name, k] of Object.entries(KIND)) {
    if (!k.applies(path) || k.fileExempt?.(code)) continue;
    const hits = [...code.matchAll(k.pattern)].map((m) => m.index);
    if (hits.length) out[name] = hits;
  }
  return out;
}

const rule = (name) => ({
  meta: { type: 'suggestion', docs: { description: KIND[name].message } },
  create(context) {
    const path = repoPath(context);
    if (!inDuplicateScope(path) || !KIND[name].applies(path)) return {};
    return {
      Program() {
        const text = context.sourceCode.text;
        for (const at of duplicateHits(path, text)[name] ?? []) {
          const before = text.slice(0, at).split('\n');
          const line = before.length;
          const column = before[before.length - 1].length;
          context.report({ loc: { start: { line, column }, end: { line, column: column + 1 } }, message: KIND[name].message });
        }
      },
    };
  },
});

export const duplicateRules = Object.fromEntries(Object.keys(KIND).map((name) => [name, rule(name)]));
