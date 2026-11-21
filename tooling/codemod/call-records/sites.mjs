// Every app call that names its service and call by strings: the shapes `garden/no-call-by-name` counts
// (tooling/lint/oxlint-plugin-garden/call-by-name-rule.js), each with what a rewrite needs, or the reason it can't be.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { bindingOf, calleeName, keyOf, literal, load, resolveRelative, walk } from './ast.mjs';

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
        if (!site.problem && (!site.module || !site.path)) site.problem = 'service or call named by a template';
        out.push(site);
      }
      if (n.type === 'Property') {
        const key = keyOf(n);
        if (key === 'procedure' && isString(n.value))
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
