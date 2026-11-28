/**
 * The journeys revert's probes run a stack set up exactly as a Real-app journeys shard sets it up, because both run the
 * one setup (tooling/ci/journey-shard.sh) on a runner both ready one way (.github/actions/journey-runner), and neither
 * keeps a stack step of its own. (Failure it prevents, project-state#4151: main-bisect.yml kept its own copy of the
 * shard's setup without the shard's custody switch, so on 27 Nov 2026 J-p2p-21 and J-wallet-01, red on main from #11129,
 * passed every probe, "No culprit … nothing reproduces" (run 46009737757), and were filed as flaky; main stayed red
 * about 6 hours.) The planted cases at the bottom, main's files from before the fix among them, fail each rule.
 * Run by tooling/scripts/tooling-tests.mjs.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const JOURNEYS = '.github/workflows/real-app-journeys.yml';
const BISECT = '.github/workflows/main-bisect.yml';
const PROBE = 'tooling/ci/journeys-revert-probe.sh';
const SHARD_SH = 'tooling/ci/journey-shard.sh';
const RUNNER = './.github/actions/journey-runner';
/** main-bisect's jobs that run journeys on a stack. */
const PROBE_JOBS = ['revert-probe-leg', 'revert-control', 'confirm-run'];
/**
 * What a probe job writes to GITHUB_ENV in place of a shard's own: the red run's leave-out list, which stands for the
 * shard's JOURNEY_LEAVE_OUT (journeys-revert-probe.mjs leavesOut).
 */
const PROBE_ONLY_ENV = new Set(['JOURNEY_LEAVE_OUT_FILE']);
/** The shard's subcommands only a seeded stack (the build job's copy, which a probe never has) runs. */
const SEEDED_ONLY = new Set(['maker']);
/**
 * A command that sets up or runs the stack. Only the shared script runs one; a job may still stop the stack and read
 * its CSP report after the journeys.
 */
const STACK_COMMAND =
  /\bnode tooling\/scripts\/(?:local-test-(?:stack|gates|market|seed)|launch-custody|journey-market-past)\.mjs\b|\bplaywright test\b|uses: \.\/\.github\/actions\/nats-server\b|ghcr\.io\/foundry-rs\//;
const AFTER_JOURNEYS = /tooling\/scripts\/local-test-stack\.mjs (?:stop|csp-report)\b|playwright install\b/;

/** One job's lines (`  <name>:` up to the next job), comments dropped. */
export function jobText(workflow, name) {
  const lines = String(workflow).split('\n');
  const at = lines.findIndex((l) => l === `  ${name}:`);
  if (at < 0) return null;
  const end = lines.findIndex((l, i) => i > at && /^ {2}[A-Za-z0-9_-]+:\s*$/.test(l));
  return lines
    .slice(at, end < 0 ? lines.length : end)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
}

/** The `journey-shard.sh <subcommand>` calls in a text, in order. */
export const shardCalls = (text) => [...String(text).matchAll(/(?:journey-shard\.sh|"\$shard") (\w[\w-]*)/g)].map((m) => m[1]);

