#!/usr/bin/env node
/**
 * JUDGE DOWN: what ci-review.yml does when a reviewer call fails for a reason that is not the change (reviewer-error.mjs
 * classify `down`), and when the judge is back (project-state OWNER 289 point 11: "A judge that stops shows as 'judge
 * down', with the one action it needs, never as red PRs. No PR merges without its judge."). (Failure it prevents: from
 * about 04:39 UTC on 10 Nov every review failed on the account's weekly limit, so every open PR showed a red check, and
 * each red woke a builder who could do nothing; project-state research/fable-blueprint-2026-11-10/changes/10-D-one-verdict.md.)
 *
 *   node tooling/ci/judge-down.mjs down "<source>" status   the `judge` status pending on the head
 *   node tooling/ci/judge-down.mjs down "<source>" issue    one project-state issue, none while one is open
 *   node tooling/ci/judge-down.mjs back "<source>" status   the `judge` status this source set, cleared
 *   node tooling/ci/judge-down.mjs back "CI review" issue   the issue closed; `closed=true` to GITHUB_OUTPUT when one was
 *   node tooling/ci/judge-down.mjs second|first "CI review" key
 *                                                          the "CI review on its second key" issue opened (once) when the
 *                                                          second key answered, closed when the first answers again
 *   node tooling/ci/judge-down.mjs back "CI review" catchup the heads left without a verdict re-run (the Start the seal
 *                                                            job, which alone holds actions: write; the review job can't
 *                                                            re-run a run, ci-review.test.mjs)
 *
 * The status is for people only, and posted from the proof read job, so the review job the seal reads holds no
 * statuses permission: the seal never reads a status (review-marker.mjs reads the job's steps), so a forged `judge`
 * status can neither pass nor block anything. Env: GH_TOKEN (this repository's statuses and runs), REPO, HEAD_SHA,
 * RUN_URL, and for `down` LINE, ACTION and SIGN_IN from reviewer-error.mjs --outputs and SIGN_IN_URL; for `issue`, ISSUE_TOKEN (the
 * App token, issues on project-state). Every failure warns: this runs only in steps that can't fail their job
 * (continue-on-error), and the seal waits whatever it does.
 */
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VERDICT_STEPS, reviewRan } from './review-marker.mjs';

export const CONTEXT = 'judge';
export const ISSUE_REPO = 'INTAFACED/project-state';
export const ISSUE_TITLE = 'Judge down: CI review';
export const LABEL = 'judge-down';
/** The one record that the reviewer runs on its second key (project-state#2180): an open issue with this title and label. */
export const KEY_ISSUE_TITLE = 'CI review on its second key';
export const KEY_LABEL = 'reviewer-key';
/** The most CI review runs one success re-runs: each re-run spends the App's and Actions' quota (and one review call). */
export const CATCH_UP_CAP = 10;
/** The most heads' jobs read to find them: one GET each. */
const JOBS_READ_CAP = 40;
/** For a sign-in: the reviewer account's sign-in page (`signInUrl`, ci-review.yml's SIGN_IN_URL, where the vendor may be named), then the key. */
const signInLines = (signInUrl) =>
  `Sign in: ${signInUrl || '(no SIGN_IN_URL set in ci-review.yml)'}. Then an agent makes a new key with the reviewer CLI's \`setup-token\` and sets it as the \`CLAUDE_CODE_OAUTH_TOKEN\` secret of the \`ci-review\` environment: https://github.com/INTAFACED/intafaced/settings/environments`;

/** The status description, at most GitHub's 140 characters. */
export const describe = (source, action) => `judge down: ${source}. One action: ${action}`.slice(0, 140);

/** Bali time (WITA, UTC+8) and UTC for the issue. */
export function times(now = new Date()) {
  const bali = new Date(now.getTime() + 8 * 3_600_000).toISOString().replace('T', ' ').slice(0, 16);
  return `${bali} Bali time (${now.toISOString().replace('T', ' ').slice(0, 16)} UTC)`;
}

/** The issue's body: the error line, the time, the one action, and for a sign-in the exact link (OWNER 203). */
export function issueBody({ source, line, action, signIn, signInUrl, runUrl, now = new Date() }) {
  return [
    `The judge is down: the ${source} reviewer call failed for a reason that is not the change, so no PR gets a verdict and none merges (OWNER 289 point 11). Open PRs show the pending \`judge\` status, not a red check.`,
    '',
    `- **Error:** \`${String(line).replace(/`/g, "'")}\``,
    `- **Since:** ${times(now)}, ${runUrl}`,
    `- **One action:** ${action}`,
    ...(signIn ? [`- ${signInLines(signInUrl)}`] : []),
    '',
    `Later down runs add nothing here. The first CI review whose reviewer call succeeds closes this and re-runs the CI review on the oldest ${CATCH_UP_CAP} open PR heads that have no verdict (tooling/ci/judge-down.mjs).`,
  ].join('\n');
}

