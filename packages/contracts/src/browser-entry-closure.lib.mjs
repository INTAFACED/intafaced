/**
 * Shared import-closure walker.
 *
 * Literal ESM imports, re-exports, import(), and require() are followed.
 * A computed import or require is unresolved and fails a pure graph.
 * A successful Node import of a package root is not browser proof.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('@typescript/typescript6');

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, '../../..');
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

export const FORBIDDEN_SPECIFIERS = new Set([
  '@trpc/server',
  '@intafaced/auth',
  '@intafaced/db',
  '@intafaced/contracts',
  '@intafaced/config',
  '@intafaced/exchange-contract',
]);

const FORBIDDEN_PATH_BITS = [
  '/service-auth.js',
  '/service-auth.ts',
  '/trpc.js',
  '/trpc.ts',
  '/market-lifecycle-admission-proof.js',
  '/market-lifecycle-admission-proof.ts',
  '/packages/config/dist/index.js',
  '/packages/config/src/index.ts',
  '/packages/config/dist/env.js',
  '/packages/config/src/env.ts',
  '/packages/contracts/dist/index.js',
  '/packages/contracts/src/index.ts',
  '/packages/exchange-contract/dist/index.js',
  '/packages/exchange-contract/src/index.ts',
  '/node_modules/@trpc/',
  '/node_modules/@intafaced/auth/',
  '/node_modules/@intafaced/db/',
];

function scriptKind(fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.ts')) return ts.ScriptKind.TS;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.mjs') || fileName.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.JS;
}

function stringArg(node) {
  const arg = node.arguments[0];
  if (!arg) return { missing: true };
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return { spec: arg.text };
  return { computed: true };
}

function memberName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return null;
}

function isRequire(node) {
  if (ts.isIdentifier(node)) return node.text === 'require';
  return memberName(node) === 'require' && ts.isIdentifier(node.expression) && node.expression.text === 'module';
}

/**
 * Runtime dependency facts for one source text.
 * Declaration-level type-only imports are ignored. Named types retain their
 * module load under verbatimModuleSyntax. Computed import/require arguments
 * are unresolved. Aliased loaders and browser export conditions are outside
 * this check's scope; the checked entries use explicit import/default exports.
 */
export function dependencyFacts(source, fileName = 'module.ts') {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const specifiers = [];
  const unresolved = [];
  if ((sf.parseDiagnostics ?? []).length > 0) unresolved.push('parse-error');

  function visit(node) {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        const spec = node.moduleReference.expression;
        if (spec && ts.isStringLiteral(spec)) specifiers.push(spec.text);
        else unresolved.push('computed-require');
      }
    } else if (ts.isCallExpression(node)) {
      const expr = node.expression;
      const dynamicImport = expr.kind === ts.SyntaxKind.ImportKeyword;
      const requireCall = isRequire(expr);
      const requireResolve = memberName(expr) === 'resolve' && isRequire(expr.expression);
      if (dynamicImport || requireCall || requireResolve) {
        const got = stringArg(node);
        if (got.spec) specifiers.push(got.spec);
        else if (dynamicImport) unresolved.push('computed-import');
        else if (requireCall) unresolved.push('computed-require');
        else unresolved.push('computed-require-resolve');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { specifiers, unresolved };
}

function pickExport(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickExport(item);
      if (picked) return picked;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    if ('import' in value) return pickExport(value.import);
    if ('default' in value) return pickExport(value.default);
  }
  return null;
}

function packageRoot(file) {
  let dir = dirname(file);
  while (dir !== dirname(dir)) {
    const manifest = resolve(dir, 'package.json');
    if (existsSync(manifest)) {
      const json = JSON.parse(readFileSync(manifest, 'utf8'));
      if (typeof json.name === 'string') return { dir, json };
    }
    dir = dirname(dir);
  }
  return null;
}

