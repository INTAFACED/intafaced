// garden/step-picture-before-leaving: a step's picture shows the state the step names. The proof reader judges each step
// by one picture of its test's page (tooling/ci/step-pictures.mjs), taken as the test ends unless the test calls
// `stepPicture()` (the fixture in apps/customer/tests/real-app/journey.mjs) earlier. A test that checks the step's state
// and then leaves it, as its last action, ends on another screen, and the reader answers NOT SHOWN for a step that holds:
// J-algo-dev-15 #3 and #5 and J-portfolio-01 #1 clicked the link the step names last, J-derivatives-01 #7 closed the menu
// it had checked with Escape (intafaced #8824, #8835, #8840).
// Judged: in a journey file (`*.pw.mjs`), a `test()` callback that never calls `stepPicture`, whose last page action, in
// source order, is a click on a link (`getByRole('link', …)`, `locator('a')`; not one awaited beside a download or popup)
// or a press of Escape, and that checks nothing after it but where it arrived (`toHaveURL`, a heading shown, a value read
// once). Not judged: a `goto`, whose next screen is the state as often as not, and a test that goes on to check another
// screen (J-wallet-01 #5 read the list, then Withdraw): only the read sees those.
// [no-page]: a step's test (titled `J-<id> #<n>`, `${J} #<n>` included) that takes no page of its own (`page`, or
// `browser` or `context` to open one) and never calls `stepPicture` attaches no picture, and the reader answers NOT READ
// for a step that holds, which the proof count never counts (J-agents-21 #4: an API call and its refusal, no screen).
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const JOURNEY_FILE = /(^|\/)apps\/customer\/tests\/real-app\/.*\.pw\.[cm]?js$/u;
const STEP_CALLS = new Set(['test', 'test.only', 'test.fixme', 'test.fail', 'test.slow']);
const ACTIONS = new Set([
  'click',
  'dblclick',
  'tap',
  'press',
  'pressSequentially',
  'type',
  'fill',
  'check',
  'uncheck',
  'selectOption',
  'setInputFiles',
  'hover',
  'focus',
  'dispatchEvent',
  'goto',
  'goBack',
  'goForward',
  'reload',
]);
const CLICKS = new Set(['click', 'dblclick', 'tap']);

const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');
const dotted = (callee) => {
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && !callee.computed && callee.object?.type === 'Identifier')
    return `${callee.object.name}.${callee.property?.name}`;
  return undefined;
};
const method = (n) =>
  n?.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && !n.callee.computed ? n.callee.property?.name : undefined;
const pos = (n) => n.range?.[0] ?? n.start;
const literal = (n) => (n?.type === 'Literal' ? n.value : undefined);

/** Every call inside `node`, in source order. */
function callsIn(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'CallExpression') out.push(node);
  for (const [k, v] of Object.entries(node)) {
    if (k === 'parent') continue;
    if (Array.isArray(v)) for (const c of v) callsIn(c, out);
    else if (v && typeof v.type === 'string') callsIn(v, out);
  }
  return out;
}

/** Whether the receiver chain of an action call (`a.getByRole('link').filter(…).click()`) picks a link. */
function onLink(call) {
  for (let n = call.callee?.object; n;) {
    if (n.type === 'CallExpression') {
      const m = method(n);
      if (m === 'getByRole' && literal(n.arguments[0]) === 'link') return true;
      if (m === 'locator' && /^a(?![\w-])/u.test(String(literal(n.arguments[0]) ?? ''))) return true;
      n = n.callee?.object;
    } else if (n.type === 'MemberExpression') n = n.object;
    else if (n.type === 'ChainExpression' || n.type === 'ParenthesizedExpression') n = n.expression;
    else return false;
  }
  return false;
}

/** Whether the click is awaited beside a download or popup wait (`Promise.all([page.waitForEvent('download'), …click()])`). */
function withDownload(call) {
  for (let n = call.parent; n && !isFn(n); n = n.parent)
    if (n.type === 'ArrayExpression')
      return n.elements.some((e) =>
        callsIn(e).some((c) => method(c) === 'waitForEvent' && ['download', 'popup'].includes(literal(c.arguments[0]))),
      );
  return false;
}

