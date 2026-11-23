#!/usr/bin/env node
/**
 * SCREENING CONTENT SCAN — Class X list content must not ship in the repo.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS GATE EXISTS
 *
 * `packages/config/src/screening.ts` is the MECHANISM for sanctions / region
 * screening. The CONTENTS of any production list are a compliance decision with
 * counsel (Class X). Agents and ordinary PRs must not invent region blocklists
 * into shipped source, env examples, or compose defaults and call that "done".
 *
 * Unit tests already assert "ships empty" for the process default. A unit test
 * that nobody re-runs on a docs-only mental model is how list content sneaks in
 * as a "helpful default". This gate re-derives the empty ship from the files
 * every PR can touch.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IT CHECKS (executed, not hoped)
 *
 *   1. packages/config/src/screening.ts exists and still declares the empty-
 *      ship contract (UNSET_SCREENING_LIST + deliberate non-content header).
 *   2. No non-test source under packages/config ships a `declaration: 'listed'`
 *      constant with region entries (invented default list).
 *   3. Env / compose defaults do not set INTAFACED_SANCTIONS_REGIONS to a
 *      populated list (unset or deliberate `none` + source only after counsel).
 *   4. JURISDICTION_MATRIX business blocks never claim `authority: 'screening'`
 *      (that authority is screening.ts alone).
 *
 * Empty denominator: if screening.ts is missing, refuse — do not print clean
 * over a tree that cannot prove the prohibition.
 *
 * Usage:
 *   node tooling/ci/screening-content-scan.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const SCREENING_SRC = join(ROOT, 'packages', 'config', 'src', 'screening.ts');
const JURISDICTION_SRC = join(ROOT, 'packages', 'config', 'src', 'jurisdiction.ts');
const SANCTIONS_ENV = 'INTAFACED_SANCTIONS_REGIONS';

const failures = [];
let checks = 0;

function fail(msg) {
  failures.push(msg);
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (/\.(ts|mjs|js|yml|yaml|env|example|toml)$/i.test(entry.name) || entry.name.startsWith('.env')) {
      out.push(full);
    }
  }
  return out;
}

// ── 1 · screening.ts must exist (empty-denominator refuse) ───────────────────
checks++;
if (!existsSync(SCREENING_SRC)) {
  console.error(
    'SCREENING CONTENT SCAN FAILED — packages/config/src/screening.ts is missing.\n' +
      'Cannot prove Class X list content is unshipped. This is not a clean bill of health.',
  );
  process.exit(1);
}

const screeningBody = readFileSync(SCREENING_SRC, 'utf8');
checks++;
if (!screeningBody.includes('UNSET_SCREENING_LIST')) {
  fail('screening.ts no longer exports UNSET_SCREENING_LIST — empty-ship contract lost');
}
checks++;
if (!/WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN/i.test(screeningBody) && !/ships empty/i.test(screeningBody)) {
  fail('screening.ts lost the deliberate non-content / ships-empty contract in its header');
}
checks++;
// A default listed constant would look like declaration: 'listed' with regions.
// Tests may use listed fixtures; production source must not default to listed.
if (/export const\s+\w*[Dd]efault\w*\s*=\s*\{[^}]*declaration:\s*'listed'/s.test(screeningBody)) {
  fail('screening.ts appears to export a default listed ScreeningList — invent list content refused');
}

// ── 2 · non-test config source must not hardcode listed defaults ─────────────
const configSrc = join(ROOT, 'packages', 'config', 'src');
const configFiles = walkFiles(configSrc).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
checks++;
if (configFiles.length === 0) {
  console.error(
    'SCREENING CONTENT SCAN FAILED — packages/config/src has 0 non-test .ts files.\n' + 'NOTHING WAS SCANNED for invented list content.',
  );
  process.exit(1);
}

for (const file of configFiles) {
  if (file === SCREENING_SRC) continue;
  const body = readFileSync(file, 'utf8');
  // Invented default list in non-screening modules.
  if (/declaration:\s*'listed'/.test(body) && /regions:\s*\[/.test(body)) {
    fail(`${relative(ROOT, file)}: listed ScreeningList shape outside screening.ts — invent content refused`);
  }
}

// ── 3 · env / compose defaults must not populate the list ────────────────────
const envRoots = [ROOT, join(ROOT, 'deploy'), join(ROOT, 'infra'), join(ROOT, 'tooling')];
const envFiles = [];
for (const root of envRoots) {
  if (!existsSync(root)) continue;
  // Shallow + one level for compose and env examples
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isFile() && (/\.env/i.test(entry.name) || /compose.*\.ya?ml$/i.test(entry.name) || /\.example$/i.test(entry.name))) {
      envFiles.push(full);
    }
    if (entry.isDirectory() && !['node_modules', 'dist', '.git', 'vendor'].includes(entry.name)) {
      try {
        for (const sub of readdirSync(full, { withFileTypes: true })) {
          if (!sub.isFile()) continue;
          const sfull = join(full, sub.name);
          if (/\.env/i.test(sub.name) || /compose.*\.ya?ml$/i.test(sub.name) || /\.example$/i.test(sub.name)) {
            envFiles.push(sfull);
          }
        }
      } catch {
        /* ignore unreadable */
      }
    }
  }
}

