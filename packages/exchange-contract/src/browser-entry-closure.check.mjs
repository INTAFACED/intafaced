/**
 * Exchange-contract closure and schedule identity.
 * Requires this package's dist and @intafaced/contracts dist (a declared dependency).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mustInclude, repoRoot, resolveNext, walk } from '../../contracts/src/browser-entry-closure.lib.mjs';

function readText(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function sourceShape() {
  const schemas = readText('packages/exchange-contract/src/schemas.ts');
  const exchangeIndex = readText('packages/exchange-contract/src/index.ts');
  const exchangePkg = JSON.parse(readText('packages/exchange-contract/package.json'));
  const problems = [];
  if (!/from ['"]@intafaced\/contracts\/instruments['"]/.test(schemas)) problems.push('schemas-missing-instruments-subpath');
  if (/from ['"]@intafaced\/contracts['"]/.test(schemas)) problems.push('schemas-still-imports-contracts-root');
  if (!exchangeIndex.includes("export * from './schemas.js'")) problems.push('exchange-root-dropped-schemas');
  if (!exchangeIndex.includes("export * from './market-lifecycle-admission-proof.js'")) {
    problems.push('exchange-root-dropped-admission-proof');
  }
  const schemasExport = exchangePkg.exports?.['./schemas'];
  if (schemasExport?.default !== './dist/schemas.js' || schemasExport?.types !== './dist/schemas.d.ts') {
    problems.push('exchange-schemas-export');
  }
  if (exchangePkg.exports?.['.']?.default !== './dist/index.js') problems.push('exchange-root-export');
  return problems;
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
  ['exchange-schemas-source', 'packages/exchange-contract/src/schemas.ts'],
  ['exchange-schemas-dist', 'packages/exchange-contract/dist/schemas.js'],
  ['ledger-money-source', 'packages/ledger-client/src/money.ts'],
];

const unsafeEntries = [
  ['exchange-root-source', 'packages/exchange-contract/src/index.ts'],
  ['exchange-root-dist', 'packages/exchange-contract/dist/index.js'],
];

const pure = pureEntries.map(([id, relPath]) => ({ id, ...walk(resolve(repoRoot, relPath), { followNodeModules: true }) }));
const unsafe = unsafeEntries.map(([id, relPath]) => ({ id, ...walk(resolve(repoRoot, relPath), { followNodeModules: false }) }));

const sourceProblems = sourceShape();
const pureProblems = pure.filter((graph) => graph.forbidden.length > 0 || graph.unresolved.length > 0).map((graph) => graph.id);
const unsafeMisses = {
  'exchange-root-source': mustInclude(unsafe.find((graph) => graph.id === 'exchange-root-source'), [
    'market-lifecycle-admission-proof.ts',
    'node:crypto',
  ]),
  'exchange-root-dist': mustInclude(unsafe.find((graph) => graph.id === 'exchange-root-dist'), [
    'market-lifecycle-admission-proof.js',
    'node:crypto',
  ]),
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

process.stdout.write(
  `${JSON.stringify({
    ok,
    scope: 'exchange-contract',
    note: 'Node imported @intafaced/contracts successfully when rootImportSucceeded is true. That import is not browser proof. Schedule identity includes exchange schemas.',
    sourceProblems,
    pureProblems,
    unsafeMisses,
    identity: identityReport,
    pure: pure.map((graph) => ({
      id: graph.id,
      fileCount: graph.fileCount,
      forbidden: graph.forbidden,
      unresolved: graph.unresolved,
      specifiers: graph.specifiers,
    })),
    unsafe: unsafe.map((graph) => ({ id: graph.id, forbidden: graph.forbidden })),
  })}\n`,
);
