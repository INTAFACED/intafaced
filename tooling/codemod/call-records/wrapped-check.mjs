// A guard whose one check runs inside the service's own error mapper:
//   scopedProcedure('ops:read').use(async ({ ctx, next }) => mapped(async () => { await authority(ctx); return next({ ctx }); }))
// (svc-ops' outreach staff guards). It is guard-check.mjs's one-check shape with the check and `next()` wrapped in a
// function of the same file, so the record names the check (`access.check`) and the mount is handed the same check with
// `next()` taken out: `(ctx) => mapped(async () => { await authority(ctx); })`, written at the mount. `scopedProcedure`
// runs it last, as the `.use()` did, and passes its refusal on unchanged, so the wire is what the mapper sends today.
// The check is written where the record mounts, so every name in it must mean there what it means at the guard; a
// wrapper from another file, a check reading more than `ctx`, or anything after it but `return next()` stays, named.
import { bindingOf } from './ast.mjs';

const isFn = (n) => n?.type === 'ArrowFunctionExpression' || n?.type === 'FunctionExpression';

/** `{ ctx, next }`, as two shorthand names. */
function ctxNext(fn) {
  const [param] = fn.params;
  if (fn.params.length !== 1 || param.type !== 'ObjectPattern') return false;
  const names = param.properties.map((x) => (x.type === 'Property' && x.shorthand ? x.key.name : undefined));
  return names.length === 2 && names.includes('ctx') && names.includes('next');
}

/** The one expression a function returns: an expression body, or a block of one `return`. */
function returnedExpr(fn) {
  if (fn.body.type !== 'BlockStatement') return fn.body;
  const [only] = fn.body.body;
  return fn.body.body.length === 1 && only.type === 'ReturnStatement' ? only.argument : undefined;
}

/** `return next();` or `return next({ ctx });`: the context goes on unchanged. */
function returnsNext(stmt) {
  const ret = stmt?.type === 'ReturnStatement' ? stmt.argument : undefined;
  if (ret?.type !== 'CallExpression' || ret.callee.type !== 'Identifier' || ret.callee.name !== 'next') return false;
  if (ret.arguments.length === 0) return true;
  const [arg] = ret.arguments;
  if (ret.arguments.length !== 1 || arg.type !== 'ObjectExpression' || arg.properties.length !== 1) return false;
  const [prop] = arg.properties;
  return prop.type === 'Property' && prop.shorthand && prop.key.name === 'ctx';
}

/** `check(ctx);` or `await check(ctx);`: the call, or undefined. */
function checkCall(stmt) {
  let call = stmt?.type === 'ExpressionStatement' ? stmt.expression : undefined;
  if (call?.type === 'AwaitExpression') call = call.argument;
  if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') return undefined;
  if (call.arguments.length !== 1 || call.arguments[0].type !== 'Identifier' || call.arguments[0].name !== 'ctx') return undefined;
  return call;
}

/**
 * The `.use()` call `node` as its base guard and its one wrapped check, or undefined when it is not that shape:
 * `{ base, check: { name, file, exported: false, inline, names } }`, `inline` being the check as the mount is handed
 * it and `names` the bindings it reads (the wrapper and the check), each as the guard sees it and where.
 */
export function wrappedUse(p, node) {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return undefined;
  if (node.callee.computed || node.callee.property.name !== 'use' || node.arguments.length !== 1) return undefined;
  const fn = node.arguments[0];
  if (!isFn(fn) || !ctxNext(fn)) return undefined;
  const wrap = returnedExpr(fn);
  if (wrap?.type !== 'CallExpression' || wrap.callee.type !== 'Identifier' || wrap.arguments.length !== 1) return undefined;
  const inner = wrap.arguments[0];
  if (!isFn(inner) || inner.params.length !== 0 || inner.body.type !== 'BlockStatement' || inner.body.body.length !== 2) return undefined;
  const [first, last] = inner.body.body;
  const call = checkCall(first);
  if (!call || !returnsNext(last)) return undefined;
  // The wrapper is the service's own, in this file: a function or a const, never an import or a parameter.
  const wrapper = bindingOf(p, wrap.callee, wrap.callee.name);
  if (wrapper.kind !== 'function' && wrapper.kind !== 'var') return undefined;
  const check = bindingOf(p, call.callee, call.callee.name);
  if (check.kind === 'global' || check.kind === 'type' || check.kind === 'other') return undefined;
  const asyncInner = inner.async ? 'async ' : '';
  const inline = `(ctx) => ${wrap.callee.name}(${asyncInner}() => { ${p.src.slice(first.start, first.end)} })`;
  return {
    base: node.callee.object,
    check: {
      name: call.callee.name,
      file: p.file,
      exported: false,
      inline,
      names: [
        { name: wrap.callee.name, binding: wrapper, at: wrap.callee },
        { name: call.callee.name, binding: check, at: call.callee },
      ],
    },
  };
}

/** The names a parameter pattern binds. */
function bound(pattern) {
  if (!pattern) return [];
  if (pattern.type === 'Identifier') return [pattern.name];
  if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap((x) => bound(x.type === 'RestElement' ? x.argument : x.value));
  if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(bound);
  if (pattern.type === 'AssignmentPattern') return bound(pattern.left);
  if (pattern.type === 'RestElement') return bound(pattern.argument);
  if (pattern.type === 'TSParameterProperty') return bound(pattern.parameter);
  return [];
}

/** The nearest function around `node` whose parameters bind `name`. */
function paramOwner(p, node, name) {
  for (let n = p.parents.get(node); n; n = p.parents.get(n))
    if (/Function/.test(n.type) && n.params.some((x) => bound(x).includes(name))) return n;
  return undefined;
}

/** The declaration a binding stands for: its declarator, declaration or import specifier, or a parameter's function. */
const siteOf = (p, at, name, b) => (b.kind === 'param' ? paramOwner(p, at, name) : (b.declarator ?? b.declaration ?? b.specifier));

/**
 * Whether a wrapped check written at `node` (the procedure the record mounts in place of) reads what it read at its
 * guard: the same file, and each name it reads bound to the same declaration there.
 */
export function wrappedInScope(p, node, check) {
  return (
    check.file === p.file &&
    check.names.every(({ name, binding, at }) => {
      const here = bindingOf(p, node, name);
      return here.kind === binding.kind && siteOf(p, node, name, here) === siteOf(p, at, name, binding);
    })
  );
}
