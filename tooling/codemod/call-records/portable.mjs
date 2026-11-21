#!/usr/bin/env node
// The portability step of the call-records codemod: a record the export refuses (`procedure-strict-schema.ts`) for a
// construct with an exact JSON form gets that form in its schema's own source, so the record is written instead of
// left by hand. Each finding is followed from the record's `input` or `output` through the schema's source (consts,
// imports, `z.object`, `z.array`, unions, records, `.extend`) to the node it names:
//
//   - `z.unknown()`, on the wire, is any JSON value (an absent key is refused, as zod 4 reads a key): it becomes
//     `jsonValueSchema` (`z.json()`, which the export writes whole), its `.optional()` or `.nullable()` kept as written.
//   - `/^(?!-)[a-z0-9-]+.../` (a lookahead that only bars the first character of the class after it) becomes the same
//     language without the lookahead: `/^[a-z0-9][a-z0-9-]*.../`.
//
// Any other construct, or a path the walk can't follow, is left as it is and printed by name.
//
//   node tooling/codemod/call-records/portable.mjs --unportable <samples.mjs --unportable output> [--write] <record file.ts> ...
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { applyEdits, bindingOf, forget, keyOf, literal, load, resolveRelative, text, walk } from './ast.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);
const CONTRACTS = join(REPO, 'packages/contracts/src');
const UNKNOWN = 'z.unknown (no shape: accepts anything)';
const REFINEMENT = '.refine/.superRefine (a TypeScript predicate the export drops)';
const LOOKAROUND = /^regex \/(.*)\/ uses lookaround/;

/** `label cannot be exported without losing meaning: at (construct); ...` as `{ label, findings }`. */
export function parseWhy(why) {
  const m = /^(\S+) cannot be exported without losing meaning: (.*)$/s.exec(why);
  if (!m) return undefined;
  const findings = m[2].split(/; (?=\S+ \()/).map((f) => {
    const i = f.indexOf(' (');
    return { at: f.slice(0, i), construct: f.slice(i + 2, -1) };
  });
  return { label: m[1], findings };
}

/** `views[].filter` after the root as steps: `{ prop }`, `{ elem }`, `{ option }`, `{ value }`. */
function stepsOf(at, root) {
  const out = [];
  const re = /\.([A-Za-z_$][\w$]*)|\[\]|\|(\d+)|\{value\}|\[(\d+)\]|\{key\}/gy;
  let rest = at.slice(root.length);
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(rest))) {
    if (m[1] !== undefined) out.push({ prop: m[1] });
    else if (m[0] === '[]') out.push({ elem: true });
    else if (m[2] !== undefined) out.push({ option: Number(m[2]) });
    else if (m[0] === '{value}') out.push({ value: true });
    else return undefined;
    if (re.lastIndex === rest.length) return out;
  }
  return rest.length === 0 ? out : undefined;
}

const unwrap = (n) => {
  while (n && (n.type === 'ParenthesizedExpression' || n.type === 'TSAsExpression' || n.type === 'TSSatisfiesExpression')) n = n.expression;
  return n;
};

/** An identifier to the expression it names: a local const, or a top-level const of the file it is imported from. */
function follow(q, n) {
  for (let i = 0; i < 20; i++) {
    n = unwrap(n);
    if (n?.type !== 'Identifier') return { q, n };
    const b = bindingOf(q, n, n.name);
    if (b.kind === 'var' && b.declarator.init) {
      n = b.declarator.init;
      continue;
    }
    if (b.kind !== 'import') return undefined;
    const file = b.from.startsWith('.')
      ? resolveRelative(q.file, b.from)
      : b.from.startsWith('@intafaced/contracts')
        ? resolveRelative(join(CONTRACTS, 'x.ts'), `./${b.from === '@intafaced/contracts' ? 'index' : b.from.split('/').pop()}.js`)
        : undefined;
    if (!file) return undefined;
    q = load(file);
    const d = top(q, b.imported);
    if (d.kind !== 'var' || !d.declarator.init) {
      // `export * from` / `export { x } from` in the index: look in every file it re-exports.
      const again = reexported(q, b.imported);
      if (!again) return undefined;
      ({ q, n } = again);
      continue;
    }
    n = d.declarator.init;
  }
  return undefined;
}