/** Whether a CI review job has a verdict: a verdict step that concluded success or failure. */
export const hasVerdict = (job) =>
  (job?.steps ?? []).some((s) => VERDICT_STEPS.includes(s?.name) && ['success', 'failure'].includes(s?.conclusion));

/**
 * The CI review runs to re-run when the judge is back: for each open in-repo pull request into main (`pulls`), the
 * newest pull_request_target run on its head that actually reviewed (`runs`; `jobsOf(run)` gives its latest attempt's
 * jobs; a title or body edit's run, whose job is skipped, is passed over: review-marker.mjs reviewRan), when it has no
 * verdict; heads in the order their newest run was made, oldest first, at most `cap`. Heads whose newest run is still
 * going, heads with no run, and this run's own head are left. Returns { targets, left }: `left` counts heads past the cap
 * found without a verdict (heads not reached within JOBS_READ_CAP job reads are not counted).
 */
export async function catchUpTargets({ pulls, runs, jobsOf, repo, skipSha, cap = CATCH_UP_CAP }) {
  const byHead = new Map();
  for (const r of runs ?? []) {
    if (r?.event !== 'pull_request_target' || r?.path !== '.github/workflows/ci-review.yml') continue;
    byHead.set(r.head_sha, [...(byHead.get(r.head_sha) ?? []), r]);
  }
  for (const list of byHead.values()) list.sort((a, b) => b.id - a.id);
  const heads = (pulls ?? [])
    .filter((p) => p?.state === 'open' && p?.base?.ref === 'main' && p?.head?.repo?.full_name === repo && p?.head?.sha !== skipSha)
    .map((p) => ({ pull: p, runs: byHead.get(p.head.sha) ?? [] }))
    .filter((h) => h.runs[0]?.status === 'completed')
    .sort((a, b) => String(a.runs[0].created_at).localeCompare(String(b.runs[0].created_at)) || a.runs[0].id - b.runs[0].id);
  const targets = [];
  let left = 0;
  let reads = 0;
  for (const h of heads) {
    let found = null;
    for (const run of h.runs) {
      if (reads >= JOBS_READ_CAP || run.status !== 'completed') break;
      reads++;
      const job = (await jobsOf(run)).find(reviewRan);
      if (job) {
        found = { run, job };
        break;
      }
    }
    if (reads >= JOBS_READ_CAP && !found) break;
    if (!found || hasVerdict(found.job)) continue;
    if (targets.length < cap) targets.push({ pull: h.pull, run: found.run });
    else left++;
  }
  return { targets, left };
}

async function call(token, method, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  // A refusal or a limit stops this script: never retried here (AGENTS.md, GitHub and git).
  if ((res.status === 403 && !/already running/i.test(text)) || res.status === 429)
    throw new Error(`GitHub ${res.status} on ${method} ${path}: stopping, not retrying`);
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

const openIssues = async (token, label = LABEL, title = ISSUE_TITLE) => {
  const r = await call(token, 'GET', `/repos/${ISSUE_REPO}/issues?state=open&labels=${label}&per_page=100`);
  if (r.status !== 200) throw new Error(`could not list ${ISSUE_REPO}'s ${label} issues: HTTP ${r.status}`);
  return (r.json ?? []).filter((i) => !i.pull_request && i.title === title).sort((a, b) => a.number - b.number);
};

/** The second-key issue's body: the first key's error line and the one action, before the second key runs out too. */
export function keyIssueBody({ line, runUrl, now = new Date() }) {
  return [
    'The CI review runs on its second key, `CLAUDE_CODE_OAUTH_TOKEN_2`: its first key, `CLAUDE_CODE_OAUTH_TOKEN`, was refused or used up, so each reviewer call is asked again on the second. PRs still get their verdicts.',
    '',
    `- **First key's error:** \`${String(line || '(not given)').replace(/`/g, "'")}\``,
    `- **Since:** ${times(now)}, ${runUrl}`,
    "- **One action:** renew the first key before the second runs out too: an agent makes a new key with the reviewer CLI's `setup-token` and sets it as the `CLAUDE_CODE_OAUTH_TOKEN` secret of the `ci-review` environment (https://github.com/INTAFACED/intafaced/settings/environments), or waits for the reset the error names.",
    '',
    'The first CI review that answers on the first key again closes this (tooling/ci/judge-down.mjs).',
  ].join('\n');
}

