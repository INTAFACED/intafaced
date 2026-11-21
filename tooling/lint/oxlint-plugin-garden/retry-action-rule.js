// garden/no-action-in-retry: a test acts once, on a page that has settled; it never presses inside a retried check.
// `expect(async () => { if (await address.isVisible()) return; await connect.click({ timeout: 2_000 }); ... }).toPass()`
// clicked Connect while a remembered wallet was still restoring and retried over the race (#8642: ten journey files, each
// copying the one before it). The cure was the room's own `restoring` state; this keeps the retry from coming back.
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const PLAYWRIGHT = /\.pw\.[cm]?[jt]s$/u;
const ACTIONS = new Set([
  'check',
  'click',
  'dblclick',
  'dragTo',
  'fill',
  'press',
  'pressSequentially',
  'selectOption',
  'setChecked',
  'setInputFiles',
  'tap',
  'type',
  'uncheck',
]);
const isFn = (n) => n?.type === 'ArrowFunctionExpression' || n?.type === 'FunctionExpression';
const isExpect = (n) => n?.type === 'Identifier' && n.name === 'expect';
const member = (n, name) => n?.type === 'MemberExpression' && !n.computed && n.property?.name === name;

/** 'toPass' or 'expect.poll' when `fn` is the callback that check retries, else null. */
function retriedBy(fn) {
  const call = fn.parent;
  if (call?.type !== 'CallExpression' || call.arguments[0] !== fn) return null;
  if (member(call.callee, 'poll') && isExpect(call.callee.object)) return 'expect.poll';
  const soft = member(call.callee, 'soft') && isExpect(call.callee.object);
  if (!isExpect(call.callee) && !soft) return null;
  return member(call.parent, 'toPass') && call.parent.parent?.type === 'CallExpression' ? 'toPass' : null;
}

const noActionInRetry = {
  meta: { type: 'problem', docs: { description: 'A test acts once on a settled page; it never acts inside toPass or expect.poll.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!PLAYWRIGHT.test(file)) return {};
    return {
      CallExpression(node) {
        const m = node.callee;
        if (m?.type !== 'MemberExpression' || m.computed || !ACTIONS.has(m.property?.name)) return;
        for (let n = node.parent; n; n = n.parent) {
          if (!isFn(n)) continue;
          const check = retriedBy(n);
          if (!check) continue;
          context.report({
            node,
            message:
              `${m.property.name} inside ${check}: the retry presses whatever the page shows while it is still settling. Wait ` +
              'once for the state the page settles in, then act once: a wallet room settles on its Connect button or the ' +
              'connected address (connectWhenAsked in apps/customer/tests/real-app/dex.mjs); when a page never settles, ' +
              'give it the state it lacks in the product',
          });
          return;
        }
      },
    };
  },
};

export const retryActionRules = { 'no-action-in-retry': noActionInRetry };
