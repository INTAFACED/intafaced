// The parse, walk and edit helpers the call-records codemod shares (tooling/codemod/call-records/run.mjs).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseSync } from 'oxc-parser';

const cache = new Map();

/** One source file, parsed once per run: its text, its program and the parent of every node. */
export function load(file) {
  const abs = resolve(file);
  const hit = cache.get(abs);
  if (hit) return hit;
  const src = readFileSync(abs, 'utf8');
  const { program, errors } = parseSync(abs, src);
  if (errors.length > 0) throw new Error(`${file}: ${errors[0].message}`);
  const parents = new Map();
  walk(program, (node, parent) => parents.set(node, parent));
  const parsed = { file: abs, src, program, parents };
  cache.set(abs, parsed);
  return parsed;
}

/** Forgets a file, after an edit is written. */
export const forget = (file) => cache.delete(resolve(file));

/** Every node under `node`, parent first. `visit` returning false skips a node's children. */
export function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'type') continue;
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit, node);
    else if (value && typeof value.type === 'string') walk(value, visit, node);
  }
}

export const text = (p, node) => p.src.slice(node.start, node.end);

/** A string literal's value, or a template with no `${}`; else undefined. */
export function literal(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return undefined;
}

/** A property's key as written, when it is a plain name or a string. */
export function keyOf(prop) {
  if (prop.computed) return undefined;
  if (prop.key?.type === 'Identifier') return prop.key.name;
  return literal(prop.key);
}

/** The name a call is made by: `f(...)` and `a.b.f(...)` both read `f`. */
export function calleeName(call) {
  const c = call.callee;
  if (c?.type === 'Identifier') return c.name;
  if (c?.type === 'MemberExpression' && !c.computed && c.property?.type === 'Identifier') return c.property.name;
  return undefined;
}

/** Where a relative import of `from` in `file` lands: `./x.js` is `./x.ts` (or `./x/index.ts`). */
export function resolveRelative(file, from) {
  if (!from.startsWith('.')) return undefined;
  const base = join(dirname(file), from);
  for (const candidate of [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    base,
  ]) {
    if (existsSync(candidate) && candidate.match(/\.[cm]?[jt]sx?$/)) return candidate;
  }
  return undefined;
}