// Also docker-compose at repo root
for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', '.env.example', '.env.sample']) {
  const p = join(ROOT, name);
  if (existsSync(p) && statSync(p).isFile()) envFiles.push(p);
}

const uniqueEnv = [...new Set(envFiles)];
checks++;
// Denominator: we always scan at least screening.ts; env files may be zero and that is fine —
// zero env defaults is the empty ship. Do NOT refuse on zero env files.
for (const file of uniqueEnv) {
  let body;
  try {
    body = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  if (!body.includes(SANCTIONS_ENV)) continue;
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    // Comments may document the FORMAT (AA:reason examples). That is not a default.
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    // YAML list comments already handled; skip pure comment keys.
    if (!trimmed.includes(SANCTIONS_ENV)) continue;
    const m = trimmed.match(new RegExp(`${SANCTIONS_ENV}\\s*[=:]\\s*["']?([^"'\\n#]+)`));
    if (!m) continue;
    const raw = m[1].trim();
    if (raw === '' || raw === '""' || raw === "''") continue;
    // Deliberate reviewed-empty is mechanism, not content.
    if (raw.toLowerCase() === 'none') continue;
    // Placeholder template like ${...} or <counsel> is not content.
    if (raw.startsWith('${') || raw.startsWith('<')) continue;
    // Anything else that looks like region codes is invented content.
    if (/[A-Za-z]{2}/.test(raw)) {
      fail(
        `${relative(ROOT, file)}: ${SANCTIONS_ENV}=${raw} — sanctions list content is Class X; ` +
          `ship unset or reviewed-empty (none + source), never a populated default.`,
      );
    }
  }
}

// ── 4 · business matrix must not claim screening authority ───────────────────
checks++;
if (existsSync(JURISDICTION_SRC)) {
  const j = readFileSync(JURISDICTION_SRC, 'utf8');
  // Matrix entries are business config. A screening authority claim on a matrix
  // row would re-merge the two authorities the screening header forbids.
  if (/authority\s*:\s*['"]screening['"]/.test(j)) {
    fail('jurisdiction.ts claims authority: screening — business matrix must not satisfy sanctions authority');
  }
} else {
  fail('packages/config/src/jurisdiction.ts missing — cannot prove matrix does not claim screening authority');
}

// ── Report ───────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\n✖ SCREENING CONTENT SCAN FAILED — ${failures.length} finding(s) over ${checks} check(s)\n`);
  for (const f of failures) console.error(`  · ${f}`);
  console.error(
    '\nClass X: list content is counsel + Nitro human. Mechanism only ships empty.\n' + 'See packages/config/src/screening.ts header.\n',
  );
  process.exit(1);
}

console.log(
  `✓ screening-content-scan clean — ${checks} check(s), ${configFiles.length} config src file(s), ` +
    `${uniqueEnv.length} env/compose candidate(s); list content unshipped (Class X boundary holds)`,
);
process.exit(0);
