#!/usr/bin/env node
/**
 * DEAD CODE: no change adds a file or an export that nothing uses (project-state#2848).
 *
 * An agent copies the nearest example, and dead code reads as live. knip (configured in knip.jsonc) lists every file no
 * entry reaches and every export no other file imports, across every workspace. What it lists on main today is
 * tooling/ci/dead-code-baseline.json, which may only shrink: a finding missing from it fails and is named with its fix.
 * A baseline row knip no longer finds is printed for deletion (`--write` deletes it) and never fails: a fix never fails
 * the build.
 *
 * It also holds KEEPERS, the modules a dead-code sweep must never remove: before this gate the reachability scan held
 * them, and a missing keeper fails here.
 *
 * Usage (from the repo root):
 *   node tooling/ci/dead-code.mjs           run knip, compare with the baseline, exit 1 on a new finding
 *   node tooling/ci/dead-code.mjs --write   also delete the baseline rows knip no longer finds (never adds one)
 * Its test, dead-code.test.mjs, plants each fault.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASELINE = 'tooling/ci/dead-code-baseline.json';
export const CONFIG = 'knip.jsonc';

/**
 * KEEPERS: each imports a live source and asserts against it. Four guard the agent money-tool deny lists, so deleting
 * one drops a safety property with every other gate green. A sweep by filename pattern (`*-honesty.ts`) would take them.
 * To retire one, delete its line here in the same PR and say why in the body.
 */
export const KEEPERS = [
  'packages/config/src/fiat-currency-honesty.ts',
  'packages/config/src/module-id-honesty.ts',
  'packages/config/src/marketing-language.ts',
  'packages/contracts/src/analytics-metric-honesty.ts',
  'services/svc-agents/src/copy-intel/money-deny-honesty.ts',
  'services/svc-agents/src/merchant/guardrail-honesty.ts',
  'services/svc-agents/src/navigator/money-deny-honesty.ts',
  'services/svc-agents/src/support-agent/money-deny-honesty.ts',
  'services/svc-identity/src/affiliates/commission-tier-honesty.ts',
  'services/svc-notify/src/channels/refusal-code-honesty.ts',
];

/** knip's JSON report as findings: `file` for a dead file, `file#name` for a dead export, sorted. */
export function findingsOf(report) {
  const out = new Set();
  for (const issue of report.issues ?? []) {
    if ((issue.files ?? []).length) out.add(issue.file);
    for (const e of issue.exports ?? []) out.add(`${issue.file}#${e.name}`);
  }
  return [...out].sort();
}

/** What changed against the baseline: `added` fails, `gone` is printed for deletion. */
export function compare(found, baseline) {
  const known = new Set(baseline);
  const now = new Set(found);
  return { added: found.filter((f) => !known.has(f)), gone: baseline.filter((b) => !now.has(b)) };
}

/** One line per new finding, with its fix. */
export function explain(finding) {
  const [file, name] = finding.split('#');
  if (!name)
    return `${file}: no entry reaches this file (no test, runner, gate or start file imports it). Delete it, or import it from what should use it.`;
  return `${file}: export ${name} is imported by no other file. Drop \`export\` if this file uses it, else delete it.`;
}

function runKnip(root) {
  const bin = join(root, 'node_modules', 'knip', 'bin', 'knip.js');
  if (!existsSync(bin)) throw new Error(`knip is not installed at ${bin}: run pnpm install.`);
  const run = spawnSync(process.execPath, [bin, '--include', 'files,exports', '--reporter', 'json', '--no-progress', '--no-exit-code'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  // A plugin that cannot load its config drops that workspace's entries, so every file behind them would read as dead.
  if (run.status !== 0 || /\bERROR\b/.test(run.stderr)) {
    throw new Error(`knip did not finish cleanly (exit ${run.status}):\n${run.stderr.trim()}`);
  }
  return JSON.parse(run.stdout);
}

function main() {
  const root = process.cwd();
  const missing = KEEPERS.filter((k) => !existsSync(join(root, k)));
  if (missing.length) {
    console.error(`\n  x DEAD CODE - ${missing.length} protected module(s) were deleted:\n`);
    for (const k of missing) console.error(`      ${k}`);
    console.error('\n  Each imports a live source and asserts against it; four guard agent money-tool deny lists.');
    console.error('  Restore them, or retire one by deleting its KEEPERS line in tooling/ci/dead-code.mjs with the reason in the PR.\n');
    process.exit(1);
  }
  if (!existsSync(join(root, CONFIG)) || !existsSync(join(root, BASELINE))) {
    console.error(`\n  x DEAD CODE FAILED - ${CONFIG} or ${BASELINE} is missing. NOTHING WAS SCANNED.\n`);
    process.exit(1);
  }

  const found = findingsOf(runKnip(root));
  const baseline = JSON.parse(readFileSync(join(root, BASELINE), 'utf8'));
  const { added, gone } = compare(found, baseline);

  if (gone.length) {
    const msg = `${gone.length} row(s) in ${BASELINE} are no longer dead or no longer exist. Good: delete them (node tooling/ci/dead-code.mjs --write).`;
    console.log(process.env.GITHUB_ACTIONS ? `::warning title=Dead code::${msg}` : `  ! ${msg}`);
    for (const g of gone.slice(0, 50)) console.log(`      ${g}`);
    if (process.argv.includes('--write')) {
      const drop = new Set(gone);
      writeFileSync(
        join(root, BASELINE),
        `${JSON.stringify(
          baseline.filter((b) => !drop.has(b)),
          null,
          2,
        )}\n`,
      );
      console.log(`  wrote ${BASELINE}: ${baseline.length - gone.length} rows`);
    }
  }
  if (added.length) {
    console.error(`\n  x DEAD CODE - ${added.length} new finding(s) knip lists that ${BASELINE} does not:\n`);
    for (const a of added) console.error(`      ${explain(a)}`);
    console.error(
      [
        '',
        '  The baseline may only shrink. A file or export moved or renamed keeps its finding under the new name: fix it',
        '  rather than adding a row. If a runner starts the file by a path knip cannot read, name it as an entry in knip.jsonc.',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  console.log(`  dead code: ${found.length} known finding(s), none new (baseline ${baseline.length})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
