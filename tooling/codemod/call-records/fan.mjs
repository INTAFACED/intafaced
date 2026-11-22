// A call that names its service or call by something other than a string: one site per value it can take, when the code
// itself lists those values (a `? :`, a union type, an `as const` list, a const), and the call is written once every value
// has its record (`fanIn`). An open one (a value from a request body, a wider string) stays, named with why.
import { bindingOf, literal, load, resolveRelative, text, walk } from './ast.mjs';

const REASON = 'service or call named by a template';

/** Where each shape names its service, its call and its input. */
const ARG_AT = {
  query: { module: 0, path: 1, input: 2 },
  mutate: { module: 0, path: 1, input: 2 },
  founderCall: { module: 1, path: 2, input: 4 },
  founderEdgeCall: { module: 1, path: 2, input: 4 },
  payCall: { module: 5, path: 1, input: 3 },
  useBankRead: { path: 0, input: 1 },
  payQuery: { path: 0, input: 1 },
  payMutate: { path: 0, input: 1 },
};

const unwrap = (n) => {
  while (n && /^(ParenthesizedExpression|TSAsExpression|TSSatisfiesExpression|TSNonNullExpression)$/.test(n.type)) n = n.expression;
  return n;
};
const where = (p, n) => `\`${text(p, n).slice(0, 40)}\``;

/**
 * The sites one call is, given its service or its call is not a string: one per value with no problem of its own, or
 * the call itself named with why it stays.
 */
export function fanOut(p, site) {
  const at = ARG_AT[site.shape];
  if (!at) return [{ ...site, problem: REASON }];
  if (!site.module && !site.path) return [{ ...site, problem: `${REASON}: both its service and its call` }];
  const key = site.module ? 'path' : 'module';
  const a = site.node.arguments;
  const set = valuesOf(p, a[at[key]]);
  if (set.open) return [{ ...site, problem: `${REASON}: ${set.open}` }];
  const values = [...new Map(set.values.map((v) => [v.value, v])).values()];
  if (values.length === 1) return [{ ...site, [key]: values[0].value }];
  // Each value's input is typed by its own record: only an input written out here (or none) can be.
  const input = a[at.input];
  const typed = !input || input.type === 'ObjectExpression' || (input.type === 'Identifier' && input.name === 'undefined');
  const why = `its ${set.by} sends one input value to ${values.length} records: each one's input type can't be kept`;
  return values.map((v, i) => ({
    ...site,
    [key]: v.value,
    fan: { key: site.node, at: i, size: values.length, test: v.test },
    ...(typed ? {} : { problem: why }),
  }));
}

/**
 * The strings an expression can take: `{ by, values: [{ value, test }] }`, where `test` is the condition that picks a value
 * (the last value needs none), or `{ open }` naming why the set is not closed.
 */
function valuesOf(p, node, depth = 0) {
  node = unwrap(node);
  if (!node) return { open: 'it names no service or call' };
  if (depth > 8) return { open: `${where(p, node)} is followed too far` };
  const lit = literal(node);
  if (lit !== undefined) return { by: 'string', values: [{ value: lit }] };
  if (node.type === 'ConditionalExpression') {
    const c = valuesOf(p, node.consequent, depth + 1);
    const alt = valuesOf(p, node.alternate, depth + 1);
    if (c.values?.length !== 1 || alt.values?.length !== 1) return { open: `a \`? :\` whose branches are not each one string` };
    return { by: '`? :`', values: [{ value: c.values[0].value, test: text(p, node.test) }, { value: alt.values[0].value }] };
  }
  if (node.type === 'TemplateLiteral') {
    if (node.expressions.length !== 1) return { open: `${where(p, node)} fills in more than one value` };
    const inner = valuesOf(p, node.expressions[0], depth + 1);
    if (inner.open) return inner;
    const [head, tail] = node.quasis.map((q) => q.value.cooked);
    return { by: inner.by, values: inner.values.map((v) => ({ value: `${head}${v.value}${tail}`, test: v.test })) };
  }
  if (node.type === 'Identifier') return nameValues(p, node, node.name, node.name, depth + 1);
  return { open: `${where(p, node)} is not a name, a \`? :\` or a string` };
}

