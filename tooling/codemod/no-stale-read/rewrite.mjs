#!/usr/bin/env node
// Rewrites each journey assertion on a one-shot read of the screen, `expect(f(await el.innerText()), msg).toBe(x)`, into
// the retrying form garden/no-stale-read names: `await expect.poll(async () => f(await el.innerText()), msg).toBe(x)`.
// The same matcher judges the same value, read again until it passes or the assertion's usual timeout runs out; only how
// long the assertion waits changes. A one-shot read can catch what the page showed before an action's answer replaced it,
// which kept failing proven steps on main one at a time (J-cex-spot-07 #4, J-agents-11 #5, J-more-catalogue-02 #2).
// The lint rule (tooling/lint/oxlint-plugin-garden/stale-read-rule.js) refuses new copies; this clears the old ones.
//
//   node tooling/codemod/no-stale-read/rewrite.mjs [files…]           rewrite (default: every real-app journey file), then
//                                                                       prettier the files it changed; lists what it left
//   node tooling/codemod/no-stale-read/rewrite.mjs --check [files…]   list what it would change and leave; exit 1 if any change
//
// A site is left, with its reason, when retrying could change what it proves:
//   - negated (`.not`): retried, it passes the first moment the value differs, where the one read had to differ at once;
//   - inside a block `expect(async () => …).toPass()` already retries with the values it reads beside it;
//   - soft, `.resolves`/`.rejects`, or an options object as expect's second argument;
//   - not a statement of its own (its value is returned, kept or combined);
//   - the value read holds anything but screen reads to await, an assignment, or a `.exec`/`.test` on a shared regex:
//     reading it again would run that again;
//   - the matcher's own arguments await something: their order against the read would change;
//   - it asserts the screen stayed as it was (it equals a `…before` snapshot or a value read off the screen earlier, or its message says the screen
//     leaves, keeps or still shows something): like a negation, that must hold from the first read.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REAL_APP = join('apps', 'customer', 'tests', 'real-app');
// The rule's own list of one-shot screen reads (stale-read-rule.js SCREEN_READS).
const SCREEN_READS = new Set(['innerText', 'textContent', 'inputValue', 'getAttribute', 'allInnerTexts', 'allTextContents']);
// Other reads that only look at the page, safe to repeat inside the retried value.
const READS = new Set([...SCREEN_READS, 'count', 'isVisible', 'isHidden', 'isChecked', 'isEnabled', 'isDisabled', 'isEditable']);
const STAYED = /\b(?:leaves?|unchanged|stays?|stayed|still|never|kept|as it was|changed nothing|changes nothing|nothing changed)\b/iu;
const FUNCTIONS = new Set(['FunctionExpression', 'ArrowFunctionExpression', 'FunctionDeclaration']);

const method = (n) =>
  n?.type === 'CallExpression' && n.callee?.type === 'MemberExpression' && !n.callee.computed ? n.callee.property?.name : undefined;

/** Every node under `node` with its parent; `intoFunctions: false` stops at a nested function. */
function walk(node, visit, parent = null, intoFunctions = true) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  if (!intoFunctions && FUNCTIONS.has(node.type)) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'type' || !value || typeof value !== 'object') continue;
    if (Array.isArray(value)) for (const v of value) walk(v, visit, node, intoFunctions);
    else walk(value, visit, node, intoFunctions);
  }
}
const some = (node, pred, intoFunctions = true) => {
  let hit = false;
  walk(node, (n) => (hit ||= pred(n)), null, intoFunctions);
  return hit;
};

/** `expect(…)` (not `.soft`, `.poll`) or `expect.soft(…)`: 'plain' | 'soft' | undefined. */
function expectKind(n) {
  const c = n.callee;
  if (c?.type === 'Identifier' && c.name === 'expect') return 'plain';
  if (c?.type === 'MemberExpression' && c.object?.type === 'Identifier' && c.object.name === 'expect' && c.property?.name === 'soft')
    return 'soft';
  return undefined;
}

/** The first one-shot screen read awaited in `value`, outside nested functions, as the rule finds it; else undefined. */
const screenRead = (value) => {
  let read;
  walk(
    value,
    (n) => {
      if (n.type === 'AwaitExpression' && SCREEN_READS.has(method(n.argument))) read ??= method(n.argument);
    },
    null,
    false,
  );
  return read;
};

