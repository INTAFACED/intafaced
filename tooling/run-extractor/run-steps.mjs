#!/usr/bin/env node
// Step lists for one Real-app journeys run on main, the shape D grades (research/retro-2026-10-30/data/run-<N>.json):
// passed = tooling/scripts/roadmap.mjs passedSteps() on the run's merged `real-app-journeys` artifact; failed = every step
// seen in the report that did not pass. With --against <run-M.json>, adds diff_vs_<M> (newly passed, newly failed, added, gone).
// Usage: node tooling/run-extractor/run-steps.mjs <run id> [--against path/to/run-M.json] [--out run-N.json]
// Needs `gh` signed in with read access to INTAFACED/intafaced.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { passedSteps } from '../scripts/roadmap.mjs';

const args = process.argv.slice(2);
const runId = args[0];
if (!/^\d+$/.test(runId ?? '')) throw new Error('usage: run-steps.mjs <run id> [--against run-M.json] [--out file]');
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const REPO = 'INTAFACED/intafaced';
const gh = (...a) => execFileSync('gh', a, { encoding: 'utf8' });

const run = JSON.parse(gh('api', `repos/${REPO}/actions/runs/${runId}`));
if (run.status !== 'completed') throw new Error(`run ${runId} is ${run.status}, not completed`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), `run-${runId}-`));
gh('run', 'download', runId, '-R', REPO, '-n', 'real-app-journeys', '-D', dir);
const report = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));

const seen = new Set();
const walk = (suite) => {
  for (const spec of suite.specs ?? []) {
    const m = /^(J-[a-z0-9-]+-\d+)\s+#(\d+)\b/.exec(spec.title ?? '');
    if (m) seen.add(`${m[1]}#${Number(m[2])}`);
  }
  for (const child of suite.suites ?? []) walk(child);
};
for (const suite of report.suites ?? []) walk(suite);
const passed = [...passedSteps(report)].sort();
const passedSet = new Set(passed);
const failed = [...seen].filter((k) => !passedSet.has(k)).sort();

const out = {
  run: run.run_number,
  run_id: run.id,
  head_sha: run.head_sha,
  conclusion: run.conclusion,
  completed_at: run.updated_at,
  source: `tooling/run-extractor/run-steps.mjs on run ${run.id}; passed = roadmap.mjs passedSteps() on the real-app-journeys artifact; failed = every step seen that did not pass`,
  passed,
  failed,
};
const against = opt('--against');
if (against) {
  const prev = JSON.parse(fs.readFileSync(against, 'utf8'));
  const pa = new Set(prev.passed);
  const all = new Set([...prev.passed, ...prev.failed]);
  const now = new Set([...passed, ...failed]);
  out[`diff_vs_${prev.run}`] = {
    newly_passed: passed.filter((k) => !pa.has(k)),
    newly_failed: failed.filter((k) => !new Set(prev.failed).has(k)),
    added: [...now].filter((k) => !all.has(k)).sort(),
    gone: [...all].filter((k) => !now.has(k)).sort(),
  };
}
const file = opt('--out') ?? `run-${run.run_number}.json`;
fs.writeFileSync(file, JSON.stringify(out));
console.log(`${file}: run ${run.run_number} (${run.id}) at ${run.head_sha.slice(0, 9)}, ${passed.length} passed, ${failed.length} failed`);
