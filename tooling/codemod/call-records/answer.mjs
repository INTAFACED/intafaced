// The answer schema of a record whose router writes no `.output()`: its callers' own, when every caller of the call parses
// the answer with the one same schema and that schema is pure zod (no check or change beyond its shape). The record's
// output is what `mountRecord` holds the handler's answer to (`.output(record.output)`), so the handler is held to the
// schema its callers already parsed with: an answer that fits it reaches them as before, and one that doesn't is refused
// at the service instead of at the caller. A caller with no schema (a reader function, or none) would lose every field the
// schema does not name, so its call stays, named; so does a call two callers parse with different schemas.
// A portal `list` caller parses one row (`list('x.y', item, input)`, a page of `item` on the wire): the record's answer is
// that page, `{ items: item[], nextCursor }`, the very shape the tool parsed with (`page` in the portal's schemas).
import { relative } from 'node:path';
import { bindingOf, load, resolveRelative } from './ast.mjs';

const at = (repo, s) => `${relative(repo, s.file)}:${s.line}`;

/** Through parentheses and `as`, and a local or imported const, to the declaration a schema expression stands for. */
function declarationOf(p, node, depth = 0) {
  if (!node || depth > 8) return { p, node };
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'ParenthesizedExpression')
    return declarationOf(p, node.expression, depth + 1);
  if (node.type !== 'Identifier') return { p, node };
  const b = bindingOf(p, node, node.name);
  if (b.kind === 'var' && b.declaration?.kind === 'const' && b.declarator.init) return declarationOf(p, b.declarator.init, depth + 1);
  return { p, node };
}

/**
 * A schema read through a namespace import (`p.teamMeSchema`, with `import * as p from './schemas'`), as the name its own
 * file declares or re-exports: the record writes that name and the closure follows it from there, as it does a named
 * import. Anything else is returned as it is.
 */
function throughNamespace(p, node) {
  if (node?.type !== 'MemberExpression' || node.computed || node.object?.type !== 'Identifier' || node.property?.type !== 'Identifier')
    return { p, node };
  const b = bindingOf(p, node.object, node.object.name);
  const file = b.kind === 'import' && b.imported === '*' ? resolveRelative(p.file, b.from) : undefined;
  if (!file) return { p, node };
  const q = load(file);
  const name = node.property.name;
  for (const stmt of q.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : undefined;
    if (decl?.type === 'VariableDeclaration')
      for (const d of decl.declarations) if (d.id.type === 'Identifier' && d.id.name === name) return { p: q, node: d.id };
    if (stmt.type === 'ExportNamedDeclaration' && !stmt.declaration && !stmt.source)
      for (const sp of stmt.specifiers ?? [])
        if (
          (sp.exported.name ?? sp.exported.value) === name &&
          (sp.local.name ?? sp.local.value) === name &&
          sp.local.type === 'Identifier'
        )
          return { p: q, node: sp.local };
  }
  return { p, node };
}

/**
 * The output a record takes from its callers, `{ output: { p, node } }`, or `{ why }` naming the caller that keeps the
 * call by name. `schemaOf(s)` is the caller's answer schema node in its own file (undefined when it parses with none);
 * `itemOf(s)` is a portal list caller's row schema, its answer a page of that row (`{ output: { p, node, page: true } }`);
 * `checksOf(p, node)` lists what that schema checks beyond its shape (answerChecks in index.mjs).
 */
export function answerFromCallers(repo, sites, { schemaOf, checksOf, itemOf = () => undefined }) {
  let taken;
  let first;
  for (const s of sites) {
    const item = s.schema || schemaOf(s) ? undefined : itemOf(s);
    const written = s.schema ?? (schemaOf(s) ? { p: load(s.file), node: schemaOf(s) } : item ? { p: load(s.file), node: item } : undefined);
    const own = written && { ...throughNamespace(written.p, written.node), ...(item ? { page: true } : {}) };
    if (!own)
      return {
        why: `${at(repo, s)} reads the answer ${s.reader ? 'with its own reader function' : 'unparsed'}, not a zod schema a record can take`,
      };
    const checks = checksOf(own.p, own.node);
    if (checks.length) return { why: `${at(repo, s)} parses it with a schema that is not pure zod (${checks.join(', ')})` };
    const d = declarationOf(own.p, own.node);
    const key = `${own.page ? 'page of ' : ''}${d.p.file}:${d.node.start}`;
    if (!taken) {
      taken = own;
      first = { s, key };
    } else if (first.key !== key)
      return { why: `${at(repo, first.s)} and ${at(repo, s)} parse it with different schemas: the record can take only one` };
  }
  return taken ? { output: taken } : { why: 'no caller parses the answer with a schema' };
}