/** How an action call leaves the screen, or null. */
function leaves(call) {
  const m = method(call);
  if (m === 'press' && call.arguments.some((a) => literal(a) === 'Escape')) return 'pressing Escape';
  if (CLICKS.has(m) && onLink(call)) return 'a click on a link';
  return null;
}

// A retrying check of the screen: `await expect(locator).toBeVisible()` (toHaveText, toContainText, toHaveCount, …),
// never a check of the URL or of a value already read.
const SCREEN_MATCHERS =
  /^(toBe(Visible|Hidden|Enabled|Disabled|Checked|Editable|Empty|Focused|Attached|InViewport)|toHave(Text|Count|Value|Values|Attribute|Class|Css|Id|AccessibleName|AccessibleDescription|Role|Screenshot)|toContainText)$/u;
const isExpect = (n) => n?.type === 'CallExpression' && (dotted(n.callee) === 'expect' || dotted(n.callee) === 'expect.soft');
function isScreenCheck(call) {
  if (!SCREEN_MATCHERS.test(method(call) ?? '')) return false;
  for (let n = call.callee?.object; n; n = n.type === 'MemberExpression' ? n.object : null) if (isExpect(n)) return true;
  return false;
}

/** `expect(page.getByRole('heading', …)).toBeVisible()`: a check that the test arrived, not of a state. */
function isArrival(call) {
  if (method(call) !== 'toBeVisible') return false;
  for (let n = call.callee?.object; n; n = n.type === 'MemberExpression' ? n.object : null) {
    if (!isExpect(n)) continue;
    const target = n.arguments[0];
    return target?.type === 'CallExpression' && method(target) === 'getByRole' && literal(target.arguments[0]) === 'heading';
  }
  return false;
}

/** The name the action's receiver chain starts from (`page` in `page.getByRole('link').click()`), or null. */
function pageOf(call) {
  let n = call.callee;
  while (n && n.type !== 'Identifier') n = n.type === 'MemberExpression' ? n.object : n.type === 'CallExpression' ? n.callee : null;
  return n?.name ?? null;
}

/** A call of a file's own or imported function (`editorRoom(page)`) that is handed the page. */
function helperOn(call, page) {
  if (call.callee?.type !== 'Identifier' || call.callee.name === 'expect') return false;
  return call.arguments.some((a) => a.type === 'Identifier' && (a.name === page || a.name === 'page'));
}

// A step's title: `J-agents-21 #4 …`, or a template whose first part is an expression (`${J} #4 …`, `${J} #${n} …`).
const STEP_TITLE = /^(?:J-[a-z0-9]+(?:-[a-z0-9]+)*-\d+|\0) ?#(?:\d|\0)/u;
function titleText(n) {
  if (n?.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n?.type === 'TemplateLiteral') return n.quasis.map((q, i) => (i ? '\0' : '') + (q.value.cooked ?? q.value.raw)).join('');
  return undefined;
}

/** The names `node` reads (not a property after a dot, nor an object key), with whether a `newPage()` is called. */
function namesIn(node, out = new Set(), key = '', parent = null) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'Identifier') {
    const prop = key === 'property' && parent?.type === 'MemberExpression' && !parent.computed;
    const objKey = key === 'key' && parent?.type === 'Property' && !parent.computed && !parent.shorthand;
    if (!prop && !objKey) out.add(node.name);
  }
  if (method(node) === 'newPage') out.add('newPage()');
  for (const [k, v] of Object.entries(node)) {
    if (k === 'parent') continue;
    if (Array.isArray(v)) for (const c of v) namesIn(c, out, k, node);
    else if (v && typeof v.type === 'string') namesIn(v, out, k, node);
  }
  return out;
}
const PAGE_NAMES = ['page', 'browser', 'context', 'newPage()'];

