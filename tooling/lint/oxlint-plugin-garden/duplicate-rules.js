// garden/use-shared-helper: one rule for every hand-written copy of a helper that lives in one shared place. Each kind's
// message names the shared helper to import. Four kinds are the regex DUPLICATE RATCHET's of tooling/ci/boundary-scan.mjs
// (R-scale, R-unwrap, R-parse, R-fetch), with its patterns and its scope, counted on the text with comments blanked as the
// scan counted; `compose-slice` is a hand-written slice of one docker compose service, in tests and apps too; `local-helper`
// is a local isRecord, sleep or unreachable, anywhere. Every message starts with its `[kind]`, and the lint ratchet counts each
// kind on its own (tooling/ci/lint-ratchet.mjs ruleOf), so a removed copy of one kind never pays for an added copy of another.
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
  'compose-slice': {
    scope: (p) => !!p && !SKIP_DIRS.test(`/${p}`),
    // `/^  svc-x:\n(?:.*\n)*?(?=^  [a-z]|\Z)/m` and its kin; JavaScript has no `\Z`, so a copy never ended a last service.
    pattern: /\^(?: {2}| \{2\})(?:[\w-]+|\$\{\w+\}):(?:\\{1,2}n|\[\\s\\S\])/gu,
    message: "hand-written compose service slice: use `composeServiceBlock(composeText, 'svc-x')` from '@intafaced/config/compose'",
  },
  'local-scale': {
    applies: (p) => !p.startsWith('packages/ledger-client/'),
    pattern: /\b10n\s*\*\*\s*18n\b/gu,
    message: 'local `10n ** 18n` scale: import the scale from @intafaced/ledger-client (money.ts)',
  },
  'hand-decimal-parse': {
    applies: (p) => !p.startsWith('packages/ledger-client/'),
    pattern: /\.padEnd\(\s*[\w.]+\s*,\s*['"]0['"]\s*\)/gu,
    message: "hand-rolled decimal parse (`.padEnd(n, '0')`): use @intafaced/ledger-client's money parsing",
  },
  'hand-trpc-unwrap': {
    applies: (p) => p.startsWith('services/'),
    pattern: /\bresult\??\.data\b/gu,
    message: 'hand-rolled tRPC reply unwrap (`result?.data`): use `unwrapTrpcData` from @intafaced/contracts',
  },
  'fetch-without-timeout': {
    applies: (p) => p.startsWith('services/'),
    fileExempt: (code) => /AbortSignal|timeoutMs|\bsignal\s*[:,}]|timeout/iu.test(code),
    pattern: /(?<![.\w])(?:globalThis\.)?fetch\(/gu,
    message: 'fetch with no timeout or signal in this file: pass `signal: AbortSignal.timeout(ms)`',
  },
};

/** The offsets each kind counts in one file, as the regex scan counted them. */
export function duplicateHits(path, text) {
  const out = {};
  const code = blankComments(text);
  for (const [name, k] of Object.entries(KIND)) {
    if (!(k.scope ? k.scope(path) : inDuplicateScope(path) && k.applies(path)) || k.fileExempt?.(code)) continue;
    const hits = [...code.matchAll(k.pattern)].map((m) => m.index);
    if (hits.length) out[name] = hits;
  }
  return out;
}

// Local copies of helpers that live in @intafaced/contracts, found on the syntax tree.
const HELPER_NAMES = new Set(['isRecord', 'isObject', 'isPlainObject', 'asRecord', 'sleep', 'wait', 'delay', 'unreachable']);
const LOCAL_HELPER =
  "[local-helper] local helper '%s': import the shared one (isRecord from @intafaced/contracts/guards, sleep from @intafaced/contracts/sleep)";
const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');

export const useSharedHelper = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Import the shared helper instead of a hand-written copy; the message names which one.' },
  },
  create(context) {
    const path = repoPath(context);
    const local = (node, name) => context.report({ node, message: LOCAL_HELPER.replace('%s', name) });
    return {
      Program() {
        const text = context.sourceCode.text;
        for (const [name, hits] of Object.entries(duplicateHits(path, text))) {
          for (const at of hits) {
            const before = text.slice(0, at).split('\n');
            const line = before.length;
            const column = before[before.length - 1].length;
            context.report({
              loc: { start: { line, column }, end: { line, column: column + 1 } },
              message: `[${name}] ${KIND[name].message}`,
            });
          }
        }
      },
      FunctionDeclaration(node) {
        if (node.id && HELPER_NAMES.has(node.id.name)) local(node.id, node.id.name);
      },
      VariableDeclarator(node) {
        if (node.id?.type === 'Identifier' && HELPER_NAMES.has(node.id.name) && isFn(node.init)) local(node.id, node.id.name);
      },
    };
  },
};