/** The values `name` can hold where node `at` reads it, each picked by `local === value`. */
function nameValues(p, at, name, local, depth) {
  const b = bindingOf(p, at, name);
  const byName = (values, by) =>
    values.length === 1
      ? { by, values: [{ value: values[0] }] }
      : { by, values: values.map((value, i) => ({ value, ...(i < values.length - 1 ? { test: `${local} === '${value}'` } : {}) })) };
  if (b.kind === 'param') {
    const param = paramOf(p, at, name);
    if (!param) return { open: `parameter \`${name}\` is not a plain name` };
    if (reassigned(param.fn, name)) return { open: `parameter \`${name}\` is assigned again` };
    const t = typeValues(p, param.id.typeAnnotation, depth);
    return t.open ? { open: `parameter \`${name}\`'s type ${t.open}` } : byName(t.values, `\`${local}\``);
  }
  if (b.kind === 'var') {
    if (b.declaration.kind !== 'const' || b.declarator.id.type !== 'Identifier') return { open: `\`${name}\` is not a const` };
    const ann = b.declarator.id.typeAnnotation;
    if (ann) {
      const t = typeValues(p, ann, depth);
      return t.open ? { open: `\`${name}\`'s type ${t.open}` } : byName(t.values, `\`${local}\``);
    }
    const v = valuesOf(p, b.declarator.init, depth);
    return v.open
      ? v
      : byName(
          v.values.map((x) => x.value),
          `\`${local}\``,
        );
  }
  if (b.kind === 'import') {
    const q = importedFile(p, b);
    if (!q) return { open: `\`${name}\` comes from ${b.from}, which the codemod does not follow` };
    const top = declaredAt(q, b.imported);
    if (!top) return { open: `\`${name}\` is not a top-level name in ${b.from}` };
    return nameValues(q, top, b.imported, local, depth + 1);
  }
  return { open: `\`${name}\` is not declared where the codemod can read it` };
}

/** A top-level name in a file, as a node `bindingOf` can be asked from. */
function declaredAt(q, name) {
  const top = q.program.body[0];
  if (!top) return undefined;
  const b = bindingOf(q, top, name);
  return b.kind === 'global' ? undefined : top;
}

function importedFile(p, b) {
  if (!b.from.startsWith('.')) return undefined;
  const file = resolveRelative(p.file, b.from) ?? resolveRelative(p.file, `${b.from}.tsx`);
  return file ? load(file) : undefined;
}

/** The literal strings a type allows: `'a' | 'b'`, an alias of one, `(typeof LIST)[number]` or `keyof typeof TABLE`. */
function typeValues(p, t, depth) {
  if (depth > 8) return { open: 'is followed too far' };
  if (!t) return { open: 'is not written' };
  if (t.type === 'TSTypeAnnotation' || t.type === 'TSParenthesizedType') return typeValues(p, t.typeAnnotation, depth + 1);
  if (t.type === 'TSLiteralType' && typeof t.literal?.value === 'string') return { values: [t.literal.value] };
  if (t.type === 'TSUnionType') {
    const out = [];
    for (const m of t.types) {
      const v = typeValues(p, m, depth + 1);
      if (v.open) return v;
      out.push(...v.values);
    }
    return { values: out };
  }
  if (t.type === 'TSTypeReference' && t.typeName?.type === 'Identifier' && !t.typeArguments) {
    const d = typeDecl(p, t, t.typeName.name, depth);
    return d.open ? d : typeValues(d.q, d.alias.typeAnnotation, depth + 1);
  }
  const query = (x) => {
    while (x?.type === 'TSParenthesizedType') x = x.typeAnnotation;
    return x?.type === 'TSTypeQuery' && x.exprName.type === 'Identifier' && !x.typeArguments ? x.exprName : undefined;
  };
  if (t.type === 'TSIndexedAccessType' && t.indexType.type === 'TSNumberKeyword' && query(t.objectType)) {
    const list = constInit(p, query(t.objectType), query(t.objectType).name, depth);
    if (list?.type !== 'ArrayExpression') return { open: `reads \`${query(t.objectType).name}\`, which is not an \`as const\` list` };
    const values = list.elements.map((e) => literal(e));
    return values.every((v) => v !== undefined) ? { values } : { open: `lists \`${query(t.objectType).name}\`, not only strings` };
  }
  if (t.type === 'TSTypeOperator' && t.operator === 'keyof' && query(t.typeAnnotation)) {
    const table = constInit(p, query(t.typeAnnotation), query(t.typeAnnotation).name, depth);
    if (table?.type !== 'ObjectExpression')
      return { open: `reads \`${query(t.typeAnnotation).name}\`, which is not an \`as const\` table` };
    const keys = table.properties.map((pr) => (pr.type === 'Property' && !pr.computed ? (pr.key.name ?? literal(pr.key)) : undefined));
    return keys.every((k) => typeof k === 'string')
      ? { values: keys }
      : { open: `keys \`${query(t.typeAnnotation).name}\` by more than names` };
  }
  return { open: 'is not a closed set of strings' };
}

