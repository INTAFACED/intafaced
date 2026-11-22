// A guard that checks more than its scope: `scopedProcedure(...).use(({ ctx, next }) => { check(ctx); return next(); })`.
// Its extra check is the service's own function, so the record names it (`access.check`) and the mount takes it from the
// service's parts (`ServiceParts.checks`), where `scopedProcedure` runs it last, as the `.use()` did. Any other
// `.use()` (two statements, a check reading something other than `ctx`, a guard a record has no check option for) stays
// as it is, named by the caller.
import { bindingOf, resolveRelative } from './ast.mjs';

/**
 * The `.use()` call `node` as its base guard and its one check, or undefined when it is not that shape:
 * `{ base, check: { name, file } }`, `file` being where the check is declared (undefined for a local not exported).
 */
export function checkedUse(p, node) {
  if (node?.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return undefined;
  if (node.callee.computed || node.callee.property.name !== 'use' || node.arguments.length !== 1) return undefined;
  const fn = node.arguments[0];
  if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression') return undefined;
  const [param] = fn.params;
  if (fn.params.length !== 1 || param.type !== 'ObjectPattern') return undefined;
  const names = param.properties.map((x) => (x.type === 'Property' && x.shorthand ? x.key.name : undefined));
  if (names.length !== 2 || !names.includes('ctx') || !names.includes('next')) return undefined;
  if (fn.body.type !== 'BlockStatement' || fn.body.body.length !== 2) return undefined;
  const [first, last] = fn.body.body;
  // `check(ctx);` or `await check(ctx);`: the check reads the context alone, as a ServiceCheck does.
  let call = first.type === 'ExpressionStatement' ? first.expression : undefined;
  if (call?.type === 'AwaitExpression') call = call.argument;
  if (call?.type !== 'CallExpression' || call.callee.type !== 'Identifier') return undefined;
  if (call.arguments.length !== 1 || call.arguments[0].type !== 'Identifier' || call.arguments[0].name !== 'ctx') return undefined;
  // `return next();`: the context goes on unchanged.
  const ret = last.type === 'ReturnStatement' ? last.argument : undefined;
  if (ret?.type !== 'CallExpression' || ret.callee.type !== 'Identifier' || ret.callee.name !== 'next' || ret.arguments.length)
    return undefined;
  const name = call.callee.name;
  const b = bindingOf(p, call.callee, name);
  if (b.kind === 'import') {
    const file = resolveRelative(p.file, b.from);
    return file ? { base: node.callee.object, check: { name: b.imported, file, exported: true } } : undefined;
  }
  if (b.kind !== 'function' && b.kind !== 'var') return undefined;
  return { base: node.callee.object, check: { name, file: p.file, exported: b.exported } };
}

/** The base guard's access with the check added: only a `scope` record names a check, and only one. */
export function withCheck(access, check) {
  if (!access.text.startsWith("{ caller: 'scope'") || /\bcheck: '/.test(access.text)) return undefined;
  return { ...access, text: `${access.text.slice(0, -2)}, check: '${check.name}' }`, check };
}

/**
 * The parts a record naming its service's own check is mounted with, in the router file `file`: the file's own
 * `: ServiceParts` when it declares one, else `{ refusalOf, checks: { check } }` written at the mount from the service's
 * refusal reader and the check's export. Undefined when neither can be had (the call stays, named).
 */
export function partsFor(readers, file, guard, readerOf) {
  const declared = readers.find((r) => r.parts && r.file === file);
  if (declared) return declared;
  const check = guard.check;
  const reader = readerOf();
  if (!check || !reader || (!check.exported && check.file !== file)) return undefined;
  const imports = [
    ...(reader.file === file ? [] : [{ file: reader.file, name: reader.name }]),
    ...(check.file === file ? [] : [{ file: check.file, name: check.name }]),
  ];
  return { name: `{ refusalOf: ${reader.name}, checks: { ${check.name} } }`, file, imports };
}
