// garden/no-switch-router: one procedure per router path. A router whose part is chosen at start-up between two sets of
// procedures (`changes: router(control ? live(control) : { submit: standIn })`, `flag ? liveRouter() : standIn()`,
// `a ?? b`) puts two procedures under one path; neither is the call's record, so every caller of that path stays a call by
// name (tooling/codemod/call-records/router.mjs, "two procedures under one path"). The fix is one procedure per path that
// switches inside its handler, as `founderChangeProcedures` in services/svc-pay/src/namespaces/founder-control.ts does.
// Counted, outside tests, where a `router(...)` call's argument, or a property of the object it is given, is a `? :`,
// `??` or `||` whose two sides both may hold procedures (an object with members, a call, a name). Not counted: a side
// that is empty (`{}`, `undefined`, a literal), `&&`, and a spread (`...(control ? { control: r } : {})` adds or leaves
// out a path; it never puts two under one).
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__|__fixtures__)\/)/u;
const FIX =
  'mount one procedure per path and switch inside its handler (`control ? … : notBuilt(…)`), as `founderChangeProcedures` ' +
  'in services/svc-pay/src/namespaces/founder-control.ts does, so the call has one record';

const bare = (n) => {
  let x = n;
  while (
    x &&
    (x.type === 'TSAsExpression' ||
      x.type === 'TSSatisfiesExpression' ||
      x.type === 'TSNonNullExpression' ||
      x.type === 'ParenthesizedExpression' ||
      x.type === 'TSTypeAssertion')
  )
    x = x.expression;
  return x;
};
/** A side that may hold procedures: an object with members, a call, or a name other than `undefined`. */
const mayHold = (n) => {
  const x = bare(n);
  if (x?.type === 'ObjectExpression') return x.properties.length > 0;
  if (x?.type === 'Identifier') return x.name !== 'undefined';
  return x?.type === 'CallExpression' || x?.type === 'ConditionalExpression' || x?.type === 'LogicalExpression';
};
const isSwitch = (n) => {
  const x = bare(n);
  if (x?.type === 'ConditionalExpression') return mayHold(x.consequent) && mayHold(x.alternate);
  if (x?.type === 'LogicalExpression' && (x.operator === '??' || x.operator === '||')) return mayHold(x.left) && mayHold(x.right);
  return false;
};
const isRouterCall = (c) => {
  const callee = c.callee;
  if (callee?.type === 'Identifier') return callee.name === 'router';
  return callee?.type === 'MemberExpression' && !callee.computed && callee.property?.name === 'router';
};
const keyOf = (p) => (p.key?.type === 'Identifier' ? p.key.name : typeof p.key?.value === 'string' ? p.key.value : '?');

const noSwitchRouter = {
  meta: { type: 'problem', docs: { description: 'One procedure per router path: no router part chosen between two sets.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (TEST_FILE.test(file)) return {};
    const report = (node, where) =>
      context.report({ node, message: `${where} puts two procedures under one path (a switch between routers): ${FIX}` });
    return {
      CallExpression(node) {
        if (!isRouterCall(node)) return;
        const arg = bare(node.arguments[0]);
        if (isSwitch(arg)) return report(arg, 'This router');
        if (arg?.type !== 'ObjectExpression') return;
        for (const p of arg.properties) if (p.type === 'Property' && isSwitch(p.value)) report(p, `\`${keyOf(p)}\``);
      },
    };
  },
};

export const switchRouterRules = { 'no-switch-router': noSwitchRouter };
