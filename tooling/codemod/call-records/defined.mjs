// Where a router part the reader meets is defined: a name a re-export passes on (`export { createXRouter } from
// './router.js'`, `export * from`), and a factory's parameter bound to the argument its call passes
// (`createAccountRouter(deps, createCompromiseRouter(...))` whose body mounts `compromised`). router.mjs asks it before it
// names a part unread.
import { load, resolveRelative } from './ast.mjs';

/** The file and local name that declare what `q` exports as `name`, through re-exports; undefined when none does. */
export function exportOf(q, name, depth = 0) {
  if (!q || depth > 8) return undefined;
  const stars = [];
  for (const stmt of q.program.body) {
    if (stmt.type === 'ExportNamedDeclaration' && stmt.declaration) {
      const d = stmt.declaration;
      if (d.id?.name === name) return { q, name };
      if (d.type === 'VariableDeclaration' && d.declarations.some((v) => v.id.name === name)) return { q, name };
    }
    if (stmt.type === 'ExportNamedDeclaration' && stmt.source && !stmt.exportKind?.startsWith('type')) {
      for (const s of stmt.specifiers ?? []) {
        const exportedName = s.exported.name ?? s.exported.value;
        if (exportedName !== name) continue;
        const file = resolveRelative(q.file, stmt.source.value);
        return file ? exportOf(load(file), s.local.name ?? s.local.value, depth + 1) : undefined;
      }
    }
    if (stmt.type === 'ExportAllDeclaration' && !stmt.exported && stmt.source) stars.push(stmt.source.value);
  }
  for (const from of stars) {
    const file = resolveRelative(q.file, from);
    const found = file ? exportOf(load(file), name, depth + 1) : undefined;
    if (found) return found;
  }
  return undefined;
}

/** A function's plain parameters bound to the arguments `call` passes, read in `p` (and `env`, the caller's own). */
export function boundParams(fn, call, p, env) {
  const bound = new Map();
  fn.params.forEach((param, i) => {
    if (param.type === 'Identifier' && call.arguments[i] && call.arguments[i].type !== 'SpreadElement')
      bound.set(param.name, { p, node: call.arguments[i], env });
  });
  return bound;
}
