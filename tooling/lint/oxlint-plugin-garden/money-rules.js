// Two money mistakes the CI review kept finding after a push, held at the moment of writing instead.
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__)\/)/u;
const isTest = (context) =>
  TEST_FILE.test(
    String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/'),
  );

/** Walk an expression tree (no parent links), calling visit on each node; visit returns true to stop. */
function some(node, visit) {
  if (!node || typeof node !== 'object') return false;
  if (typeof node.type === 'string' && visit(node)) return true;
  for (const k in node) {
    if (k === 'parent' || k === 'loc' || k === 'range') continue;
    const v = node[k];
    if (Array.isArray(v)) {
      if (v.some((x) => some(x, visit))) return true;
    } else if (v && typeof v === 'object' && typeof v.type === 'string' && some(v, visit)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-number-money: `typeof x.amount === 'number'` whose number branch converts the value instead of refusing it.
const MONEY = /(?:^|[a-z])(?:amount|balance|fee|price|notional|total|minor|cents|units)s?$/iu;
const propName = (m) =>
  m?.type === 'MemberExpression'
    ? m.computed
      ? m.property?.type === 'Literal' && typeof m.property.value === 'string'
        ? m.property.value
        : null
      : m.property?.name
    : null;

/** For `typeof <x>.<money> ===/!== 'number'`, the member's name and whether the check is negated; else null. */
function moneyNumberCheck(n) {
  if (n?.type !== 'BinaryExpression' || !['===', '==', '!==', '!='].includes(n.operator)) return null;
  const [t, lit] = n.left?.type === 'UnaryExpression' ? [n.left, n.right] : [n.right, n.left];
  if (t?.type !== 'UnaryExpression' || t.operator !== 'typeof') return null;
  if (lit?.type !== 'Literal' || lit.value !== 'number') return null;
  let arg = t.argument;
  if (arg?.type === 'ChainExpression') arg = arg.expression;
  const name = propName(arg);
  if (!name || !MONEY.test(name)) return null;
  return { name, negated: n.operator.startsWith('!') };
}
/** The money checks in a condition joined by && / ||, with their sense. */
function checksIn(test) {
  if (test?.type === 'LogicalExpression') return [...checksIn(test.left), ...checksIn(test.right)];
  const c = moneyNumberCheck(test);
  return c ? [c] : [];
}
const CONVERTERS = new Set(['String', 'Number', 'BigInt', 'Decimal', 'Big', 'BigNumber', 'parseFloat', 'parseInt']);
const CONVERT_METHODS = new Set(['toString', 'toFixed', 'toPrecision', 'toLocaleString']);
/** Does this branch turn a number into money (String(n), n.toFixed(), `${n}`, new Decimal(n)) rather than refuse it? */
const converts = (branch) =>
  some(branch, (n) => {
    if (n.type === 'ThrowStatement') return false;
    if ((n.type === 'CallExpression' || n.type === 'NewExpression') && n.callee?.type === 'Identifier' && CONVERTERS.has(n.callee.name))
      return true;
    if (n.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && CONVERT_METHODS.has(n.callee.property?.name)) return true;
    if (n.type === 'TemplateLiteral' && n.expressions.length > 0) return true;
    return false;
  });

const NUMBER_MONEY_MESSAGE =
  'money is never a number at the wire: refuse it (AGENTS.md floor 2); parse the body with the contract’s decimal-string schema from @intafaced/contracts';

const noNumberMoney = {
  meta: {
    type: 'problem',
    docs: {
      description: 'A money field that arrives as a number is refused, never converted; the customer app never makes money a float.',
    },
  },
  create(context) {
    // A test-like file in a money folder is judged as the old scanners judged it: only *.test.* files were left out.
    if (isTest(context)) return /\.test\.[cm]?[jt]sx?$/u.test(String(context.filename)) ? {} : customerFloats(context, true);
    const check = (node) => {
      for (const c of checksIn(node.test)) {
        const numberBranch = c.negated ? node.alternate : node.consequent;
        if (numberBranch && converts(numberBranch)) {
          context.report({ node: node.test, message: `\`${c.name}\` accepted as a number and converted: ${NUMBER_MONEY_MESSAGE}` });
          return;
        }
      }
    };
    return { ConditionalExpression: check, IfStatement: check, ...customerFloats(context) };
  },
};

// The customer app never turns a money value into a float. Everywhere in it: Number(), parseFloat() or unary + of a value
// whose name says money. In the folders whose old scanner tests this replaced (data/ but its chart and sparkline files, the
// desk, the Options room): every Number(), parseFloat(), .toFixed() and unary +. A value drawn on a chart takes the one
// exit, chartValue() in shared/chart-value.ts, whose result never becomes text, a body or money again.
const CUSTOMER = /\/apps\/customer\/src\/(.+)$/u;
const SOURCE = /\.tsx?$/u;
const STRICT = [
  (rel) => rel.startsWith('data/') && !rel.split('/').some((d) => d.startsWith('__')) && !/chart|sparkline/iu.test(rel.split('/').pop()),
  (rel) => /^screens\/trade\/desk\/[^/]+$/u.test(rel),
  (rel) => /^screens\/trade\/options\/[^/]+$/u.test(rel),
];
const MONEY_WORDS = new Set(
  'amount balance fee price notional total minor cents units cost pnl margin collateral equity premium strike payout principal volume size qty quantity px sz mark bid ask mid last spot oracle high low'.split(
    ' ',
  ),
);
const NOT_MONEY_WORDS = new Set(
  'bps pct percent ratio rate count index ms seconds places digits decimals precision width height page pages contrast seen'.split(' '),
);
/** Callback parameters that are the elements of a money-named array (`amounts.reduce((s, x) => s + Number(x))`), with the
 * array's name; set while the call's callback is walked. */
let heldMoney = new Map();
const CANDLE_FIELDS = new Set(['o', 'h', 'l', 'c', 'v']);
const unwrap = (n) =>
  ['ChainExpression', 'TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression'].includes(n?.type)
    ? unwrap(n.expression)
    : n;
/** The value's name when it says money: a money word anywhere in it (`priceUsd`, `amount_in`) and no rate word (`feeBps`),
 * or a candle's field (`bar.c`); else null. */
function moneyName(arg) {
  const n = unwrap(arg);
  if (n?.type === 'Identifier' && heldMoney.get(n.name)?.length) return `${n.name} (an element of ${heldMoney.get(n.name).at(-1)})`;
  if (n?.type === 'MemberExpression' && !n.computed && CANDLE_FIELDS.has(n.property?.name))
    return `${nameOf(n.object) ?? '…'}.${n.property.name}`;
  const name = nameOf(n);
  if (!name) return null;
  const parts = name
    .split(/_|-|(?<=[a-z0-9])(?=[A-Z])/u)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
  if (parts.some((w) => NOT_MONEY_WORDS.has(w))) return null;
  return parts.some((w) => MONEY_WORDS.has(w) || (w.endsWith('s') && MONEY_WORDS.has(w.slice(0, -1)))) ? name : null;
}
const EXIT = 'chartValue';
const EXIT_FILE = 'shared/chart-value.ts';
const FLOAT_FIX =
  'keep money a decimal string and compute with parseAmount/formatAmount (@intafaced/money-math) or the data/decimal helpers ' +
  '(AGENTS.md floor 2); a value drawn on a chart goes through chartValue() from shared/chart-value';
const EXIT_FIX =
  'chartValue() is the chart’s own float and never becomes text, a request body or money again: send or show the decimal string it was made from';
const TEXT_CALLS = new Set(['String', 'BigInt', 'Decimal', 'Big', 'BigNumber', 'parseAmount', 'formatAmount', 'displayAmount']);
const TEXT_METHODS = new Set(['toString', 'toFixed', 'toPrecision', 'toLocaleString', 'format', 'stringify']);

/** The name a value goes by: `amount`, `order.price`, `amount.trim()`, `formatAmount(x)`; null for arithmetic. */
function nameOf(n) {
  switch (n?.type) {
    case 'Identifier':
      return n.name;
    case 'MemberExpression':
      return propName(n) ?? (n.computed ? nameOf(n.object) : null);
    case 'CallExpression':
      if (n.callee?.type === 'Identifier' && ['String', 'Number'].includes(n.callee.name)) return nameOf(n.arguments[0]);
      return n.callee?.type === 'MemberExpression' ? nameOf(n.callee.object) : n.callee?.type === 'Identifier' ? n.callee.name : null;
    case 'TemplateLiteral':
      return n.expressions.length === 1 && n.quasis.every((q) => q.value?.cooked === '') ? nameOf(n.expressions[0]) : null;
    case 'LogicalExpression':
      return nameOf(n.left);
    case 'ChainExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
      return nameOf(n.expression);
    default:
      return null;
  }
}
/** `Number(x)`, `globalThis.Number(x)`, `new Number(x)`, `parseFloat(x)`, `Number.parseFloat(x)`: the call's kind, else null. */
function floatCall(n) {
  const c = n.callee;
  const name = c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' && !c.computed ? c.property?.name : null;
  if (name === 'parseFloat') return 'parseFloat()';
  if (name === 'parseInt') return 'parseInt()';
  if (name !== 'Number') return null;
  if (c.type === 'MemberExpression' && !['globalThis', 'window', 'self'].includes(c.object?.name)) return null;
  return 'Number()';
}

function customerFloats(context, strictOnly = false) {
  const path = String(context.filename).split('\\').join('/');
  const rel = CUSTOMER.exec(path)?.[1];
  if (!rel || !SOURCE.test(rel)) return {};
  const strict = STRICT.some((inFolder) => inFolder(rel));
  if (strictOnly && !strict) return {};
  const exitFile = rel === EXIT_FILE;
  const exitValues = new Set(); // local consts that hold a chartValue() result
  const exitNames = new Set([EXIT]); // chartValue and the local names it is imported as
  heldMoney = new Map();
  const held = []; // per call: the callback parameters it put in heldMoney
  const exitSpaces = new Set(); // `import * as ns`: ns.chartValue()
  const isExit = (n) =>
    n?.type === 'CallExpression' &&
    ((n.callee?.type === 'Identifier' && exitNames.has(n.callee.name)) ||
      (n.callee?.type === 'MemberExpression' &&
        !n.callee.computed &&
        exitSpaces.has(n.callee.object?.name) &&
        n.callee.property?.name === EXIT));
  /** Is this value a chartValue() result: the call, a const holding one, or arithmetic, Math.* or a branch of them?
   * A value the chart computes from one (a pixel from priceToCoordinate) is not. */
  const holdsExit = (n) => {
    switch (n?.type) {
      case 'CallExpression':
        return isExit(n) || (n.callee?.type === 'MemberExpression' && n.callee.object?.name === 'Math' && n.arguments.some(holdsExit));
      case 'Identifier':
        return exitValues.has(n.name);
      case 'BinaryExpression':
      case 'LogicalExpression':
        return holdsExit(n.left) || holdsExit(n.right);
      case 'UnaryExpression':
        return holdsExit(n.argument);
      case 'ConditionalExpression':
        return holdsExit(n.consequent) || holdsExit(n.alternate);
      case 'ArrayExpression':
        return n.elements.some(holdsExit);
      case 'ObjectExpression':
        return n.properties.some((p) => holdsExit(p.type === 'Property' ? p.value : p.argument));
      case 'SpreadElement':
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
      case 'TSSatisfiesExpression':
      case 'ParenthesizedExpression':
        return holdsExit(n.argument ?? n.expression);
      default:
        return false;
    }
  };
  let inExit = 0; // inside chartValue's own body, in its own file
  const enterFn = (node) => {
    if (exitFile && functionName(node) === EXIT) inExit += 1;
  };
  const leaveFn = (node) => {
    if (exitFile && functionName(node) === EXIT) inExit -= 1;
  };
  const float = (node, kind, arg, byNameOnly = kind.includes('parseInt')) => {
    if (inExit) return;
    const name = moneyName(arg);
    if (name) context.report({ node, message: `\`${name}\` is money and ${kind} makes it a float: ${FLOAT_FIX}` });
    else if (strict && !byNameOnly)
      context.report({ node, message: `${kind} in a money folder (data/, the desk, the Options room) makes a float: ${FLOAT_FIX}` });
  };
  const leak = (node, what) => context.report({ node, message: `${what} of a chartValue() result: ${EXIT_FIX}` });
  return {
    FunctionDeclaration: enterFn,
    'FunctionDeclaration:exit': leaveFn,
    VariableDeclarator(node) {
      if (node.id?.type === 'Identifier' && isFunction(node.init)) enterFn(node);
      else if (node.id?.type === 'Identifier' && holdsExit(node.init)) exitValues.add(node.id.name);
    },
    'VariableDeclarator:exit'(node) {
      if (node.id?.type === 'Identifier' && isFunction(node.init)) leaveFn(node);
    },
    CallExpression(node) {
      const kind = floatCall(node);
      if (kind) return void (node.arguments[0] && float(node, kind, node.arguments[0]));
      const c = node.callee;
      const method = c?.type === 'MemberExpression' && !c.computed ? c.property?.name : null;
      const array = ARRAY_METHODS.has(method) ? moneyName(c.object) : null;
      const fn = node.arguments[0];
      if (array && floatFn(fn)) float(node, `.${method}(${floatFn(fn)})`, c.object, true);
      if (array && isFunction(fn)) {
        // The callback's element is the array's: `amounts.map((p) => { return Number(p); })` is judged as `Number(amount)`.
        const params = (method.startsWith('reduce') ? [fn.params[1]] : method === 'sort' ? fn.params.slice(0, 2) : [fn.params[0]])
          .flatMap((x) => (x?.type === 'ArrayPattern' ? x.elements : [x]))
          .filter((x) => x?.type === 'Identifier')
          .map((x) => x.name);
        for (const name of params) heldMoney.set(name, [...(heldMoney.get(name) ?? []), nameOf(c.object) ?? array]);
        held.push([node, params]);
      }
      if (c?.type === 'MemberExpression' && c.object?.name === 'Array' && c.property?.name === 'from' && floatFn(node.arguments[1]))
        float(node, `Array.from(…, ${floatFn(node.arguments[1])})`, node.arguments[0], true);
      if (strict && c?.type === 'MemberExpression' && !c.computed && c.property?.name === 'toFixed') float(node, '.toFixed()', c.object);
      if (c?.type === 'Identifier' && TEXT_CALLS.has(c.name) && node.arguments.some(holdsExit)) leak(node, `${c.name}()`);
      if (c?.type === 'MemberExpression' && !c.computed && TEXT_METHODS.has(c.property?.name)) {
        if (holdsExit(c.object)) leak(node, `.${c.property.name}()`);
        else if (['format', 'stringify'].includes(c.property.name) && node.arguments.some(holdsExit)) leak(node, `.${c.property.name}()`);
      }
    },
    ForOfStatement(node) {
      const array = moneyName(node.right);
      const id = node.left?.type === 'VariableDeclaration' ? node.left.declarations[0]?.id : null;
      if (!array || !id) return;
      const params = (id.type === 'ArrayPattern' ? id.elements : [id]).filter((x) => x?.type === 'Identifier').map((x) => x.name);
      for (const name of params) heldMoney.set(name, [...(heldMoney.get(name) ?? []), nameOf(node.right) ?? array]);
      held.push([node, params]);
    },
    'ForOfStatement:exit'(node) {
      if (held.at(-1)?.[0] !== node) return;
      for (const name of held.pop()[1]) heldMoney.get(name)?.pop();
    },
    JSXExpressionContainer(node) {
      if (['JSXElement', 'JSXFragment'].includes(node.parent?.type) && holdsExit(node.expression)) leak(node, 'JSX text');
    },
    'CallExpression:exit'(node) {
      if (held.at(-1)?.[0] !== node) return;
      for (const name of held.pop()[1]) heldMoney.get(name)?.pop();
    },
    ImportNamespaceSpecifier(node) {
      exitSpaces.add(node.local.name);
    },
    ImportSpecifier(node) {
      if ((node.imported?.name ?? node.imported?.value) === EXIT) exitNames.add(node.local.name);
    },
    NewExpression(node) {
      if (node.callee?.type === 'Identifier' && node.callee.name === 'Number' && node.arguments[0])
        float(node, 'new Number()', node.arguments[0]);
      if (node.callee?.type === 'Identifier' && TEXT_CALLS.has(node.callee.name) && node.arguments.some(holdsExit))
        leak(node, `new ${node.callee.name}()`);
    },
    UnaryExpression(node) {
      if (node.operator === '+') float(node, 'unary +', node.argument);
    },
    TemplateLiteral(node) {
      if (node.expressions.some(holdsExit)) leak(node, 'a template string');
    },
    BinaryExpression(node) {
      const text = (x) => (x?.type === 'Literal' && typeof x.value === 'string') || x?.type === 'TemplateLiteral';
      if (node.operator === '+' && ((text(node.left) && holdsExit(node.right)) || (text(node.right) && holdsExit(node.left))))
        leak(node, 'text joined to');
    },
  };
}
const ARRAY_METHODS = new Set([
  'map',
  'flatMap',
  'forEach',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'sort',
  'reduce',
  'reduceRight',
]);
/** `Number`, `parseFloat`, `parseInt`, `Number.parseFloat` or `Number.parseInt` passed as a callback: its name, else null. */
const floatFn = (fn) =>
  fn?.type === 'Identifier' && ['Number', 'parseFloat', 'parseInt'].includes(fn.name)
    ? fn.name
    : fn?.type === 'MemberExpression' &&
        !fn.computed &&
        fn.object?.name === 'Number' &&
        ['parseFloat', 'parseInt'].includes(fn.property?.name)
      ? `Number.${fn.property.name}`
      : null;
const isFunction = (n) => n?.type === 'ArrowFunctionExpression' || n?.type === 'FunctionExpression';
const functionName = (n) => (n?.type === 'FunctionDeclaration' ? n.id?.name : n?.type === 'VariableDeclarator' ? n.id?.name : null);

// ---------------------------------------------------------------------------------------------------------------------
// garden/no-random-request-key: an idempotency or request key built from randomUUID(), Date.now() or Math.random().
const KEY_NAME = /idempotenc|clientRequestId|requestKey|dedupe/iu;
const isRandomCall = (n) => {
  if (n.type !== 'CallExpression') return false;
  const c = n.callee;
  if (c?.type === 'Identifier') return c.name === 'randomUUID';
  if (c?.type !== 'MemberExpression' || c.computed) return false;
  const obj = c.object?.type === 'Identifier' ? c.object.name : null;
  const prop = c.property?.name;
  return prop === 'randomUUID' || (obj === 'Date' && prop === 'now') || (obj === 'Math' && prop === 'random');
};
const keyName = (n) => {
  if (!n) return null;
  if (n.type === 'Identifier') return n.name;
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value;
  if (n.type === 'MemberExpression') return propName(n) ?? null;
  return null;
};
const RANDOM_KEY_MESSAGE =
  'a request key must be a business key (`deposit:crypto-native:0xabc…`), stable across retries: build it from the ' +
  'business identity of the operation, never randomUUID(), Date.now() or Math.random() (AGENTS.md floor 3)';

/**
 * Is this value a random key? The random call itself, or a value built straight from one: a template or `+` holding it,
 * a method on it (`Date.now().toString(36)`), `String(...)` of it, a ternary branch, or a local const that is one.
 * Not random: a value held for reuse (`useRef(randomUUID())`, `useState(...)`) and a fallback after a held or caller-given
 * key (`held ?? randomUUID()`), since a retry then sends the same key.
 */
function randomValue(n, randomConsts) {
  if (!n) return false;
  const r = (x) => randomValue(x, randomConsts);
  switch (n.type) {
    case 'CallExpression':
      if (isRandomCall(n)) return true;
      if (n.callee?.type === 'MemberExpression') return r(n.callee.object);
      if (n.callee?.type === 'Identifier' && n.callee.name === 'String') return r(n.arguments[0]);
      return false;
    case 'MemberExpression':
      return r(n.object);
    case 'Identifier':
      return randomConsts.has(n.name);
    case 'TemplateLiteral':
      return n.expressions.some(r);
    case 'BinaryExpression':
      return n.operator === '+' && (r(n.left) || r(n.right));
    case 'ConditionalExpression':
      return r(n.consequent) || r(n.alternate);
    case 'LogicalExpression':
      return r(n.left);
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
    case 'ParenthesizedExpression':
    case 'ChainExpression':
      return r(n.expression);
    default:
      return false;
  }
}
/** A key put into React state (`setReview({ idempotencyKey: … })`) is held for reuse like a ref. */
const intoState = (prop) => {
  const call = prop.parent?.parent;
  return call?.type === 'CallExpression' && call.callee?.type === 'Identifier' && /^set[A-Z]/u.test(call.callee.name);
};

const noRandomRequestKey = {
  meta: { type: 'problem', docs: { description: 'Idempotency keys are business keys, not random values.' } },
  create(context) {
    if (isTest(context)) return {};
    const randomConsts = new Set(); // local consts whose value is a random key
    const pending = []; // key sites, judged at the end so a const declared further down still counts
    const site = (name, value, node) => {
      if (name && KEY_NAME.test(name) && value) pending.push([node, value, name]);
    };
    return {
      VariableDeclarator(node) {
        if (node.id?.type !== 'Identifier' || !node.init) return;
        if (randomValue(node.init, randomConsts)) randomConsts.add(node.id.name);
        site(node.id.name, node.init, node);
      },
      Property(node) {
        if ((!node.computed || node.key?.type === 'Literal') && !intoState(node)) site(keyName(node.key), node.value, node);
      },
      AssignmentExpression(node) {
        site(keyName(node.left), node.right, node);
      },
      'Program:exit'() {
        for (const [node, value, name] of pending)
          if (randomValue(value, randomConsts)) context.report({ node, message: `\`${name}\` is random: ${RANDOM_KEY_MESSAGE}` });
      },
    };
  },
};

export const moneyRules = { 'no-number-money': noNumberMoney, 'no-random-request-key': noRandomRequestKey };
