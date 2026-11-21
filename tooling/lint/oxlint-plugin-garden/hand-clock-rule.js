// garden/no-hand-clock: a journey reads time one way, from apps/customer/tests/real-app/clock.mjs, and compares only a
// period that has closed. Two shapes kept turning journeys red on a step nobody changed:
//   - a candle read with a clock value while its minute may still be open: the screen and the hand count read the same
//     one-minute candle moments apart and a trade between them moved its close (J-portfolio-04 #3, #7871; J-portfolio-05
//     #1, #7907). The one way is `await closedMinute(page, at)` before the read.
//   - a minute or day boundary worked by hand (`Math.floor(t / 60_000)`, `t % 86_400_000`, `toISOString().slice(0, 10)`,
//     `setUTCHours(0, …)`): each copy picks its own edge, and a day that turns over at midnight UTC lands a period in the
//     wrong day (J-ops-console-07 #8, #7895; J-charts-desk-04 #2, #8172). The one way is clock.mjs's minuteStart,
//     hourStart, dayStart, utcDay and utcMinuteOf.
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline (tooling/ci/lint-ratchet.mjs).
const REAL_APP = /(?:^|\/)apps\/customer\/tests\/real-app\/.+\.mjs$/u;
const HELPER_FILE = /(?:^|\/)apps\/customer\/tests\/real-app\/clock\.mjs$/u;
const FROM = 'from apps/customer/tests/real-app/clock.mjs';
const FUNCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration']);

const PERIOD_MS = new Set([60_000, 3_600_000, 86_400_000]);
const PERIOD_NAME = /^(?:MINUTE|HOUR|DAY|ONE_MINUTE|ONE_HOUR|ONE_DAY)(?:_MS)?$/u;
const ROUNDING = new Set(['floor', 'ceil', 'trunc', 'round']);
const SLICE_ENDS = { 10: 'utcDay', 16: 'utcMinuteOf' };
// A read of a candle or bar series: the callee's own name says so (closesAround, candles, chartBars, ohlcv, closedBarsSince).
const CANDLE_READ = /candle|ohlcv|close|bars?(?![a-z])/iu;

const isPeriod = (n) => (n?.type === 'Literal' && PERIOD_MS.has(n.value)) || (n?.type === 'Identifier' && PERIOD_NAME.test(n.name));
const calleeName = (n) =>
  n.callee?.type === 'Identifier'
    ? n.callee.name
    : n.callee?.type === 'MemberExpression' && !n.callee.computed
      ? n.callee.property?.name
      : undefined;
const isMethod = (n, object, name) =>
  n?.type === 'CallExpression' &&
  n.callee?.type === 'MemberExpression' &&
  !n.callee.computed &&
  n.callee.property?.name === name &&
  (object === undefined || (n.callee.object?.type === 'Identifier' && n.callee.object.name === object));
const isClockRead = (n) =>
  isMethod(n, 'Date', 'now') ||
  (n?.type === 'NewExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'Date' && n.arguments.length === 0);
const pos = (n) => n.range?.[0] ?? n.start;

/** Whether `pred` holds for `node` or any node inside it, not entering nested functions. */
function has(node, pred) {
  if (!node || typeof node.type !== 'string') return false;
  if (pred(node)) return true;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (value.some((v) => v && !FUNCTIONS.has(v.type) && has(v, pred))) return true;
    } else if (!FUNCTIONS.has(value.type) && has(value, pred)) return true;
  }
  return false;
}

/** The innermost function around `node` whose own body binds `name` to a clock read (`const at = Date.now()`). */
function clockBinding(node, name) {
  for (let f = node.parent; f; f = f.parent) {
    if (!FUNCTIONS.has(f.type)) continue;
    const bound = has(
      f.body,
      (n) => n.type === 'VariableDeclarator' && n.id?.type === 'Identifier' && n.id.name === name && n.init && has(n.init, isClockRead),
    );
    if (bound) return f;
  }
  return null;
}

const insideExpect = (node) => {
  for (let n = node.parent; n && !FUNCTIONS.has(n.type); n = n.parent)
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && n.callee.name === 'expect') return true;
  return false;
};

const handBoundary = (node) => {
  // Math.floor(t / 60_000), Math.ceil((t + x) / MINUTE)
  if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && node.callee.object?.name === 'Math') {
    const a = node.arguments[0];
    if (ROUNDING.has(node.callee.property?.name) && a?.type === 'BinaryExpression' && a.operator === '/' && isPeriod(a.right))
      return 'minuteStart(at), hourStart(at) or dayStart(at)';
  }
  // t % 86_400_000, except an assertion that a value sits on an edge (`expect(t % DAY).toBe(0)`)
  if (node.type === 'BinaryExpression' && node.operator === '%' && isPeriod(node.right) && !insideExpect(node))
    return 'minuteStart(at), hourStart(at) or dayStart(at)';
  // d.toISOString().slice(0, 10); a local datetime-local value (shifted by getTimezoneOffset) is the browser's own, not UTC
  if (isMethod(node, undefined, 'slice') && isMethod(node.callee.object, undefined, 'toISOString')) {
    const [s, e] = node.arguments;
    const local = has(node.callee.object, (n) => isMethod(n, undefined, 'getTimezoneOffset'));
    if (!local && s?.type === 'Literal' && s.value === 0 && e?.type === 'Literal' && SLICE_ENDS[e.value])
      return `${SLICE_ENDS[e.value]}(at)`;
  }
  // d.setUTCHours(0, 0, 0, 0) or setUTCHours(24, …): midnight UTC
  if (isMethod(node, undefined, 'setUTCHours') && node.arguments[0]?.type === 'Literal' && [0, 24].includes(node.arguments[0].value))
    return 'dayStart(at)';
  return null;
};

const noHandClock = {
  meta: {
    type: 'problem',
    docs: { description: 'A journey reads time from clock.mjs and compares a candle only once its minute has closed.' },
  },
  create(context) {
    const file = context.filename ?? context.getFilename();
    if (!REAL_APP.test(file) || HELPER_FILE.test(file)) return {};
    const check = (node) => {
      const use = handBoundary(node);
      if (use)
        context.report({
          node,
          message: `a minute or day boundary worked by hand: use ${use} ${FROM}, the one place a period's edge is worked`,
        });
    };
    return {
      BinaryExpression: check,
      CallExpression(node) {
        check(node);
        const name = calleeName(node);
        if (!name || name === 'closedMinute' || !CANDLE_READ.test(name)) return;
        const clocks = node.arguments.filter((a) => a.type === 'Identifier' && clockBinding(node, a.name));
        if (clocks.length === 0) return;
        const names = new Set(clocks.map((a) => a.name));
        const owner = clockBinding(node, clocks[0].name);
        const closedFirst = has(
          owner.body,
          (n) =>
            n.type === 'CallExpression' &&
            calleeName(n) === 'closedMinute' &&
            pos(n) < pos(node) &&
            n.arguments.some((a) => a.type === 'Identifier' && names.has(a.name)),
        );
        if (closedFirst) return;
        context.report({
          node,
          message:
            `${name}(…) reads a candle at ${[...names].join(', ')}, a clock read whose minute may still be open: a trade moves ` +
            `an open candle's close between two reads. First \`await closedMinute(page, ${clocks.at(-1).name})\` ${FROM}`,
        });
      },
    };
  },
};

export const handClockRules = { 'no-hand-clock': noHandClock };