/** Why the retried form would not prove the same thing, or null when it would. */
function whyLeft(kind, call, parents, src, screenNames) {
  if (kind === 'soft') return 'soft assertion';
  for (let a = parents.get(call); a; a = parents.get(a))
    if (
      FUNCTIONS.has(a.type) &&
      parents.get(a)?.type === 'CallExpression' &&
      expectKind(parents.get(a)) &&
      parents.get(a).arguments[0] === a
    )
      return 'already inside a retried block (`expect(async () => …).toPass()`), which reads the page and its other values again together';
  const [value, message, ...rest] = call.arguments;
  if (rest.length || value.type === 'SpreadElement') return 'unusual expect arguments';
  if (message && message.type !== 'Literal' && message.type !== 'TemplateLiteral') return 'expect has an options argument';
  if (message?.type === 'Literal' && typeof message.value !== 'string') return 'expect has an options argument';
  // Up the chain: expect(…)[.not|.resolves|.rejects].matcher(args)
  let n = call;
  const props = [];
  for (;;) {
    const p = parents.get(n);
    if (p?.type === 'MemberExpression' && p.object === n && !p.computed) {
      props.push(p.property.name);
      n = p;
      continue;
    }
    if (p?.type === 'CallExpression' && p.callee === n && props.length) {
      n = p;
      break;
    }
    return 'not a matcher call';
  }
  if (props.includes('not')) return 'negated: the one read must already differ';
  if (props.includes('resolves') || props.includes('rejects')) return 'resolves/rejects';
  const stmt = parents.get(n);
  if (stmt?.type !== 'ExpressionStatement' || stmt.expression !== n) return 'not a statement of its own';
  if (some({ type: 'X', a: n.arguments }, (x) => x.type === 'AwaitExpression')) return 'the matcher awaits its own argument';
  const expected = n.arguments.map((a) => src.slice(a.start, a.end)).join(' ');
  const said = message ? src.slice(message.start, message.end) : '';
  const equal = ['toBe', 'toEqual', 'toStrictEqual'].includes(n.callee.property.name);
  const earlier = n.arguments.length === 1 && n.arguments[0].type === 'Identifier' && screenNames.has(n.arguments[0].name);
  if ((equal && (earlier || /^[\w.$]*before[\w.$]*$/iu.test(expected))) || STAYED.test(said))
    return 'equals what the screen showed earlier, or says it stayed: must hold from the first read';
  if (some(value, (x) => x.type === 'AwaitExpression' && !READS.has(method(x.argument))))
    return 'the value awaits something other than a screen read';
  if (some(value, (x) => x.type === 'AssignmentExpression' || x.type === 'UpdateExpression')) return 'the value assigns';
  if (some(value, (x) => ['exec', 'test'].includes(method(x)) && x.callee.object.type !== 'Literal'))
    return 'the value runs a shared regex';
  return { matcher: n };
}

/** The rewritten text of one file, with what changed and what was left. */
export function rewrite(src, file = 'x.mjs') {
  const { program, errors } = parseSync(file, src);
  if (errors.length) throw new Error(`${file}: ${errors[0].message}`);
  const parents = new Map();
  const found = [];
  // Names the file binds to something read off the screen: an assertion equal to one compares with what was shown earlier.
  const screenNames = new Set();
  walk(program, (n, parent) => {
    parents.set(n, parent);
    if (
      n.type === 'VariableDeclarator' &&
      n.id.type === 'Identifier' &&
      n.init &&
      some(n.init, (x) => x.type === 'AwaitExpression' && SCREEN_READS.has(method(x.argument)))
    )
      screenNames.add(n.id.name);
    if (n.type === 'CallExpression' && expectKind(n) && n.arguments[0] && screenRead(n.arguments[0])) found.push(n);
  });
  const lineOf = (pos) => src.slice(0, pos).split('\n').length;
  const edits = [];
  const done = [];
  const left = [];
  for (const call of found) {
    const why = whyLeft(expectKind(call), call, parents, src, screenNames);
    if (typeof why === 'string') {
      left.push({ line: lineOf(call.start), reason: why });
      continue;
    }
    const [value, message] = call.arguments;
    let body = src.slice(value.start, value.end);
    if (value.type === 'ObjectExpression' || value.type === 'SequenceExpression') body = `(${body})`;
    const msg = message ? `, ${src.slice(message.start, message.end)}` : '';
    edits.push({ start: why.matcher.start, end: why.matcher.start, text: 'await ' });
    edits.push({ start: call.start, end: call.end, text: `expect.poll(async () => ${body}${msg})` });
    done.push({ line: lineOf(call.start) });
  }
  let out = src;
  for (const e of edits.sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { out, done, left };
}

function journeyFiles() {
  const dir = join(REPO, REAL_APP);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.pw.mjs'))
    .sort()
    .map((f) => join(REAL_APP, f));
}

function main(argv) {
  const check = argv.includes('--check');
  const named = argv.filter((a) => !a.startsWith('--'));
  const files = named.length ? named.map((f) => relative(REPO, join(process.cwd(), f))) : journeyFiles();
  const changed = [];
  let nDone = 0;
  const leftLines = [];
  for (const file of files) {
    const src = readFileSync(join(REPO, file), 'utf8');
    const { out, done, left } = rewrite(src, file);
    for (const l of left) leftLines.push(`${file}:${l.line}  left: ${l.reason}`);
    if (!done.length) continue;
    nDone += done.length;
    changed.push(file);
    for (const d of done) console.log(`${file}:${d.line}  ${check ? 'would rewrite' : 'rewritten'}`);
    if (!check) writeFileSync(join(REPO, file), out);
  }
  for (const l of leftLines) console.log(l);
  console.log(`${nDone} rewritten in ${changed.length} files; ${leftLines.length} left`);
  if (check) process.exit(changed.length ? 1 : 0);
  if (changed.length) execFileSync(join(REPO, 'node_modules', '.bin', 'prettier'), ['--write', ...changed], { cwd: REPO, stdio: 'ignore' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
