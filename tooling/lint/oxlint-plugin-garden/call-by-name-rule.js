// garden/no-call-by-name: an app calls a service through the call's written record in @intafaced/contracts
// (packages/contracts/src/procedure.ts), `api.call(<RECORD>, input)`, so its path, input type and answer parser come from the
// one record the service mounts. A call named by strings carries its own copy of the answer and drifts from the service
// without failing to compile. The shapes counted, in apps/customer/src and apps/admin/src outside tests:
//   - `api.query('bank', 'cards.list', …)` / `api.mutate('agents', procedure, …)`: a service or call named by a string;
//   - `useBankRead('cards.list', …)`: a read named by a string;
//   - `{ procedure: 'cards.freeze' }`: a dialog or step naming its call by a string;
//   - `founderCall(ctx, 'bank', 'x.y', …)`, `founderEdgeCall(config, 'ops', 'x.y', …)`, `payCall(ctx, 'x.y', …)`;
//   - `{ 'cards.list': cardsSchema }`: a hand schema keyed by a call's name.
//   - `useBank('businessTeam.roles', …)`, `change.run('x.y', …)`: a helper given the call's name by a string, where the helper
//     (a function of the same file, one it returns, or one imported from a file of the app) hands that parameter to a
//     sender above at its service or call position, directly or inside a template: each caller is a finding, beside the
//     helper's own sender.
// The pattern is common (about 1,300 copies), so the rule fails only when a change adds one: judged by the lint ratchet,
// the copies on main are each file's ceiling and a file the change adds starts at zero (tooling/ci/lint-ratchet.mjs,
// tooling/lint/ratchet.json failInAddedFiles). `node tooling/lint/count-rule.mjs garden/no-call-by-name` prints how many are
// left and where.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const TEST_FILE = /(\.(test|spec|testkit)\.[cm]?[jt]sx?$)|(\.pw\.[cm]?[jt]s$)|(\/(test|tests|__tests__|__fixtures__)\/)/u;
const APP_SRC = /(?:^|\/)apps\/(?:customer|admin)\/src\//u;
// A call's dotted name as a service mounts it: `cards.list`, `founderAdmin.registries.save`.
const CALL_NAME = /^[a-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)+$/u;
// The helpers that take a call by name, and the positions of its service and call names among their arguments.
const NAMED_AT = { query: [0, 1], mutate: [0, 1], founderCall: [1, 2], founderEdgeCall: [1, 2], payCall: [1], useBankRead: [0] };
const FIX =
  'call it through its record in @intafaced/contracts: `api.call(<RECORD>, input)` (packages/contracts/src/procedure.ts), ' +
  'declaring the record there if it has none';

const isString = (n) => (n?.type === 'Literal' && typeof n.value === 'string') || n?.type === 'TemplateLiteral';
const keyName = (p) =>
  p.key?.type === 'Literal' && typeof p.key.value === 'string'
    ? p.key.value
    : p.key?.type === 'Identifier' && !p.computed
      ? p.key.name
      : undefined;
const isSchema = (v) => {
  let n = v;
  while (n && (n.type === 'CallExpression' || n.type === 'MemberExpression')) n = n.type === 'CallExpression' ? n.callee : n.object;
  return (n?.type === 'Identifier' && (n.name === 'z' || n.name.endsWith('Schema'))) || false;
};

const SKIP_KEYS = new Set(['parent', 'loc', 'range', 'start', 'end', 'type']);
const isFunction = (n) => n?.type === 'FunctionDeclaration' || n?.type === 'FunctionExpression' || n?.type === 'ArrowFunctionExpression';
/** Every node under `node`; `visit` returning false skips a node's children. */
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) walk(c, visit);
    else if (v && typeof v.type === 'string') walk(v, visit);
  }
}
/** The name a call is made by: `f(…)` or `x.f(…)`. */
const calleeName = (c) =>
  c?.type === 'Identifier' ? c.name : c?.type === 'MemberExpression' && !c.computed ? c.property?.name : undefined;
/** The positions of a sender's service and call names, or undefined when the call is no sender above. */
function namedAt(node) {
  const name = calleeName(node.callee);
  if (!name || !Object.hasOwn(NAMED_AT, name)) return undefined;
  // `api.query(…)` / `api.mutate(…)`, never a bare `query(…)` (a database or test helper of the same name).
  if ((name === 'query' || name === 'mutate') && node.callee.type !== 'MemberExpression') return undefined;
  return NAMED_AT[name];
}
/** Whether `arg` is the parameter `name` itself, or a template or `+` that holds it. */
function carries(arg, name) {
  if (arg?.type === 'Identifier') return arg.name === name;
  if (arg?.type === 'TemplateLiteral') return arg.expressions.some((e) => carries(e, name));
  if (arg?.type === 'BinaryExpression' && arg.operator === '+') return carries(arg.left, name) || carries(arg.right, name);
  if (arg?.type === 'TSAsExpression' || arg?.type === 'TSNonNullExpression') return carries(arg.expression, name);
  return false;
}
/** A function's plain parameter names by position (`rev = 0` counts as `rev`). */
const paramNames = (fn) =>
  fn.params.map((p) =>
    p.type === 'Identifier' ? p.name : p.type === 'AssignmentPattern' && p.left.type === 'Identifier' ? p.left.name : undefined,
  );