/** The variables a job writes to GITHUB_ENV. */
const envWrites = (text) => [...String(text).matchAll(/echo "([A-Z_]+)=[^"]*" >> "\$GITHUB_ENV"/g)].map((m) => m[1]);

/** The keys of a job's own `env:` block. */
function jobEnvKeys(job) {
  const lines = String(job).split('\n');
  const at = lines.findIndex((l) => /^ {4}env:\s*$/.test(l));
  if (at < 0) return [];
  const keys = [];
  for (const l of lines.slice(at + 1)) {
    const m = /^ {6}([A-Z_][A-Z0-9_]*):/.exec(l);
    if (!m) break;
    keys.push(m[1]);
  }
  return keys;
}

/**
 * Every way the probes' stack can differ from a shard's, as one line each naming the fix; none when they are one.
 * `files` holds the text of JOURNEYS, BISECT and PROBE. Pure.
 */
export function setupDrift(files) {
  const out = [];
  const shard = jobText(files[JOURNEYS], 'journeys');
  if (!shard) return [`${JOURNEYS}: no \`journeys\` job`];
  const stackLines = (text) =>
    String(text)
      .split('\n')
      .filter((l) => !/^\s*#/.test(l) && STACK_COMMAND.test(l) && !AFTER_JOURNEYS.test(l));
  for (const l of stackLines(shard))
    out.push(`${JOURNEYS} journeys: \`${l.trim()}\` sets up or runs the stack itself — move it into ${SHARD_SH}, which the probes run too`);
  if (!shard.includes(`uses: ${RUNNER}`)) out.push(`${JOURNEYS} journeys: ready the runner with \`uses: ${RUNNER}\``);
  for (const v of envWrites(shard).filter((v) => v !== 'LOCAL_STACK_CUSTODY_LAYER'))
    out.push(`${JOURNEYS} journeys: writes ${v} to GITHUB_ENV, which no probe sets — set it in ${SHARD_SH} or ${RUNNER}`);
  if (envWrites(shard).includes('LOCAL_STACK_CUSTODY_LAYER') && !/custody=\$\(bash tooling\/ci\/journey-shard\.sh custody /.test(shard))
    out.push(`${JOURNEYS} journeys: take LOCAL_STACK_CUSTODY_LAYER from \`journey-shard.sh custody\`, as the probe does`);
  const probe = String(files[PROBE] ?? '');
  if (!/LOCAL_STACK_CUSTODY_LAYER="\$c"/.test(probe) || !/c=\$\(bash "\$shard" custody /.test(probe))
    out.push(`${PROBE}: set LOCAL_STACK_CUSTODY_LAYER from \`journey-shard.sh custody\`, as a shard does`);
  for (const l of stackLines(probe)) out.push(`${PROBE}: \`${l.trim()}\` sets up or runs the stack itself — run ${SHARD_SH} instead`);
  const want = shardCalls(shard).filter((c) => !SEEDED_ONLY.has(c) && c !== 'custody');
  const got = shardCalls(probe).filter((c) => c !== 'custody');
  if (JSON.stringify(want) !== JSON.stringify(got))
    out.push(`${PROBE}: runs ${SHARD_SH} ${got.join(', ') || 'nowhere'}, where a shard runs ${want.join(', ')} — run the same, in order`);
  const keys = jobEnvKeys(shard).filter((k) => k !== 'JOURNEYS_TARGET');
  for (const name of PROBE_JOBS) {
    const job = jobText(files[BISECT], name);
    if (!job) {
      out.push(`${BISECT}: no \`${name}\` job`);
      continue;
    }
    for (const l of stackLines(job)) out.push(`${BISECT} ${name}: \`${l.trim()}\` sets up the stack itself — leave it to ${PROBE}`);
    if (!job.includes(`uses: ${RUNNER}`)) out.push(`${BISECT} ${name}: ready the runner with \`uses: ${RUNNER}\`, as a shard does`);
    if (!job.includes(SHARD_SH)) out.push(`${BISECT} ${name}: copy ${SHARD_SH} beside the probe, which runs it`);
    for (const v of envWrites(job).filter((v) => !PROBE_ONLY_ENV.has(v)))
      out.push(`${BISECT} ${name}: writes ${v} to GITHUB_ENV, which a shard doesn't — set it in ${RUNNER}`);
    const have = new Set(jobEnvKeys(job));
    for (const k of keys.filter((k) => !have.has(k))) out.push(`${BISECT} ${name}: a shard's job sets ${k} and this job doesn't`);
  }
  return out;
}

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const today = () => ({ [JOURNEYS]: read(JOURNEYS), [BISECT]: read(BISECT), [PROBE]: read(PROBE) });

test('the probes and a shard set up the stack one way', () => {
  const faults = setupDrift(today());
  assert.deepEqual(faults, [], `\n${faults.join('\n')}`);
});

test('planted: main before the fix fails, naming the custody switch only a shard set', () => {
  // The files at the commit before this rule, the 27 Nov setup that let #11129's break pass every probe.
  const at = (p) => {
    try {
      return execFileSync('git', ['show', `e9e46e8982:${p}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  const old = { [JOURNEYS]: at(JOURNEYS), [BISECT]: at(BISECT), [PROBE]: at(PROBE) };
  if (Object.values(old).some((t) => t === null)) return; // a shallow clone without that commit
  const faults = setupDrift(old);
  assert.ok(
    faults.some((f) => f.includes(PROBE) && f.includes('LOCAL_STACK_CUSTODY_LAYER')),
    faults.join('\n'),
  );
  assert.ok(
    faults.some((f) => f.includes('launch-custody.mjs')),
    'the shard computed the switch itself',
  );
});

test('planted: a setup step only the shard has fails', () => {
  const files = today();
  const env = files[JOURNEYS].replace(
    '      - name: Load the TEST content\n',
    '      - name: A new switch\n        run: echo "LOCAL_STACK_NEW=1" >> "$GITHUB_ENV"\n      - name: Load the TEST content\n',
  );
  assert.notEqual(env, files[JOURNEYS]);
  assert.match(setupDrift({ ...files, [JOURNEYS]: env }).join('\n'), /writes LOCAL_STACK_NEW to GITHUB_ENV, which no probe sets/);
  const cmd = files[JOURNEYS].replace(
    '        run: bash tooling/ci/journey-shard.sh content\n',
    '        run: |\n          bash tooling/ci/journey-shard.sh content\n          node tooling/scripts/local-test-gates.mjs apply --extra\n',
  );
  assert.notEqual(cmd, files[JOURNEYS]);
  assert.match(setupDrift({ ...files, [JOURNEYS]: cmd }).join('\n'), /local-test-gates\.mjs apply --extra.*move it into/);
  const sub = files[JOURNEYS].replace(
    '        run: bash tooling/ci/journey-shard.sh first-trade\n',
    '        run: |\n          bash tooling/ci/journey-shard.sh first-trade\n          bash tooling/ci/journey-shard.sh content\n',
  );
  assert.notEqual(sub, files[JOURNEYS]);
  assert.match(setupDrift({ ...files, [JOURNEYS]: sub }).join('\n'), /run the same, in order/);
  const key = files[JOURNEYS].replace(
    '      INTAFACED_SANCTIONS_REGIONS: ${{ secrets.INTAFACED_SANCTIONS_REGIONS }}\n      INTAFACED_SANCTIONS_LIST_SOURCE',
    '      INTAFACED_SANCTIONS_REGIONS: ${{ secrets.INTAFACED_SANCTIONS_REGIONS }}\n      LOCAL_STACK_OTHER: x\n      INTAFACED_SANCTIONS_LIST_SOURCE',
  );
  assert.notEqual(key, files[JOURNEYS]);
  assert.match(setupDrift({ ...files, [JOURNEYS]: key }).join('\n'), /revert-probe-leg: a shard's job sets LOCAL_STACK_OTHER/);
});

test('planted: a probe job that sets up its own stack, or skips the shared runner, fails', () => {
  const files = today();
  const own = files[BISECT].replace(
    '      - uses: ./.github/actions/journey-runner\n',
    '      - name: Get a nats-server binary\n        uses: ./.github/actions/nats-server\n',
  );
  assert.notEqual(own, files[BISECT]);
  const faults = setupDrift({ ...files, [BISECT]: own }).join('\n');
  assert.match(faults, /ready the runner with/);
  const custody = files[PROBE].replace('LOCAL_STACK_CUSTODY_LAYER="$c" ', '');
  assert.notEqual(custody, files[PROBE]);
  assert.match(setupDrift({ ...files, [PROBE]: custody }).join('\n'), /set LOCAL_STACK_CUSTODY_LAYER from/);
});
