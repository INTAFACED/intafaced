// Reads a service's tRPC tree: each procedure's dotted path, the file and node it is written at, and its chain
// (`guard(...).input(I).output(O).query(H)`). Follows nested `router({...})`, local consts, `...spread`s and
// `createXRouter(...)` calls into other files.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bindingOf, calleeName, keyOf, load, resolveRelative, walk } from './ast.mjs';
import { boundParams, exportOf } from './defined.mjs';
import { founderAccess } from './founder-guard.mjs';
import { checkedUse, optionCheck, withCheck } from './guard-check.mjs';
import { wrappedInScope, wrappedUse } from './wrapped-check.mjs';

const LEAF = new Set(['query', 'mutation']);

/** The root router: `create<Name>Router` in `src/router.ts` whose body returns `router({...})`. */
function rootOf(serviceDir, fnName) {
  // The router a service serves, `export const appRouter = ...` in src/index.ts, when it has one: it holds every part
  // (svc-identity merges some twenty create*Router parts there), and the router.ts root is one of them.
  const index = join(serviceDir, 'src', 'index.ts');
  if (!fnName && existsSync(index)) {
    const q = load(index);
    let init;
    walk(q.program, (n) => {
      if (n.type === 'VariableDeclarator' && n.id?.name === 'appRouter' && n.init) init = n.init;
    });
    if (init) return { p: q, node: init };
  }
  const file = join(serviceDir, 'src', 'router.ts');
  if (!existsSync(file)) throw new Error(`${serviceDir}: no src/router.ts`);
  const p = load(file);
  const fns = [];
  walk(p.program, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id && (fnName ? n.id.name === fnName : /^create\w*Router$/.test(n.id.name))) fns.push(n);
  });
  const fn = fns.find((f) => returned(p, f)) ?? fns[0];
  if (!fn) throw new Error(`${file}: no create*Router function`);
  return { p, node: returned(p, fn) };
}

/** What a function returns: its arrow body or the argument of its last top-level `return`. */
function returned(p, fn) {
  if (fn.body?.type !== 'BlockStatement') return fn.body;
  const rets = fn.body.body.filter((s) => s.type === 'ReturnStatement');
  return rets.at(-1)?.argument;
}

/**
 * Every procedure under `root`, by dotted path. Paths it cannot follow land in `unread` with the reason, so nothing is
 * guessed.
 */
