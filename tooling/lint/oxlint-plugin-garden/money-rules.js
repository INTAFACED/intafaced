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
  meta: { type: 'problem', docs: { description: 'A money field that arrives as a number is refused, never converted.' } },
  create(context) {
    if (isTest(context)) return {};
    const check = (node) => {
      for (const c of checksIn(node.test)) {
        const numberBranch = c.negated ? node.alternate : node.consequent;
        if (numberBranch && converts(numberBranch)) {
          context.report({ node: node.test, message: `\`${c.name}\` accepted as a number and converted: ${NUMBER_MONEY_MESSAGE}` });
          return;
        }
      }
    };
    return { ConditionalExpression: check, IfStatement: check };
  },
};

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
