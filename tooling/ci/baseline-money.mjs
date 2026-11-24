#!/usr/bin/env node
/**
 * The journeys baseline's money flags, held to the money rule at this commit (project-state#3690).
 *
 * `docs/runbooks/journey-baseline.json` stores a `money` flag per step; the money rule (`moneyRule` in
 * journey-verdict.mjs) computes it from journeys.json, slices.json and the package manifests. A change to those
 * inputs can flip steps to money without touching the baseline: on 22 Nov #9539 gave apps/admin a dev dependency on
 * the ledger client, 33 entries went stale on main, and the merge seal then stopped every PR whose run reached one.
 * The journeys run only sees the steps it runs, so this reads every entry, on every PR, with no run: an entry whose
 * flag differs from the rule, or a `regression` entry whose step is money (the verdict's "a money step may be in the
 * baseline only as unbuilt"), fails here, on the PR that caused it.
 *
 * Usage:
 *   node tooling/ci/baseline-money.mjs           check; exit 1 naming each entry
 *   node tooling/ci/baseline-money.mjs --write   set each stale flag to the rule's value (a state is never changed)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASELINE_PATH, manifestsAt, moneyRule } from './journey-verdict.mjs';

const WRITE = 'node tooling/ci/baseline-money.mjs --write';
const INPUTS = ['docs/roadmap/journeys.json', 'docs/roadmap/slices.json', BASELINE_PATH];

/** The baseline's entries the money rule disagrees with: `stale` (flag, rule) and `money regression` steps. A step the
 *  rule doesn't know counts as money, as the verdict counts it. */
export function moneyProblems(baseline, money) {
  const stale = [];
  const regression = [];
  for (const e of baseline.steps ?? []) {
    const rule = money[e.step] ?? true;
    if (e.money !== rule) stale.push({ step: e.step, flag: e.money, rule });
    if (e.state === 'regression' && rule) regression.push(e.step);
  }
  return { stale, regression };
}

/** The baseline's text with each stale entry's `"money"` set to the rule's value, every other byte kept. */
export function withRuleFlags(text, stale) {
  let out = text;
  for (const { step, rule } of stale) {
    const at = out.indexOf(`"step": ${JSON.stringify(step)}`);
    if (at < 0) throw new Error(`${step} is not in the baseline's text`);
    const end = out.indexOf('}', at);
    const entry = out.slice(at, end);
    const fixed = entry.replace(/"money": (?:true|false|null|"[^"]*"|-?\d+)/, `"money": ${rule}`);
    if (fixed === entry && !entry.includes(`"money": ${rule}`)) throw new Error(`${step}'s entry has no money flag to set`);
    out = out.slice(0, at) + fixed + out.slice(end);
  }
  return out;
}

/** The report for a checkout at `root`: { ok, lines }. Missing inputs or an empty baseline refuse. */
export function check(root) {
  const missing = INPUTS.filter((f) => !existsSync(join(root, f)));
  if (missing.length) return { ok: false, lines: [`BASELINE MONEY FAILED: cannot read ${missing.join(', ')}, so no flag was checked.`] };
  const read = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
  const baseline = read(BASELINE_PATH);
  if (!baseline.steps?.length)
    return { ok: false, lines: [`BASELINE MONEY FAILED: ${BASELINE_PATH} has no steps, so no flag was checked.`] };
  const money = moneyRule({ journeys: read(INPUTS[0]), slices: read(INPUTS[1]), manifests: manifestsAt(root) });
  const { stale, regression } = moneyProblems(baseline, money);
  if (!stale.length && !regression.length)
    return { ok: true, lines: [`baseline money: all ${baseline.steps.length} entries carry the money rule's flag at this commit`] };
  const lines = [];
  if (stale.length)
    lines.push(
      `BASELINE MONEY FAILED: ${stale.length} of ${baseline.steps.length} entries in ${BASELINE_PATH} carry a money flag the money rule at this commit does not give:`,
      ...stale.map((s) => `  ${s.step}: money ${s.flag} in the baseline, ${s.rule} by the rule`),
      `If this change meant to move the rule's inputs (journeys.json, slices.json, a package's dependency on the ledger client, a Rust crate), rewrite the flags: ${WRITE}`,
      'If it did not, undo the input change instead: a flag the baseline should not change is a sign the input moved by mistake.',
    );
  if (regression.length)
    lines.push(
      `BASELINE MONEY FAILED: ${regression.length} regression entr${regression.length === 1 ? 'y is a money step' : 'ies are money steps'} at this commit; a money step may be in the baseline only as unbuilt:`,
      ...regression.map((s) => `  ${s}`),
      `--write does not change a state: fix the step, or undo the input change that made it money.`,
    );
  return { ok: false, lines, stale };
}

function main() {
  const root = process.cwd();
  const r = check(root);
  if (process.argv.includes('--write') && r.stale?.length) {
    const file = join(root, BASELINE_PATH);
    writeFileSync(file, withRuleFlags(readFileSync(file, 'utf8'), r.stale));
    console.log(`baseline money: set ${r.stale.length} flag(s) to the money rule's value in ${BASELINE_PATH}`);
    const again = check(root);
    for (const l of again.lines) (again.ok ? console.log : console.error)(l);
    process.exit(again.ok ? 0 : 1);
  }
  for (const l of r.lines) (r.ok ? console.log : console.error)(l);
  process.exit(r.ok ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
