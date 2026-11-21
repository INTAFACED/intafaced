// Every app call that names its service and call by strings: the shapes `garden/no-call-by-name` counts
// (tooling/lint/oxlint-plugin-garden/call-by-name-rule.js), each with what a rewrite needs, or the reason it can't be.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { bindingOf, calleeName, keyOf, literal, load, walk } from './ast.mjs';

const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__|__fixtures__)\/)/u;
const NAMED_AT = { query: [0, 1], mutate: [0, 1], founderCall: [1, 2], founderEdgeCall: [1, 2], payCall: [1], useBankRead: [0] };
const CALL_NAME = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
const isString = (n) => (n?.type === 'Literal' && typeof n.value === 'string') || n?.type === 'TemplateLiteral';

function appFiles(repo) {
  return execFileSync('git', ['ls-files', 'apps/customer/src', 'apps/admin/src'], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !TEST_FILE.test(f))
    .map((f) => join(repo, f));
}

export function findSites(repo) {
  const out = [];
  for (const file of appFiles(repo)) {
    const p = load(file);
    const line = (n) => p.src.slice(0, n.start).split('\n').length;
    walk(p.program, (n) => {
      if (n.type === 'CallExpression') {
        const name = calleeName(n);
        if (!name || !Object.hasOwn(NAMED_AT, name)) return;
        if ((name === 'query' || name === 'mutate') && n.callee.type !== 'MemberExpression') return;
        if (!NAMED_AT[name].some((i) => isString(n.arguments[i]))) return;
        const a = n.arguments;
        const site = { file, line: line(n), node: n, shape: name };
        if (name === 'query' || name === 'mutate') {
          Object.assign(site, { module: literal(a[0]), path: literal(a[1]), kind: name === 'query' ? 'query' : 'mutation' });
          if (a.length < 4 || a.length > 5 || a.some((x) => x.type === 'SpreadElement'))
            site.problem = `${name} with ${a.length} arguments`;
        } else if (name === 'founderCall') {
          const method = literal(a[3]);
          Object.assign(site, {
            module: literal(a[1]),
            path: literal(a[2]),
            kind: method === 'GET' ? 'query' : method === 'POST' ? 'mutation' : undefined,
          });
          const b = n.callee.type === 'Identifier' ? bindingOf(p, n.callee, 'founderCall') : undefined;
          if (b?.kind === 'import') site.founderCallFrom = b.from;
          else site.problem = 'founderCall not imported by name';
          if (!site.kind) site.problem = 'founderCall with a method that is not a literal';
          else if (!isSchemaParse(a[5])) site.reader = true;
          else if (a[6] && /sendEmptyInput/.test(p.src.slice(a[6].start, a[6].end))) site.problem = 'founderCall with sendEmptyInput';
        } else if (name === 'founderEdgeCall') {
          Object.assign(site, { module: literal(a[1]), path: literal(a[2]), problem: 'founderEdgeCall has no record form yet' });
        } else if (name === 'payCall') {
          Object.assign(site, { module: literal(a[5]) ?? 'pay', path: literal(a[1]), problem: 'payCall has no record form yet' });
        } else if (name === 'useBankRead') {
          Object.assign(site, { module: 'bank', path: literal(a[0]), problem: 'useBankRead has no record form yet' });
        }
        if (name === 'founderCall' && a[2]?.type === 'MemberExpression' && !a[2].computed && a[2].property.name === 'procedure')
          Object.assign(site, { shape: 'ops-dispatch', problem: 'sends the call its table entry names: it moves with the table' });
        if (!site.problem && (!site.module || !site.path)) site.problem = 'service or call named by a template';
        out.push(site);
      }
      if (n.type === 'Property') {
        const key = keyOf(n);
        const desk = key === 'procedure' ? deskRead(p, n) : undefined;
        const entry = key === 'procedure' && !desk ? opsEntry(p, n) : undefined;
        if (desk) out.push({ file, line: line(n), node: n, shape: 'desk-read', ...desk });
        else if (entry) out.push({ file, line: line(n), node: n, shape: 'ops-entry', ...entry });
        else if (key === 'procedure' && isString(n.value) && n.value.value !== '')
          out.push({
            file,
            line: line(n),
            node: n,
            shape: 'procedure-prop',
            path: literal(n.value),
            problem: '`procedure:` names its call by a string',
          });
        else if (n.key?.type === 'Literal' && key && CALL_NAME.test(key)) {
          let v = n.value;
          while (v && (v.type === 'CallExpression' || v.type === 'MemberExpression')) v = v.type === 'CallExpression' ? v.callee : v.object;
          if (v?.type === 'Identifier' && (v.name === 'z' || v.name.endsWith('Schema')))
            out.push({ file, line: line(n), node: n, shape: 'keyed-schema', path: key, problem: 'a schema keyed by its call name' });
        }
      }
    });
  }
  return out;
}