/** Which key answered: `second` opens the one second-key issue (none while one is open), `first` closes it. */
async function keyIssue(which) {
  const { RUN_URL = '', LINE = '', ISSUE_TOKEN } = process.env;
  console.log(`reviewer key: ${which}${which === 'second' ? ' (CLAUDE_CODE_OAUTH_TOKEN_2); renew CLAUDE_CODE_OAUTH_TOKEN' : ''}`);
  if (!ISSUE_TOKEN) return console.log(`::warning::no project-state issues token, so no "${KEY_ISSUE_TITLE}" issue is read or written`);
  const open = await openIssues(ISSUE_TOKEN, KEY_LABEL, KEY_ISSUE_TITLE);
  if (which === 'first') {
    for (const i of open) {
      await call(ISSUE_TOKEN, 'POST', `/repos/${ISSUE_REPO}/issues/${i.number}/comments`, {
        body: `The first key answered again at ${times()} (${RUN_URL}).`,
      });
      const c = await call(ISSUE_TOKEN, 'PATCH', `/repos/${ISSUE_REPO}/issues/${i.number}`, { state: 'closed', state_reason: 'completed' });
      console.log(
        c.status === 200 ? `closed ${ISSUE_REPO}#${i.number}` : `::warning::${ISSUE_REPO}#${i.number} wasn't closed: HTTP ${c.status}`,
      );
    }
    return;
  }
  if (open.length) return console.log(`${ISSUE_REPO}#${open[0].number} is already open; nothing added`);
  const made = await call(ISSUE_TOKEN, 'POST', `/repos/${ISSUE_REPO}/issues`, {
    title: KEY_ISSUE_TITLE,
    labels: [KEY_LABEL],
    body: keyIssueBody({ line: LINE, runUrl: RUN_URL }),
  });
  console.log(
    made.status === 201
      ? `opened ${ISSUE_REPO}#${made.json.number}`
      : `::warning::the "${KEY_ISSUE_TITLE}" issue wasn't opened: HTTP ${made.status}`,
  );
}

async function downStatus(source) {
  const { GH_TOKEN, REPO, HEAD_SHA, RUN_URL = '', ACTION = '' } = process.env;
  const s = await call(GH_TOKEN, 'POST', `/repos/${REPO}/statuses/${HEAD_SHA}`, {
    state: 'pending',
    context: CONTEXT,
    description: describe(source, ACTION),
    target_url: RUN_URL || undefined,
  });
  console.log(s.status === 201 ? `posted: ${CONTEXT} pending` : `::warning::the ${CONTEXT} status wasn't posted: HTTP ${s.status}`);
}

async function downIssue(source) {
  const { RUN_URL = '', LINE = '', ACTION = '', SIGN_IN, SIGN_IN_URL = '', ISSUE_TOKEN } = process.env;
  if (!ISSUE_TOKEN) return console.log(`::warning::no project-state issues token, so no "${ISSUE_TITLE}" issue is read or opened`);
  const open = await openIssues(ISSUE_TOKEN);
  if (open.length) return console.log(`${ISSUE_REPO}#${open[0].number} is already open; nothing added`);
  const signIn = SIGN_IN === 'true';
  const made = await call(ISSUE_TOKEN, 'POST', `/repos/${ISSUE_REPO}/issues`, {
    title: ISSUE_TITLE,
    labels: [LABEL],
    body: issueBody({ source, line: LINE, action: ACTION, signIn, signInUrl: SIGN_IN_URL, runUrl: RUN_URL }),
  });
  if (made.status !== 201) return console.log(`::warning::the "${ISSUE_TITLE}" issue wasn't opened: HTTP ${made.status}`);
  console.log(`opened ${ISSUE_REPO}#${made.json.number}`);
  // Two runs that went down at once may both have opened one: the newer closes its own, so one stays.
  const all = await openIssues(ISSUE_TOKEN);
  if (all.length > 1 && all[0].number !== made.json.number) {
    await call(ISSUE_TOKEN, 'POST', `/repos/${ISSUE_REPO}/issues/${made.json.number}/comments`, {
      body: `Duplicate of #${all[0].number}, opened at the same time.`,
    });
    await call(ISSUE_TOKEN, 'PATCH', `/repos/${ISSUE_REPO}/issues/${made.json.number}`, { state: 'closed', state_reason: 'not_planned' });
    console.log(`closed ${ISSUE_REPO}#${made.json.number} as a duplicate of #${all[0].number}`);
  }
}

