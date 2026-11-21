// What a schema needs to live in @intafaced/contracts: every name it reads, followed to where it is declared. A name
// declared in a service or app file moves into the record file (its old home then imports it from contracts); a name
// contracts already exports is imported from its file there; zod is zod. Anything else is a problem the run names.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { bindingOf, freeNames, load, resolveRelative, text, walk } from './ast.mjs';

const GLOBALS = new Set([
  'const',
  'undefined',
  'Infinity',
  'NaN',
  'Number',
  'String',
  'Boolean',
  'BigInt',
  'Symbol',
  'Object',
  'Array',
  'Math',
  'Date',
  'JSON',
  'RegExp',
  'Error',
  'Set',
  'Map',
  'Record',
  'Readonly',
  'Partial',
  'Pick',
  'Omit',
  'ReadonlyArray',
  'Exclude',
  'Extract',
  'NonNullable',
  'ReturnType',
  'Parameters',
  'Promise',
  'URL',
  'isFinite',
  'parseInt',
  'parseFloat',
  'encodeURIComponent',
]);
/** Packages @intafaced/contracts already depends on (its package.json). */
const CONTRACT_DEPS = new Set(['zod', '@intafaced/config', '@intafaced/auth']);

let contractsIndex;
/** Where each name contracts exports is declared: `name -> file` for every non-test file in packages/contracts/src. */
export function contractsExports(repo) {
  if (contractsIndex) return contractsIndex;
  contractsIndex = new Map();
  const dir = join(repo, 'packages/contracts/src');
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f.endsWith('.d.ts') || f === 'index.ts') continue;
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/^export (?:const|function|class|enum|type|interface|let) ([A-Za-z_$][\w$]*)/gm))
      if (!contractsIndex.has(m[1])) contractsIndex.set(m[1], join(dir, f));
  }
  return contractsIndex;
}

