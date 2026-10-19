#!/usr/bin/env node
/**
 * NOTICE PIN — vendor licence pin + launch-list facts cannot silently drift.
 *
 * D26-P3-04. Engineering freshness only. Not legal advice. Does not purchase
 * a licence and does not clear launch. Counsel Class X (Nitro) stays the
 * owner of any licence purchase.
 *
 * WHY
 * ───
 * Root NOTICE was compiled 2026-07-29 against 4311cff. Vendor NOTICE + LICENSE
 * are the Apache-2.0 pin for the redistributed exchange. Compose tags, jar
 * count, and the Charting Library working tree can move while NOTICE still
 * reads as current. A green `pnpm gates` over that lie is worse than an
 * outdated file that admits it.
 *
 * WHAT IT CHECKS
 * ──────────────
 *   · required files exist (empty tree → named miss, never a clean tick)
 *   · vendor NOTICE licence / retrieved / source match LICENSE + root NOTICE
 *   · tip facts we can prove: jar count, charting_library file count,
 *     grafana/tempo tags, vendor mysql/mongo tags
 *   · NOTICE §11 names the divergences (NAMED-DIVERGENT) so they are not silent
 *
 * Exit 0 = pins hold. Exit 1 = missing subject or silent drift.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const problems = [];

const PINS = {
  vendorLicence: 'Apache License 2.0',
  vendorRetrieved: '2026-07-28',
  vendorSource: 'https://github.com/jammy928/CoinExchange_CryptoExchange_Java',
  noticeCompileCommit: '4311cff',
  jarCountTip: 32,
  chartingLibraryFilesTip: 0,
  grafanaImage: 'grafana/grafana:11.4.0',
  tempoImage: 'grafana/tempo:2.6.1',
  mysqlImage: 'mysql:8.0',
  mongoImageTip: 'mongo:4.4',
};

const REQUIRED = [
  'NOTICE',
  'docs/LICENCE-POSITION.md',
  'docker-compose.yml',
  'vendor/upstream-exchange/NOTICE',
  'vendor/upstream-exchange/LICENSE',
  'vendor/upstream-exchange-compose.yml',
];

function fail(msg) {
  problems.push(msg);
}

function read(rel) {
  const p = join(ROOT, rel);
  if (!existsSync(p)) {
    fail(`NOTICE PIN FAILED — missing required file: ${rel}`);
    return '';
  }
  return readFileSync(p, 'utf8');
}

function mustInclude(rel, body, needle, why) {
  if (!body) return;
  if (!body.includes(needle)) fail(`${rel}: missing ${JSON.stringify(needle)} — ${why}`);
}

function walkFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walkFiles(p, acc);
    else acc.push(p);
  }
  return acc;
}

for (const rel of REQUIRED) {
  if (!existsSync(join(ROOT, rel))) fail(`NOTICE PIN FAILED — missing required file: ${rel}`);
}

const rootNotice = read('NOTICE');
const vendorNotice = read('vendor/upstream-exchange/NOTICE');
const vendorLicense = read('vendor/upstream-exchange/LICENSE');
const compose = read('docker-compose.yml');
const vendorCompose = read('vendor/upstream-exchange-compose.yml');
const launchList = read('docs/LICENCE-POSITION.md');

if (vendorNotice) {
  mustInclude('vendor/upstream-exchange/NOTICE', vendorNotice, `Licence:   ${PINS.vendorLicence}`, 'vendor pin licence');
  mustInclude('vendor/upstream-exchange/NOTICE', vendorNotice, `Retrieved: ${PINS.vendorRetrieved}`, 'vendor pin retrieval date');
  mustInclude('vendor/upstream-exchange/NOTICE', vendorNotice, PINS.vendorSource, 'vendor pin source URL');
}

if (vendorLicense) {
  const first = vendorLicense
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean);
  if (!first || !first.includes('Apache License')) {
    fail('vendor/upstream-exchange/LICENSE: first non-empty line is not Apache License — vendor pin broken');
  }
}

if (rootNotice) {
  mustInclude('NOTICE', rootNotice, 'vendor/upstream-exchange/NOTICE', 'root NOTICE must cite the vendor provenance file');
  mustInclude('NOTICE', rootNotice, PINS.vendorLicence, 'root NOTICE must record the vendor Apache pin');
  mustInclude('NOTICE', rootNotice, PINS.vendorRetrieved, 'root NOTICE must record the vendor retrieval date');
  mustInclude('NOTICE', rootNotice, PINS.vendorSource, 'root NOTICE must record the vendor source URL');
  mustInclude('NOTICE', rootNotice, PINS.noticeCompileCommit, '§§1–10 compile commit must stay named (not silently rewritten)');
  mustInclude('NOTICE', rootNotice, '§11 · FRESHNESS', 'tip check lives in §11 so snapshot §§1–10 are not pretended current');
  mustInclude('NOTICE', rootNotice, 'NAMED-DIVERGENT', 'divergences from the compile must be named, not silent');
  mustInclude('NOTICE', rootNotice, 'not legal advice', 'must not be readable as a legal opinion');
  mustInclude('NOTICE', rootNotice, '32 committed `.jar`', 'tip jar count must be named in §11');
  mustInclude('NOTICE', rootNotice, 'charting_library working-tree count: 0', 'Path A working-tree fact must be named');
  mustInclude('NOTICE', rootNotice, PINS.mongoImageTip, 'tip mongo tag must be named in §11');
  mustInclude('NOTICE', rootNotice, 'lightweight-charts', 'launch chart pin (Apache-2.0) must stay recorded');
  mustInclude('NOTICE', rootNotice, PINS.grafanaImage, '§9 grafana tag must stay in NOTICE or §11');
  mustInclude('NOTICE', rootNotice, PINS.tempoImage, '§9 tempo tag must stay in NOTICE or §11');
}

if (compose) {
  mustInclude('docker-compose.yml', compose, `image: ${PINS.grafanaImage}`, 'NOTICE §9 grafana pin');
  mustInclude('docker-compose.yml', compose, `image: ${PINS.tempoImage}`, 'NOTICE §9 tempo pin');
}

if (vendorCompose) {
  mustInclude('vendor/upstream-exchange-compose.yml', vendorCompose, `image: ${PINS.mysqlImage}`, 'vendor mysql pin');
  mustInclude(
    'vendor/upstream-exchange-compose.yml',
    vendorCompose,
    `image: ${PINS.mongoImageTip}`,
    'vendor mongo tip pin (named-divergent from NOTICE snapshot mongo:6)',
  );
}

if (launchList) {
  mustInclude('docs/LICENCE-POSITION.md', launchList, 'not legal advice', 'launch list must stay an engineering record');
  mustInclude('docs/LICENCE-POSITION.md', launchList, 'Class X', 'licence purchase residual must stay named Class X');
  mustInclude('docs/LICENCE-POSITION.md', launchList, 'NOTICE', 'launch list must still point at the evidence file');
}

const vendorRoot = join(ROOT, 'vendor', 'upstream-exchange');
if (existsSync(vendorRoot)) {
  const jars = walkFiles(vendorRoot).filter((p) => p.endsWith('.jar'));
  if (jars.length !== PINS.jarCountTip) {
    fail(`jar count ${jars.length} !== pin ${PINS.jarCountTip} — update NOTICE §11 and PINS.jarCountTip together (no silent extra binary)`);
  }

  // Any charting_library directory anywhere under the vendor tree counts; the Vue front end that
  // held it was deleted, and a re-add must still be a named decision, not a silent file.
  const chartFiles = walkFiles(vendorRoot).filter((p) => p.split(/[\\/]/).includes('charting_library'));
  if (chartFiles.length !== PINS.chartingLibraryFilesTip) {
    fail(
      `charting_library working-tree files ${chartFiles.length} !== pin ${PINS.chartingLibraryFilesTip} — Path A expected empty; a re-add is Class X (Nitro + counsel), not a silent NOTICE skip`,
    );
  }
}

if (problems.length) {
  console.error('NOTICE PIN FAILED\n');
  for (const p of problems) console.error(`  · ${p}`);
  console.error(`\n${problems.length} pin(s) broken. Named-divergent is allowed; silent drift is not.`);
  process.exit(1);
}

console.log(
  `✓ notice-pin — vendor Apache-2.0 pin holds; ${PINS.jarCountTip} jars; charting_library=${PINS.chartingLibraryFilesTip}; grafana/tempo tags match; §11 names divergences`,
);
