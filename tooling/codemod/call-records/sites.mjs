// Every app call that names its service and call by strings: the shapes `garden/no-call-by-name` counts
// (tooling/lint/oxlint-plugin-garden/call-by-name-rule.js), each with what a rewrite needs, or the reason it can't be.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { bindingOf, calleeName, keyOf, literal, load, resolveRelative, walk } from './ast.mjs';
import { fanOut } from './fan.mjs';
import { handSchemas } from './dead-hand-schemas.mjs';
import { businessSite } from './pay-business.mjs';
import { toolSite } from './tool-forms.mjs';
import { wrapperOut } from './wrapper.mjs';

const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__|__fixtures__)\/)/u;
const NAMED_AT = { query: [0, 1], mutate: [0, 1], founderCall: [1, 2], founderEdgeCall: [1, 2], payCall: [1], useBankRead: [0] };
/** The record form each wrapper's home declares beside it. */
const FORM_OF = { founderEdgeCall: 'founderEdgeRecordCall', payCall: 'payRecordCall', useBankRead: 'useBankRecord' };
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
  const files = appFiles(repo);
  const wrappers = new Set();
  for (const file of files) {
    const p = load(file);
    const line = (n) => p.src.slice(0, n.start).split('\n').length;
    walk(p.program, (n) => {
      if (n.type === 'CallExpression') {
        // A portal tool called bare, by name: its record form is beside it (tool-forms.mjs).
        const tool = toolSite(p, n);
        if (tool) {
          out.push({ file, line: line(n), node: n, ...tool });
          return;
        }
        const name = calleeName(n);
        if (!name || !Object.hasOwn(NAMED_AT, name)) return;
        if ((name === 'query' || name === 'mutate') && n.callee.type !== 'MemberExpression') return;
        if (!NAMED_AT[name].some((i) => isString(n.arguments[i]))) return;
        const a = n.arguments;
        const site = { file, line: line(n), node: n, shape: name };
        const business = businessSite(p, n);
        if (business) Object.assign(site, business);
        else if (name === 'query' || name === 'mutate') {
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
        } else if (name === 'founderEdgeCall' || name === 'payCall' || name === 'useBankRead') {
          // Each has its record form beside it, which the codemod calls from where the site imports the wrapper.
          const at = {
            founderEdgeCall: { module: 1, path: 2, method: 3 },
            payCall: { module: 5, path: 1, method: 2 },
            useBankRead: { path: 0 },
          }[name];
          const method = at.method === undefined ? 'GET' : literal(a[at.method]);
          Object.assign(site, {
            module: name === 'useBankRead' ? 'bank' : name === 'payCall' && a[5] === undefined ? 'pay' : literal(a[at.module]),
            path: literal(a[at.path]),
            kind: method === 'GET' ? 'query' : method === 'POST' ? 'mutation' : undefined,
          });
          const b = n.callee.type === 'Identifier' ? bindingOf(p, n.callee, name) : undefined;
          // Imported by name, or declared in this file, whose record form is declared beside it (no import to add).
          if (b?.kind === 'import') site.wrapperFrom = b.from;
          else if (b?.kind !== 'function' || !p.src.includes(`function ${FORM_OF[name]}`)) site.problem = `${name} not imported by name`;
          if (!site.problem && !site.kind) site.problem = `${name} with a method that is not a literal`;
          if (!site.problem && a.some((x) => x.type === 'SpreadElement')) site.problem = `${name} with a spread argument`;
          if (!site.problem && name === 'payCall' && !isSchemaParse(a[4])) site.reader = true;
          if (!site.problem && name === 'useBankRead' && site.path) {
            site.schema = bankReadSchema(p, b, site.path);
            if (!site.schema) site.problem = `useBankRead's answer schema bankReads['${site.path}'] is not one the codemod can read`;
          }
        }
        if (name === 'founderCall' && a[2]?.type === 'MemberExpression' && !a[2].computed && a[2].property.name === 'procedure')
          Object.assign(site, { shape: 'ops-dispatch', problem: 'sends the call its table entry names: it moves with the table' });
        // A call named by its wrapper's parameter or spec: a site per caller's string, or the wrapper named with why (wrapper.mjs).
        const w = !site.problem && site.module && !site.path ? wrapperOut(p, site, files, wrappers) : undefined;
        if (Array.isArray(w)) out.push(...w);
        else if (w) out.push({ ...site, problem: `call name passed through a wrapper: ${w.why}` });
        // A service or call not named by a string: one site per value the code lists, or the call named with why (fan.mjs).
        else if (!site.problem && (!site.module || !site.path)) out.push(...fanOut(p, site));
        else out.push(site);
      }
      if (n.type === 'Property') {
        const key = keyOf(n);
        const desk = key === 'procedure' ? deskRead(p, n) : undefined;
        const entry = key === 'procedure' && !desk ? opsEntry(p, n) : undefined;
        const spec = key === 'procedure' && !desk && !entry ? writeSpec(p, n) : undefined;
        if (desk) out.push({ file, line: line(n), node: n, shape: 'desk-read', ...desk });
        else if (spec) out.push({ file, line: line(n), node: n, shape: 'write-spec', ...spec });
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
  // A spec's `procedure: '<call>'` that its wrapper moves is that wrapper's site, not a second one of its own.
  const claimed = new Set(out.filter((s) => s.shape === 'wrapper').map((s) => s.node));
  return out.filter((s) => s.shape === 'wrapper' || !claimed.has(s.node));
}

/** `parseWith(schema)` or `schema.safeParse`-shaped: the call's answer as the service sends it, nothing of its own. */
function isSchemaParse(n) {
  return n?.type === 'CallExpression' && n.callee.type === 'Identifier' && n.callee.name === 'parseWith' && n.arguments.length === 1;
}

/**
 * The schema `useBankRead(path, ...)` parses its answer with: `bankReads[path]`, followed from the file `useBankRead` is
 * imported from, through `bankReads`' import and the spreads it is composed of. `{ p, node }`, or undefined.
 */
function bankReadSchema(p, useBankRead, path) {
  // `./components` may be a .tsx file, which resolveRelative does not try without an extension.
  const fileOf = (q, b) =>
    b?.kind === 'import' && b.from.startsWith('.')
      ? (resolveRelative(q.file, b.from) ?? resolveRelative(q.file, `${b.from}.tsx`))
      : undefined;
  const declared = (file, name, seen = new Set()) => {
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
      } else if (prop.type === 'Property' && keyOf(prop) === path) found = { p: q, node: prop.value };
    }
    return found;
  };
  const reads = declared(fileOf(p, useBankRead), 'bankReads');
  return reads && inObject(reads.q, reads.init, new Set());
}

/**
 * A catalog entry that names its record by a spread the file defines: an ops-desk read (`{ module: 'bank', procedure:
 * 'health' }` beside `readOf`, always a query) or an operator tool (`{ edgeModule: 'bank', procedure: 'ops.x', kind:
 * 'mutation' }` beside `toolOf`). The entry becomes `...readOf(RECORD)` or `...toolOf(RECORD)` where `procedure` was, and
 * the keys the record now gives are dropped.
 */
const SPREADS = [
  // A desk read in a file that has `ReadSpec` but not `readOf` imports `readOf` from where `ReadSpec` comes from.
  { helper: 'readOf', moduleKey: 'module', kindKey: undefined, typeName: 'ReadSpec' },
  { helper: 'toolOf', moduleKey: 'edgeModule', kindKey: 'kind' },
];
function deskRead(p, n) {
  if (!literal(n.value)) return undefined;
  const obj = p.parents.get(n);
  if (obj?.type !== 'ObjectExpression') return undefined;
  const prop = (k) => obj.properties.find((pr) => pr.type === 'Property' && keyOf(pr) === k && literal(pr.value));
  for (const { helper, moduleKey, kindKey, typeName } of SPREADS) {
    const moduleProp = prop(moduleKey);
    const kindProp = kindKey ? prop(kindKey) : undefined;
    if (!moduleProp || (kindKey && !kindProp)) continue;
    // `bindingOf` names an unbound name `global`.
    const bound = bindingOf(p, n, helper).kind !== 'global';
    const type = typeName ? bindingOf(p, n, typeName) : undefined;
    const helperFrom = !bound && type?.kind === 'import' ? type.from : undefined;
    if (!bound && !helperFrom) continue;
    const kind = kindProp ? literal(kindProp.value) : 'query';
    if (kind !== 'query' && kind !== 'mutation') continue;
    const inputProp = obj.properties.find((pr) => pr.type === 'Property' && keyOf(pr) === 'input');
    return {
      module: literal(moduleProp.value),
      path: literal(n.value),
      kind,
      helper,
      helperFrom,
      drop: [moduleProp, kindProp].filter(Boolean),
      inputProp,
      obj,
    };
  }
  return undefined;
}

/** The keys every bank write spec has beside its call (`ActionSpec`, apps/customer/src/features/money/components.tsx). */
const SPEC_KEYS = ['title', 'notes', 'input'];
/**
 * A bank write dialog's spec, `{ title, procedure: 'sorter.create', notes, input }` in a file that names `ActionSpec`: it
 * names its record (`record: RECORD`) and the dialog sends it by that record (`sendWrite`, features/money/write-flow.ts).
 * Its answer schema is the hand one the dialog held it to, `bankWrites[path]` (`schema`), so a check there is not lost.
 */
function writeSpec(p, n) {
  const path = literal(n.value);
  const obj = p.parents.get(n);
  if (!path || obj?.type !== 'ObjectExpression' || bindingOf(p, n, 'ActionSpec').kind === 'global') return undefined;
  const keys = new Set(obj.properties.map((pr) => (pr.type === 'Property' ? keyOf(pr) : undefined)));
  if (!SPEC_KEYS.every((k) => keys.has(k))) return undefined;
  const site = { module: 'bank', path, kind: 'mutation' };
  const repo = p.file.slice(0, p.file.indexOf('/apps/customer/src/'));
  const hand = repo ? handSchemas(repo).find((h) => h.map.endsWith('Writes') && h.name === path) : undefined;
  if (hand) site.schema = { p: hand.p, node: hand.prop.value };
  return site;
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
