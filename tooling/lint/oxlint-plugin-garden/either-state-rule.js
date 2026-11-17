// garden/no-either-state-match: a journey step that accepts any of several states proves none of them.
// `expect(['unknown', 'pending_retry', 'posting', 'qualified']).toContain(open.state)` (J-campaigns-08 #5 at #8512's head)
// passes whichever of the four the service answered, so the step's own state is never pinned. A list of HTTP statuses
// (`[401, 403]`) is a different question (which refusal), and is left to the reader. A replay over the 50
// merged journey builds before 16 Nov found this one case (#8512:343). Judged by the lint ratchet: a new copy fails, the copies on main
// are the baseline (tooling/ci/lint-ratchet.mjs).
const JOURNEY = /(?:^|\/)apps\/customer\/tests\/real-app\/[^/]+\.pw\.mjs$/u;
const isState = (n) => n?.type === 'Literal' && typeof n.value === 'string';
// A check run once per row, per answer or per link is a rule over a whole set (every row's state is one of the allowed
// ones: J-ops-console-01 `['set', 'blank']`, J-support-public-10 `['open', 'pending']`), which is honest; only a check of one
// value is judged.
const LOOPS = new Set(['ForStatement', 'ForOfStatement', 'ForInStatement', 'WhileStatement', 'DoWhileStatement']);
const EACH = new Set(['forEach', 'every', 'map', 'some', 'filter', 'flatMap']);
function inLoop(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (LOOPS.has(n.type)) return true;
    const isFn = n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression';
    const call = n.parent;
    if (isFn && call?.type === 'CallExpression' && call.arguments.includes(n)) {
      const c = call.callee;
      if (c?.type === 'MemberExpression' && !c.computed && EACH.has(c.property?.name)) return true;
    }
  }
  return false;
}

/** The call `expect(<array>)` (or `expect.soft(<array>)`), or null. */
function expectedArray(call) {
  if (call?.type !== 'CallExpression') return null;
  const c = call.callee;
  const isExpect =
    (c?.type === 'Identifier' && c.name === 'expect') ||
    (c?.type === 'MemberExpression' &&
      !c.computed &&
      c.object?.type === 'Identifier' &&
      c.object.name === 'expect' &&
      c.property?.name === 'soft');
  const arg = call.arguments[0];
  return isExpect && arg?.type === 'ArrayExpression' ? arg : null;
}

const noEitherStateMatch = {
  meta: { type: 'problem', docs: { description: 'A journey step pins the one state it names; it never accepts any of a list.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!JOURNEY.test(file)) return {};
    return {
      CallExpression(node) {
        const m = node.callee;
        if (m?.type !== 'MemberExpression' || m.computed || !['toContain', 'toContainEqual'].includes(m.property?.name)) return;
        const list = expectedArray(m.object);
        if (!list || list.elements.length < 2 || !list.elements.every(isState) || inLoop(node)) return;
        context.report({
          node,
          message:
            `either-state match: this passes on any of ${list.elements.length} states, so the step proves none: pin the one ` +
            "state the step names (`expect(x).toBe('qualified')`). When the step's words name a branch, set that branch up " +
            'and pin its state in its own check',
        });
      },
    };
  },
};

export const eitherStateRules = { 'no-either-state-match': noEitherStateMatch };
