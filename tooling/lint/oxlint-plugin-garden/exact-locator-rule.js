// garden/exact-locator: a journey locator named by a plain string matches by part, so a page that grows breaks it.
// Playwright's getByLabel / getByText / getByRole({ name }) match any element whose name CONTAINS the string, case-blind,
// unless `exact: true` is given. Twice in 14 days that turned main red on a step nobody changed:
//   - J-support-public-10 #5 (#7124, runs 1144 and 1146): `getByRole('region', { name: 'Customer' })` also matched the
//     "Verify the customer" section #7118 added (fixed by #7126 with `exact: true`);
//   - J-developer-06 #5 (#8517): `getByLabel('Why')` also matched a key whose random name held "why" (fixed by #8519).
// and builds lost pushes on the same kind: 'Export', 'Asset', 'To', 'Amount', a radio label. A regex is an explicit part
// match and passes; so does an explicit `exact: false`. Judged by the lint ratchet: a new copy fails, the copies on main are
// the baseline (tooling/ci/lint-ratchet.mjs).
const REAL_APP = /(?:^|\/)apps\/customer\/tests\/real-app\/.+\.mjs$/u;
const BY_STRING = new Set(['getByLabel', 'getByText', 'getByPlaceholder', 'getByTitle', 'getByAltText']);

const isString = (n) => (n?.type === 'Literal' && typeof n.value === 'string') || n?.type === 'TemplateLiteral';
const shown = (n) => (n.type === 'Literal' ? `'${n.value}'` : `\`${n.quasis.map((q) => q.value.cooked ?? q.value.raw).join('${…}')}\``);
const propOf = (obj, key) =>
  obj?.type === 'ObjectExpression'
    ? obj.properties.find(
        (p) => p.type === 'Property' && !p.computed && (p.key?.name === key || (p.key?.type === 'Literal' && p.key.value === key)),
      )
    : undefined;
/** The options object says `exact:` itself (true or false), or spreads something that may. */
const decidesExact = (obj) =>
  obj?.type === 'ObjectExpression' && (propOf(obj, 'exact') !== undefined || obj.properties.some((p) => p.type === 'SpreadElement'));

const message = (call, text) =>
  `\`${call}\` matches any element whose name contains ${text}, case-blind, so a later section or a random name ` +
  'that holds it breaks this step (J-support-public-10 #5, J-developer-06 #5, both red on main): add `{ exact: true }`, ' +
  'or pass a regex when a part match is meant';

const exactLocator = {
  meta: { type: 'problem', docs: { description: 'A journey locator named by a string matches that whole name.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!REAL_APP.test(file)) return {};
    return {
      CallExpression(node) {
        const c = node.callee;
        if (c?.type !== 'MemberExpression' || c.computed) return;
        const name = c.property?.name;
        if (BY_STRING.has(name)) {
          const [text, opts] = node.arguments;
          if (isString(text) && !decidesExact(opts) && opts?.type !== 'Identifier')
            context.report({ node, message: message(`${name}(${shown(text)})`, shown(text)) });
          return;
        }
        if (name === 'getByRole') {
          const opts = node.arguments[1];
          const n = propOf(opts, 'name');
          if (n && isString(n.value) && !decidesExact(opts))
            context.report({ node, message: message(`getByRole(…, { name: ${shown(n.value)} })`, shown(n.value)) });
        }
      },
    };
  },
};

export const exactLocatorRules = { 'exact-locator': exactLocator };