/** `parseWith(schema)` or `schema.safeParse`-shaped: the call's answer as the service sends it, nothing of its own. */
function isSchemaParse(n) {
  return n?.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'parseWith' && n.arguments.length === 1;
}

/**
 * An ops-desk read (`{ module: 'bank', procedure: 'health', ... }` in a file that has `readOf`): a query whose entry
 * names its record as `...readOf(RECORD)`, the form the desk's catalog test asks for.
 */
function deskRead(p, n) {
  if (!literal(n.value)) return undefined;
  const obj = p.parents.get(n);
  const moduleProp = obj?.properties?.find((pr) => pr.type === 'Property' && keyOf(pr) === 'module' && literal(pr.value));
  if (!moduleProp || bindingOf(p, n, 'readOf').kind === 'none') return undefined;
  const inputProp = obj.properties.find((pr) => pr.type === 'Property' && keyOf(pr) === 'input');
  return { module: literal(moduleProp.value), path: literal(n.value), kind: 'query', moduleProp, inputProp, obj };
}

/** The ops-desk reads in one parsed file. */
export function deskReadSite(p) {
  const out = [];
  walk(p.program, (n) => {
    const desk = n.type === 'Property' && keyOf(n) === 'procedure' ? deskRead(p, n) : undefined;
    if (desk) out.push(desk);
  });
  return out;
}

/** The table an entry sits in: `const OPS = { op: { procedure: 'x.y', ... } }` (with or without `as const`), by name. */
function tableOf(p, entry) {
  const prop = p.parents.get(entry);
  const table = prop?.type === 'Property' ? p.parents.get(prop) : undefined;
  if (table?.type !== 'ObjectExpression') return undefined;
  let up = p.parents.get(table);
  while (up && (up.type === 'TSAsExpression' || up.type === 'TSSatisfiesExpression')) up = p.parents.get(up);
  return up?.type === 'VariableDeclarator' && up.id.type === 'Identifier' ? { table, name: up.id.name } : undefined;
}

/**
 * How many uses of the table could read an entry's `procedure` other than `sent` (the founderCall arguments): each
 * use must read a named key (`OPS[op].schema`, `spec.what`), or be a type query (`keyof typeof OPS`).
 */
function tableLeaks(p, tableName, sent) {
  let leaks = 0;
  // One entry, as `OPS[op]`, `OPS.hide` or a name bound to either: only a named key other than `procedure` reads it safely.
  const entryUse = (node) => {
    const up = p.parents.get(node);
    if (up?.type === 'MemberExpression' && up.object === node && !up.computed)
      return up.property.name !== 'procedure' || sent.has(up) ? 0 : 1;
    if (up?.type === 'VariableDeclarator' && up.init === node && up.id.type === 'Identifier') {
      let n = 0;
      walk(p.program, (r) => {
        if (r.type !== 'Identifier' || r.name !== up.id.name || r === up.id) return;
        const b = bindingOf(p, r, r.name);
        if (b.kind === 'var' && b.declarator === up) n += entryUse(r);
      });
      return n;
    }
    return 1;
  };
  walk(p.program, (r) => {
    if (r.type !== 'Identifier' || r.name !== tableName) return;
    const up = p.parents.get(r);
    if (up?.type === 'VariableDeclarator' && up.id === r) return;
    if (up?.type === 'TSTypeQuery') return;
    // Its keys only: `Object.hasOwn(OPS, op)`, `Object.keys(OPS)`, `op in OPS`.
    if (up?.type === 'BinaryExpression' && up.operator === 'in' && up.right === r) return;
    const callee =
      up?.type === 'CallExpression' && up.callee.type === 'MemberExpression' ? p.src.slice(up.callee.start, up.callee.end) : '';
    if (/^Object\.(hasOwn|keys)$/.test(callee) && up.arguments[0] === r) return;
    if (up?.type === 'MemberExpression' && up.object === r) leaks += entryUse(up);
    else leaks += 1;
  });
  return leaks;
}

