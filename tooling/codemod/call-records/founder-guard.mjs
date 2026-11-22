// A founder guard: the service's own `founderProcedure(...)`, built on contracts' `protectedProcedure`, which reads the
// founder entitlement live and puts the founder's user id on the context (`founderUserId`). A record names it as
// `{ caller: 'founder' }` and the mount takes it from the service's parts (`ServiceParts.founder`), so the record mounts
// where the procedure stood, handed the same guard expression the procedure was built from (`founder`, or the
// `founderProcedure(deps.founderAuthority)` call itself). Any other guard named `founder` is read as what it is.
import { bindingOf, load, resolveRelative, text } from './ast.mjs';
import { exportOf } from './defined.mjs';

const unwrap = (n) =>
  n && (n.type === 'ParenthesizedExpression' || n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression') ? unwrap(n.expression) : n;

/** True when the function `fn` (in `p`) returns `protectedProcedure.use(...)` as its last statement. */
function buildsOnProtected(p, fn) {
  const body = fn?.body;
  const last = body?.type === 'BlockStatement' ? body.body.at(-1) : undefined;
  const ret = unwrap(last?.type === 'ReturnStatement' ? last.argument : body?.type === 'BlockStatement' ? undefined : body);
  if (ret?.type !== 'CallExpression' || ret.callee.type !== 'MemberExpression' || ret.callee.computed) return false;
  if (ret.callee.property.name !== 'use' || ret.callee.object.type !== 'Identifier') return false;
  const base = ret.callee.object;
  const b = bindingOf(p, base, base.name);
  return base.name === 'protectedProcedure' && b.kind === 'import' && /^@intafaced\/contracts(\/trpc)?$/.test(b.from ?? '');
}

/** True when `id` names the service's own `founderProcedure`: a function of its own files, built on `protectedProcedure`. */
function isFounderBuilder(p, id) {
  if (id?.type !== 'Identifier') return false;
  const b = bindingOf(p, id, id.name);
  if (b.kind === 'function') return id.name === 'founderProcedure' && buildsOnProtected(p, b.declaration);
  if (b.kind !== 'import' || b.imported !== 'founderProcedure') return false;
  const file = resolveRelative(p.file, b.from);
  if (!file) return false;
  const found = exportOf(load(file), 'founderProcedure');
  if (!found) return false;
  const fn = found.q.program.body
    .map((stmt) => (stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt))
    .find((d) => d?.type === 'FunctionDeclaration' && d.id?.name === found.name);
  return Boolean(fn) && buildsOnProtected(found.q, fn);
}

/** The parameter `name` of the nearest function around `node` that declares it, with its type, or undefined. */
function paramOf(p, node, name) {
  for (let n = p.parents.get(node); n; n = p.parents.get(n)) {
    if (!/Function/.test(n.type)) continue;
    const param = n.params.find((x) => x.type === 'Identifier' && x.name === name);
    if (param) return param;
  }
  return undefined;
}

/** True when a type is `ReturnType<typeof founderProcedure>`, directly or through a local alias. */
function isFounderType(p, t, depth = 0) {
  if (t?.type !== 'TSTypeReference' || t.typeName.type !== 'Identifier' || depth > 4) return false;
  if (t.typeName.name === 'ReturnType') {
    const [arg] = t.typeArguments?.params ?? [];
    return arg?.type === 'TSTypeQuery' && isFounderBuilder(p, arg.exprName);
  }
  const b = bindingOf(p, t.typeName, t.typeName.name);
  return b.kind === 'type' && b.declaration.type === 'TSTypeAliasDeclaration' && isFounderType(p, b.declaration.typeAnnotation, depth + 1);
}

/** True when the guard expression `node` stands for the service's founder guard. */
function isFounderGuard(p, node, env = undefined, depth = 0) {
  node = unwrap(node);
  if (!node || depth > 8) return false;
  if (node.type === 'CallExpression') return node.callee.type === 'Identifier' && isFounderBuilder(p, node.callee);
  if (node.type !== 'Identifier') return false;
  const b = bindingOf(p, node, node.name);
  if (b.kind === 'param') {
    if (env?.has(node.name)) {
      const bound = env.get(node.name);
      return isFounderGuard(bound.p, bound.node, bound.env, depth + 1);
    }
    return isFounderType(p, paramOf(p, node, node.name)?.typeAnnotation?.typeAnnotation);
  }
  if (b.kind === 'var' && b.declaration?.kind === 'const' && b.declarator.id.type === 'Identifier' && b.declarator.init)
    return isFounderGuard(p, b.declarator.init, undefined, depth + 1);
  return false;
}

/**
 * The record's access for a procedure built on the founder guard `node` (in the router file `p`, where the record
 * mounts), or undefined when it is not one: `founder` carries the guard's own text, which the mount is handed.
 */
export function founderAccess(p, node) {
  return isFounderGuard(p, node) ? { text: "{ caller: 'founder' }", founder: text(p, unwrap(node)) } : undefined;
}

/** The parts a founder record is mounted with: the service's refusal reader and the guard the procedure stood on. */
export function founderPartsFor(file, guard, reader) {
  if (!reader) return undefined;
  return {
    name: `{ refusalOf: ${reader.name}, ${guard.founder === 'founder' ? 'founder' : `founder: ${guard.founder}`} }`,
    file,
    imports: reader.file === file ? [] : [{ file: reader.file, name: reader.name }],
  };
}
