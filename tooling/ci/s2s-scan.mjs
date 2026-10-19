#!/usr/bin/env node
/**
 * S2S SCAN: services stop hand-signing service calls and stop comparing a claimed caller name.
 *
 * Service-to-service calls move to per-service keys (packages/contracts `service-keys`, `service-auth-http`). A
 * service that signs by hand with `serviceAuthHeaders*` is still on the shared secret, and a service that compares
 * `ctx.service` to a name is trusting a name instead of declaring its callers (`serviceProcedureFor`). Both are
 * counted per file in tooling/ci/s2s-ratchet.json. The counts may only SHRINK:
 *
 *   - a count above its baseline, or a file that is not in the baseline, fails (new hand-signing or a new name check);
 *   - a count below its baseline also fails, with the number to lower it to, so the baseline cannot drift loose.
 *
 * Counts are of code lines: comment lines and test files are not counted. A fully migrated tree has an empty baseline.
 *
 * Usage:
 *   node tooling/ci/s2s-scan.mjs                   check
 *   node tooling/ci/s2s-scan.mjs --write-baseline  rewrite s2s-ratchet.json from the tree (a reviewed change)
 * Exit 0 = baseline holds, 1 = it does not.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SERVICES = join(ROOT, 'services');
const BASELINE = join(ROOT, 'tooling', 'ci', 's2s-ratchet.json');

/** What is counted, by kind. */
export const PATTERNS = {
  sign: [/\bserviceAuthHeaders(?:ForBody)?\s*\(/g, /\bsignServiceCall\w*\s*\(/g],
  caller: [/\bctx\.service\b/g],
};

/** Counts per kind in one source text. Comment lines are skipped. */
export function countSource(text) {
  const counts = { sign: 0, caller: 0 };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const [kind, patterns] of Object.entries(PATTERNS)) {
      for (const pattern of patterns) counts[kind] += (line.match(pattern) ?? []).length;
    }
  }
  return counts;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && /\.(?:ts|tsx|mts)$/.test(entry.name) && !/\.(?:test|spec)\.(?:ts|tsx|mts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** { 'services/svc-x/src/y.ts': { sign, caller } } for every file with a nonzero count, in sorted order. */
export function scanTree(services = SERVICES, root = ROOT) {
  const found = {};
  for (const file of walk(services).sort()) {
    const counts = countSource(readFileSync(file, 'utf8'));
    if (counts.sign === 0 && counts.caller === 0) continue;
    found[relative(root, file).split(sep).join('/')] = counts;
  }
  return found;
}

/** Problems between the tree and the baseline, as lines. Empty when it holds. */
export function compare(found, baseline) {
  const problems = [];
  for (const file of new Set([...Object.keys(found), ...Object.keys(baseline)])) {
    const have = found[file] ?? { sign: 0, caller: 0 };
    const allowed = baseline[file] ?? { sign: 0, caller: 0 };
    for (const kind of ['sign', 'caller']) {
      const label = kind === 'sign' ? 'hand-signed service call (serviceAuthHeaders*)' : 'ctx.service comparison';
      if (have[kind] > allowed[kind]) {
        problems.push(
          `${file}: ${have[kind]} ${label} above the baseline of ${allowed[kind]}. ` +
            (kind === 'sign'
              ? 'Sign with the service key (s2sFetch / s2sRequestHeaders) instead of adding shared-secret signing.'
              : 'Declare the allowed callers with serviceProcedureFor instead of comparing a name.'),
        );
      } else if (have[kind] < allowed[kind]) {
        problems.push(
          `${file}: ${label} is down to ${have[kind]} (baseline ${allowed[kind]}). Lower the baseline in s2s-ratchet.json to ${have[kind]}.`,
        );
      }
    }
  }
  return problems;
}

function main() {
  if (!existsSync(SERVICES)) {
    console.error('✖ S2S SCAN FAILED: cannot find services/. It scans nothing without it.');
    process.exit(1);
  }
  const found = scanTree();
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(BASELINE, `${JSON.stringify({ files: found }, null, 2)}\n`);
    console.log(`wrote ${relative(ROOT, BASELINE)} (${Object.keys(found).length} files)`);
    return;
  }
  if (!existsSync(BASELINE)) {
    console.error('✖ S2S SCAN FAILED: tooling/ci/s2s-ratchet.json is missing. Without it nothing is held to a baseline.');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).files;
  const problems = compare(found, baseline);
  if (problems.length > 0) {
    console.error('\n✖ S2S SCAN FAILED\n');
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error('\n  The baseline may only shrink. docs/adr and status/service-auth.md say where the shared secret is going.\n');
    process.exit(1);
  }
  const total = Object.values(found).reduce((n, c) => n + c.sign + c.caller, 0);
  console.log(`✓ s2s scan: ${Object.keys(found).length} files, ${total} hand-signed calls or name checks, none above the baseline`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