/** The names a declaration or pattern binds. */
function boundNames(p, out) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p.name);
  else if (p.type === 'AssignmentPattern') boundNames(p.left, out);
  else if (p.type === 'RestElement') boundNames(p.argument, out);
  else if (p.type === 'ArrayPattern') for (const e of p.elements) boundNames(e, out);
  else if (p.type === 'ObjectPattern') for (const x of p.properties) boundNames(x.type === 'RestElement' ? x : x.value, out);
  return out;
}

/**
 * The helpers of one program that send a parameter as a call's service or name: `{ senders, returned, bindings, exported }`.
 * `senders`: function name → the argument positions its callers name the call at (only names the program binds once);
 * `returned`: function name → { method → positions } for a sender it returns in an object (`return { run }`);
 * `exported`: exported name → local name.
 */
export function helpersOf(program) {
  const bindings = new Map();
  const fns = [];
  const exported = new Map();
  const bind = (n) => bindings.set(n, (bindings.get(n) ?? 0) + 1);
  walk(program, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) {
      bind(n.id.name);
      fns.push({ name: n.id.name, fn: n });
    } else if (n.type === 'VariableDeclarator') {
      for (const x of boundNames(n.id, [])) bind(x);
      if (n.id.type === 'Identifier' && isFunction(n.init)) fns.push({ name: n.id.name, fn: n.init });
    } else if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier')
      bind(n.local.name);
    else if (n.type === 'ClassDeclaration' && n.id) bind(n.id.name);
    else if (n.type === 'CatchClause') for (const x of boundNames(n.param, [])) bind(x);
    if (isFunction(n)) for (const p of n.params) for (const x of boundNames(p, [])) bind(x);
    if (n.type === 'ExportNamedDeclaration') {
      const d = n.declaration;
      if (d?.type === 'FunctionDeclaration' && d.id) exported.set(d.id.name, d.id.name);
      if (d?.type === 'VariableDeclaration')
        for (const v of d.declarations) if (v.id.type === 'Identifier') exported.set(v.id.name, v.id.name);
      if (!n.source) for (const s of n.specifiers ?? []) exported.set(s.exported.name ?? s.exported.value, s.local.name ?? s.local.value);
    }
  });
  const once = fns.filter((f) => bindings.get(f.name) === 1);
  const senders = new Map();
  // A helper that hands its parameter to another helper at that one's position is a sender too: repeat until none is added.
  for (let changed = true; changed;) {
    changed = false;
    for (const { name, fn } of once) {
      const params = paramNames(fn);
      const at = new Set(senders.get(name) ?? []);
      const before = at.size;
      walk(fn.body, (n) => {
        if (n.type !== 'CallExpression') return;
        const positions = namedAt(n) ?? (n.callee.type === 'Identifier' && n.callee.name !== name ? senders.get(n.callee.name) : undefined);
        if (!positions) return;
        for (const i of positions) params.forEach((p, k) => p && carries(n.arguments[i], p) && at.add(k));
      });
      if (at.size > before) {
        senders.set(name, [...at].sort());
        changed = true;
      }
    }
  }
  const returned = new Map();
  for (const { name, fn } of once) {
    if (fn.body?.type !== 'BlockStatement') continue;
    const methods = {};
    walk(fn.body, (n) => {
      if (isFunction(n)) return false;
      if (n.type !== 'ReturnStatement' || n.argument?.type !== 'ObjectExpression') return;
      for (const p of n.argument.properties) {
        const key = p.type === 'Property' && !p.computed ? keyName(p) : undefined;
        if (key && p.value?.type === 'Identifier' && senders.has(p.value.name)) methods[key] = senders.get(p.value.name);
      }
    });
    if (Object.keys(methods).length) returned.set(name, methods);
  }
  return { senders, returned, bindings, exported };
}

