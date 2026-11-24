// garden/count-zero-needs-shown: in a journey step, a count of 0 proves something is absent only on a page that has drawn.
// `await page.goto(url); await expect(page.getByTestId('campaign-budget-left')).toHaveCount(0);` (J-campaigns-01 #3 at
// #8498) passes the moment the navigation returns, before the room has rendered anything, so it would pass on a page that
// later shows the line. The fix is `absentIn(container, locator)` (the `absent` module beside the journey files), which shows
// the container first. A count of 0 is judged by what came before it in the same step: it is fine after a check that
// something is shown (toBeVisible, toHaveText, toContainText, toHaveCount(n > 0), ...), and flagged when a navigation
// (goto, reload, goBack, goForward) comes after the last such check.
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const JOURNEY = /(?:^|\/)apps\/customer\/tests\/real-app\/[^/]+\.pw\.mjs$/u;
const SHOWN = new Set([
  'toBeVisible',
  'toHaveText',
  'toContainText',
  'toHaveValue',
  'toHaveValues',
  'toHaveAttribute',
  'toBeEnabled',
  'toBeDisabled',
  'toBeChecked',
  'toHaveClass',
  'toHaveURL',
  'toHaveTitle',
  'toBeAttached',
]);
// Only a navigation clears what was shown.
const MOVES = new Set(['goto', 'reload', 'goBack', 'goForward']);
// An action on an element waits until it is visible (Playwright's actionability), so the page has drawn: a count of 0
// after a click is usually a dialog or row seen going away.
const ACTIONS = new Set([
  'click',
  'dblclick',
  'tap',
  'fill',
  'press',
  'pressSequentially',
  'check',
  'uncheck',
  'selectOption',
  'setInputFiles',
  'setChecked',
  'hover',
  'focus',
  'type',
]);

/** The matcher call chain of `expect(x)[.not].matcher(args)`: { matcher, negated, args } or null. */
function matcherOf(call) {
  if (call?.type !== 'CallExpression' || call.callee?.type !== 'MemberExpression' || call.callee.computed) return null;
  let obj = call.callee.object;
  let negated = false;
  if (obj?.type === 'MemberExpression' && !obj.computed && obj.property?.name === 'not') {
    negated = true;
    obj = obj.object;
  }
  if (obj?.type !== 'CallExpression') return null;
  const c = obj.callee;
  const isExpect =
    (c?.type === 'Identifier' && c.name === 'expect') ||
    (c?.type === 'MemberExpression' &&
      !c.computed &&
      c.object?.type === 'Identifier' &&
      c.object.name === 'expect' &&
      c.property?.name === 'soft');
  return isExpect ? { matcher: call.callee.property?.name, negated, args: call.arguments } : null;
}
const isZero = (n) => n?.type === 'Literal' && n.value === 0;
const isCountZero = (call) => {
  const m = matcherOf(call);
  return !!m && !m.negated && m.matcher === 'toHaveCount' && isZero(m.args[0]);
};
const isShown = (call) => {
  const m = matcherOf(call);
  if (!m || m.negated) return false;
  if (m.matcher === 'toHaveCount') return !isZero(m.args[0]);
  return SHOWN.has(m.matcher);
};
/** What a statement says about the page, read from its calls in source order; the last that counts decides: 'move' (a
 * navigation) or 'shown' (a shown check, an action on an element, or an awaited helper of the file, such as
 * `await openRoom(page)`, which may wait for the room; given the benefit of the doubt). Functions passed to `expect` (a
 * `toPass` or `poll` callback) run here and are read; other nested functions are not. */
function lastSignal(stmt) {
  let last = null;
  const walk = (n, inExpect = false) => {
    if (!n || typeof n !== 'object') return;
    const fn = n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration';
    if (fn && !inExpect) return;
    const isExpectCall =
      n.type === 'CallExpression' &&
      ((n.callee?.type === 'Identifier' && n.callee.name === 'expect') ||
        (n.callee?.type === 'MemberExpression' && n.callee.object?.type === 'Identifier' && n.callee.object.name === 'expect'));
    for (const k in n) {
      if (k === 'parent') continue;
      const v = n[k];
      const inner = isExpectCall && k === 'arguments';
      if (Array.isArray(v)) v.forEach((x) => walk(x, inner || (fn && inExpect)));
      else if (v && typeof v.type === 'string') walk(v, inner || (fn && inExpect));
    }
    if (n.type === 'CallExpression') {
      if (isCountZero(n)) return;
      const c = n.callee;
      const name = c?.type === 'MemberExpression' && !c.computed ? c.property?.name : null;
      if (isShown(n) || ACTIONS.has(name)) last = 'shown';
      else if (MOVES.has(name)) last = 'move';
      else if (c?.type === 'Identifier' && c.name !== 'expect' && n.parent?.type === 'AwaitExpression') last = 'shown';
    }
  };
  walk(stmt);
  return last;
}

const BODY = new Set(['BlockStatement', 'Program', 'StaticBlock', 'SwitchCase']);
/** Is there a navigation since the last shown check, looking back from `node` through the statements before it, block by
 * block, up to the enclosing function? Reaching the function's start decides nothing (a helper it calls may have shown
 * the room), so only a navigation found first is flagged. */
function navigatedSinceShown(node) {
  let child = node;
  for (let n = node.parent; n; child = n, n = n.parent) {
    if (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') return false;
    if (!BODY.has(n.type)) continue;
    const list = n.type === 'SwitchCase' ? n.consequent : n.body;
    for (let i = list.indexOf(child) - 1; i >= 0; i--) {
      const s = lastSignal(list[i]);
      if (s === 'shown') return false;
      if (s === 'move') return true;
    }
  }
  return false;
}

const countZeroNeedsShown = {
  meta: { type: 'problem', docs: { description: 'A journey checks a count of 0 only on something shown: absentIn(container, locator).' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!JOURNEY.test(file)) return {};
    return {
      CallExpression(node) {
        if (!isCountZero(node)) return;
        // Judged from the statements before the one that holds the count.
        const stmt = (() => {
          let s = node;
          while (s.parent && !BODY.has(s.parent.type)) s = s.parent;
          return s;
        })();
        if (!navigatedSinceShown(stmt)) return;
        context.report({
          node,
          message:
            'a count of 0 right after a navigation, with nothing shown since, passes before the page has drawn: use ' +
            '`absentIn(container, locator)` from the `absent` module beside the journey files, which shows the container the thing would sit in first',
        });
      },
    };
  },
};

export const absentRules = { 'count-zero-needs-shown': countZeroNeedsShown };
