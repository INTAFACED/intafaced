#!/usr/bin/env node
/**
 * `pnpm verify` — the same steps as before, plus a verdict that cannot be
 * skipped past.
 *
 * WHY THIS IS A SCRIPT AND NOT A `&&` CHAIN ANY MORE
 *
 * The chain was:
 *
 *   scan:agent-autoload && tracker:check && format:check &&
 *   turbo run build typecheck test && scan:workspace && dod-gate
 *
 * Two properties of `&&` are what this replaces:
 *
 *  1. **The last link never runs when an earlier one fails.** `pnpm verify` halts
 *     turbo on the first failing task, so a red `svc-trade` means the run never
 *     reaches `svc-pay` at all — and that is exactly the moment someone needs to
 *     be told how much of the suite was real. Several agents have been reaching
 *     for `--continue` to get that picture by hand. The verdict now prints
 *     unconditionally, pass or fail, and `pnpm verify --continue` forwards the
 *     flag to turbo for anyone who wants the whole board.
 *
 *  2. **`;` is not portable.** pnpm runs scripts through the platform shell, so
 *     an "always run this last" link written with `;` works on a developer's
 *     bash and silently changes meaning on Windows. A node script behaves the
 *     same everywhere, which for a repo whose agents run on three platforms is
 *     the difference between a rule and a suggestion.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not change which steps run, their order, or the exit code you get for
 * a genuine failure. `pnpm verify` still exits non-zero on the first broken
 * step; a run whose only problem is unreachable infrastructure still exits 0 on
 * a developer machine, because a `verify` that cannot be run without Docker is a
 * `verify` that gets deleted. What it adds is that such a run can no longer end
 * on the word "successful" without a paragraph underneath explaining what that
 * word is not covering.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_UNREPORTED } from './unreported-suites.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/** Anything after `--` (or any extra argv) is forwarded to the turbo step. */
const passthrough = process.argv.slice(2).filter((a) => a !== '--');

/**
 * One id for this run, stamped into every journal record. Two agents running
 * `verify` in two worktrees already have separate journals; this also stops a
 * stray `pnpm test` from an hour ago colouring the verdict of this one.
 */
const runId = `verify-${Date.now()}-${randomUUID().slice(0, 8)}`;
const journalDir = join(repoRoot, '.intafaced-run', 'infra');
rmSync(journalDir, { recursive: true, force: true });

const env = { ...process.env, INTAFACED_RUN_ID: runId };

// `pnpm gates` rather than a list of scans spelled out here.
//
// This wrapper originally enumerated its own steps, which would have made it
// the THIRD hand-maintained list of gates in the repo — after package.json's
// `verify` and ci.yml's steps, the two that had already drifted apart badly
// enough that two gates ran in CI with no local equivalent.
//
// tooling/ci/gates.mjs is now the single list both this and CI consume, and it
// self-guards: every .mjs in tooling/ci/ must be a declared gate or explicitly
// excluded with a reason. Re-listing them here would have reintroduced the
// exact drift that file exists to make impossible.
const steps = [
  ['doctrine gates', 'pnpm gates'],
  ['format', 'pnpm format:check'],
  ['build · typecheck · test', ['pnpm', 'exec', 'turbo', 'run', 'build', 'typecheck', 'test', ...passthrough].join(' ')],
  ['definition of done', 'node tooling/ci/dod-gate.mjs'],
];

let failed = null;

for (const [label, command] of steps) {
  const result = spawnSync(command, { cwd: repoRoot, env, shell: true, stdio: 'inherit' });
  const code = result.status ?? 1;
  if (code !== 0) {
    failed = { label, command, code };
    break;
  }
}

/**
 * ALWAYS. This is the whole point of the file — the verdict is not a step that
 * an earlier failure gets to cancel.
 */
const verdict = spawnSync(process.execPath, [join(here, 'infra-verdict.mjs')], { cwd: repoRoot, env, stdio: 'inherit' });
const verdictCode = verdict.status ?? 0;

if (failed) {
  console.error(`\n✖ pnpm verify FAILED at: ${failed.label}  (${failed.command})\n`);
  process.exit(failed.code);
}

/**
 * The last line has to agree with the block above it. "Every step passed"
 * printed underneath a paragraph saying a third of the suite never ran is how a
 * reader ends up believing whichever sentence they saw last — which is the exact
 * failure this whole change exists to remove, reproduced one line lower down.
 *
 * 2 = incomplete but permitted (a laptop with no Docker). Still exit 0: the
 * constraint is honesty, not friction.
 */
if (verdictCode === 2) {
  console.log('⚠ pnpm verify — every step passed, but the run was INCOMPLETE. Do not call this green; see the block above.\n');
  process.exit(0);
}
if (verdictCode !== 0) process.exit(verdictCode);

/**
 * Same rule applied to the happiest case. While `unreported-suites.mjs` has
 * entries there are suites whose skip guard writes nothing to the journal, so
 * "every infrastructure-backed suite actually ran" would be a claim about suites
 * this process never heard from — a smaller copy of "92 successful, 92 total".
 */
if (ALL_UNREPORTED.length > 0) {
  console.log(
    `✓ pnpm verify — every step passed, and every suite that reports in ran. ` +
      `${ALL_UNREPORTED.length} suite(s) still cannot report either way; they are named above.\n`,
  );
  process.exit(0);
}

console.log('✓ pnpm verify — every step passed, and every infrastructure-backed suite actually ran.\n');
