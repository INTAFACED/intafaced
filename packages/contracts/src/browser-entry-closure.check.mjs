/**
 * Import-closure proof for the browser-safe package entries.
 *
 * A successful Node import of the package root is not evidence that a browser
 * can load it. This walks static import specifiers, classifies the server
 * roots as unsuitable, and requires the pure subpaths to exclude that graph.
 * Schema identity is the same object across the old root and the new subpaths,
 * not a second schema that happens to accept a few samples.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const FORBIDDEN_SPECIFIERS = new Set([
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

function specifiersOf(source) {
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*\/\/.*(?=\n|$)/g, '$1')
    .replace(/^\s*import\s+type\s+[^;]*;/gm, '')
    .replace(/^\s*export\s+type\s+[^;]*;/gm, '');
  const found = [];
  const re =
    /\bfrom\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = re.exec(stripped))) {
    const spec = match[1] || match[2] || match[3];
    if (spec) found.push(spec);
  }
  return found;
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

function resolveNext(spec, parentReal) {
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

function walk(entry, { followNodeModules }) {
  if (!existsSync(entry)) {
    return {
      entry: relative(repoRoot, entry),
      missing: true,
      files: [],
      specifiers: [],
      forbidden: [`missing:${relative(repoRoot, entry)}`],
      fileCount: 0,
    };
  }
  const seen = new Set();
  const files = [];
  const specifiers = new Set();
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
    for (const spec of specifiersOf(text)) {
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
      const inNodeModules = nextReal.includes(`${resolve(repoRoot, 'node_modules')}`) || nextReal.includes('/node_modules/');
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
    forbidden: [...forbidden].sort(),
    fileCount: files.length,
  };
}

function readText(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function sourceShape() {
  const instruments = readText('packages/contracts/src/instruments.ts');
  const schemas = readText('packages/exchange-contract/src/schemas.ts');
  const contractsIndex = readText('packages/contracts/src/index.ts');
  const exchangeIndex = readText('packages/exchange-contract/src/index.ts');
  const contractsPkg = JSON.parse(readText('packages/contracts/package.json'));
  const exchangePkg = JSON.parse(readText('packages/exchange-contract/package.json'));
  const problems = [];
  if (!/from ['"]@intafaced\/config\/modules['"]/.test(instruments)) problems.push('instruments-missing-config-modules');
  if (/from ['"]@intafaced\/config['"]/.test(instruments)) problems.push('instruments-still-imports-config-root');
  if (!/from ['"]@intafaced\/contracts\/instruments['"]/.test(schemas)) problems.push('schemas-missing-instruments-subpath');
  if (/from ['"]@intafaced\/contracts['"]/.test(schemas)) problems.push('schemas-still-imports-contracts-root');
  if (!contractsIndex.includes("export * from './instruments.js'")) problems.push('contracts-root-dropped-instruments');
  if (!exchangeIndex.includes("export * from './schemas.js'")) problems.push('exchange-root-dropped-schemas');
  if (!exchangeIndex.includes("export * from './market-lifecycle-admission-proof.js'")) {
    problems.push('exchange-root-dropped-admission-proof');
  }
  const instrumentsExport = contractsPkg.exports?.['./instruments'];
  const schemasExport = exchangePkg.exports?.['./schemas'];
  const contractsRoot = contractsPkg.exports?.['.'];
  const exchangeRoot = exchangePkg.exports?.['.'];
  if (instrumentsExport?.default !== './dist/instruments.js' || instrumentsExport?.types !== './dist/instruments.d.ts') {
    problems.push('contracts-instruments-export');
  }
  if (schemasExport?.default !== './dist/schemas.js' || schemasExport?.types !== './dist/schemas.d.ts') {
    problems.push('exchange-schemas-export');
  }
  if (contractsRoot?.default !== './dist/index.js') problems.push('contracts-root-export');
  if (exchangeRoot?.default !== './dist/index.js') problems.push('exchange-root-export');
  if (contractsPkg.exports?.['./identity']?.default !== './dist/identity.js') problems.push('identity-subpath-moved');
  return problems;
}

function mustInclude(graph, needles) {
  const blob = [...graph.forbidden, ...graph.specifiers, ...graph.files].join('\n');
  return needles.filter((needle) => !blob.includes(needle));
}

async function identity() {
  const parent = resolve(repoRoot, 'packages/exchange-contract/dist/schemas.js');
  const rootPath = resolveNext('@intafaced/contracts', parent).file;
  const purePath = resolveNext('@intafaced/contracts/instruments', parent).file;
  const schemasPath = resolveNext('@intafaced/exchange-contract/schemas', parent).file;
  if (!rootPath || !purePath || !schemasPath) {
    throw new Error(`export resolution failed root=${rootPath} instruments=${purePath} schemas=${schemasPath}`);
  }
  const root = await import(pathToFileURL(rootPath).href);
  const pure = await import(pathToFileURL(purePath).href);
  const schemas = await import(pathToFileURL(schemasPath).href);
  const keys = Object.keys(pure.TRADING_SCHEDULES);
  const sameObject =
    root.scheduleKeySchema === pure.scheduleKeySchema &&
    schemas.marketScheduleKeySchema === pure.scheduleKeySchema &&
    schemas.marketSchema.shape.schedule === pure.scheduleKeySchema;
  const knownKeysParse = keys.every(
    (key) =>
      pure.scheduleKeySchema.safeParse(key).success &&
      root.scheduleKeySchema.safeParse(key).success &&
      schemas.marketScheduleKeySchema.safeParse(key).success,
  );
  const unknownRefused =
    pure.scheduleKeySchema.safeParse('lse-equities').success === false &&
    root.scheduleKeySchema.safeParse('lse-equities').success === false &&
    schemas.marketSchema.shape.schedule.safeParse('lse-equities').success === false;
  const options = [...pure.scheduleKeySchema.options].sort().join('|');
  const rootOptions = [...root.scheduleKeySchema.options].sort().join('|');
  const marketOptions = [...schemas.marketScheduleKeySchema.options].sort().join('|');
  return {
    rootImportSucceeded: true,
    rootImportIsBrowserProof: false,
    sameObject,
    knownKeysParse,
    unknownRefused,
    optionsMatchTradingSchedules: options === [...keys].sort().join('|') && options === rootOptions && options === marketOptions,
    scheduleKeys: keys,
  };
}

const pureEntries = [
  ['contracts-instruments-source', 'packages/contracts/src/instruments.ts'],
  ['contracts-instruments-dist', 'packages/contracts/dist/instruments.js'],
  ['contracts-identity-source', 'packages/contracts/src/identity.ts'],
  ['contracts-identity-dist', 'packages/contracts/dist/identity.js'],
  ['exchange-schemas-source', 'packages/exchange-contract/src/schemas.ts'],
  ['exchange-schemas-dist', 'packages/exchange-contract/dist/schemas.js'],
  ['ledger-money-source', 'packages/ledger-client/src/money.ts'],
];

const unsafeEntries = [
  ['contracts-root-source', 'packages/contracts/src/index.ts'],
  ['contracts-root-dist', 'packages/contracts/dist/index.js'],
  ['exchange-root-source', 'packages/exchange-contract/src/index.ts'],
  ['exchange-root-dist', 'packages/exchange-contract/dist/index.js'],
];

const pure = pureEntries.map(([id, relPath]) => ({
  id,
  ...walk(resolve(repoRoot, relPath), { followNodeModules: true }),
}));
const unsafe = unsafeEntries.map(([id, relPath]) => ({
  id,
  ...walk(resolve(repoRoot, relPath), { followNodeModules: false }),
}));

const sourceProblems = sourceShape();
const pureProblems = pure.filter((graph) => graph.forbidden.length > 0).map((graph) => graph.id);
const unsafeMisses = {
  'contracts-root-source': mustInclude(
    unsafe.find((graph) => graph.id === 'contracts-root-source'),
    ['@trpc/server', '@intafaced/auth', 'node:crypto'],
  ),
  'contracts-root-dist': mustInclude(
    unsafe.find((graph) => graph.id === 'contracts-root-dist'),
    ['@trpc/server', '@intafaced/auth', 'node:crypto'],
  ),
  'exchange-root-source': mustInclude(
    unsafe.find((graph) => graph.id === 'exchange-root-source'),
    ['market-lifecycle-admission-proof.ts', 'node:crypto'],
  ),
  'exchange-root-dist': mustInclude(
    unsafe.find((graph) => graph.id === 'exchange-root-dist'),
    ['market-lifecycle-admission-proof.js', 'node:crypto'],
  ),
};

let identityReport;
try {
  identityReport = await identity();
} catch (error) {
  identityReport = {
    rootImportSucceeded: false,
    rootImportIsBrowserProof: false,
    sameObject: false,
    knownKeysParse: false,
    unknownRefused: false,
    optionsMatchTradingSchedules: false,
    scheduleKeys: [],
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
}

const unsafeOk = Object.values(unsafeMisses).every((misses) => misses.length === 0);
const identityOk =
  identityReport.rootImportSucceeded === true &&
  identityReport.rootImportIsBrowserProof === false &&
  identityReport.sameObject === true &&
  identityReport.knownKeysParse === true &&
  identityReport.unknownRefused === true &&
  identityReport.optionsMatchTradingSchedules === true;

const ok = sourceProblems.length === 0 && pureProblems.length === 0 && unsafeOk && identityOk;

const report = {
  ok,
  note: 'Node imported @intafaced/contracts successfully when rootImportSucceeded is true. That import is not browser proof: the contracts and exchange-contract roots stay unsuitable because their graphs include server modules.',
  sourceProblems,
  pureProblems,
  unsafeMisses,
  identity: identityReport,
  pure: pure.map((graph) => ({
    id: graph.id,
    entry: graph.entry,
    fileCount: graph.fileCount,
    forbidden: graph.forbidden,
    specifiers: graph.specifiers,
    files: graph.files,
  })),
  unsafe: unsafe.map((graph) => ({
    id: graph.id,
    entry: graph.entry,
    fileCount: graph.fileCount,
    forbidden: graph.forbidden,
    specifiers: graph.specifiers.filter(
      (spec) => FORBIDDEN_SPECIFIERS.has(spec) || builtins.has(spec) || spec.startsWith('node:') || spec.startsWith('.'),
    ),
  })),
};

process.stdout.write(`${JSON.stringify(report)}\n`);
