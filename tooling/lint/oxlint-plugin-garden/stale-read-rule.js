// garden/no-stale-read: a journey reads the page only once it has settled, in one supported way each.
// Two shapes kept costing journey runs a flaky failure on a step nobody changed:
//   - an answer read across a `reload` or `goto`: a `waitForResponse` set up before the navigation takes the old page's
//     answer, whose body the navigation then drops, or which is the old page's data (J-charts-desk-09 #1, #7919;
//     J-home-ia-06 #1, #7452; J-wallet-04 #4, #7457), and a hand-made `framenavigated` match still takes a read the old
//     page started before the navigation (J-wallet-04 #4, #8061). The one way is `answerAfterNavigation` /
//     `answersAfterNavigation` in apps/customer/tests/real-app/navigation.mjs, the only file that may hold these shapes.
//   - a one-shot read of the screen inside an assertion, `expect(await note.innerText())`, which reads what the page showed
//     before an action's answer replaced it (J-cex-spot-07 #4, #8680 and #8722). The one way is a retrying assertion.
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const REAL_APP = /(?:^|\/)apps\/customer\/tests\/real-app\/.+\.mjs$/u;
const HELPER_FILE = /(?:^|\/)apps\/customer\/tests\/real-app\/navigation\.mjs$/u;
const HELPER =
  '`answerAfterNavigation(page, match, () => page.reload())` (or `answersAfterNavigation`) from apps/customer/tests/real-app/navigation.mjs';
const NAVIGATIONS = new Set(['reload', 'goto']);
const SCREEN_READS = new Set(['innerText', 'textContent', 'inputValue', 'getAttribute', 'allInnerTexts', 'allTextContents']);
const FUNCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration']);

const method = (n) =>
  n?.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && !n.callee.computed ? n.callee.property?.name : undefined;
const firstString = (n) => (n.arguments[0]?.type === 'Literal' ? n.arguments[0].value : undefined);
const isNavigation = (n) => NAVIGATIONS.has(method(n));
const isResponseWait = (n) => method(n) === 'waitForResponse' || (method(n) === 'waitForEvent' && firstString(n) === 'response');
const isFrameWatch = (n) => ['on', 'once', 'addListener', 'waitForEvent'].includes(method(n)) && firstString(n) === 'framenavigated';

/** Whether `pred` holds for `node` or any node inside it; `intoFunctions: false` stops at a nested function. */
function has(node, pred, intoFunctions = true) {
  if (!node || typeof node.type !== 'string') return false;
  if (pred(node)) return true;
  if (!intoFunctions && FUNCTIONS.has(node.type)) return false;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (value.some((v) => has(v, pred, intoFunctions))) return true;
    } else if (has(value, pred, intoFunctions)) return true;
  }
  return false;
}

/** The wait itself or a chain on it (`.then(...)`, `.catch(...)`), up to the expression that holds the promise. */
function promiseOf(node) {
  let n = node;
  for (;;) {
    const p = n.parent;
    if (p?.type === 'MemberExpression' && p.object === n && p.parent?.type === 'CallExpression' && p.parent.callee === p) n = p.parent;
    else if (p?.type === 'ChainExpression' || p?.type === 'ParenthesizedExpression') n = p;
    else return n;
  }
}

/** The name a kept promise is bound to (`const x = page.waitForResponse(…)` or `x = …`), or null. */
function boundName(expr) {
  const p = expr.parent;
  if (p?.type === 'VariableDeclarator' && p.init === expr && p.id?.type === 'Identifier') return p.id.name;
  if (p?.type === 'AssignmentExpression' && p.right === expr && p.left?.type === 'Identifier') return p.left.name;
  return null;
}

/** The statement holding `node` that sits directly in a block's list, with that list. */
function statementIn(node) {
  let n = node;
  while (n?.parent) {
    const body =
      n.parent.type === 'BlockStatement' || n.parent.type === 'Program'
        ? n.parent.body
        : n.parent.type === 'SwitchCase'
          ? n.parent.consequent
          : null;
    if (body) return { stmt: n, body };
    if (FUNCTIONS.has(n.parent.type)) return null;
    n = n.parent;
  }
  return null;
}

/** An array the wait sits in (as in `Promise.all([wait, page.reload()])`), within its own statement. */
function arrayAround(node) {
  let n = node;
  while (n.parent && !FUNCTIONS.has(n.parent.type) && !/Statement|Declaration$/.test(n.parent.type)) {
    if (n.parent.type === 'ArrayExpression') return { array: n.parent, element: n };
    n = n.parent;
  }
  return null;
}

/** Whether a kept wait meets a navigation before, or in the same statement as, its first use. */
function keptAcrossNavigation(expr, name) {
  const at = statementIn(expr);
  if (!at) return false;
  for (const stmt of at.body.slice(at.body.indexOf(at.stmt) + 1)) {
    const used = has(stmt, (n) => n.type === 'Identifier' && n.name === name);
    if (has(stmt, isNavigation)) return true;
    if (used) return false;
  }
  return false;
}

const navigationMessage = (how) =>
  `a response wait ${how} a \`reload\` or \`goto\` can take the old page's answer, whose body the navigation drops ` +
  `(J-charts-desk-09 #1, J-wallet-04 #4): read the new page's answer with ${HELPER}`;
const FRAME_MESSAGE =
  'a hand-made `framenavigated` match still takes a read the old page started before the navigation (J-wallet-04 #4): ' +
  `read the new page's answer with ${HELPER}`;
const screenMessage = (read) =>
  `\`expect(await ….${read}())\` reads the screen once, so it can read what the page showed before the action's answer ` +
  'replaced it (J-cex-spot-07 #4): assert with a retrying form, `await expect(locator).toHaveText(…)` (toHaveValue, ' +
  'toHaveAttribute), or `await expect.poll(() => locator.innerText()).toBe(…)`';

/** `expect(…)` or `expect.soft(…)`, never `expect.poll(…)`, which retries. */
const isExpect = (n) =>
  n.callee?.type === 'Identifier'
    ? n.callee.name === 'expect'
    : n.callee?.type === 'MemberExpression' &&
      n.callee.object?.type === 'Identifier' &&
      n.callee.object.name === 'expect' &&
      n.callee.property?.name === 'soft';

const staleRead = {
  meta: { type: 'problem', docs: { description: 'A journey reads the page only once it has settled, in its one supported way.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!REAL_APP.test(file) || HELPER_FILE.test(file)) return {};
    return {
      CallExpression(node) {
        if (isFrameWatch(node)) {
          context.report({ node, message: FRAME_MESSAGE });
          return;
        }
        if (isResponseWait(node)) {
          const raced = arrayAround(node);
          if (raced && raced.array.elements.some((e) => e && e !== raced.element && has(e, isNavigation))) {
            context.report({ node, message: navigationMessage('raced against') });
            return;
          }
          const expr = promiseOf(node);
          const name = boundName(expr);
          if (name && keptAcrossNavigation(expr, name)) context.report({ node, message: navigationMessage('kept across') });
          return;
        }
        if (isExpect(node) && node.arguments[0]) {
          let read;
          has(
            node.arguments[0],
            (n) => {
              if (n.type === 'AwaitExpression' && SCREEN_READS.has(method(n.argument))) read ??= method(n.argument);
              return read !== undefined;
            },
            false,
          );
          if (read) context.report({ node, message: screenMessage(read) });
        }
      },
    };
  },
};

export const staleReadRules = { 'no-stale-read': staleRead };