/** Whether the file keeps one page for all its steps (`let page;` at the top, `page = await context.newPage()` in a hook):
 *  its steps reach that page through helpers, and the run keeps that page's window as their picture. */
function sharesPage(program) {
  const top = new Set();
  for (const s of program.body ?? [])
    if (s.type === 'VariableDeclaration' && s.kind !== 'const')
      for (const d of s.declarations) if (d.id?.type === 'Identifier') top.add(d.id.name);
  const assigned = (n) => {
    if (!n || typeof n !== 'object') return false;
    if (n.type === 'AssignmentExpression' && n.left?.type === 'Identifier' && top.has(n.left.name)) {
      const r = n.right?.type === 'AwaitExpression' ? n.right.argument : n.right;
      if (method(r) === 'newPage') return true;
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent') continue;
      if (Array.isArray(v) ? v.some(assigned) : v && typeof v.type === 'string' && assigned(v)) return true;
    }
    return false;
  };
  return top.size > 0 && assigned(program);
}

const stepPictureBeforeLeaving = {
  meta: { type: 'problem', docs: { description: "A step's test takes its picture before it leaves the step's screen." } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!JOURNEY_FILE.test(file)) return {};
    let shared;
    return {
      CallExpression(node) {
        if (!STEP_CALLS.has(dotted(node.callee))) return;
        const cb = node.arguments.at(-1);
        if (!isFn(cb)) return;
        const calls = callsIn(cb.body);
        if (calls.some((c) => c.callee?.type === 'Identifier' && c.callee.name === 'stepPicture')) return;
        const title = titleText(node.arguments[0]);
        if (title !== undefined && STEP_TITLE.test(title)) {
          let program = node;
          while (program.parent) program = program.parent;
          shared ??= sharesPage(program);
        }
        if (title !== undefined && STEP_TITLE.test(title) && !shared) {
          // A helper handed `stepPicture` takes the picture itself.
          const body = namesIn(cb.body);
          const names = namesIn({ type: 'Params', params: cb.params }, new Set(body));
          if (!body.has('stepPicture') && !PAGE_NAMES.some((n) => names.has(n))) {
            context.report({
              node: node.arguments[0],
              message:
                "[no-page] this step's test takes no page and never calls `stepPicture`, so it attaches no picture of the " +
                'screen the step ends on, and the proof reader answers NOT READ, which never counts as proven (J-agents-21 #4). ' +
                'End the test on the screen the step\'s "They see" names: take `page` (or open one) and `stepPicture` in its ' +
                'fixtures, and `await stepPicture()` once that screen is checked (apps/customer/tests/real-app/journey.mjs)',
            });
            return;
          }
        }
        const last = calls
          .filter((c) => ACTIONS.has(method(c)))
          .sort((a, b) => pos(a) - pos(b))
          .at(-1);
        const how = last && leaves(last);
        if (!how || withDownload(last)) return;
        // A test that goes on to check the screen it went to, itself or through a helper it hands the page to
        // (`editorRoom(page)`), judges that screen; one that only checks it arrived (its URL, its heading) ends on a page it
        // never checked.
        const after = calls.filter((c) => pos(c) > pos(last));
        if (after.some((c) => (isScreenCheck(c) && !isArrival(c)) || helperOn(c, pageOf(last)))) return;
        context.report({
          node: last,
          message:
            `this step's last action, ${how}, leaves the screen it checked, and its picture is taken as the test ends, so ` +
            'the proof reader is shown the page it went on to and answers NOT SHOWN (J-algo-dev-15 #3). Take the picture ' +
            "where the step's state is on screen: add `stepPicture` to the test's fixtures and `await stepPicture()` before " +
            'this line (apps/customer/tests/real-app/journey.mjs); when the screen it goes to is the state the step names, ' +
            'call it once that screen is checked',
        });
      },
    };
  },
};

export const stepPictureRules = { 'step-picture-before-leaving': stepPictureBeforeLeaving };
