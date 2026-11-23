#!/usr/bin/env node
// The test-doubles step of the call-records codemod: a test that hands the app an API client of its own (an object with
// `query` and `mutate`) and reaches code that now calls by record gets that double a `call`, which sends the record's
// module, path, input and answer schema to the double's own `query` or `mutate`, as the real client's `call` sends them
// down the same wire. So a double that answers by name answers by record the same way, and one that never answers
// still never answers. run.mjs runs it with the rest.
//
//   node tooling/codemod/call-records/doubles.mjs [--write]
//
// Safe to rerun: a double that has `call` is left as it is.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { applyEdits, forget, keyOf, load, resolveRelative, walk } from './ast.mjs';
import { businessDoubleEdits, callsBusinessRecord } from './pay-business.mjs';

const REPO = resolve(new URL('../../..', import.meta.url).pathname);

export const CALL_METHOD = [
  'call(',
  '  this: { query: (...args: never[]) => unknown; mutate: (...args: never[]) => unknown },',
  '  record: { kind: string; module: string; path: string; output: unknown },',
  '  input?: unknown,',
  '  opts?: unknown,',
  ') {',
  "  // tooling/codemod/call-records: a call by its record reaches this double's own query or mutate, as the client sends it.",
  "  return Reflect.apply(record.kind === 'query' ? this.query : this.mutate, this, [record.module, record.path, input, record.output, opts]);",
  '},',
].join('\n');

/**
 * The `call` for a double with only one of `query` and `mutate` (a `useApi` mock that sends only reads, or only writes): it
 * sends a record of that kind to it, and refuses the other kind as the missing method did when the call went by name.
 */
export function callMethodFor(keys) {
  if (keys.includes('query') && keys.includes('mutate')) return CALL_METHOD;
  const has = keys.includes('query') ? 'query' : 'mutate';
  const kind = has === 'query' ? 'query' : 'mutation';
  return [
    'call(',
    `  this: { ${has}: (...args: never[]) => unknown },`,
    '  record: { kind: string; module: string; path: string; output: unknown },',
    '  input?: unknown,',
    '  opts?: unknown,',
    ') {',
    `  // tooling/codemod/call-records: a call by its record reaches this double's own ${has}, as the client sends it; it has no other.`,
    `  if (record.kind !== '${kind}') throw new TypeError('this API double has no ${has === 'query' ? 'mutate' : 'query'}');`,
    `  return Reflect.apply(this.${has}, this, [record.module, record.path, input, record.output, opts]);`,
    '},',
  ].join('\n');
}

const tracked = (pattern) =>
  execFileSync('git', ['ls-files', '--', pattern], { cwd: REPO, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((f) => join(REPO, f));
const isTest = (f) => /\.test\.tsx?$/.test(f);

/** The app files that call by record: `api.call(SOME_RECORD, ...)`. */
function recordCallers(files) {
  return new Set(files.filter((f) => !isTest(f) && /\.call\(\s*[A-Z][A-Z0-9_]+\b/.test(readFileSync(f, 'utf8'))));
}

/** Whether `file`, following its relative imports (and the modules its `vi.mock` calls name), reaches one of `targets`. */
function reaches(file, targets, memo = new Map()) {
  const seen = new Set();
  const stack = [file];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (targets.has(f)) return true;
    if (memo.get(f) === false && f !== file) continue;
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const m of src.matchAll(/(?:from|import\(|vi\.mock\(|require\()\s*['"](\.[^'"]+)['"]/g)) {
      const to = resolveRelative(f, m[1]);
      if (to && !seen.has(to)) stack.push(to);
    }
  }
  memo.set(file, false);
  return false;
}

/**
 * The object literals in `file` shaped as an API client double, with no `call`: `query` and `mutate`, or one of them in what
 * a `useApi` mock returns (`useApi: () => ({ mutate })`).
 */
export function doublesIn(file) {
  const p = load(file);
  const out = [];
  walk(p.program, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const keys = node.properties.filter((pr) => pr.type === 'Property').map(keyOf);
    if (keys.includes('call')) return;
    if (keys.includes('query') && keys.includes('mutate')) out.push(node);
    else if ((keys.includes('query') || keys.includes('mutate')) && fromUseApi(p, node)) out.push(node);
  });
  return { p, out };
}

/** Whether an object is what a `useApi` mock returns: `useApi: () => ({ ... })`. */
function fromUseApi(p, node) {
  let n = p.parents.get(node);
  while (n?.type === 'ParenthesizedExpression') n = p.parents.get(n);
  const prop = n?.type === 'ArrowFunctionExpression' && n.body !== undefined ? p.parents.get(n) : undefined;
  return prop?.type === 'Property' && keyOf(prop) === 'useApi';
}

/** The edit adding `call` to one double: after its last property, in the literal's own indentation. */
function addCall(p, node) {
  const method = callMethodFor(node.properties.filter((pr) => pr.type === 'Property').map(keyOf));
  const last = node.properties[node.properties.length - 1];
  const oneLine = !p.src.slice(node.start, node.end).includes('\n');
  if (oneLine) {
    const inline = method
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .map((l) => l.trim())
      .join(' ')
      .replace(/,$/, '');
    return { start: last.end, end: last.end, text: `, ${inline}` };
  }
  const lineStart = p.src.lastIndexOf('\n', last.start) + 1;
  const indent = p.src.slice(lineStart, last.start).match(/^\s*/)[0];
  const after = p.src.slice(last.end).match(/^\s*,/);
  const at = after ? last.end + after[0].length : last.end;
  const body = method
    .split('\n')
    .map((l) => indent + l)
    .join('\n');
  return { start: at, end: at, text: `${after ? '' : ','}\n${body}` };
}

function run({ write = false } = {}) {
  const files = tracked('apps').filter((f) => /^apps\/[^/]+\/(src|tests)\/.*\.tsx?$/.test(relative(REPO, f)));
  const targets = recordCallers(files);
  // The Business API's own record callers (`pay.queryRecord(RECORD, ...)`): their doubles get its record forms (pay-business.mjs).
  const businessTargets = new Set(files.filter((f) => !isTest(f) && callsBusinessRecord(readFileSync(f, 'utf8'))));
  const memo = new Map();
  const businessMemo = new Map();
  const changed = [];
  for (const file of files.filter(isTest)) {
    if (!/\b(query|mutate)\b/.test(readFileSync(file, 'utf8'))) continue;
    const { p, out } = doublesIn(file);
    const apiEdits = out.length && reaches(file, targets, memo) ? out.map((node) => addCall(p, node)) : [];
    const businessEdits = reaches(file, businessTargets, businessMemo) ? businessDoubleEdits(p) : [];
    if (!apiEdits.length && !businessEdits.length) continue;
    changed.push({ file: relative(REPO, file), doubles: apiEdits.length + businessEdits.length });
    if (write) {
      writeFileSync(file, applyEdits(p.src, [...apiEdits, ...businessEdits]));
      forget(file);
    }
  }
  if (write && changed.length)
    execFileSync(join(REPO, 'node_modules/.bin/prettier'), ['--write', '--log-level', 'warn', ...changed.map((c) => join(REPO, c.file))], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
  return changed;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const changed = run({ write: process.argv.includes('--write') });
  console.log(JSON.stringify({ doubles: changed.reduce((n, c) => n + c.doubles, 0), files: changed }, null, 2));
}
