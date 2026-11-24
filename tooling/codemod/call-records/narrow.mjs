// A caller's schema that names fewer fields than the router's answer: zod drops the rest when it parses, so the page
// never holds them (a session's refresh token). A record's call hands back the whole answer, so such a caller keeps its
// own schema (`callAs`), or stays by name where it can't.
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { bindingOf, load, resolveRelative, walk } from './ast.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
// Methods that keep an object's fields as they are: the fields are its receiver's.
const SAME = new Set([
  'strict',
  'strip',
  'describe',
  'nullable',
  'optional',
  'nullish',
  'readonly',
  'refine',
  'superRefine',
  'check',
  'brand',
  'default',
  'catch',
]);

/** Where an import names a file this reads: the app's own relative files, and contracts' sources. */
function fileOf(p, from) {
  if (from.startsWith('.')) return resolveRelative(p.file, from);
  const m = /^@intafaced\/contracts\/(.+)$/.exec(from);
  if (!m) return undefined;
  const f = join(REPO, 'packages/contracts/src', `${m[1]}.ts`);
  return existsSync(f) ? f : undefined;
}

/** The value a name holds where it is used: its const's initializer, here or in the file it is imported from. */
function valueOf(p, node) {
  const b = bindingOf(p, node, node.name);
  if (b.kind === 'var' && b.declarator.init) return [p, b.declarator.init];
  if (b.kind !== 'import' || b.typeOnly) return undefined;
  const file = fileOf(p, b.from);
  if (!file) return undefined;
  return topLevel(load(file), b.imported);
}

/** A file's own top-level const of that name, or one it re-exports from a file this reads: [parsed file, initializer]. */
function topLevel(q, name, depth = 0) {
  for (const stmt of q.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
    if (decl.type === 'VariableDeclaration')
      for (const d of decl.declarations) if (d.id.type === 'Identifier' && d.id.name === name && d.init) return [q, d.init];
    if (stmt.type === 'ExportNamedDeclaration' && stmt.source && depth < 4) {
      const s = stmt.specifiers.find((x) => (x.exported.name ?? x.exported.value) === name);
      const file = s && fileOf(q, stmt.source.value);
      if (file) return topLevel(load(file), s.local.name ?? s.local.value, depth + 1);
    }
  }
  return undefined;
}

/**
 * The field names of an object schema as written (`z.object({...})`, `.extend({...})`, a const or an import of one), or
 * undefined when they can't be read for sure (a spread, a computed key, `.passthrough()`, `.pick()`, a builder function).
 */
export function fieldsOf(p, node, depth = 0) {
  if (!node || depth > 12) return undefined;
  while (['TSAsExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression', 'TSNonNullExpression'].includes(node.type))
    node = node.expression;
  if (node.type === 'Identifier') {
    const v = valueOf(p, node);
    return v ? fieldsOf(v[0], v[1], depth + 1) : undefined;
  }
  if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression' || node.callee.computed) return undefined;
  const method = node.callee.property.name;
  const keys = (obj) => {
    if (obj?.type !== 'ObjectExpression') return undefined;
    const out = [];
    for (const prop of obj.properties) {
      if (prop.type !== 'Property' || prop.computed) return undefined;
      out.push(prop.key.name ?? prop.key.value);
    }
    return out;
  };
  if (method === 'object' && node.callee.object.type === 'Identifier' && node.callee.object.name === 'z') return keys(node.arguments[0]);
  if (method === 'extend') {
    const base = fieldsOf(p, node.callee.object, depth + 1);
    const more = keys(node.arguments[0]);
    return base && more ? [...new Set([...base, ...more])] : undefined;
  }
  if (SAME.has(method)) return fieldsOf(p, node.callee.object, depth + 1);
  return undefined;
}

/** The answer fields a caller's schema drops: those the router's answer names and the caller's doesn't, or none. */
export function droppedFields(callerP, callerNode, outputP, outputNode) {
  const caller = fieldsOf(callerP, callerNode);
  const answer = fieldsOf(outputP, outputNode);
  if (!caller || !answer) return [];
  return answer.filter((k) => !caller.includes(k));
}

/** A written record's `output` schema in its contracts file: [parsed file, node], or undefined. */
export function recordOutput(file, name) {
  const p = load(file);
  let found;
  walk(p.program, (n) => {
    if (found) return false;
    if (n.type !== 'VariableDeclarator' || n.id.name !== name) return;
    const call = n.init;
    const obj = call?.type === 'CallExpression' ? call.arguments[0] : undefined;
    const prop =
      obj?.type === 'ObjectExpression' ? obj.properties.find((x) => x.type === 'Property' && x.key.name === 'output') : undefined;
    if (prop) found = [p, prop.value];
    return false;
  });
  return found;
}

const UNWRAP = new Set(['AwaitExpression', 'ParenthesizedExpression', 'TSAsExpression', 'TSNonNullExpression']);
const isSafeParseOf = (p, call, arg) =>
  call?.type === 'CallExpression' &&
  call.callee.type === 'MemberExpression' &&
  !call.callee.computed &&
  call.callee.property.name === 'safeParse' &&
  call.arguments[0] === arg;

/**
 * Whether a call's answer is read with `.safeParse()`, straight or through the const it is kept in: its caller decides
 * what an answer it can't read means (a staff check reads it as "not staff"), where a record call refuses it as invalid.
 */
export function softlyParsed(p, call) {
  let node = call;
  let parent = p.parents.get(node);
  while (parent && UNWRAP.has(parent.type)) {
    node = parent;
    parent = p.parents.get(node);
  }
  if (isSafeParseOf(p, parent, node)) return true;
  if (parent?.type !== 'VariableDeclarator' || parent.init !== node || parent.id.type !== 'Identifier') return false;
  const name = parent.id.name;
  let scope = p.parents.get(parent);
  while (scope && !/Function|Program/.test(scope.type)) scope = p.parents.get(scope);
  let found = false;
  walk(scope, (m) => {
    if (found) return false;
    if (m.type === 'Identifier' && m.name === name && isSafeParseOf(p, p.parents.get(m), m)) found = true;
  });
  return found;
}