/** The scopes (function bodies, blocks, the program) that enclose a node, innermost first. */
function scopesOf(p, node) {
  const out = [];
  for (let n = p.parents.get(node); n; n = p.parents.get(n)) {
    if (n.type === 'BlockStatement' || n.type === 'Program' || n.type === 'StaticBlock') out.push(n);
    if (
      (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration') &&
      n.body?.type !== 'BlockStatement'
    )
      out.push(n);
  }
  return out;
}

/** What a name means where it is used: a declaration in an enclosing scope, a parameter, an import, or nothing. */
export function bindingOf(p, node, name) {
  for (const scope of scopesOf(p, node)) {
    const fn = p.parents.get(scope);
    const owner =
      scope.type === 'ArrowFunctionExpression' || scope.type === 'FunctionExpression' || scope.type === 'FunctionDeclaration'
        ? scope
        : fn && /Function/.test(fn.type) && fn.body === scope
          ? fn
          : null;
    if (owner && owner.params.some((param) => patternNames(param).includes(name))) return { kind: 'param' };
    const body = scope.type === 'Program' || scope.type === 'BlockStatement' || scope.type === 'StaticBlock' ? scope.body : [];
    for (const stmt of body) {
      const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
      if (decl.type === 'VariableDeclaration') {
        for (const d of decl.declarations)
          if (patternNames(d.id).includes(name))
            return { kind: 'var', declarator: d, statement: stmt, declaration: decl, exported: stmt !== decl };
      } else if (
        (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration' || decl.type === 'TSEnumDeclaration') &&
        decl.id?.name === name
      ) {
        return {
          kind: decl.type === 'FunctionDeclaration' ? 'function' : 'other',
          statement: stmt,
          declaration: decl,
          exported: stmt !== decl,
        };
      } else if ((decl.type === 'TSTypeAliasDeclaration' || decl.type === 'TSInterfaceDeclaration') && decl.id?.name === name) {
        return { kind: 'type', statement: stmt, declaration: decl, exported: stmt !== decl };
      } else if (stmt.type === 'ImportDeclaration') {
        for (const s of stmt.specifiers ?? []) {
          if (s.local.name !== name) continue;
          const imported =
            s.type === 'ImportSpecifier' ? (s.imported.name ?? s.imported.value) : s.type === 'ImportDefaultSpecifier' ? 'default' : '*';
          return {
            kind: 'import',
            from: stmt.source.value,
            imported,
            statement: stmt,
            specifier: s,
            typeOnly: stmt.importKind === 'type' || s.importKind === 'type',
          };
        }
      }
    }
  }
  return { kind: 'global' };
}

function patternNames(pattern) {
  if (!pattern) return [];
  switch (pattern.type) {
    case 'Identifier':
      return [pattern.name];
    case 'ObjectPattern':
      return pattern.properties.flatMap((prop) => patternNames(prop.type === 'RestElement' ? prop.argument : prop.value));
    case 'ArrayPattern':
      return pattern.elements.flatMap((el) => patternNames(el));
    case 'AssignmentPattern':
      return patternNames(pattern.left);
    case 'RestElement':
      return patternNames(pattern.argument);
    case 'TSParameterProperty':
      return patternNames(pattern.parameter);
    default:
      return [];
  }
}

/**
 * The names an expression reads from its surroundings, each with its first use: identifiers that are not a property name,
 * an object key or a name the expression binds itself (a parameter of a function inside it). Type references count.
 */
export function freeNames(p, node) {
  const bound = new Set();
  walk(node, (n) => {
    if (/Function/.test(n.type)) for (const param of n.params) for (const name of patternNames(param)) bound.add(name);
    if (n.type === 'VariableDeclarator') for (const name of patternNames(n.id)) bound.add(name);
  });
  const out = new Map();
  walk(node, (n, parent) => {
    if (n.type === 'Identifier' || n.type === 'IdentifierReference') {
      if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
      if ((parent?.type === 'Property' || parent?.type === 'ObjectProperty') && parent.key === n && !parent.computed && !parent.shorthand)
        return;
      if (parent?.type === 'TSQualifiedName' && parent.right === n) return;
      if (parent?.type === 'TSPropertySignature' && parent.key === n) return;
      if (bound.has(n.name)) return;
      if (!out.has(n.name)) out.set(n.name, n);
    }
  });
  return out;
}

/** Applies edits (`{ start, end, text }`, none overlapping) to a source text. */
export function applyEdits(src, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = src;
  let last = Infinity;
  for (const e of sorted) {
    if (e.end > last) throw new Error(`overlapping edits at ${e.start}..${e.end}`);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    last = e.start;
  }
  return out;
}

/** The JSDoc block right before a node (`/** ... *\/` on the lines above it), or ''. */
export function leadingDoc(p, node) {
  const before = p.src.slice(0, node.start);
  const m = /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*$/.exec(before);
  return m ? m[1] : '';
}

/** The start of the line a node sits on, and of the JSDoc above it when it has one: what deleting the node takes away. */
export function statementStart(p, node) {
  const doc = leadingDoc(p, node);
  const start = doc ? p.src.lastIndexOf(doc, node.start) : node.start;
  const lineStart = p.src.lastIndexOf('\n', start - 1) + 1;
  return /^\s*$/.test(p.src.slice(lineStart, start)) ? lineStart : start;
}

/** The end of a statement's line, past its newline. */
export function statementEnd(p, node) {
  const nl = p.src.indexOf('\n', node.end);
  return nl === -1 ? node.end : nl + 1;
}

/**
 * The entry `<map>[key]` of a schema map, followed from the file the binding `via` (a name imported or declared in `p`)
 * comes from, through `<map>`'s own import and the spreads it is composed of: `{ p, node }` of the entry's value, or
 * undefined. `useBankRead(path)` reads `bankReads` this way, and so does a caller's own `bankReads['x']`.
 */
export function keyedEntry(p, via, map, key) {
  // `./components` may be a .tsx file, which resolveRelative does not try without an extension.
  const fileOf = (q, b) =>
    b?.kind === 'import' && b.from.startsWith('.')
      ? (resolveRelative(q.file, b.from) ?? resolveRelative(q.file, `${b.from}.tsx`))
      : undefined;
  const declared = (file, name, seen) => {
    if (!file || seen.has(`${file}#${name}`)) return undefined;
    seen.add(`${file}#${name}`);
    const q = load(file);
    // A top-level name, asked from the file's first statement (the program itself has no enclosing scope).
    const d = bindingOf(q, q.program.body[0] ?? q.program, name);
    if (d.kind === 'import') return declared(fileOf(q, d), d.imported, seen);
    return d.kind === 'var' && d.declarator.init ? { q, init: d.declarator.init } : undefined;
  };
  const inObject = (q, obj, seen) => {
    while (obj && (obj.type === 'TSAsExpression' || obj.type === 'TSSatisfiesExpression')) obj = obj.expression;
    if (obj?.type !== 'ObjectExpression') return undefined;
    let found;
    for (const prop of obj.properties) {
      if (prop.type === 'SpreadElement' && prop.argument.type === 'Identifier') {
        const b = bindingOf(q, prop.argument, prop.argument.name);
        const d =
          b.kind === 'import' ? declared(fileOf(q, b), b.imported, seen) : b.kind === 'var' ? { q, init: b.declarator.init } : undefined;
        const inner = d && inObject(d.q, d.init, seen);
        if (inner) found = inner;
      } else if (prop.type === 'Property' && keyOf(prop) === key) found = { p: q, node: prop.value };
    }
    return found;
  };
  const seen = new Set();
  const own =
    via?.kind === 'var' && via.declarator?.init && via.declarator.id?.name === map ? { q: p, init: via.declarator.init } : undefined;
  const reads = own ?? declared(fileOf(p, via), map, seen);
  return reads && inObject(reads.q, reads.init, seen);
}