async function backStatus(source) {
  const { GH_TOKEN, REPO, HEAD_SHA, RUN_URL = '' } = process.env;
  // The newest `judge` status on the head is cleared only when this source set it.
  const st = await call(GH_TOKEN, 'GET', `/repos/${REPO}/commits/${HEAD_SHA}/statuses?per_page=100`);
  const latest = (st.json ?? []).find((x) => x?.context === CONTEXT);
  if (latest?.state === 'pending' && String(latest.description).startsWith(`judge down: ${source}.`)) {
    const s = await call(GH_TOKEN, 'POST', `/repos/${REPO}/statuses/${HEAD_SHA}`, {
      state: 'success',
      context: CONTEXT,
      description: `judge back: ${source}`,
      target_url: RUN_URL || undefined,
    });
    console.log(s.status === 201 ? `posted: ${CONTEXT} success` : `::warning::the ${CONTEXT} status wasn't cleared: HTTP ${s.status}`);
  }
}

async function backIssue(source) {
  const { RUN_URL = '', ISSUE_TOKEN, GITHUB_OUTPUT } = process.env;
  // Only the CI review's success catches up: the proof read's verdicts are not what the seal waits for.
  if (source !== 'CI review') return;
  if (!ISSUE_TOKEN) return console.log('::warning::no project-state issues token, so no judge-down issue is read or closed');
  const open = await openIssues(ISSUE_TOKEN);
  if (!open.length) return console.log('the judge is up and no judge-down issue is open');
  // Closed first, so a second success at the same time finds none and re-runs nothing.
  for (const i of open) {
    const c = await call(ISSUE_TOKEN, 'PATCH', `/repos/${ISSUE_REPO}/issues/${i.number}`, { state: 'closed', state_reason: 'completed' });
    if (c.status !== 200) return console.log(`::warning::${ISSUE_REPO}#${i.number} wasn't closed: HTTP ${c.status}; nothing re-run`);
  }
  const note = `The judge is back: the CI review's reviewer call succeeded at ${times()} (${RUN_URL}). This run's Start the seal job re-runs the CI review on the oldest ${CATCH_UP_CAP} open PR heads with no verdict, and lists them in its log.`;
  for (const i of open) await call(ISSUE_TOKEN, 'POST', `/repos/${ISSUE_REPO}/issues/${i.number}/comments`, { body: note });
  // The catch-up runs only after this run closed the issue, so a second success at the same time re-runs nothing.
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, 'closed=true\n');
  console.log(note);
}

async function backCatchUp(source) {
  const { GH_TOKEN, REPO, HEAD_SHA } = process.env;
  if (source !== 'CI review') return;
  const pulls = await call(GH_TOKEN, 'GET', `/repos/${REPO}/pulls?state=open&base=main&sort=created&direction=asc&per_page=100`);
  const runs = await call(GH_TOKEN, 'GET', `/repos/${REPO}/actions/workflows/ci-review.yml/runs?event=pull_request_target&per_page=100`);
  if (pulls.status !== 200 || runs.status !== 200) throw new Error(`could not list the open PRs or the review runs`);
  const { targets, left } = await catchUpTargets({
    pulls: pulls.json,
    runs: runs.json?.workflow_runs,
    repo: REPO,
    skipSha: HEAD_SHA,
    jobsOf: async (run) =>
      (await call(GH_TOKEN, 'GET', `/repos/${REPO}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).json?.jobs ?? [],
  });
  // A whole run re-run: its own Start the seal job starts that head's seal when the review ends.
  const done = [];
  for (const { pull, run } of targets) {
    const r = await call(GH_TOKEN, 'POST', `/repos/${REPO}/actions/runs/${run.id}/rerun`);
    done.push(`#${pull.number} (run ${run.id}: ${r.status === 201 ? 're-run' : `HTTP ${r.status}`})`);
  }
  console.log(
    [
      done.length
        ? `Re-ran the CI review on the oldest ${done.length} open PR heads with no verdict: ${done.join(', ')}.`
        : 'No open PR head was left without a verdict.',
      left ? `${left} more head(s) have no verdict past the cap of ${CATCH_UP_CAP}; each is reviewed on its next push.` : '',
    ]
      .filter(Boolean)
      .join(' '),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, source, part] = process.argv.slice(2);
  const run = {
    'down status': downStatus,
    'down issue': downIssue,
    'back status': backStatus,
    'back issue': backIssue,
    'back catchup': backCatchUp,
    'second key': () => keyIssue('second'),
    'first key': () => keyIssue('first'),
  }[`${cmd} ${part}`];
  if (!run || !source) {
    console.error('usage: judge-down.mjs down|back "<source>" status|issue|catchup, or second|first "<source>" key');
    process.exit(1);
  }
  // Exits 0 even when it fails: the Judge down step is the seal's marker (review-marker.mjs isJudgeDown reads that it
  // concluded success), so a refused issue call must not turn the marker into a failed step.
  run(source).catch((e) => console.log(`::warning::judge-down ${cmd} ${part}: ${e.message}`));
}
