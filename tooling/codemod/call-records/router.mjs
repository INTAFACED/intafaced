// Reads a service's tRPC tree: each procedure's dotted path, the file and node it is written at, and its chain
// (`guard(...).input(I).output(O).query(H)`). Follows nested `router({...})`, local consts, `...spread`s and
// `createXRouter(...)` calls into other files.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bindingOf, calleeName, keyOf, load, resolveRelative, walk } from './ast.mjs';

const LEAF = new Set(['query', 'mutation']);

/** The root router: `create<Name>Router` in `src/router.ts` whose body returns `router({...})`. */
function rootOf(serviceDir, fnName) {
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
  const seen = new Set();
  const visit = (p, node, prefix, depth) => {
    if (!node || depth > 40) return;
    const key = `${p.file}:${node.start}:${prefix}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (
      node.type === 'TSAsExpression' ||
      node.type === 'TSSatisfiesExpression' ||
      node.type === 'ParenthesizedExpression' ||
      node.type === 'TSNonNullExpression'
    )
      return visit(p, node.expression, prefix, depth + 1);
    if (node.type === 'ObjectExpression') {
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') {
          visit(p, prop.argument, prefix, depth + 1);
          continue;
        }
        const k = keyOf(prop);
        if (k === undefined) {
          unread.push({ path: `${prefix}<computed>`, why: 'computed key', file: p.file });
          continue;
        }
        visit(p, prop.value, `${prefix}${k}.`, depth + 1);
      }
      return;
    }
    if (node.type === 'CallExpression') {
      const name = calleeName(node);
      if (name && LEAF.has(name) && node.callee.type === 'MemberExpression') {
        const path = prefix.slice(0, -1);
        out.set(path, { path, p, node, prop: p.parents.get(node) });
        return;
      }
      if (name === 'router' || name === 't.router' || name === 'createTRPCRouter') return visit(p, node.arguments[0], prefix, depth + 1);
      if (name === 'mergeRouters') {
        for (const a of node.arguments) visit(p, a, prefix, depth + 1);
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
        const target = functionOf(p, node.callee, node.callee.name);
        if (target) return visit(target.p, returned(target.p, target.fn), prefix, depth + 1);
      }
      unread.push({ path: `${prefix}*`, why: `call ${name ?? '?'}() not followed`, file: p.file, at: node.start });
      return;
    }
    if (node.type === 'Identifier') {
      const b = bindingOf(p, node, node.name);
      if (b.kind === 'var' && b.declarator.init) return visit(p, b.declarator.init, prefix, depth + 1);
      if (b.kind === 'import') {
        const file = resolveRelative(p.file, b.from);
        if (file) {
          const q = load(file);
          const d = exported(q, b.imported);
          if (d) return visit(q, d, prefix, depth + 1);
        }
      }
      unread.push({ path: `${prefix}*`, why: `name ${node.name} not followed (${b.kind})`, file: p.file, at: node.start });
      return;
    }
    if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
      unread.push({ path: `${prefix}*`, why: `${node.type} router`, file: p.file, at: node.start });
      return;
    }
    unread.push({ path: `${prefix}*`, why: `${node.type} not followed`, file: p.file, at: node.start });
  };
  visit(root.p, root.node, '', 0);
  return { procedures: out, unread };
}

/** A function a call names: declared in this file or imported from a relative file. */
function functionOf(p, at, name) {
  const b = bindingOf(p, at, name);
  if (b.kind === 'function') return { p, fn: b.declaration };
  if (b.kind === 'var' && /Function/.test(b.declarator.init?.type ?? '')) return { p, fn: b.declarator.init };
  if (b.kind === 'import') {
    const file = resolveRelative(p.file, b.from);
    if (!file) return undefined;
    const q = load(file);
    const fn = exportedFunction(q, b.imported);
    return fn ? { p: q, fn } : undefined;
  }
  return undefined;
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
  const guard = guardOf(p, cur, problems);
  if (!output) problems.push('no .output(): the record has no answer schema to take');
  if (!handler) problems.push('no handler');
  return { kind, input, output, handler, guard, problems };
}

const ACCESS_OPTS = new Set(['module', 'plane', 'tier', 'person']);

/** The record's `access` for a guard expression, as source text, or a problem. */
function guardOf(p, node, problems, depth = 0) {
  if (!node || depth > 5) {
    problems.push('guard not read');
    return undefined;
  }
  if (node.type === 'Identifier') {
    if (node.name === 'publicProcedure') return { text: "{ caller: 'public' }", base: node };
    const b = bindingOf(p, node, node.name);
    if (b.kind === 'var' && b.declarator.init) return guardOf(p, b.declarator.init, problems, depth + 1);
    problems.push(`guard ${node.name} (${b.kind}) is not one a record names`);
    return undefined;
  }
  if (node.type !== 'CallExpression') {
    problems.push(`guard ${node.type} not read`);
    return undefined;
  }
  if (node.callee.type === 'MemberExpression') {
    problems.push(`guard ${calleeName(node)}() chained: not one a record names`);
    return undefined;
  }
  const name = node.callee.name;
  const args = node.arguments;
  const lit = (n) => (n?.type === 'Literal' ? JSON.stringify(n.value).replace(/^"|"$/g, '') : undefined);
  const opts = (n, allowed) => {
    if (!n) return '';
    if (n.type !== 'ObjectExpression') return null;
    const parts = [];
    for (const prop of n.properties) {
      const k = prop.type === 'Property' ? keyOf(prop) : undefined;
      if (!k || !allowed.has(k) || prop.value.type !== 'Literal') return null;
      parts.push(`${k}: ${typeof prop.value.value === 'string' ? `'${prop.value.value}'` : String(prop.value.value)}`);
    }
    return parts.length ? `, ${parts.join(', ')}` : '';
  };
  if (name === 'scopedProcedure') {
    const scope = args[0]?.type === 'Literal' ? args[0].value : undefined;
    const rest = opts(args[1], ACCESS_OPTS);
    if (typeof scope !== 'string' || rest === null) {
      problems.push('scopedProcedure with a scope or options a record cannot copy');
      return undefined;
    }
    return { text: `{ caller: 'scope', scope: '${scope}'${rest} }`, scope };
  }
  if (name === 'signedInProcedure') {
    const rest = opts(args[0], new Set(['module', 'plane']));
    if (rest === null) {
      problems.push('signedInProcedure options a record cannot copy');
      return undefined;
    }
    return { text: `{ caller: 'signedIn'${rest} }` };
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
    const list =
      args[0]?.type === 'ArrayExpression' && args[0].elements.every((e) => e?.type === 'Literal')
        ? args[0].elements.map((e) => `'${e.value}'`)
        : null;
    const rest = opts(args[1], new Set(['module', 'plane']));
    if (!list || rest === null) {
      problems.push('anyScopeProcedure arguments a record cannot copy');
      return undefined;
    }
    return { text: `{ caller: 'anyScope', scopes: [${list.join(', ')}]${rest} }` };
  }
  if (name === 'serviceProcedureFor') {
    const list =
      args[0]?.type === 'ArrayExpression' && args[0].elements.every((e) => e?.type === 'Literal')
        ? args[0].elements.map((e) => `'${e.value}'`)
        : null;
    if (!list) {
      problems.push('serviceProcedureFor arguments a record cannot copy');
      return undefined;
    }
    return { text: `{ caller: 'service', callers: [${list.join(', ')}] }` };
  }
  problems.push(`guard ${name}() is not one a record names`);
  return undefined;
}