/** A type alias by name where `at` reads it, here or through a relative import: `{ q, alias }` or `{ open }`. */
function typeDecl(p, at, name, depth) {
  const b = bindingOf(p, at, name);
  if (b.kind === 'type' && b.declaration.type === 'TSTypeAliasDeclaration' && !b.declaration.typeParameters)
    return { q: p, alias: b.declaration };
  if (b.kind === 'import' && depth < 8) {
    const q = importedFile(p, b);
    const top = q && declaredAt(q, b.imported);
    if (top) return typeDecl(q, top, b.imported, depth + 1);
  }
  return { open: `names \`${name}\`, which is not a type alias the codemod can read` };
}

/** The `as const` value `name` is declared with where `at` reads it (here or through a relative import), or undefined. */
function constInit(p, at, name, depth) {
  const b = bindingOf(p, at, name);
  if (b.kind === 'import' && depth < 8) {
    const q = importedFile(p, b);
    const top = q && declaredAt(q, b.imported);
    return top ? constInit(q, top, b.imported, depth + 1) : undefined;
  }
  if (b.kind !== 'var' || b.declaration.kind !== 'const') return undefined;
  const init = b.declarator.init;
  const asConst =
    init?.type === 'TSAsExpression' && init.typeAnnotation.type === 'TSTypeReference' && init.typeAnnotation.typeName.name === 'const';
  return asConst ? unwrap(init) : undefined;
}

/** The innermost enclosing function that takes `name` as a plain parameter: `{ fn, id }`. */
function paramOf(p, at, name) {
  for (let n = p.parents.get(at); n; n = p.parents.get(n)) {
    if (!/Function/.test(n.type)) continue;
    for (const param of n.params) {
      const id = param.type === 'AssignmentPattern' ? param.left : param.type === 'TSParameterProperty' ? param.parameter : param;
      if (id?.type === 'Identifier' && id.name === name) return { fn: n, id };
    }
  }
  return undefined;
}

function reassigned(fn, name) {
  let found = false;
  walk(fn.body, (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'Identifier' && n.left.name === name) found = true;
    if (n.type === 'UpdateExpression' && n.argument.type === 'Identifier' && n.argument.name === name) found = true;
  });
  return found;
}

/** One value of a fanned call, rewritten later with the others (`fanIn`). */
export function fanBranch(changes, s, name, spec, takesNone) {
  const f = changes.of(s.file);
  f.fans ??= new Map();
  if (!f.fans.has(s.fan.key)) f.fans.set(s.fan.key, { s, size: s.fan.size, branches: [] });
  f.fans.get(s.fan.key).branches[s.fan.at] = { s, name, spec, takesNone };
}

/**
 * Each fanned call with every value moved: `(t1 ? call(A, ...) : t2 ? call(B, ...) : call(C, ...))`, each value typed by
 * its own record. With one value left, none moves: all are named.
 */
export function fanIn(changes, planned, done, callText) {
  for (const [file, f] of changes.files) {
    for (const { s, size, branches } of f.fans?.values() ?? []) {
      const got = Array.from({ length: size }, (_, i) => branches[i]);
      if (got.some((x) => !x)) {
        const back = new Set(got.filter(Boolean).map((x) => x.s));
        for (const r of [...done, ...planned.existing]) r.sites = r.sites.filter((x) => !back.has(x));
        for (const x of back) planned.hand.push({ site: x, why: 'another value of its call stays, and one call sends them all' });
        continue;
      }
      const call = (b) => callText(changes, b.s, b.name, b.takesNone);
      const body = got.slice(0, -1).reduceRight((rest, b) => `${b.s.fan.test} ? ${call(b)} : ${rest}`, call(got.at(-1)));
      changes.edit(file, s.node.start, s.node.end, `(${body})`);
      for (const b of got) changes.imp(file, b.spec, b.name);
    }
  }
}
