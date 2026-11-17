#!/usr/bin/env node
/**
 * OPEN FLAKY — the one command an agent opens a flaky item with, so it never exists without its label (RULING 7,
 * project-state #2065: on 10 Nov 2026, 14 open "Flaky:" issues had no label and 12 carried `flaky-test` where a
 * builder's pick 1 reads `flaky`).
 *
 *   a journey step that failed, then passed, on the same commit   --step "J-x-01 #3"   -> labelled `flaky` (pick 1)
 *   a unit test that failed, then passed, on the same commit      --test <file>       -> labelled `flaky-test`, which is
 *                                                                                        no pick 1 label
 *
 * The label goes in `gh issue create --label`, the request that opens the issue, never a later edit. An open issue with
 * the same title is commented on instead of opening a second one. Main trust opens its own (main-trust.mjs for unit
 * tests, post-merge-trust.mjs for journey steps); this is for the ones an agent finds.
 *
 *   node tooling/ci/open-flaky.mjs --step "J-wallet-05 #2" [--step …] --sha <commit> --run <run url> \
 *     --title "<what fails, in plain words>" --body-file <file> [--dry-run]
 *   node tooling/ci/open-flaky.mjs --test services/svc-x/src/a.test.ts --sha <commit> --run <run url> \
 *     --title "<what fails>" --body-file <file> [--dry-run]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export const LABELS = { step: 'flaky', test: 'flaky-test' };
const STEP = /^J-[a-z0-9]+(?:-[a-z0-9]+)*-\d+ #\d+$/;
const TEST = /^(apps|services|packages|tooling)\/[\w./@-]+\.(test|spec)\.[cm]?[jt]sx?$/;
const SHA = /^[0-9a-f]{7,40}$/;
const RUN = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/;

/** Parse argv into the options; repeated --step and --test collect. Pure. */
export function parseArgs(argv) {
  const o = { steps: [], tests: [], dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--step') o.steps.push(argv[++i]);
    else if (a === '--test') o.tests.push(argv[++i]);
    else if (['--sha', '--run', '--title', '--body-file', '--repo'].includes(a))
      o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** The issue to open: title, label and body. Refuses anything that is not one kind of flaky item on one commit. Pure. */
export function flakyIssue({ steps = [], tests = [], sha, run, title, body }) {
  if (steps.length && tests.length) throw new Error('name journey steps or unit tests, not both: they take different labels');
  if (!steps.length && !tests.length) throw new Error('name the flaky journey step (--step "J-x-01 #3") or unit test (--test <file>)');
  for (const s of steps) if (!STEP.test(s ?? '')) throw new Error(`--step ${s} is not a journey step like "J-wallet-05 #2"`);
  for (const t of tests) if (!TEST.test(t ?? '') || t.includes('..')) throw new Error(`--test ${t} is not a repo-relative test file`);
  if (!SHA.test(sha ?? '')) throw new Error('--sha must be the commit it failed and then passed on');
  if (!RUN.test(run ?? '')) throw new Error('--run must be the GitHub Actions run URL that shows it');
  if (!title?.trim()) throw new Error('--title says what fails, in plain words');
  if (!body?.trim()) throw new Error('--body-file holds what failed and what you saw');
  const kind = steps.length ? 'step' : 'test';
  const what = kind === 'step' ? steps.join(', ') : tests.map((t) => `\`${t}\``).join(', ');
  const head = `Flaky: ${what}`;
  const fullTitle = title.startsWith('Flaky: ') ? title : `${head}: ${title.trim()}`;
  const why =
    kind === 'step'
      ? `${what} failed, then passed, on the same commit \`${sha.slice(0, 10)}\` ([run](${run})): a journey step's flaky item, labelled \`flaky\`.`
      : `${what} failed, then passed, on the same commit \`${sha.slice(0, 10)}\` ([run](${run})). It is a unit test, no journey step, so it carries \`flaky-test\` and no pick 1 label.`;
  return {
    title: fullTitle,
    label: LABELS[kind],
    body: `${why}\n\n${body.trim()}\n\n_Opened by tooling/ci/open-flaky.mjs._`,
  };
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const issue = flakyIssue({ ...o, body: o.bodyFile ? readFileSync(o.bodyFile, 'utf8') : '' });
  const repo = o.repo ? ['--repo', o.repo] : [];
  if (o.dryRun) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }
  const open = JSON.parse(
    gh(['issue', 'list', ...repo, '--state', 'open', '--search', `in:title "${issue.title}"`, '--json', 'number,title']),
  );
  const same = open.find((i) => i.title === issue.title);
  if (same) {
    gh(['issue', 'comment', String(same.number), ...repo, '--body', issue.body]);
    gh(['issue', 'edit', String(same.number), ...repo, '--add-label', issue.label]);
    console.log(`commented on #${same.number} (${issue.label})`);
    return;
  }
  console.log(gh(['issue', 'create', ...repo, '--title', issue.title, '--label', issue.label, '--body', issue.body]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.error(`✖ open-flaky: ${e.message}`);
    process.exit(1);
  }
}