const FILE_EXT = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js'];
const parsed = new Map();
let parser;
/** oxc-parser, from beside this plugin or from the checkout the lint ratchet names (GARDEN_TREE); null when neither has it. */
function parse(file, text) {
  if (parser === undefined) {
    parser = null;
    for (const from of [import.meta.url, process.env.GARDEN_TREE && join(process.env.GARDEN_TREE, 'package.json')].filter(Boolean)) {
      try {
        parser = createRequire(from)('oxc-parser');
        break;
      } catch {
        // not installed there
      }
    }
  }
  return parser ? parser.parseSync(file, text).program : undefined;
}
/** The helpers an app file exports (exported name → positions), read once per lint run. */
function exportedSenders(file) {
  if (parsed.has(file)) return parsed.get(file);
  let out = new Map();
  try {
    const program = parse(file, readFileSync(file, 'utf8'));
    if (program) {
      const h = helpersOf(program);
      out = new Map([...h.exported].filter(([, local]) => h.senders.has(local)).map(([name, local]) => [name, h.senders.get(local)]));
    }
  } catch {
    // unreadable or unparsable: it names no helper
  }
  parsed.set(file, out);
  return out;
}
/** The app file an import names (relative, or the app's `@/`), beside the linted file or in the lint ratchet's checkout. */
function importedFile(file, spec) {
  const app = /^(.*?)(apps\/(?:customer|admin)\/src\/)/u.exec(file);
  if (!app) return undefined;
  const rel = spec.startsWith('@/')
    ? app[2] + spec.slice(2)
    : spec.startsWith('.')
      ? join(dirname(file.slice(app[1].length)), spec)
      : undefined;
  if (!rel || !APP_SRC.test(rel) || TEST_FILE.test(rel)) return undefined;
  for (const root of [app[1] || '.', process.env.GARDEN_TREE].filter(Boolean))
    for (const ext of FILE_EXT) {
      const f = join(root, rel + ext);
      if (/\.[cm]?[jt]sx?$/u.test(f) && existsSync(f)) return f;
    }
  return undefined;
}

const noCallByName = {
  meta: { type: 'suggestion', docs: { description: 'An app calls a service through its written record, never by name.' } },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    if (!APP_SRC.test(file) || TEST_FILE.test(file)) return {};
    let local = { senders: new Map(), returned: new Map(), bindings: new Map() };
    const imported = new Map();
    const madeBy = new Map();
    const helperAt = (node) => {
      const c = node.callee;
      if (c?.type === 'Identifier') return local.senders.get(c.name) ?? imported.get(c.name);
      if (c?.type !== 'MemberExpression' || c.computed || c.object.type !== 'Identifier') return undefined;
      return local.returned.get(madeBy.get(c.object.name))?.[c.property.name];
    };
    return {
      Program(node) {
        local = helpersOf(node);
        for (const s of node.body) {
          if (s.type !== 'ImportDeclaration' || s.importKind === 'type') continue;
          const from = importedFile(file, s.source.value);
          if (!from) continue;
          for (const sp of s.specifiers) {
            if (sp.type !== 'ImportSpecifier' || local.bindings.get(sp.local.name) !== 1) continue;
            const at = exportedSenders(from).get(sp.imported.name ?? sp.imported.value);
            if (at) imported.set(sp.local.name, at);
          }
        }
        // `const change = useChange(…)`: its `change.run(…)` is the helper useChange returns, when every binding of
        // `change` in the file is made by that one helper.
        const made = new Map();
        walk(node, (n) => {
          if (n.type !== 'VariableDeclarator' || n.id.type !== 'Identifier') return;
          const init = n.init?.type === 'AwaitExpression' ? n.init.argument : n.init;
          const by = init?.type === 'CallExpression' && init.callee.type === 'Identifier' ? init.callee.name : undefined;
          const was = made.get(n.id.name) ?? { by, n: 0 };
          made.set(n.id.name, { by: was.by === by ? by : undefined, n: was.n + 1 });
        });
        for (const [name, m] of made) if (m.by && local.returned.has(m.by) && m.n === local.bindings.get(name)) madeBy.set(name, m.by);
      },
      CallExpression(node) {
        const at = namedAt(node);
        if (at) {
          if (at.some((i) => isString(node.arguments[i])))
            context.report({ node, message: `\`${calleeName(node.callee)}\` names its service or call by a string: ${FIX}` });
          return;
        }
        const helper = helperAt(node);
        if (helper?.some((i) => isString(node.arguments[i])))
          context.report({
            node,
            message: `a helper given the call's name, \`${calleeName(node.callee)}\`, is handed it by a string: ${FIX}`,
          });
      },
      Property(node) {
        const key = keyName(node);
        // `procedure: ''` names no call (an unknown tool's empty result), so there is nothing to name by record.
        if (key === 'procedure' && isString(node.value) && node.value.value !== '') {
          context.report({ node, message: `\`procedure:\` names a call by a string: ${FIX}` });
          return;
        }
        if (node.key?.type === 'Literal' && key && CALL_NAME.test(key) && isSchema(node.value))
          context.report({ node, message: `a schema keyed by the call's name \`${key}\` is a hand copy of its answer: ${FIX}` });
      },
    };
  },
};

export const callByNameRules = { 'no-call-by-name': noCallByName };