/** A file's top-level binding of `name` (`bindingOf` reads scopes from a node's parents, so from a top-level node). */
const top = (q, name) => bindingOf(q, q.program.body[0] ?? q.program, name);

function reexported(q, name) {
  for (const s of q.program.body) {
    if ((s.type !== 'ExportAllDeclaration' && s.type !== 'ExportNamedDeclaration') || !s.source) continue;
    if (s.type === 'ExportNamedDeclaration' && !s.specifiers.some((x) => (x.exported.name ?? x.exported.value) === name)) continue;
    const file = resolveRelative(q.file, s.source.value);
    if (!file) continue;
    const r = load(file);
    const d = top(r, name);
    if (d.kind === 'var' && d.declarator.init) return { q: r, n: d.declarator.init };
  }
  return undefined;
}

/** The method chain of a schema expression, outermost first, and the call it starts from (`z.object(...)`). */
function chainOf(n) {
  const methods = [];
  n = unwrap(n);
  while (n?.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed) {
    const obj = unwrap(n.callee.object);
    if (obj?.type === 'Identifier' && obj.name === 'z') return { base: n, factory: n.callee.property.name, methods };
    methods.push({ name: n.callee.property.name, call: n, receiver: obj });
    n = obj;
  }
  return { base: n, factory: undefined, methods };
}

/** The node one step down from a schema expression, with the file it is in. */
function down(q, n, step) {
  const f = follow(q, n);
  if (!f) return undefined;
  ({ q, n } = f);
  const { base, factory, methods } = chainOf(n);
  // `.array()` and `.extend({...})` on the way: the element is the receiver; an extended key may be in the extension.
  for (const m of methods) {
    if (step.elem && m.name === 'array') return { q, n: m.receiver };
    if (step.prop && (m.name === 'extend' || m.name === 'safeExtend')) {
      const hit = propIn(q, m.call.arguments[0], step.prop);
      if (hit) return hit;
    }
  }
  if (!factory) {
    // A chain on another schema (`base.extend(...)`, `x.optional()`): keep looking in what it starts from.
    return base && base !== n ? down(q, base, step) : undefined;
  }
  const a = base.arguments;
  if (step.prop && (factory === 'object' || factory === 'strictObject' || factory === 'looseObject')) return propIn(q, a[0], step.prop);
  if (step.elem && factory === 'array') return { q, n: a[0] };
  if (step.option !== undefined && (factory === 'union' || factory === 'discriminatedUnion')) {
    const list = follow(q, factory === 'union' ? a[0] : a[1]);
    const el = list?.n?.type === 'ArrayExpression' ? list.n.elements[step.option] : undefined;
    return el ? { q: list.q, n: el } : undefined;
  }
  if (step.value && factory === 'record') return { q, n: a[1] };
  return undefined;
}

/** A key of an object shape (spreads of another shape followed), with the file it is in. */
function propIn(q, shapeNode, name) {
  const f = follow(q, shapeNode);
  if (!f || f.n?.type !== 'ObjectExpression') return undefined;
  for (const pr of [...f.n.properties].reverse()) {
    if (pr.type === 'Property' && keyOf(pr) === name) return { q: f.q, n: pr.value, prop: pr };
    if (pr.type === 'SpreadElement') {
      // `...other.shape`: the key may be in that schema.
      const arg = unwrap(pr.argument);
      const inner = arg?.type === 'MemberExpression' && !arg.computed && arg.property.name === 'shape' ? arg.object : arg;
      const hit = inner?.type === 'MemberExpression' ? undefined : (down(f.q, inner, { prop: name }) ?? propIn(f.q, inner, name));
      if (hit) return hit;
    }
  }
  return undefined;
}

/** The record's `input` or `output` expression in its record file, by the record's name. */
function recordSide(files, name, side) {
  for (const file of files) {
    const q = load(file);
    let hit;
    walk(q.program, (n) => {
      if (hit || n.type !== 'ObjectExpression') return;
      const nameProp = n.properties.find((pr) => pr.type === 'Property' && keyOf(pr) === 'name');
      if (!nameProp || literal(nameProp.value) !== name) return;
      const prop = n.properties.find((pr) => pr.type === 'Property' && keyOf(pr) === side);
      if (prop) hit = { q, n: prop.value, prop, record: n };
    });
    if (hit) return hit;
  }
  return undefined;
}