export function procedures(serviceDir, fnName) {
  const root = rootOf(serviceDir, fnName);
  const out = new Map();
  const unread = [];
  const twice = new Set();
  const seen = new Set();
  const visit = (p, node, prefix, depth, env = undefined) => {
    if (!node || depth > 40) return;
    // A wrapper and what it wraps can start at one offset (`a?.b` and `a.b`), so the type is part of the key.
    const key = `${p.file}:${node.start}:${node.type}:${prefix}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'ParenthesizedExpression' ||
      node.type === 'TSNonNullExpression' ||
      node.type === 'ChainExpression'
    )
      return visit(p, node.expression, prefix, depth + 1, env);
    if (node.type === 'ObjectExpression') {
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') {
          visit(p, prop.argument, prefix, depth + 1, env);
          continue;
        }
        const k = keyOf(prop);
        if (k === undefined) {
          unread.push({ path: `${prefix}<computed>`, why: 'computed key', file: p.file });
          continue;
        }
        visit(p, prop.value, `${prefix}${k}.`, depth + 1, env);
      }
      return;
    }
    if (node.type === 'CallExpression') {
      const name = calleeName(node);
      if (name && LEAF.has(name) && node.callee.type === 'MemberExpression') {
        const path = prefix.slice(0, -1);
        if (out.has(path) && out.get(path).node !== node) twice.add(path);
        out.set(path, { path, p, node, prop: p.parents.get(node) });
        return;
      }
      if (name === 'router' || name === 't.router' || name === 'createTRPCRouter')
        return visit(p, node.arguments[0], prefix, depth + 1, env);
      if (name === 'mergeRouters') {
        for (const a of node.arguments) visit(p, a, prefix, depth + 1, env);
        return;
      }
      if (name === 'mountRecord') {
        out.set(prefix.slice(0, -1), { path: prefix.slice(0, -1), p, node, prop: p.parents.get(node), mounted: true });
        return;
      }
      if (name === 'mountRecords') {
        unread.push({ path: `${prefix}*`, why: 'mountRecords (already records)', file: p.file, mounted: true });
        return;
      }
      if (node.callee.type === 'Identifier') {
        // A factory's parameters are read as the arguments this call passes (defined.mjs).
        const target = functionOf(p, node.callee, node.callee.name);
        if (target) return visit(target.p, returned(target.p, target.fn), prefix, depth + 1, boundParams(target.fn, node, p, env));
      }
      unread.push({ path: `${prefix}*`, why: `call ${name ?? '?'}() not followed`, file: p.file, at: node.start });
      return;
    }
    if (node.type === 'Identifier') {
      const b = bindingOf(p, node, node.name);
      if (b.kind === 'param' && env?.has(node.name)) {
        const bound = env.get(node.name);
        return visit(bound.p, bound.node, prefix, depth + 1, bound.env);
      }
      if (b.kind === 'var' && b.declarator.init) return visit(p, b.declarator.init, prefix, depth + 1, env);
      if (b.kind === 'import') {
        const t = importedFrom(p, b);
        const d = t ? exported(t.q, t.name) : undefined;
        if (d) return visit(t.q, d, prefix, depth + 1);
      }
      unread.push({ path: `${prefix}*`, why: `name ${node.name} not followed (${b.kind})`, file: p.file, at: node.start });
      return;
    }
    // A router behind a switch (`flag ? live : empty`, `a ?? b`): every branch's procedures. A record is the same call
    // whether or not its branch is mounted; unmounted, it is refused exactly as the call by name was.
    if (node.type === 'ConditionalExpression') {
      visit(p, node.consequent, prefix, depth + 1, env);
      visit(p, node.alternate, prefix, depth + 1, env);
      return;
    }
    if (node.type === 'LogicalExpression') {
      visit(p, node.left, prefix, depth + 1, env);
      visit(p, node.right, prefix, depth + 1, env);
      return;
    }
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
      // `...campaigns.customer`: the property of an object a local, an import or a route builder's return gives.
      const obj = objectValue(p, node.object);
      const prop = obj?.node.properties.find((pr) => pr.type === 'Property' && keyOf(pr) === node.property.name);
      if (prop) return visit(obj.p, prop.value, prefix, depth + 1);
    }
    unread.push({ path: `${prefix}*`, why: `${node.type} not followed`, file: p.file, at: node.start });
  };
  visit(root.p, root.node, '', 0);
  // Two procedures under one path (a switch's live and stand-in branches): neither is the record, so both are named.
  for (const path of twice) {
    unread.push({ path, why: 'two procedures under one path (a switch router)', file: out.get(path).p.file });
    out.delete(path);
  }
  return { procedures: out, unread };
}

/** A function a call names: declared in this file or imported from a relative file. */
function functionOf(p, at, name) {
  const b = bindingOf(p, at, name);
  if (b.kind === 'function') return { p, fn: b.declaration };
  if (b.kind === 'var' && /Function/.test(b.declarator.init?.type ?? '')) return { p, fn: b.declarator.init };
  if (b.kind === 'import') {
    const t = importedFrom(p, b);
    const fn = t ? exportedFunction(t.q, t.name) : undefined;
    return fn ? { p: t.q, fn } : undefined;
  }
  return undefined;
}

/** The file and name declaring what an import binding names, through re-exports (defined.mjs). */
function importedFrom(p, b) {
  const file = resolveRelative(p.file, b.from);
  return file ? exportOf(load(file), b.imported) : undefined;
}

function exportedFunction(q, name) {
  for (const stmt of q.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || !stmt.declaration) continue;
    const d = stmt.declaration;
    if (d.type === 'FunctionDeclaration' && d.id?.name === name) return d;
    if (d.type === 'VariableDeclaration')
      for (const v of d.declarations) if (v.id.name === name && /Function/.test(v.init?.type ?? '')) return v.init;
  }
  return undefined;
}

/** The object literal an expression stands for: through locals, imports, parentheses and a function's return. */
function objectValue(p, node, depth = 0) {
  if (!node || depth > 12) return undefined;
  if (node.type === 'ObjectExpression') return { p, node };
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSNonNullExpression' ||
    node.type === 'ChainExpression'
  )
    return objectValue(p, node.expression, depth + 1);
  // An object behind a switch (`ready ? build() : null`, `a && b`): the one branch that gives an object. Two that do are
  // not guessed between.
  const branches =
    node.type === 'ConditionalExpression'
      ? [node.consequent, node.alternate]
      : node.type === 'LogicalExpression'
        ? [node.left, node.right]
        : null;
  if (branches) {
    const found = branches.map((b) => objectValue(p, b, depth + 1)).filter(Boolean);
    return found.length === 1 ? found[0] : undefined;
  }
  if (node.type === 'Identifier') {
    const b = bindingOf(p, node, node.name);
    if (b.kind === 'var' && b.declarator.init) return objectValue(p, b.declarator.init, depth + 1);
    if (b.kind === 'import') {
      const t = importedFrom(p, b);
      const d = t ? exported(t.q, t.name) : undefined;
      return d ? objectValue(t.q, d, depth + 1) : undefined;
    }
    return undefined;
  }
  if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
    const target = functionOf(p, node.callee, node.callee.name);
    return target ? objectValue(target.p, returned(target.p, target.fn), depth + 1) : undefined;
  }
  return undefined;
}

function exported(q, name) {
  for (const stmt of q.program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || !stmt.declaration) continue;
    const d = stmt.declaration;
    if (d.type === 'VariableDeclaration') for (const v of d.declarations) if (v.id.name === name) return v.init;
  }
  return undefined;
}

/**
 * A procedure's chain read from its leaf: the guard it starts from, its `.input()` and `.output()`, and its handler.
 * `problem` names anything a record can't hold (a `.use()`, two inputs, a guard of its own).
 */
export function chainOf(proc) {
  const { p, node } = proc;
  const kind = node.callee.property.name === 'query' ? 'query' : 'mutation';
  const handler = node.arguments[0];
  let input;
  let output;
  const problems = [];
  let cur = node.callee.object;
  while (cur?.type === 'CallExpression' && cur.callee.type === 'MemberExpression' && !cur.callee.computed) {
    const m = cur.callee.property.name;
    if (m === 'input') {
      if (input) problems.push('two .input() calls');
      input = cur.arguments[0];
    } else if (m === 'output') {
      if (output) problems.push('two .output() calls');
      output = cur.arguments[0];
    } else if (m === 'meta') {
      problems.push('.meta()');
    } else if (m === 'use') {
      problems.push('.use() middleware');
    } else break;
    cur = cur.callee.object;
  }
  // The service's founder guard is named on the record and handed to the mount where the procedure stood (founder-guard.mjs).
  const guard = founderAccess(p, cur) ?? guardOf(p, cur, problems);
  // A wrapped check is written where the record mounts: it must read there what it read at its guard.
  if (guard?.check?.inline && !wrappedInScope(p, node, guard.check))
    problems.push('guard use() chained: its wrapped check reads a name that means something else where the record mounts');
  // So must a check of this file handed as the guard's `check` option: the mount is handed it by the same name.
  if (guard?.check?.names && !guard.check.inline && guard.check.file === p.file && !wrappedInScope(p, node, guard.check))
    problems.push(`guard check ${guard.check.name} means something else where the record mounts`);
  if (!output) problems.push('no .output(): the record has no answer schema to take');
  if (!handler) problems.push('no handler');
  return { kind, input, output, handler, guard, problems };
}

const ACCESS_OPTS = new Set(['module', 'plane', 'tier', 'person', 'ownSession', 'check']);

/**
 * Guards whose check no record field says, so their calls stay by name: each with the reason. Naming one here only ever
 * keeps a call; it never moves one.
 */
const KEPT_GUARDS = new Map([
  ['coachRunProcedure', 'checks agents:execute with its own refusal codes before the person-only check; no record field says that'],
]);

/** What an expression stands for, through parentheses, `as const`, a guard function's bound parameters and local consts. */
function valueOf(p, node, env, depth = 0) {
  if (!node || depth > 12) return undefined;
  if (
    node.type === 'TSAsExpression' ||
    node.type === 'TSSatisfiesExpression' ||
    node.type === 'ParenthesizedExpression' ||
    node.type === 'TSNonNullExpression'
  )
    return valueOf(p, node.expression, env, depth + 1);
  if (node.type !== 'Identifier') return { p, node };
  const b = bindingOf(p, node, node.name);
  if (b.kind === 'param' && env?.has(node.name)) {
    const bound = env.get(node.name);
    return valueOf(bound.p, bound.node, bound.env, depth + 1);
  }
  if (b.kind === 'var' && b.declaration?.kind === 'const' && b.declarator.id.type === 'Identifier' && b.declarator.init)
    return valueOf(p, b.declarator.init, undefined, depth + 1);
  if (b.kind === 'import') {
    const file = resolveRelative(p.file, b.from);
    const q = file ? load(file) : undefined;
    const d = q ? exported(q, b.imported) : undefined;
    if (d) return valueOf(q, d, undefined, depth + 1);
  }
  return { p, node };
}

/** The literal an expression stands for (a string, number or boolean), or undefined. */
function literalOf(p, node, env) {
  const v = valueOf(p, node, env);
  return v?.node.type === 'Literal' && ['string', 'number', 'boolean'].includes(typeof v.node.value) ? v.node.value : undefined;
}

/** The record's `access` for a guard expression, as source text, or a problem. */
function guardOf(p, node, problems, depth = 0, env = undefined) {
  const kept = keptName(p, node, env);
  if (kept) {
    problems.push(`guard ${kept} kept by hand: it ${KEPT_GUARDS.get(kept)}`);
    return undefined;
  }
  if (!node || depth > 8) {
    problems.push('guard not read');
    return undefined;
  }
  if (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression')
    return guardOf(p, node.expression, problems, depth + 1, env);
  if (node.type === 'Identifier') {
    if (node.name === 'publicProcedure') return { text: "{ caller: 'public' }", base: node };
    const b = bindingOf(p, node, node.name);
    if (b.kind === 'param' && env?.has(node.name)) {
      const bound = env.get(node.name);
      return guardOf(bound.p, bound.node, problems, depth + 1, bound.env);
    }
    if (b.kind === 'var' && b.declarator.init) return guardOf(p, b.declarator.init, problems, depth + 1);
    // A shared guard of the service's own file that checks more than its scope (`export const opsProcedure = ….use(…)`).
    if (b.kind === 'import') {
      const file = resolveRelative(p.file, b.from);
      const q = file ? load(file) : undefined;
      const init = q ? exported(q, b.imported) : undefined;
      if (init && checkedUse(q, init)) return guardOf(q, init, problems, depth + 1);
    }
    // contracts' protectedProcedure is signedInProcedure() with no module: the same `authed` check and nothing more.
    if (node.name === 'protectedProcedure' && b.kind === 'import' && /^@intafaced\/contracts(\/trpc)?$/.test(b.from ?? ''))
      return { text: "{ caller: 'signedIn' }", base: node };
    problems.push(`guard ${node.name} (${b.kind}) is not one a record names`);
    return undefined;
  }
  if (node.type !== 'CallExpression') {
    problems.push(`guard ${node.type} not read`);
    return undefined;
  }
  if (node.callee.type === 'MemberExpression') {
    // A scope guard and one check of the service's own (`.use(({ ctx, next }) => { check(ctx); return next(); })`): the
    // record names the check (guard-check.mjs).
    // Or that check inside the service's own error mapper (wrapped-check.mjs): the mount is handed it without `next()`.
    const used = checkedUse(p, node) ?? wrappedUse(p, node);
    const base = used ? guardOf(p, used.base, [], depth + 1, env) : undefined;
    const access = base ? withCheck(base, used.check) : undefined;
    if (access) return access;
    problems.push(`guard ${calleeName(node)}() chained: not one a record names`);
    return undefined;
  }
  // A guard a function of the service's own returns (`operator('admin:read')`, `executeProcedure()`): read what it
  // returns, its parameters bound to this call's arguments.
  if (node.callee.type === 'Identifier' && !BUILDERS.has(node.callee.name)) {
    const target = functionOf(p, node.callee, node.callee.name);
    // Only a function that is its one returned guard: a body with any other statement may return another guard.
    const single =
      target &&
      (target.fn.body?.type !== 'BlockStatement' ||
        (target.fn.body.body.length === 1 && target.fn.body.body[0].type === 'ReturnStatement'));
    const body = single ? returned(target.p, target.fn) : undefined;
    if (target && !single) {
      problems.push(`guard ${node.callee.name}() is a function with more than its returned guard: not one a record names`);
      return undefined;
    }
    if (body) {
      const bound = new Map();
      target.fn.params.forEach((param, i) => {
        if (param.type === 'Identifier' && node.arguments[i]) bound.set(param.name, { p, node: node.arguments[i], env });
      });
      return guardOf(target.p, body, problems, depth + 1, bound);
    }
  }
  const name = node.callee.name;
  const args = node.arguments;
  const lit = (n) => {
    const v = literalOf(p, n, env);
    return v === undefined ? undefined : String(v);
  };
  // The service's own check a guard's options hand it (`GuardOptions.check`), as `checkedUse` gives one; set by `opts`.
  let check;
  const opts = (n, allowed) => {
    if (!n) return '';
    const v = valueOf(p, n, env);
    if (v?.node.type !== 'ObjectExpression') return null;
    const parts = [];
    for (const prop of v.node.properties) {
      const k = prop.type === 'Property' ? keyOf(prop) : undefined;
      // The service's own check (`GuardOptions.check`) is named on the record; the mount takes it from the service's parts,
      // or is handed it by name where the record mounts (`partsFor`).
      if (k === 'check' && allowed.has(k) && prop.value.type === 'Identifier') {
        parts.push(`check: '${prop.value.name}'`);
        check = optionCheck(v.p, prop.value);
        continue;
      }
      const value = k && allowed.has(k) ? literalOf(v.p, prop.value, v.p === p ? env : undefined) : undefined;
      if (value === undefined) return null;
      parts.push(`${k}: ${typeof value === 'string' ? `'${value}'` : String(value)}`);
    }
    return parts.length ? `, ${parts.join(', ')}` : '';
  };
  const literals = (n) => {
    const v = valueOf(p, n, env);
    if (v?.node.type !== 'ArrayExpression') return null;
    const out = v.node.elements.map((e) => (e ? literalOf(v.p, e, v.p === p ? env : undefined) : undefined));
    return out.every((e) => typeof e === 'string') ? out.map((e) => `'${e}'`) : null;
  };
  if (name === 'scopedProcedure') {
    const scope = literalOf(p, args[0], env);
    const rest = opts(args[1], ACCESS_OPTS);
    if (typeof scope !== 'string' || rest === null) {
      problems.push('scopedProcedure with a scope or options a record cannot copy');
      return undefined;
    }
    return { text: `{ caller: 'scope', scope: '${scope}'${rest} }`, scope, ...(check ? { check } : {}) };
  }
  if (name === 'signedInProcedure') {
    const rest = opts(args[0], new Set(['module', 'plane', 'check']));
    if (rest === null) {
      problems.push('signedInProcedure options a record cannot copy');
      return undefined;
    }
    return { text: `{ caller: 'signedIn'${rest} }`, ...(check ? { check } : {}) };
  }
  if (name === 'publicJurisdictionProcedure') {
    const mod = lit(args[0]);
    if (mod === undefined || (args[1] && lit(args[1]) === undefined)) {
      problems.push('publicJurisdictionProcedure arguments a record cannot copy');
      return undefined;
    }
    return { text: `{ caller: 'jurisdiction', module: '${mod}'${args[1] ? `, plane: '${lit(args[1])}'` : ''} }` };
  }
  if (name === 'anyScopeProcedure') {
    const list = literals(args[0]);
    const rest = opts(args[1], new Set(['module', 'plane', 'check']));
    if (!list || rest === null) {
      problems.push('anyScopeProcedure arguments a record cannot copy');
      return undefined;
    }
    return { text: `{ caller: 'anyScope', scopes: [${list.join(', ')}]${rest} }`, ...(check ? { check } : {}) };
  }
  if (name === 'serviceProcedureFor') {
    const list = literals(args[0]);
    // `forbidden`: the door's own wording for an unlisted caller, which the record keeps.
    const rest = opts(args[1], new Set(['forbidden']));
    if (!list || rest === null) {
      problems.push('serviceProcedureFor arguments a record cannot copy');
      return undefined;
    }
    return { text: `{ caller: 'service', callers: [${list.join(', ')}]${rest} }` };
  }
  if (name === 'personProcedure') {
    // `personProcedure()` or `personProcedure(null, …)`: no scope; else the scope, then the guards a record copies.
    const none = !args[0] || (args[0].type === 'Literal' && args[0].value === null);
    const scope = none ? undefined : literalOf(p, args[0], env);
    const rest = opts(args[1], new Set(['module', 'plane', 'tier']));
    if ((!none && typeof scope !== 'string') || rest === null) {
      problems.push('personProcedure with a scope or options a record cannot copy');
      return undefined;
    }
    return {
      text: `{ caller: 'person'${scope === undefined ? '' : `, scope: '${scope}'`}${rest} }`,
      ...(scope === undefined ? {} : { scope }),
    };
  }
  problems.push(`guard ${name}() is not one a record names`);
  return undefined;
}

/** The guard builders a record names (the rest of `guardOf`); any other call is a function of the service's own. */
const BUILDERS = new Set([
  'scopedProcedure',
  'signedInProcedure',
  'publicJurisdictionProcedure',
  'anyScopeProcedure',
  'serviceProcedureFor',
  'personProcedure',
]);

/** The name of a kept guard this expression is, or calls: `founder`, `opsProcedure`, `coachRunProcedure()`. */
function keptName(p, node, env) {
  const id =
    node?.type === 'CallExpression' && node.callee.type === 'Identifier' ? node.callee : node?.type === 'Identifier' ? node : undefined;
  if (!id || !KEPT_GUARDS.has(id.name)) return undefined;
  const b = bindingOf(p, id, id.name);
  // A parameter bound to an argument is read through that argument; an unbound one is the guard the name says.
  if (b.kind === 'param' && env?.has(id.name)) return undefined;
  return id.name;
}
