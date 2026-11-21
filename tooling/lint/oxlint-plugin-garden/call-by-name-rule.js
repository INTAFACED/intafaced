// garden/no-call-by-name: an app calls a service through the call's written record in @intafaced/contracts
// (packages/contracts/src/procedure.ts), `api.call(<RECORD>, input)`, so its path, input type and answer parser come from the
// one record the service mounts. A call named by strings carries its own copy of the answer and drifts from the service
// without failing to compile. The shapes counted, in apps/customer/src and apps/admin/src outside tests:
//   - `api.query('bank', 'cards.list', …)` / `api.mutate('agents', procedure, …)`: a service or call named by a string;
//   - `useBankRead('cards.list', …)`: a read named by a string;
//   - `{ procedure: 'cards.freeze' }`: a dialog or step naming its call by a string;
//   - `founderCall(ctx, 'bank', 'x.y', …)`, `founderEdgeCall(config, 'ops', 'x.y', …)`, `payCall(ctx, 'x.y', …)`;
//   - `{ 'cards.list': cardsSchema }`: a hand schema keyed by a call's name.
// The pattern is common (about 1,300 copies), so the rule fails only when a change adds one: judged by the lint ratchet,
// the copies on main are each file's ceiling and a file the change adds starts at zero (tooling/ci/lint-ratchet.mjs,
// tooling/lint/ratchet.json failInAddedFiles). `node tooling/lint/count-rule.mjs garden/no-call-by-name` prints how many are
// left and where.
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__|__fixtures__)\/)/u;
const APP_SRC = /(?:^|\/)apps\/(?:customer|admin)\/src\//u;
// A call's dotted name as a service mounts it: `cards.list`, `founderAdmin.registries.save`.
const CALL_NAME = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
// The helpers that take a call by name, and the positions of its service and call names among their arguments.
const NAMED_AT = { query: [0, 1], mutate: [0, 1], founderCall: [1, 2], founderEdgeCall: [1, 2], payCall: [1], useBankRead: [0] };
const FIX =
  'call it through its record in @intafaced/contracts: `api.call(<RECORD>, input)` (packages/contracts/src/procedure.ts), ' +
  'declaring the record there if it has none';

const isString = (n) => (n?.type === 'Literal' && typeof n.value === 'string') || n?.type === 'TemplateLiteral';
const keyName = (p) =>
  p.key?.type === 'Literal' && typeof p.key.value === 'string'
    ? p.key.value
    : p.key?.type === 'Identifier' && !p.computed
      ? p.key.name
      : undefined;
const isSchema = (v) => {
  let n = v;
  while (n && (n.type === 'CallExpression' || n.type === 'MemberExpression')) n = n.type === 'CallExpression' ? n.callee : n.object;
  return (n?.type === 'Identifier' && (n.name === 'z' || n.name.endsWith('Schema'))) || false;
};

const noCallByName = {
  meta: { type: 'suggestion', docs: { description: 'An app calls a service through its written record, never by name.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!APP_SRC.test(file) || TEST_FILE.test(file)) return {};
    return {
      CallExpression(node) {
        const c = node.callee;
        const name = c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' && !c.computed ? c.property?.name : undefined;
        if (!name || !Object.hasOwn(NAMED_AT, name)) return;
        // `api.query(…)` / `api.mutate(…)`, never a bare `query(…)` (a database or test helper of the same name).
        if ((name === 'query' || name === 'mutate') && c.type !== 'MemberExpression') return;
        if (NAMED_AT[name].some((i) => isString(node.arguments[i])))
          context.report({ node, message: `\`${name}\` names its service or call by a string: ${FIX}` });
      },
      Property(node) {
        const key = keyName(node);
        // `procedure: ''` names no call (an unknown tool's empty result), so there is nothing to name by record.
        if (key === 'procedure' && isString(node.value) && node.value.value !== '') {
          context.report({ node, message: `\`procedure:\` names a call by a string: ${FIX}` });
          return;
        }
        if (node.key?.type === 'Literal' && key && CALL_NAME.test(key) && isSchema(node.value))
          context.report({ node, message: `a schema keyed by the call's name \`${key}\` is a hand copy of its answer: ${FIX}` });
      },
    };
  },
};

export const callByNameRules = { 'no-call-by-name': noCallByName };
