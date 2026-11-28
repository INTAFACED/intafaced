// garden/no-runtime-swap: a service is put together in one place at start-up; a module never replaces a function on another
// module's class at run time. Installers used to swap methods in import order (`proto.placeOrder = async function …` on
// TradeService's prototype), so which body ran depended on which file was imported last; each is now a layer, a function
// from the class to a subclass (services/svc-trade/src/spot/fok-place.ts `withFokPlace`), applied in index.ts with
// `layered()` (services/svc-trade/src/layered.ts; tooling/codemod/runtime-swap/rewrite.mjs moved them). Counted, outside
// tests, by syntax:
//   - `Imported.prototype.m = …` (also `??=`, `||=`, `Imported.prototype['m'] = …`), where `Imported` is an imported binding,
//     a function parameter (`ctor: typeof TradeService`) or an alias of either;
//   - the same through an alias of the prototype: `const proto = ctor.prototype as unknown as {…}; const p = proto;
//     p.m = …`;
//   - `Object.assign(<prototype>, { m: … })` (one per member) and `Object.defineProperty(<prototype>, 'm', …)`.
// Not counted: a flag (`proto[FLAG] = true`, a computed key or a literal value), a class declared in the same file, a
// browser global's prototype (a polyfill), and plain helpers that touch no prototype.
// Judged by the lint ratchet: the copies on main (none left) are each file's ceiling and a file the change adds starts at
// zero (tooling/ci/lint-ratchet.mjs, tooling/lint/ratchet.json
// failInAddedFiles). `node tooling/lint/count-rule.mjs garden/no-runtime-swap` prints how many are left and where.
const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__|__fixtures__)\/)/u;
const FIX =
  'put the behaviour in the class itself, or compose it where the service is assembled at start-up (pass the part in, ' +
  'wrap it in a new object, or write a layer `withX(Base) { return class extends Base {…} }` and apply it in index.ts ' +
  "with layered(), as services/svc-trade/src/spot/fok-place.ts does), instead of replacing another module's method at run time";

const isFn = (n) => n?.type === 'ArrowFunctionExpression' || n?.type === 'FunctionExpression';
/** Strip `as T`, `satisfies T`, `x!` and parentheses. */
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
const propName = (m) =>
  !m.computed && m.property?.type === 'Identifier'
    ? m.property.name
    : m.computed && m.property?.type === 'Literal' && typeof m.property.value === 'string'
      ? m.property.value
      : undefined;
const paramNames = (fn) => {
  const out = [];
  for (const p of fn.params ?? []) {
    let x = p.type === 'TSParameterProperty' ? p.parameter : p;
    if (x?.type === 'AssignmentPattern') x = x.left;
    if (x?.type === 'Identifier') out.push(x.name);
  }
  return out;
};
/** A value that is just a flag: a literal, `undefined`, a negated literal (`!0`). */
const isFlagValue = (v) => {
  const x = bare(v);
  return (
    x?.type === 'Literal' ||
    (x?.type === 'Identifier' && x.name === 'undefined') ||
    (x?.type === 'UnaryExpression' && bare(x.argument)?.type === 'Literal')
  );
};

const noRuntimeSwap = {
  meta: { type: 'suggestion', docs: { description: "No module replaces a method on another module's class at run time." } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (TEST_FILE.test(file)) return {};
    const imported = new Set();
    const localClasses = new Set();
    const classAliases = new Set(); // `const C = Imported`
    const protoAliases = new Set(); // `const proto = C.prototype as …`, `const p = proto`
    const fnStack = [];

    const isParam = (name) => fnStack.some((fn) => paramNames(fn).includes(name));
    const isClassRef = (n) => {
      const x = bare(n);
      if (x?.type !== 'Identifier' || localClasses.has(x.name)) return false;
      return imported.has(x.name) || classAliases.has(x.name) || isParam(x.name);
    };
    /** `C.prototype` of a class from elsewhere, or an alias of one. */
    const isProto = (n) => {
      const x = bare(n);
      if (x?.type === 'Identifier') return protoAliases.has(x.name);
      if (x?.type === 'ConditionalExpression') return isProto(x.consequent) || isProto(x.alternate);
      return x?.type === 'MemberExpression' && propName(x) === 'prototype' && isClassRef(x.object);
    };
    const report = (node, member) =>
      context.report({ node, message: `\`${member}\` is replaced on another module's class at run time: ${FIX}` });

    const enter = (node) => fnStack.push(node);
    const leave = () => fnStack.pop();
    return {
      ImportDeclaration(node) {
        for (const s of node.specifiers ?? []) if (s.local?.name) imported.add(s.local.name);
      },
      ClassDeclaration(node) {
        if (node.id?.name) localClasses.add(node.id.name);
      },
      FunctionDeclaration: enter,
      'FunctionDeclaration:exit': leave,
      FunctionExpression: enter,
      'FunctionExpression:exit': leave,
      ArrowFunctionExpression: enter,
      'ArrowFunctionExpression:exit': leave,
      VariableDeclarator(node) {
        if (node.id?.type !== 'Identifier' || !node.init) return;
        if (isProto(node.init)) protoAliases.add(node.id.name);
        else if (isClassRef(node.init)) classAliases.add(node.id.name);
      },
      AssignmentExpression(node) {
        const left = node.left;
        if (left?.type !== 'MemberExpression') return;
        const name = propName(left);
        if (name === undefined || isFlagValue(node.right)) return;
        if (isProto(left.object)) report(node, name);
      },
      CallExpression(node) {
        const c = node.callee;
        if (c?.type !== 'MemberExpression' || bare(c.object)?.type !== 'Identifier' || bare(c.object).name !== 'Object') return;
        const how = propName(c);
        const [target, second] = node.arguments;
        if (!isProto(target)) return;
        if (how === 'defineProperty' && second?.type === 'Literal' && typeof second.value === 'string') report(node, second.value);
        if (how === 'assign')
          for (const src of node.arguments.slice(1))
            for (const p of src?.type === 'ObjectExpression' ? src.properties : [])
              if (p.type === 'Property' && (isFn(p.value) || p.method || !isFlagValue(p.value)) && !p.computed)
                report(p, p.key?.name ?? p.key?.value);
      },
    };
  },
};

export const runtimeSwapRules = { 'no-runtime-swap': noRuntimeSwap };