/** `^(?!c)[...]+rest` with `c` one character of the class: the class without `c`, then the class `*`. */
export function withoutLeadingLookahead(source) {
  const m = /^\^\(\?!(\\?.)\)\[([^\]]+)\]\+(.*)$/s.exec(source);
  if (!m) return undefined;
  const [, bar, cls, rest] = m;
  const plain = bar.replace(/^\\/, '');
  // Only a class written as ranges and single characters, where the barred one is a single character in it.
  if (!/^(?:[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9]|\\?[^\\\]])+$/.test(cls) || !cls.endsWith(plain) || plain.length !== 1) return undefined;
  const first = cls.slice(0, -plain.length);
  if (!first || first.endsWith('\\')) return undefined;
  return `^[${first}][${cls}]*${rest}`;
}

/** The edit that makes one finding portable, or the reason it stays. */
function fix(target, construct) {
  // A name for the schema (`domain` for `z.string().regex(...)`): the edit lands where it is written.
  const found = follow(target.q, target.n);
  if (!found) return { why: 'the codemod cannot follow the schema to it' };
  const { q } = found;
  const node = unwrap(found.n);
  if (construct === UNKNOWN) {
    // The call that starts the chain: `z.unknown()` itself, under any `.optional()`, `.nullable()` or `.describe()`.
    let start = node;
    const methods = [];
    while (
      start?.type === 'CallExpression' &&
      start.callee.type === 'MemberExpression' &&
      unwrap(start.callee.object)?.type !== 'Identifier'
    ) {
      methods.push(start.callee.property.name);
      start = unwrap(start.callee.object);
    }
    if (!(start?.type === 'CallExpression' && text(q, start.callee) === 'z.unknown' && start.arguments.length === 0))
      return { why: 'its z.unknown() is not written here as z.unknown()' };
    if (methods.some((m) => !['optional', 'nullable', 'nullish', 'describe', 'meta'].includes(m)))
      return { why: `its z.unknown() carries ${methods.join(', ')}` };
    // zod 4: a key `z.unknown()` is required (absent is refused), so `jsonValueSchema` with the same chain is exact.
    return { q, edit: { start: start.start, end: start.end, text: 'jsonValueSchema' }, needs: 'jsonValueSchema' };
  }
  const look = LOOKAROUND.exec(construct);
  if (look) {
    let hit;
    walk(node, (m) => {
      if (!hit && m.type === 'Literal' && m.regex && m.regex.pattern === look[1]) hit = m;
    });
    if (!hit) return { why: 'its regex is not written here as a literal' };
    const plain = withoutLeadingLookahead(hit.regex.pattern);
    if (!plain) return { why: `regex /${hit.regex.pattern}/ has a lookaround with no plain form the codemod knows` };
    return { q, edit: { start: hit.start, end: hit.end, text: `/${plain}/${hit.regex.flags}` } };
  }
  return { why: construct };
}

/**
 * The `.refine(..., message)` a refined schema carries where it is written: its words, and a name for the check (the
 * schema's own name when it has one, else the key it sits under). `.superRefine` says nothing a record can quote.
 */
function refinementOf(target) {
  const found = follow(target.q, target.n);
  if (!found) return { why: 'the codemod cannot follow the schema to it' };
  const says = [];
  for (const m of chainOf(found.n).methods) {
    if (m.name === 'superRefine') return { why: 'a .superRefine names no rule in words' };
    if (m.name !== 'refine') continue;
    const msg = m.call.arguments[1];
    const words =
      literal(msg) ??
      (msg?.type === 'ObjectExpression'
        ? literal(msg.properties.find((pr) => pr.type === 'Property' && keyOf(pr) === 'message')?.value)
        : undefined);
    if (!words) return { why: 'its .refine has no message to name the rule by' };
    says.push(words);
  }
  if (!says.length) return { why: "its refinement is not a .refine written in the schema's chain" };
  const own =
    unwrap(target.n)?.type === 'Identifier' ? unwrap(target.n).name.replace(/Schema$/, '') : target.prop ? keyOf(target.prop) : 'answer';
  const name = `${own.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}_holds`;
  return { key: `${found.q.file}:${found.n.start}`, name, says: says.join('; ') };
}