const unsafeCache = new Map();
/** True when a contracts file reaches `node:` (directly or through its relative imports): it can't load in the browser. */
export function nodeOnly(file, seen = new Set()) {
  if (unsafeCache.has(file)) return unsafeCache.get(file);
  if (seen.has(file)) return false;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  let bad = /from ['"]node:|import\(['"]node:/.test(src);
  if (!bad)
    for (const m of src.matchAll(/^import (?!type)[^;]*? from ['"](\.[^'"]+)['"]/gm)) {
      const next = resolveRelative(file, m[1]);
      if (next && nodeOnly(next, seen)) {
        bad = true;
        break;
      }
    }
  unsafeCache.set(file, bad);
  return bad;
}

/**
 * The closure of the given nodes (each `{ p, node }`): `moved` (declarations to move, in an order that declares each
 * before its use), `fromContracts` (`name -> { file, imported }`), `fromPackages` (`spec -> Set(names)`), and `problems`.
 */
export function closureOf(repo, roots) {
  const moved = new Map();
  const order = [];
  const fromContracts = new Map();
  const fromPackages = new Map();
  const problems = [];
  const visiting = new Set();
  const index = contractsExports(repo);
  const addPkg = (spec, line) => {
    if (!fromPackages.has(spec)) fromPackages.set(spec, new Set());
    fromPackages.get(spec).add(line);
  };
  const visit = (p, node, where) => {
    for (const [name, use] of freeNames(p, node)) {
      if (name === 'z') {
        const b = bindingOf(p, use, name);
        if (b.kind !== 'import' || b.from !== 'zod') problems.push(`${where}: z is not zod's`);
        continue;
      }
      const b = bindingOf(p, use, name);
      if (b.kind === 'global') {
        if (!GLOBALS.has(name)) problems.push(`${where}: ${name} is not declared anywhere it can be read`);
        continue;
      }
      if (b.kind === 'param') {
        problems.push(`${where}: ${name} is a function parameter, so the schema is built per call`);
        continue;
      }
      if (b.kind === 'import') {
        const from = b.from;
        if (from === '@intafaced/contracts' || from.startsWith('@intafaced/contracts/')) {
          const file = index.get(b.imported);
          if (!file) problems.push(`${where}: ${b.imported} from ${from} not found in contracts' files`);
          else if (nodeOnly(file)) inlineOrRefuse(p, name, file, b.imported);
          else fromContracts.set(name, { file, imported: b.imported, typeOnly: b.typeOnly });
          continue;
        }
        if (CONTRACT_DEPS.has(from)) {
          addPkg(from, b.imported === name ? name : `${b.imported} as ${name}`);
          continue;
        }
        const file = resolveRelative(p.file, from);
        if (!file) {
          problems.push(`${where}: ${name} comes from ${from}, which contracts does not depend on`);
          continue;
        }
        const q = load(file);
        const target = topLevel(q, b.imported);
        if (!target) {
          problems.push(`${where}: ${b.imported} is not a declaration in ${relative(repo, file)}`);
          continue;
        }
        if (b.imported !== name) problems.push(`${where}: ${b.imported} is imported as ${name}`);
        take(q, b.imported, target);
        continue;
      }
      take(p, name, b);
    }
  };
  // A contracts name in a file the browser can't load: an `as const` list of literals is written out; anything else refuses.
  const inlineOrRefuse = (p, name, file, imported) => {
    const q = load(file);
    const t = topLevel(q, imported);
    const init = t?.declarator?.init;
    const list = init?.type === 'TSAsExpression' ? init.expression : init;
    if (list?.type === 'ArrayExpression' && list.elements.every((e) => e?.type === 'Literal')) {
      const key = `${file}#${imported}`;
      if (!moved.has(key)) {
        moved.set(key, {
          name,
          text: `/** ${imported} in contracts' \`${relative(join(repo, 'packages/contracts/src'), file)}\`, written out: that file is not browser-safe. */\nconst ${name} = ${text(q, init)};`,
          inline: true,
        });
        order.push(key);
      }
      return;
    }
    problems.push(`${relative(repo, p.file)}: ${imported} lives in ${relative(repo, file)}, which the browser can't load`);
  };
  const take = (q, name, b) => {
    const key = `${q.file}#${name}`;
    if (moved.has(key) || visiting.has(key)) return;
    if (b.kind !== 'var' && b.kind !== 'function' && b.kind !== 'type' && b.kind !== 'other') {
      problems.push(`${relative(repo, q.file)}: ${name} is a ${b.kind}`);
      return;
    }
    visiting.add(key);
    const node = b.kind === 'var' ? b.declarator : b.declaration;
    visit(q, node, `${relative(repo, q.file)}#${name}`);
    visiting.delete(key);
    moved.set(key, { name, q, binding: b, text: declText(q, b) });
    order.push(key);
  };
  for (const { p, node, where } of roots) if (node) visit(p, node, where);
  const names = new Map();
  for (const key of order) {
    const m = moved.get(key);
    if (names.has(m.name) && names.get(m.name) !== key)
      problems.push(`two declarations named ${m.name} move (${names.get(m.name)} and ${key})`);
    names.set(m.name, key);
  }
  return { moved: order.map((k) => moved.get(k)), fromContracts, fromPackages, problems };
}

/** A top-level declaration of `name` in a file. */
export function topLevel(q, name) {
  for (const stmt of q.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt;
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations)
        if (d.id.type === 'Identifier' && d.id.name === name)
          return { kind: 'var', declarator: d, statement: stmt, declaration: decl, exported: stmt !== decl };
    } else if (
      decl.id?.name === name &&
      /^(FunctionDeclaration|TSTypeAliasDeclaration|TSInterfaceDeclaration|TSEnumDeclaration|ClassDeclaration)$/.test(decl.type)
    ) {
      return {
        kind: decl.type === 'FunctionDeclaration' ? 'function' : /^TS(TypeAlias|Interface)/.test(decl.type) ? 'type' : 'other',
        statement: stmt,
        declaration: decl,
        exported: stmt !== decl,
      };
    }
  }
  return undefined;
}

/** A moved declaration as the record file writes it: exported, with its JSDoc. */
function declText(q, b) {
  const doc = (() => {
    const before = q.src.slice(
      0,
      (b.kind === 'var' && b.declaration.declarations.length === 1 ? b.statement : b.kind === 'var' ? b.declarator : b.statement).start,
    );
    const m = /(\/\*\*(?:(?!\*\/)[\s\S])*\*\/)\s*$/.exec(before);
    return m ? `${m[1]}\n` : '';
  })();
  if (b.kind === 'var') return `${doc}export ${b.declaration.kind} ${text(q, b.declarator)};`;
  return `${doc}export ${text(q, b.declaration)}`;
}

/** True when `name` is read anywhere in a file outside the given ranges. */
export function usedOutside(p, name, ranges) {
  let used = false;
  walk(p.program, (n, parent) => {
    if (used) return false;
    if (ranges.some((r) => n.start >= r.start && n.end <= r.end)) return false;
    if (n.type !== 'Identifier' || n.name !== name) return;
    if (parent?.type === 'MemberExpression' && parent.property === n && !parent.computed) return;
    if (parent?.type === 'Property' && parent.key === n && !parent.computed && !parent.shorthand) return;
    if (parent?.type === 'VariableDeclarator' && parent.id === n) return;
    if (/^(ImportSpecifier|ImportDefaultSpecifier|ImportNamespaceSpecifier|ExportSpecifier)$/.test(parent?.type ?? '')) return;
    if (parent?.type === 'FunctionDeclaration' && parent.id === n) return;
    if (/^TS(TypeAlias|Interface|Enum)Declaration$/.test(parent?.type ?? '') && parent.id === n) return;
    used = true;
  });
  return used;
}
