// garden/no-raw-stored-search: a test that searches serialized values for a short run of digits that must be absent
// (`expect(JSON.stringify(rows)).not.toContain('4321')`) fails by chance whenever a random id, hash or clock time in those
// values holds the same digits: a stored card row's payload hash held a PIN's four digits, and a customer-details event's
// uuid held a phone number's. The fix is `storedText(...)` from `@intafaced/db/testing` (packages/db/src/testing.ts),
// which masks uuids, hex hashes and clock times and leaves every other value as strict. Judged by the lint ratchet: a new
// copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__)\/)/u;
// A run of digits or lowercase hex short enough to turn up inside a random id by chance.
const SHORT_HEX = /^[0-9a-f]{1,8}$/u;

const unwrap = (n) => {
  let v = n;
  while (
    v &&
    (v.type === 'TSAsExpression' ||
      v.type === 'TSSatisfiesExpression' ||
      v.type === 'TSNonNullExpression' ||
      v.type === 'ParenthesizedExpression')
  )
    v = v.expression;
  return v;
};
const isStringify = (n) =>
  n?.type === 'CallExpression' &&
  n.callee?.type === 'MemberExpression' &&
  !n.callee.computed &&
  n.callee.object?.type === 'Identifier' &&
  n.callee.object.name === 'JSON' &&
  n.callee.property?.name === 'stringify';

/** The value the nearest enclosing block declares `name` with, or null. */
function declaredInit(node, name) {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type !== 'BlockStatement' && n.type !== 'Program') continue;
    for (const stmt of n.body) {
      const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
      if (decl?.type !== 'VariableDeclaration') continue;
      for (const d of decl.declarations) if (d.id?.type === 'Identifier' && d.id.name === name) return d.init ?? null;
    }
  }
  return null;
}

/** Is this value serialized text: JSON.stringify(...), a string method on it, `+` holding it, or a const that is one? */
function serialized(node, depth = 0) {
  const n = unwrap(node);
  if (!n || depth > 8) return false;
  const r = (x) => serialized(x, depth + 1);
  if (isStringify(n)) return true;
  if (n.type === 'CallExpression' && n.callee?.type === 'MemberExpression') return r(n.callee.object);
  if (n.type === 'BinaryExpression' && n.operator === '+') return r(n.left) || r(n.right);
  if (n.type === 'TemplateLiteral') return n.expressions.some(r);
  if (n.type === 'Identifier') return r(declaredInit(n, n.name));
  return false;
}

/** `expect(x).not.toContain('<short hex>')`: the searched value and the literal, or null. */
function absenceSearch(call) {
  const c = call.callee;
  if (c?.type !== 'MemberExpression' || c.computed || c.property?.name !== 'toContain') return null;
  const not = c.object;
  if (not?.type !== 'MemberExpression' || not.computed || not.property?.name !== 'not') return null;
  const ex = not.object;
  if (ex?.type !== 'CallExpression') return null;
  const e = ex.callee;
  const isExpect =
    (e?.type === 'Identifier' && e.name === 'expect') ||
    (e?.type === 'MemberExpression' &&
      !e.computed &&
      e.object?.type === 'Identifier' &&
      e.object.name === 'expect' &&
      e.property?.name === 'soft');
  const lit = call.arguments[0];
  if (!isExpect || lit?.type !== 'Literal' || typeof lit.value !== 'string' || !SHORT_HEX.test(lit.value)) return null;
  return { searched: ex.arguments[0], text: lit.value };
}

const noRawStoredSearch = {
  meta: { type: 'problem', docs: { description: 'An absence search over serialized values masks random ids first, through storedText.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!TEST_FILE.test(file)) return {};
    return {
      CallExpression(node) {
        const s = absenceSearch(node);
        if (!s || !serialized(s.searched)) return;
        context.report({
          node,
          message:
            `searching serialized values for '${s.text}' fails by chance when a random id, hash or clock time in them ` +
            'holds those digits: search storedText(...) from @intafaced/db/testing (packages/db/src/testing.ts) instead, ' +
            'which masks them and keeps every other value',
        });
      },
    };
  },
};

export const storedSearchRules = { 'no-raw-stored-search': noRawStoredSearch };