/** `{ name: { at, says }, ... }`, one entry per refinement, at every place it sits. */
function checksText(named) {
  const used = new Set();
  const entries = [...named.values()].map((c) => {
    let name = c.name;
    for (let i = 2; used.has(name); i++) name = `${c.name}_${i}`;
    used.add(name);
    const at = c.at.length === 1 ? JSON.stringify(c.at[0]) : `[${c.at.map((a) => JSON.stringify(a)).join(', ')}]`;
    return `${name}: { at: ${at}, says: ${JSON.stringify(c.says)} }`;
  });
  return `{ ${entries.join(', ')} }`;
}

/** Where a file imports `jsonValueSchema` from. */
const jsonValueFrom = (file) =>
  file.startsWith(CONTRACTS) ? './procedure-strict-schema.js' : '@intafaced/contracts/procedure-strict-schema';

export function plan(skipped, recordFiles) {
  const edits = new Map();
  const left = [];
  const add = (q, edit, needs) => {
    if (!edits.has(q.file)) edits.set(q.file, { edits: new Map(), needs: new Set() });
    const f = edits.get(q.file);
    f.edits.set(`${edit.start}:${edit.end}`, edit);
    if (needs) f.needs.add(needs);
  };
  for (const why of Object.values(skipped)) {
    const parsed = parseWhy(why);
    if (!parsed) continue;
    const side = parsed.label.endsWith('.input') ? 'input' : parsed.label.endsWith('.output') ? 'output' : undefined;
    const name = parsed.label.slice(0, parsed.label.lastIndexOf('.'));
    const start = side && recordSide(recordFiles, name, side);
    const named = new Map();
    for (const f of parsed.findings) {
      const root = side === 'input' ? 'input' : parsed.label;
      const steps = f.at.startsWith(root) ? stepsOf(f.at, root) : undefined;
      let target = start && steps ? { q: start.q, n: start.n } : undefined;
      for (const step of steps ?? []) target = target && down(target.q, target.n, step);
      if (target && side === 'output' && f.construct === REFINEMENT) {
        // An answer's refinement stays where it is and is named in the record's `outputChecks`, in its own words.
        const r = refinementOf(target);
        if (r.why) left.push({ record: name, at: f.at, why: r.why });
        else {
          const at = `output${f.at.slice(root.length)}`;
          if (!named.has(r.key)) named.set(r.key, { name: r.name, says: r.says, at: [] });
          named.get(r.key).at.push(at);
        }
        continue;
      }
      const r = target ? fix(target, f.construct) : { why: 'the codemod cannot follow the schema to it' };
      if (r.edit) add(r.q, r.edit, r.needs);
      else left.push({ record: name, at: f.at, why: r.why });
    }
    if (named.size) {
      if (start.record.properties.some((pr) => pr.type === 'Property' && keyOf(pr) === 'outputChecks')) {
        for (const c of named.values()) for (const at of c.at) left.push({ record: name, at, why: 'the record already has outputChecks' });
      } else add(start.q, { start: start.prop.end, end: start.prop.end, text: `, outputChecks: ${checksText(named)}` });
    }
  }
  return { edits, left };
}

function write(edits) {
  for (const [file, f] of edits) {
    let src = applyEdits(readFileSync(file, 'utf8'), [...f.edits.values()]);
    for (const name of f.needs) {
      if (
        new RegExp(`\\b${name}\\b[^;]*\\} from`).test(
          src
            .split('\n')
            .filter((l) => l.startsWith('import'))
            .join('\n'),
        )
      )
        continue;
      const from = jsonValueFrom(file);
      const lastImport = [...src.matchAll(/^import [^;]+;\n/gm)].at(-1);
      const at = lastImport ? lastImport.index + lastImport[0].length : 0;
      src = `${src.slice(0, at)}import { ${name} } from '${from}';\n${src.slice(at)}`;
    }
    writeFileSync(file, src);
    forget(file);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--unportable');
  const skipped = JSON.parse(readFileSync(argv[i + 1], 'utf8'));
  const files = argv.filter((a, j) => j !== i && j !== i + 1 && !a.startsWith('--')).map((f) => resolve(f));
  const { edits, left } = plan(skipped, files);
  if (argv.includes('--write')) write(edits);
  console.log(
    JSON.stringify(
      { fixed: [...edits.values()].reduce((n, f) => n + f.edits.size, 0), files: [...edits.keys()].map((f) => relative(REPO, f)), left },
      null,
      2,
    ),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
