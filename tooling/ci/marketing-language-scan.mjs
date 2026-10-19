#!/usr/bin/env node
/**
 * MARKETING LANGUAGE SCAN — D26-P0-16 / DIRECTION §8.9
 *
 * Product copy may not describe anything to a user as audited, insured, or
 * guaranteed unless the line (or the previous line) carries OWNER-SEAL(§8.9).
 *
 * Law module (pure helpers + tests): packages/config/src/marketing-language.ts
 * This gate re-derives the ban over product locale catalogues so invent cannot
 * land as a helpful string. It does NOT edit the Vue shell (nitro-frontend-all).
 *
 * Usage:
 *   node tooling/ci/marketing-language-scan.mjs
 *   node tooling/ci/marketing-language-scan.mjs --self-test
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** Keep spelling identical to packages/config/src/marketing-language.ts */
export const OWNER_SEAL_MARKER = 'OWNER-SEAL(§8.9)';
export const OWNER_SEAL_RE = /OWNER-SEAL\s*\(\s*§?\s*8\.9\s*\)/i;
export const MARKETING_BAN_WORDS = ['audited', 'insured', 'guaranteed'];

const LAW_SRC = join('packages', 'config', 'src', 'marketing-language.ts');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  '.turbo',
  'coverage',
  '.docker-data',
  '.pnpm-store',
  '.tools',
  'target',
  'build',
]);

/**
 * Product-copy roots. Locale catalogues only — not every TS comment that says
 * "guaranteed by the primary key". Vue craft stays under nitro-frontend-all;
 * this gate reads catalogues, it does not rewrite them.
 */
const COPY_ROOT_GLOBS = [
  join('packages', 'i18n'),
  // The legacy Vue customer site's catalogue (vendor 05_Web_Front, assets/lang) was
  // listed here until 2026-10-13, when the site was retired; the site was deleted 2026-10-19.
  // Historical path — walk if a later drop puts catalogues here.
  join('vendor', 'upstream-exchange', '04_Web_Admin', 'src', 'assets', 'lang'),
  // Actual admin i18n tree on tip (locale.js / index.js). assets/lang does not exist.
  join('vendor', 'upstream-exchange', '04_Web_Admin', 'src', 'locale'),
];

const COPY_EXTENSIONS = new Set(['.js', '.ts', '.mjs', '.json', '.vue']);

export function hasOwnerSeal(text) {
  return OWNER_SEAL_RE.test(text ?? '');
}

export function isHonestMarketingLanguageUse(line) {
  const l = String(line).toLowerCase();
  if (/\baudited\s*:\s*false\b/.test(l)) return true;
  if (/\b(?:un|non)[- ]?(?:audited|insured|guaranteed)\b/.test(l)) return true;
  if (
    /\b(?:not|never|no)\s+(?:a\s+|be\s+|been\s+|an?\s+)?(?:fully\s+|externally\s+|independently\s+)?(?:audited|insured|guaranteed)\b/.test(
      l,
    )
  ) {
    return true;
  }
  if (/^\s*audited\s*:/.test(line) && !/\baudited\s*:\s*true\b/i.test(line)) return true;
  return false;
}

export function findUnsealedMarketingClaims(line, previousLine = '') {
  if (hasOwnerSeal(line) || hasOwnerSeal(previousLine)) return [];
  if (isHonestMarketingLanguageUse(line)) return [];
  const hits = [];
  for (const word of MARKETING_BAN_WORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(line)) {
      hits.push({
        word,
        reason: `DIRECTION §8.9 — "${word}" in product copy requires ${OWNER_SEAL_MARKER}`,
      });
    }
  }
  return hits;
}

function isSeparateCheckout(dir) {
  return existsSync(join(dir, '.git'));
}

function* walkCopyFiles(dir) {
  if (!existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      if (isSeparateCheckout(full)) continue;
      yield* walkCopyFiles(full);
    } else if ([...COPY_EXTENSIONS].some((ext) => name.endsWith(ext))) {
      yield full;
    }
  }
}

function scanTree(root) {
  const lawPath = join(root, LAW_SRC);
  if (!existsSync(lawPath)) {
    return {
      ok: false,
      kind: 'missing-law',
      message:
        `MARKETING LANGUAGE SCAN FAILED — ${LAW_SRC.replace(/\\/g, '/')} is missing.\n` +
        'Cannot prove DIRECTION §8.9 product-copy ban. This is not a clean bill of health.',
    };
  }

  const lawBody = readFileSync(lawPath, 'utf8');
  for (const word of MARKETING_BAN_WORDS) {
    if (!lawBody.includes(`'${word}'`)) {
      return {
        ok: false,
        kind: 'law-drift',
        message: `MARKETING LANGUAGE SCAN FAILED — ${LAW_SRC.replace(/\\/g, '/')} no longer declares '${word}'.`,
      };
    }
  }
  if (!lawBody.includes(OWNER_SEAL_MARKER)) {
    return {
      ok: false,
      kind: 'law-drift',
      message: `MARKETING LANGUAGE SCAN FAILED — ${LAW_SRC.replace(/\\/g, '/')} lost ${OWNER_SEAL_MARKER}.`,
    };
  }

  const files = [];
  for (const relRoot of COPY_ROOT_GLOBS) {
    const abs = join(root, relRoot);
    for (const f of walkCopyFiles(abs)) files.push(f);
  }

  if (files.length === 0) {
    return {
      ok: false,
      kind: 'empty',
      message:
        'MARKETING LANGUAGE SCAN FAILED — 0 product-copy files were read. NOTHING WAS SCANNED.\n' +
        '  Expected locale catalogues under packages/i18n, vendor/**/assets/lang, or 04_Web_Admin/src/locale.',
    };
  }

  const violations = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join('/');
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const prev = i > 0 ? lines[i - 1] : '';
      for (const hit of findUnsealedMarketingClaims(lines[i], prev)) {
        violations.push({
          file: rel,
          line: i + 1,
          word: hit.word,
          text: lines[i].trim().slice(0, 140),
          reason: hit.reason,
        });
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, kind: 'hits', violations, scanned: files.length };
  }
  return { ok: true, scanned: files.length };
}