/** `TABLE[op]` itself, or a name bound to it (`const spec = TABLE[op]`). */
function readsTable(p, node, tableName) {
  if (node.type === 'Identifier') {
    const b = bindingOf(p, node, node.name);
    node = b.kind === 'var' ? b.declarator.init : undefined;
  }
  return node?.type === 'MemberExpression' && node.object.type === 'Identifier' && node.object.name === tableName;
}

/**
 * A table entry (`OPS = { save: { procedure: 'admin.saveLesson', ... } }`) that one or more calls in its file send as
 * `founderCall(ctx, 'academy', spec.procedure, 'POST', input, read)`, where `spec` is `OPS[op]`. The entry names its
 * record (`record: RECORD`) and those calls send it (`founderRecordRead(ctx, spec.record, input, read)`), the whole
 * table or none of it.
 */
function opsEntry(p, n) {
  if (!literal(n.value)) return undefined;
  const entry = p.parents.get(n);
  const t = entry?.type === 'ObjectExpression' ? tableOf(p, entry) : undefined;
  if (!t) return undefined;
  const dispatchers = [];
  walk(p.program, (c) => {
    if (c.type !== 'CallExpression' || calleeName(c) !== 'founderCall') return;
    const a2 = c.arguments[2];
    if (a2?.type === 'MemberExpression' && !a2.computed && a2.property.name === 'procedure' && readsTable(p, a2.object, t.name))
      dispatchers.push(c);
  });
  const leaks = dispatchers.length ? tableLeaks(p, t.name, new Set(dispatchers.map((d) => d.arguments[2]))) : 0;
  if (!dispatchers.length) return undefined;
  const site = { path: literal(n.value), table: t.table, tableName: t.name, dispatchers };
  if (leaks) site.problem = `${t.name}'s \`procedure\` is read by more than its founderCall (or the table is passed on whole)`;
  const modules = new Set(dispatchers.map((d) => literal(d.arguments[1])));
  const methods = new Set(dispatchers.map((d) => literal(d.arguments[3])));
  const [module] = modules;
  const [method] = methods;
  site.module = module;
  site.kind = method === 'GET' ? 'query' : method === 'POST' ? 'mutation' : undefined;
  const b = dispatchers[0].callee.type === 'Identifier' ? bindingOf(p, dispatchers[0].callee, 'founderCall') : undefined;
  if (b?.kind === 'import') site.founderCallFrom = b.from;
  else site.problem ??= 'founderCall not imported by name';
  if (site.problem) return site;
  if (modules.size !== 1 || !module) site.problem = `${t.name}'s calls name more than one service, or none by a literal`;
  else if (methods.size !== 1 || !site.kind) site.problem = `${t.name}'s calls send more than one method, or none by a literal`;
  else if (dispatchers.some((d) => d.arguments.length < 6 || d.arguments.length > 7 || d.arguments.some((x) => x.type === 'SpreadElement')))
    site.problem = `${t.name}'s calls have an argument list the codemod does not read`;
  else if (dispatchers.some((d) => d.arguments[6] && /sendEmptyInput/.test(p.src.slice(d.arguments[6].start, d.arguments[6].end))))
    site.problem = 'founderCall with sendEmptyInput';
  return site;
}

/** The table entries in one parsed file that its own `founderCall(..., spec.procedure, ...)` sends. */
export function opsEntrySites(p) {
  const out = [];
  walk(p.program, (n) => {
    const entry = n.type === 'Property' && keyOf(n) === 'procedure' ? opsEntry(p, n) : undefined;
    if (entry) out.push(entry);
  });
  return out;
}