function esmFile(spec, viaRequire) {
  const root = packageRoot(viaRequire);
  if (!root?.json.exports) return viaRequire;
  const sub = spec === root.json.name ? '.' : `.${spec.slice(root.json.name.length)}`;
  const target = pickExport(root.json.exports[sub]);
  if (!target || target.includes('*')) return viaRequire;
  const file = resolve(root.dir, target);
  return existsSync(file) ? file : viaRequire;
}

export function resolveNext(spec, parentReal) {
  if (builtins.has(spec) || spec.startsWith('node:')) return { builtin: spec };
  if (spec.startsWith('.')) {
    const candidate = resolve(dirname(parentReal), spec);
    if (existsSync(candidate)) return { file: candidate };
    if (spec.endsWith('.js')) {
      const tsPath = candidate.replace(/\.js$/, '.ts');
      if (existsSync(tsPath)) return { file: tsPath };
    }
    return { error: `missing-target:${spec}` };
  }
  try {
    const viaRequire = createRequire(parentReal).resolve(spec);
    const file = esmFile(spec, viaRequire);
    if (!existsSync(file)) return { error: `missing-target:${spec}` };
    return { file };
  } catch (error) {
    return { error: `unresolved:${spec}:${error instanceof Error ? error.message : String(error)}` };
  }
}

function rel(file) {
  const real = realpathSync(file);
  const fromRepo = relative(repoRoot, real);
  if (!fromRepo.startsWith('..')) return fromRepo;
  return real;
}

function forbiddenBits(file) {
  const norm = file.replaceAll('\\', '/');
  return FORBIDDEN_PATH_BITS.filter((bit) => norm.includes(bit));
}

export function walk(entry, { followNodeModules }) {
  if (!existsSync(entry)) {
    return {
      entry: relative(repoRoot, entry),
      missing: true,
      files: [],
      specifiers: [],
      unresolved: [],
      forbidden: [`missing:${relative(repoRoot, entry)}`],
      fileCount: 0,
    };
  }
  const seen = new Set();
  const files = [];
  const specifiers = new Set();
  const unresolved = new Set();
  const forbidden = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.pop();
    let real;
    try {
      real = realpathSync(current);
    } catch {
      forbidden.add(`unreadable:${current}`);
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    files.push(rel(real));
    for (const bit of forbiddenBits(real)) forbidden.add(bit);
    let text;
    try {
      text = readFileSync(real, 'utf8');
    } catch {
      forbidden.add(`unreadable:${rel(real)}`);
      continue;
    }
    const facts = dependencyFacts(text, real);
    for (const kind of facts.unresolved) {
      unresolved.add(kind);
      forbidden.add(`unresolved:${kind}`);
    }
    for (const spec of facts.specifiers) {
      specifiers.add(spec);
      if (builtins.has(spec) || spec.startsWith('node:')) {
        forbidden.add(spec);
        continue;
      }
      if (FORBIDDEN_SPECIFIERS.has(spec)) forbidden.add(spec);
      const resolved = resolveNext(spec, real);
      if (resolved.builtin) {
        forbidden.add(resolved.builtin);
        continue;
      }
      if (resolved.error || !resolved.file) {
        forbidden.add(resolved.error ?? `unresolved:${spec}`);
        continue;
      }
      let nextReal;
      try {
        nextReal = realpathSync(resolved.file);
      } catch {
        forbidden.add(`missing-target:${spec}`);
        continue;
      }
      const inNodeModules = nextReal.includes('/node_modules/');
      const workspace = !relative(repoRoot, nextReal).startsWith('..') && !nextReal.includes('/node_modules/');
      if (inNodeModules && !workspace && !followNodeModules) continue;
      queue.push(nextReal);
    }
    if (files.length > 4000) {
      forbidden.add('graph-limit');
      break;
    }
  }
  return {
    entry: relative(repoRoot, entry),
    missing: false,
    files,
    specifiers: [...specifiers].sort(),
    unresolved: [...unresolved].sort(),
    forbidden: [...forbidden].sort(),
    fileCount: files.length,
  };
}

export function mustInclude(graph, needles) {
  const blob = [...graph.forbidden, ...graph.specifiers, ...graph.files].join('\n');
  return needles.filter((needle) => !blob.includes(needle));
}