function selfTest() {
  const fails = [];
  const assert = (c, m) => {
    if (!c) fails.push(m);
  };

  assert(findUnsealedMarketingClaims('fully audited smart contracts').length === 1, 'affirmative audited refused');
  assert(findUnsealedMarketingClaims('funds are insured').length === 1, 'affirmative insured refused');
  assert(findUnsealedMarketingClaims('guaranteed returns').length === 1, 'affirmative guaranteed refused');
  assert(findUnsealedMarketingClaims(`audited by counsel ${OWNER_SEAL_MARKER}`).length === 0, 'seal on line allows');
  assert(findUnsealedMarketingClaims('audited by counsel', OWNER_SEAL_MARKER).length === 0, 'seal on previous allows');
  assert(findUnsealedMarketingClaims('Template is not audited until a real audit.').length === 0, 'negation honest');
  assert(findUnsealedMarketingClaims('marked audited:false until audit').length === 0, 'status false honest');
  assert(findUnsealedMarketingClaims('not a guaranteed yield').length === 0, 'not a guaranteed honest');
  assert(findUnsealedMarketingClaims('            audited: "Template audited",').length === 0, 'i18n key label honest');
  assert(findUnsealedMarketingClaims('audited: true').length === 1, 'audited:true refused');

  // Empty-denominator: missing law file refuses.
  const empty = mkdtempSync(join(tmpdir(), 'mkt-lang-empty-'));
  try {
    const r = scanTree(empty);
    assert(r.ok === false && r.kind === 'missing-law', 'empty tree refuses missing law');
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }

  // Fixture tree: law present, one unsealed claim → hits; seal → clean.
  const fix = mkdtempSync(join(tmpdir(), 'mkt-lang-fix-'));
  try {
    const lawDir = join(fix, 'packages', 'config', 'src');
    const langDir = join(fix, 'vendor', 'upstream-exchange', '04_Web_Admin', 'src', 'locale');
    mkdirSync(lawDir, { recursive: true });
    mkdirSync(langDir, { recursive: true });
    writeFileSync(
      join(lawDir, 'marketing-language.ts'),
      `export const MARKETING_BAN_WORDS = ['audited', 'insured', 'guaranteed'] as const;\n` +
        `export const OWNER_SEAL_MARKER = '${OWNER_SEAL_MARKER}' as const;\n`,
      'utf8',
    );
    writeFileSync(join(langDir, 'en.js'), `export default { claim: "fully audited platform" };\n`, 'utf8');
    const bad = scanTree(fix);
    assert(bad.ok === false && bad.kind === 'hits' && bad.violations?.length >= 1, 'fixture unsealed claim fails');

    writeFileSync(
      join(langDir, 'en.js'),
      `export default {\n  // ${OWNER_SEAL_MARKER}\n  claim: "fully audited platform",\n  ok: "not audited yet",\n};\n`,
      'utf8',
    );
    const good = scanTree(fix);
    assert(good.ok === true && good.scanned >= 1, 'sealed + honest fixture passes');

    // Admin catalogues live under src/locale, not assets/lang — that skip is a hole.
    const adminLocale = join(fix, 'vendor', 'upstream-exchange', '04_Web_Admin', 'src', 'locale');
    mkdirSync(adminLocale, { recursive: true });
    writeFileSync(join(adminLocale, 'locale.js'), `export default { claim: "funds are insured" };\n`, 'utf8');
    const adminBad = scanTree(fix);
    assert(
      adminBad.ok === false && adminBad.kind === 'hits' && adminBad.violations?.some((v) => v.word === 'insured'),
      'admin src/locale unsealed claim fails',
    );
  } finally {
    rmSync(fix, { recursive: true, force: true });
  }

  if (fails.length) {
    console.error('marketing-language-scan --self-test FAIL:');
    for (const f of fails) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log('marketing-language-scan --self-test OK');
  console.log(`  fixtures green · seal ${OWNER_SEAL_MARKER} · words ${MARKETING_BAN_WORDS.join(',')}`);
  process.exit(0);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun && process.argv.includes('--self-test')) selfTest();

if (isDirectRun) {
  const result = scanTree(ROOT);
  if (!result.ok) {
    if (result.kind === 'hits') {
      console.error(`\n✖ MARKETING LANGUAGE SCAN FAILED — ${result.violations.length} unsealed claim(s) (DIRECTION §8.9)\n`);
      for (const v of result.violations) {
        console.error(`  ${v.file}:${v.line}`);
        console.error(`    ${v.text}`);
        console.error(`    → ${v.reason}\n`);
      }
      console.error(`  Add ${OWNER_SEAL_MARKER} on the claim line (or the line above), or rewrite without the ban word.\n`);
      process.exit(1);
    }
    console.error(`\n✖ ${result.message}\n`);
    process.exit(1);
  }
  console.log(
    `✓ marketing-language-scan clean — ${result.scanned} product-copy file(s), 0 unsealed audited/insured/guaranteed claims (DIRECTION §8.9)`,
  );
}
