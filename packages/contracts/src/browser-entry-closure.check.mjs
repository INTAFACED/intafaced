/**
 * Contracts-local closure. Does not read exchange-contract.
 * Own dist is produced by this package's test script (`tsc` then vitest).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mustInclude, repoRoot, walk } from './browser-entry-closure.lib.mjs';

function readText(path) {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function sourceShape() {
  const instruments = readText('packages/contracts/src/instruments.ts');
  const contractsIndex = readText('packages/contracts/src/index.ts');
  const contractsPkg = JSON.parse(readText('packages/contracts/package.json'));
  const problems = [];
  if (!/from ['"]@intafaced\/config\/modules['"]/.test(instruments)) problems.push('instruments-missing-config-modules');
  if (/from ['"]@intafaced\/config['"]/.test(instruments)) problems.push('instruments-still-imports-config-root');
  if (!contractsIndex.includes("export * from './instruments.js'")) problems.push('contracts-root-dropped-instruments');
  const instrumentsExport = contractsPkg.exports?.['./instruments'];
  if (instrumentsExport?.default !== './dist/instruments.js' || instrumentsExport?.types !== './dist/instruments.d.ts') {
    problems.push('contracts-instruments-export');
  }
  if (contractsPkg.exports?.['.']?.default !== './dist/index.js') problems.push('contracts-root-export');
  if (contractsPkg.exports?.['./identity']?.default !== './dist/identity.js') problems.push('identity-subpath-moved');
  return problems;
}

async function identity() {
  const rootPath = resolve(repoRoot, 'packages/contracts/dist/index.js');
  const purePath = resolve(repoRoot, 'packages/contracts/dist/instruments.js');
  const root = await import(pathToFileURL(rootPath).href);
  const pure = await import(pathToFileURL(purePath).href);
  const keys = Object.keys(pure.TRADING_SCHEDULES);
  const sameObject = root.scheduleKeySchema === pure.scheduleKeySchema;
  const knownKeysParse = keys.every(
    (key) => pure.scheduleKeySchema.safeParse(key).success && root.scheduleKeySchema.safeParse(key).success,
  );
  const unknownRefused =
    pure.scheduleKeySchema.safeParse('lse-equities').success === false &&
    root.scheduleKeySchema.safeParse('lse-equities').success === false;
  const options = [...pure.scheduleKeySchema.options].sort().join('|');
  const rootOptions = [...root.scheduleKeySchema.options].sort().join('|');
  return {
    rootImportSucceeded: true,
    rootImportIsBrowserProof: false,
    sameObject,
    knownKeysParse,
    unknownRefused,
    optionsMatchTradingSchedules: options === [...keys].sort().join('|') && options === rootOptions,
    scheduleKeys: keys,
  };
}

const pureEntries = [
  ['contracts-instruments-source', 'packages/contracts/src/instruments.ts'],
  ['contracts-instruments-dist', 'packages/contracts/dist/instruments.js'],
  ['contracts-identity-source', 'packages/contracts/src/identity.ts'],
  ['contracts-identity-dist', 'packages/contracts/dist/identity.js'],
  ['contracts-account-controls-source', 'packages/contracts/src/account-controls.ts'],
  ['contracts-account-controls-dist', 'packages/contracts/dist/account-controls.js'],
];

const unsafeEntries = [
  ['contracts-root-source', 'packages/contracts/src/index.ts'],
  ['contracts-root-dist', 'packages/contracts/dist/index.js'],
];

const pure = pureEntries.map(([id, relPath]) => ({ id, ...walk(resolve(repoRoot, relPath), { followNodeModules: true }) }));
const unsafe = unsafeEntries.map(([id, relPath]) => ({ id, ...walk(resolve(repoRoot, relPath), { followNodeModules: false }) }));

const sourceProblems = sourceShape();
const pureProblems = pure.filter((graph) => graph.forbidden.length > 0 || graph.unresolved.length > 0).map((graph) => graph.id);
const unsafeMisses = {
  'contracts-root-source': mustInclude(
    unsafe.find((graph) => graph.id === 'contracts-root-source'),
    ['@trpc/server', '@intafaced/auth', 'node:crypto'],
  ),
  'contracts-root-dist': mustInclude(
    unsafe.find((graph) => graph.id === 'contracts-root-dist'),
    ['@trpc/server', '@intafaced/auth', 'node:crypto'],
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
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
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
    scope: 'contracts',
    note: 'Node imported @intafaced/contracts successfully when rootImportSucceeded is true. That import is not browser proof. This contracts check does not read exchange-contract.',
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
