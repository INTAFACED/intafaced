#!/usr/bin/env node
/**
 * Merge-seal step: a pull request that changes money, security, gate-file or look-baseline paths is sealed only when
 * the `CI review` job (.github/workflows/ci-review.yml) passed its `Verdict` step on the pull request's exact head.
 *
 *   node tooling/ci/review-marker.mjs --self-test
 *   GH_TOKEN=... HEAD_SHA=... REPO=owner/name PR_NUMBER=... node tooling/ci/review-marker.mjs
 *
 * What counts (ciReviewVerdict), read from GitHub's Actions API, never from a comment or a status: a workflow run of
 * exactly REVIEW_WORKFLOW, started by `pull_request_target` (so GitHub ran the default branch's copy of the file and
 * of its brief, whatever the pull request changes), whose head is this exact sha, with a job named REVIEW_JOB whose
 * step VERDICT_STEP concluded success. A comment (`Independent review: PASS <sha>`, from any login, the shared one
 * included), a commit status of any name, a check run created through the API, a run of a branch's copy of the file
 * (event `pull_request` or `workflow_dispatch`) and a verdict on another head count for nothing. A FAIL stands for its
 * head and for every head with the same code: when any attempt of any such run on this head, or on any other head on
 * any branch whose commit has the same tree, failed its VERDICT_STEP, nothing else counts. So re-running the
 * job, reopening the pull request or pushing an empty or message-only commit can't ask again until it passes; a head
 * that changes the code is reviewed afresh. (Failure it prevents: #7078 merged 12 minutes before its review, OWNER 154
 * (a); and a PASS comment from the one login every agent shares said nothing about who reviewed.)
 *
 * The seal waits up to REVIEW_WAIT_MS for the review before it fails, and the review job re-runs a red seal on its head
 * once it passes (ci-review.mjs), so nobody re-runs it by hand. Same requirement, later verdict: a head without the
 * review still fails.
 *
 * Only money, security, gate-file and look-baseline changes need it (owner decisions 2026-10-22 and, for baselines,
 * 2026-10-26). Every other pull request is sealed on its checks alone. On a merge queue's commit (`merge_group`) the
 * same rule is applied to every pull request in the group, each against its own head, without waiting (sealMergeGroup).
 * The seal runs the default branch's copy of this file, so a pull request cannot change which of its files need the
 * review. A pull request that edits the workflow itself touches .github/, which always needs the review.
 *
 * The comment and session helpers below (MARKER, sessionsForHead, commentSignoff, ...) stay exported for
 * review-signoff.mjs, which still runs until its retirement PR; nothing in the seal reads them any more.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gateFilesTouched } from '../scripts/gate-file-guard.mjs';
import { BASELINE } from './look-baselines.mjs';

/** How long the seal waits for the review before it fails, and how often it looks. ci.yml's merge-seal timeout covers it. */
const REVIEW_WAIT_MS = 20 * 60_000;
const REVIEW_POLL_MS = 60_000; // each poll reads the head's and the branch's lists, the tree index and its review runs

/** The comment line the sign-off workflow accepts, on its own line. */
export const MARKER = /^Independent review: PASS ([0-9a-f]{40})[ \t]*$/im;

export const STATUS_CONTEXT = 'Independent review';

const SESSION_ID = /session_[A-Za-z0-9]+/g;
/**
 * A commit's session trailer, the `<Tool>-Session: <link>` line AGENTS.md item 8 names. Any word before `-Session:`
 * counts, so a renamed trailer still names its author (more author sessions, never fewer).
 */
const SESSION_TRAILER = /^[A-Za-z]+-Session:/i;

/** The sessions that wrote a pull request: every session id on a session-trailer line of its commit messages. */
export function commitSessions(messages) {
  const out = new Set();
  for (const msg of messages ?? []) {
    for (const line of String(msg ?? '').split('\n')) {
      if (SESSION_TRAILER.test(line.trim())) for (const id of line.match(SESSION_ID) ?? []) out.add(id);
    }
  }
  return out;
}

/**
 * The author sessions of head `sha`, from the pull request's commit list (GitHub's /pulls/{n}/commits: at most 250,
 * ordered by date, not by parent). Null when the list may not be whole for this head: the head is not in it (a push
 * in between) or GitHub's cap of 250 was reached. One rule for the seal and the sign-off workflow.
 */
export function sessionsForHead(commits, sha) {
  const list = commits ?? [];
  const want = String(sha).toLowerCase();
  if (list.length >= 250 || !list.some((c) => String(c?.sha ?? '').toLowerCase() === want)) return null;
  return commitSessions(list.map((c) => c?.commit?.message));
}

/** A `Reviewer session:` line whose first word is the session, bare or as a link (docs/agents/reviewer-brief.md). */
const REVIEWER_LINE = /^Reviewer session:\s*<?(?:https?:\/\/[^\s>]*\/)?(session_[A-Za-z0-9]+)\b/i;

/**
 * The sessions a PASS names as its reviewer: the session written first on each `Reviewer session:` line. The rest of
 * the line may name the author ("Reviewer session: session_R (author is session_A)") without making it the author's
 * PASS. A comment with no such line counts every session id in it, so any other phrasing errs towards refusing.
 */
export function passSessions(body) {
  const lines = String(body ?? '').split('\n');
  const named = lines.map((l) => REVIEWER_LINE.exec(l.trim())?.[1]).filter(Boolean);
  return new Set(named.length > 0 ? named : lines.flatMap((l) => l.match(SESSION_ID) ?? []));
}

/** The sessions a PASS names on its `Reviewer session:` lines, and only those. */
export function reviewerLineSessions(body) {
  return String(body ?? '')
    .split('\n')
    .map((l) => REVIEWER_LINE.exec(l.trim())?.[1])
    .filter(Boolean);
}

/**
 * Why a PASS does not count for the session it names, or null when it does. A PASS must name its reviewing session on
 * a line of its own, `Reviewer session: session_…` (AGENTS.md item 8; a gate since OWNER 138 (1)(a), 31 Oct): without
 * one, nothing shows another session reviewed. A PASS that names the PR's own session does not count either (owner
 * decision 2026-10-30, OWNER 124 (4)): a session on one of the PR's session-trailer commit lines. `authorSessions` is
 * that Set, or null when the commits could not be read whole; then no PASS counts.
 */
export function sessionRefusal(body, authorSessions) {
  if (reviewerLineSessions(body).length === 0)
    return 'it names no reviewing session; add a line of its own `Reviewer session: session_…` (AGENTS.md item 8)';
  if (!(authorSessions instanceof Set)) return "the pull request's commits could not be read whole, so its sessions are unknown";
  for (const id of passSessions(body)) {
    if (authorSessions.has(id)) return `it names the pull request's own session (${id}); another session must review`;
  }
  return null;
}

/** True when the newest status of the review context on this head is a success. */
export function hasSignoff(statuses) {
  const mine = statuses.filter((s) => s?.context === STATUS_CONTEXT);
  return mine.length > 0 && mine[0].state === 'success'; // the API lists newest first
}

/**
 * A PASS marker for exactly this head by a listed reviewer (the session rule is separate: sessionRefusal). `reviewers`
 * are lower-case logins from the default branch's reviewers.json, `author` is the pull request author's login.
 */
export function markerFits(c, { sha, reviewers, requireDistinctFromAuthor, author }) {
  const login = String(c?.user?.login ?? '').toLowerCase();
  const m = MARKER.exec(c?.body ?? '');
  if (!m || m[1].toLowerCase() !== String(sha).toLowerCase() || !reviewers.includes(login)) return false;
  return !(requireDistinctFromAuthor && login === String(author ?? '').toLowerCase());
}

/**
 * Does a PASS comment sign off this head? `comments` are issue comments; `authorSessions` the sessions on the PR's
 * session-trailer commit lines, or null (unknown: nothing counts). Returns { ok, refused }, where `refused` lists the
 * fitting PASSes the session rule turned down, with why.
 */
export function commentSignoff({ comments, authorSessions = null, ...who }) {
  const refused = [];
  for (const c of (comments ?? []).filter((x) => markerFits(x, who))) {
    const reason = sessionRefusal(c.body, authorSessions);
    if (!reason) return { ok: true, refused };
    refused.push({ id: c.id, reason });
  }
  return { ok: false, refused };
}

export const hasCommentSignoff = (args) => commentSignoff(args).ok;

/** The one workflow, job and step whose result seals a head (AGENTS.md item 8). */
export const REVIEW_WORKFLOW = '.github/workflows/ci-review.yml';
export const REVIEW_JOB = 'CI review';
export const VERDICT_STEP = 'Verdict';
/** The only base a review counts for: a review of a pull request into another branch reviewed another diff. */
export const REVIEW_BASE = 'main';
const SHA40 = /^[0-9a-f]{40}$/;
/**
 * The tree index: every CI review run uploads an artifact named REVIEW_INDEX_PREFIX + its head's tree sha, before it
 * reviews (ci-review.yml "Index this head's tree"). The seal finds the runs on other heads with its head's tree by that
 * name, one keyed read, instead of listing every run of the workflow (a list GitHub cuts at 1,000).
 */
export const REVIEW_INDEX_PREFIX = 'ci-review-tree-';
export const reviewIndexName = (tree) => `${REVIEW_INDEX_PREFIX}${tree}`;
/**
 * Runs from before the index went live have no index artifact, so the seal reads them as a window: every
 * pull_request_target run of REVIEW_WORKFLOW created before INDEX_MARGIN_MS after INDEX_PR merged (readIndexLive). The
 * time is GitHub's record of the merge (`merged_at`), which no author can set; a run made after it used the default
 * branch's copy with the index step, which indexes its head before any verdict (ci-review.test.mjs holds that step
 * unconditional and before the review), so no run falls between the window and the index. If INDEX_PR isn't merged
 * into REVIEW_BASE, the seal fails closed. The window's start is the workflow's own `created_at` on GitHub. It is read
 * in time slices when it holds more than GitHub lists for one filter, so it can never lock the seal, and it is read
 * again on every poll, so a re-run of a run in it is seen.
 * If this change is ever reverted and landed again, the new pull request sets INDEX_PR to its own number.
 */
export const INDEX_PR = 7146;
/** Overlap after the merge: a run started by an event just before it may be created a little later. */
export const INDEX_MARGIN_MS = 6 * 60 * 60_000;

/**
 * The CI review's verdict on head `sha`, from GitHub's Actions API. `runs` are the workflow runs listed for
 * REVIEW_WORKFLOW at this head; `attempts(run)` gives, for one run, the jobs of each of its attempts (arrays of
 * GitHub's job objects with `steps`). `runs` may also hold runs on other heads (any branch), and `tree(sha)`
 * gives a commit's tree sha (one GET per head): a FAIL on another head with the same tree stands here too, so an empty
 * commit can't ask again. Pure apart from `attempts` and `tree`, so the self-test and ci-review.test.mjs run offline.
 * `base` is the pull request's base now: anything but REVIEW_BASE is no verdict. A passing run counts only when its
 * `pull_requests` names a pull request into REVIEW_BASE (`number`, when given, must be this one): a PASS reviewed
 * against a side branch saw only the diff from that branch, so retargeting the pull request to main can't carry it.
 * A FAIL stands whatever its base.
 * Returns { ok, state, why }: state is `pass`, `fail` (a FAIL verdict stands for this head), `pending` or `none`.
 */
export async function ciReviewVerdict({ sha, runs, attempts, tree, base, number }) {
  const want = String(sha ?? '').toLowerCase();
  if (!SHA40.test(want)) return { ok: false, state: 'none', why: `"${sha}" is not a full head sha` };
  if (base !== REVIEW_BASE)
    return {
      ok: false,
      state: 'none',
      why: `the pull request's base is ${base ?? 'unknown'}, not ${REVIEW_BASE}: only a pull request into ${REVIEW_BASE} is sealed`,
    };
  const intoMain = (r) =>
    (r?.pull_requests ?? []).some((p) => p?.base?.ref === REVIEW_BASE && (number == null || Number(p?.number) === Number(number)));
  const headOf = (r) => String(r?.head_sha ?? '').toLowerCase();
  const ours = (runs ?? []).filter((r) => r?.path === REVIEW_WORKFLOW && r?.event === 'pull_request_target');
  const own = ours.filter((r) => headOf(r) === want);
  const others = ours.filter((r) => SHA40.test(headOf(r)) && headOf(r) !== want);
  // A FAIL on another head with the same code (the same tree) stands for this head too. Fails closed: without a tree
  // reader, runs on other heads are no verdict, never ignored.
  if (others.length > 0) {
    if (typeof tree !== 'function')
      return {
        ok: false,
        state: 'none',
        why: `${others.length} CI review run(s) on other heads, and no tree reader to tell whether they reviewed the same code`,
      };
    const mine = await tree(want);
    for (const run of others) {
      const theirs = headOf(run);
      const listed = String(run?.head_commit?.tree_id ?? '').toLowerCase();
      if (!mine || (SHA40.test(listed) ? listed : await tree(theirs)) !== mine) continue;
      for (const [i, jobs] of (await attempts(run)).entries()) {
        for (const job of (jobs ?? []).filter((j) => j?.name === REVIEW_JOB)) {
          if (String(job.head_sha ?? theirs).toLowerCase() !== theirs) continue;
          if ((job.steps ?? []).find((s) => s?.name === VERDICT_STEP)?.conclusion === 'failure')
            return {
              ok: false,
              state: 'fail',
              why: `run ${run.id} attempt ${i + 1}: the CI review found blocking findings on ${theirs}, which has the same tree (${mine}) as ${want}; a FAIL stands for the same code, so push a fix that changes it`,
            };
        }
      }
    }
  }
  const ignored = (runs ?? []).length - own.length;
  if (own.length === 0)
    return {
      ok: false,
      state: 'none',
      why: `no ${REVIEW_WORKFLOW} run started by pull_request_target on ${want}${ignored ? ` (${ignored} other run(s) ignored)` : ''}`,
    };
  let passedIn = null;
  let pending = false;
  for (const run of own) {
    for (const [i, jobs] of (await attempts(run)).entries()) {
      for (const job of (jobs ?? []).filter((j) => j?.name === REVIEW_JOB)) {
        if (String(job.head_sha ?? want).toLowerCase() !== want) continue;
        const step = (job.steps ?? []).find((s) => s?.name === VERDICT_STEP);
        if (step?.conclusion === 'failure')
          return {
            ok: false,
            state: 'fail',
            why: `run ${run.id} attempt ${i + 1}: the CI review found blocking findings on ${want}; a FAIL stands for its head, so push a fix`,
          };
        if (!intoMain(run)) continue; // reviewed against another base: neither a pass nor pending here
        if (job.status !== 'completed') pending = true;
        else if (job.conclusion === 'success' && step?.conclusion === 'success') passedIn ??= `run ${run.id} attempt ${i + 1}`;
      }
    }
  }
  if (passedIn) return { ok: true, state: 'pass', why: `CI review passed on ${want} (${passedIn})` };
  return pending
    ? { ok: false, state: 'pending', why: `the CI review on ${want} is still running` }
    : {
        ok: false,
        state: 'none',
        why: `no CI review on ${want} passed its ${VERDICT_STEP} step (it did not finish, or failed before a verdict; re-run it)`,
      };
}

/**
 * Security code by path: the services AGENTS.md names, ledger-client and auth, config (freeze authority, sanctions
 * screening, the money kill switch, production posture) and db (columns, migrations), the workflows, what changes the
 * dependency tree or the registry, the images and compose files, the shared compiler settings and the infra config.
 */
export const SECURITY_PATHS = [
  /^services\/svc-(edge|ops|protocol|fix)\//,
  /^packages\/(ledger-client|auth|config|db)\//,
  /^\.github\//,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)Dockerfile[^/]*$/,
  /(^|\/)\.dockerignore$/,
  /(^|\/)docker-compose[^/]*\.ya?ml$/,
  /^tsconfig\.base\.json$/,
  /^tooling\/infra\//,
];

const LEDGER_CLIENT = '@intafaced/ledger-client';

/**
 * The folder a file's money check reads package.json from (`services/svc-pay`, `tooling/pay-sim`), or null for a file
 * at the top of the repo or of tooling/. A tooling folder with no package.json (tooling/scripts runs the local stack
 * and its ledger recipes) fails closed in reviewReason.
 */
export function packageRootOf(file) {
  const m = /^(apps|services|packages|tooling)\/([^/]+)\//.exec(file);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function dependsOnLedgerClient(manifest) {
  return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
    (k) => manifest?.[k] && Object.hasOwn(manifest[k], LEDGER_CLIENT),
  );
}

/**
 * Why this change needs the independent review, or null when it does not. Money code is ledger-client and every
 * package that depends on it directly, on the default branch or on the head. `manifests` maps a package root to the
 * package.json objects read for it; a root with none counts as money (fail closed), and so does an empty file list.
 */
export function reviewReason(files, manifests) {
  if (files.length === 0) return 'no changed files could be read for this head';
  const security = files.find((f) => SECURITY_PATHS.some((re) => re.test(f)));
  if (security) return `security: ${security}`;
  const gate = gateFilesTouched(files);
  if (gate.length > 0) return `gate file: ${gate[0].file}`;
  const baseline = files.find((f) => BASELINE.test(f));
  if (baseline) return `look baseline: ${baseline}`;
  for (const root of new Set(files.map(packageRootOf).filter(Boolean))) {
    const found = manifests.get(root) ?? [];
    if (found.length === 0) return `money: no package.json could be read for ${root}`;
    if (found.some(dependsOnLedgerClient)) return `money: ${root} depends on ${LEDGER_CLIENT}`;
  }
  return null;
}

/** The pull request GitHub's squash merge appends to a commit's first line, `<title> (#123)`, or null. */
export function squashPrNumber(message) {
  const m = /\(#(\d+)\)\s*$/.exec(String(message ?? '').split('\n')[0]);
  return m ? Number(m[1]) : null;
}

/** The pull request a merge queue branch names (`refs/heads/gh-readonly-queue/main/pr-123-<base sha>`), or null. */
export function queueRefPr(ref) {
  const m = /(?:^|\/)gh-readonly-queue\/.+\/pr-(\d+)-[0-9a-f]{40}$/.exec(String(ref ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * The pull requests in a merge group, oldest first: the queue squashes each one into one commit between the group's base
 * and its head (the repository allows squash merges only). Null when the group cannot be read whole: a commit names no
 * pull request (another merge method), a number repeats, the list is empty or at GitHub's compare cap of 250, or the
 * queue's own branch does not name the last one (the group's head). The seal then fails closed and the queue drops the group.
 */
export function groupPulls(commits, headRef) {
  const list = commits ?? [];
  if (list.length === 0 || list.length >= 250) return null;
  const numbers = list.map((c) => squashPrNumber(c?.commit?.message));
  if (numbers.some((n) => n === null) || new Set(numbers).size !== numbers.length) return null;
  const named = queueRefPr(headRef);
  if (named === null || numbers.at(-1) !== named) return null;
  return numbers;
}

/**
 * One look for the review of a pull request's head, the same for its own seal and for the merge queue's: the CI
 * review's verdict on that exact head (ciReviewVerdict). `io.reviewRuns(sha, branch)` lists REVIEW_WORKFLOW's runs at
 * the head and on the pull request's branch, `io.attempts(run)` the jobs of each attempt, `io.tree(sha)` a commit's tree.
 * Returns { ok, state, why }.
 */
export async function lookForSignoff({ sha, io, branch, base, number }) {
  return ciReviewVerdict({
    sha,
    base,
    number,
    runs: await io.reviewRuns(sha, branch),
    attempts: (run) => io.attempts(run),
    tree: io.tree && ((s) => io.tree(s)),
  });
}

/**
 * The seal on a merge queue's commit (`merge_group`). The commit is new, so no review ran on it; what was
 * reviewed is each queued pull request's own head. Every pull request in the group is held to the rule its own seal
 * applied (reviewReason): one that needs the independent review must carry a passing CI review for its current head,
 * or the group fails. Nothing waits: the queue only takes a pull request whose required
 * checks passed (the seal included), so a missing review here means something changed, and waiting would stall the
 * queue. `io` reads GitHub (injected so the self-test runs offline); `dryRun` also reads pull requests already closed.
 * Returns { ok, lines }.
 */
export async function sealMergeGroup({ commits, headRef, io, dryRun = false }) {
  const lines = [];
  const numbers = groupPulls(commits, headRef);
  if (!numbers) {
    const firsts = (commits ?? []).map((c) => String(c?.commit?.message ?? '').split('\n')[0]);
    return {
      ok: false,
      lines: [
        `the merge group could not be read whole (queue branch ${headRef}; commits: ${JSON.stringify(firsts).slice(0, 600)}); every commit must be one squashed pull request "<title> (#N)"`,
      ],
    };
  }
  let ok = true;
  for (const n of numbers) {
    const pull = await io.pull(n);
    const sha = String(pull?.head?.sha ?? '');
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      ok = false;
      lines.push(`#${n}: its head could not be read`);
      continue;
    }
    if (pull.state !== 'open' && !dryRun) {
      ok = false;
      lines.push(`#${n}: is ${pull.state}, not a queued pull request`);
      continue;
    }
    const files = await io.files(n, sha);
    // The manifests on main, on the pull request's head and on the group's head: a package another pull request in the
    // group makes depend on ledger-client is money code for this one too.
    const reason = reviewReason(files, await io.manifests(files, sha));
    if (reason === null) {
      lines.push(`#${n} (${sha}): independent review not required`);
      continue;
    }
    const verdict = await lookForSignoff({ sha, io, branch: pull?.head?.ref, base: pull?.base?.ref, number: n });
    if (verdict.ok) {
      lines.push(`#${n} (${sha}): ${reason}; ${verdict.why}`);
      continue;
    }
    ok = false;
    lines.push(`#${n} (${sha}): ${reason}; no passing CI review for this head (${verdict.why})`);
  }
  return { ok, lines };
}

async function selfTest() {
  const ok = { context: STATUS_CONTEXT, state: 'success' };
  const cases = [
    [[ok], true],
    [[], false],
    [[{ context: 'other', state: 'success' }], false],
    [[{ context: STATUS_CONTEXT, state: 'failure' }, ok], false],
    [[{ context: STATUS_CONTEXT, state: 'pending' }], false],
    [[ok, { context: STATUS_CONTEXT, state: 'failure' }], true],
  ];
  for (const [statuses, want] of cases) {
    if (hasSignoff(statuses) !== want) {
      console.error('review-marker self-test failed for', JSON.stringify(statuses));
      process.exit(1);
    }
  }
  const sha = 'a'.repeat(40);
  const markers = [
    [`Independent review: PASS ${sha}`, true],
    [`notes\nIndependent review: PASS ${sha}\nmore`, true],
    [`Independent review: PASS ${sha} but not really`, false],
    [`Independent review: FAIL ${sha}`, false],
    [`Independent review: PASS for head ${sha}`, false],
    ['Independent review: PASS aaaaaaaaa', false],
    [`Independent review: PASS ${sha.toUpperCase()}`, true],
  ];
  for (const [body, want] of markers) {
    if (MARKER.test(body) !== want) {
      console.error('review-marker self-test failed for', JSON.stringify(body));
      process.exit(1);
    }
  }
  const reviewers = ['nino'];
  const pass = (login, body) => ({ user: { login }, body });
  const input = (comments, extra = {}) => ({
    comments,
    sha,
    reviewers,
    requireDistinctFromAuthor: false,
    author: 'nino',
    authorSessions: new Set(),
    ...extra,
  });
  const commentCases = [
    [input([pass('Nino', `Independent review: PASS ${sha}\nReviewer session: session_R9`)]), true],
    // OWNER 138 (1)(a), 31 Oct: a PASS that names no reviewing session on its own line never counts.
    [input([pass('Nino', `Independent review: PASS ${sha}`)]), false],
    [input([pass('Nino', `Independent review: PASS ${sha}\nreviewed in session_R9`)]), false],
    [input([pass('eve', `Independent review: PASS ${sha}`)]), false],
    [input([pass('nino', `Independent review: PASS ${'b'.repeat(40)}`)]), false],
    [input([pass('nino', `Independent review: PASS ${sha} but not really`)]), false],
    [input([]), false],
    // The author's own login never counts when the PR asks for a distinct reviewer, even with a session named.
    [input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: session_R9`)], { requireDistinctFromAuthor: true }), false],
    [input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: session_R9`)], { requireDistinctFromAuthor: false }), true],
    [input([pass('nino', `x\nIndependent review: PASS ${sha}\nReviewer session: s`)]), false],
    [input([pass('nino', `x\nIndependent review: PASS ${sha}\nReviewer session: session_R9`)]), true],
    [
      input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: https://example.test/code/session_R1`)], {
        authorSessions: new Set(['session_A1']),
      }),
      true,
    ],
    [
      input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: https://example.test/code/session_A1`)], {
        authorSessions: new Set(['session_A1']),
      }),
      false,
    ],
    [input([pass('nino', `Independent review: PASS ${sha}\nsession_A1 (review)`)], { authorSessions: new Set(['session_A1']) }), false],
    [
      input([pass('nino', `Asked by session_A1.\nIndependent review: PASS ${sha}\nReviewer session: session_R1`)], {
        authorSessions: new Set(['session_A1']),
      }),
      true,
    ],
    [input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: session_R1`)], { authorSessions: null }), false],
    [
      input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: this thread\nRan in session_A1`)], {
        authorSessions: new Set(['session_A1']),
      }),
      false,
    ],
    [input([pass('nino', `Independent review: PASS ${sha}`)], { authorSessions: undefined }), false],
    // #6849, 30 Oct: the reviewer's line also named the author; it is the reviewer's PASS.
    [
      input(
        [pass('nino', `Independent review: PASS ${sha}\n\nReviewer session: session_R2 (INTAFACED R2 review; author is G, session_A1)`)],
        { authorSessions: new Set(['session_A1']) },
      ),
      true,
    ],
    [
      input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: session_A1 (and session_R2)`)], {
        authorSessions: new Set(['session_A1']),
      }),
      false,
    ],
    [
      input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: reviewing session_R1's notes, ran in session_A1`)], {
        authorSessions: new Set(['session_A1']),
      }),
      false,
    ],
    [
      input(
        [pass('nino', `Independent review: PASS ${sha}\nReviewer session: <https://example.test/code/session_R2> (author session_A1)`)],
        {
          authorSessions: new Set(['session_A1']),
        },
      ),
      true,
    ],
  ];
  for (const [args, want] of commentCases) {
    if (hasCommentSignoff(args) !== want) {
      console.error('review-marker comment self-test failed for', JSON.stringify(args));
      process.exit(1);
    }
  }
  const cm = (sha, message) => ({ sha, commit: { message } });
  const listed = [cm('h', 'b\nAgent-Session: session_A1'), cm('o', 'older but dated later')];
  if (
    sessionsForHead(listed, 'h')?.has('session_A1') !== true ||
    sessionsForHead(listed, 'x') !== null ||
    sessionsForHead(
      Array.from({ length: 250 }, (_, i) => cm(i === 0 ? 'h' : `c${i}`, '')),
      'h',
    ) !== null ||
    !commentSignoff(
      input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: session_A1`)], { authorSessions: new Set(['session_A1']) }),
    ).refused[0]?.reason.includes('session_A1')
  ) {
    console.error('review-marker sessionsForHead / refusal self-test failed');
    process.exit(1);
  }
  const msgs = [
    'feat: x\n\nCo-Authored-By: an agent\nAgent-Session: https://example.test/code/session_A1',
    'fix: y',
    'z\ntool-session: session_B2 ',
  ];
  const got = [...commitSessions(msgs)].sort().join(',');
  if (got !== 'session_A1,session_B2' || commitSessions(['see session_C3 in the body']).size !== 0) {
    console.error('review-marker commit-session self-test failed:', got);
    process.exit(1);
  }
  const money = { dependencies: { [LEDGER_CLIENT]: 'workspace:*' } };
  const plain = { dependencies: { react: '19' } };
  const manifests = new Map([
    ['services/svc-pay', [money]],
    ['services/svc-support', [plain]],
    ['apps/admin', [plain, money]],
    ['services/svc-new', []],
    ['tooling/pay-sim', [money]],
    ['apps/customer', [plain]],
    ['packages/ui', [plain]],
  ]);
  const reasonCases = [
    [['docs/x.md'], false],
    [['services/svc-support/src/a.ts', 'docs/x.md'], false],
    [['services/svc-pay/src/a.ts'], true],
    [['apps/admin/src/a.tsx'], true], // depends on the head or on the default branch
    [['services/svc-edge/src/a.ts'], true],
    [['packages/ledger-client/src/a.ts'], true],
    [['packages/config/src/freeze-authority.ts'], true],
    [['packages/db/src/migrate.ts'], true],
    [['.github/CODEOWNERS'], true],
    [['pnpm-lock.yaml'], true],
    [['tooling/ci/dependency-audit.mjs'], true],
    [['AGENTS.md'], true],
    [['services/svc-support/CLAUDE.md'], true],
    [['services/svc-new/src/a.ts'], true],
    [['services/svc-unread/src/a.ts'], true],
    [['tooling/scripts/local-test-gates.mjs'], true],
    [['tooling/pay-sim/src/cli.ts'], true],
    [['tooling/coverage.yaml'], false],
    [['.npmrc'], true],
    [['apps/customer/Dockerfile'], true],
    [['docker-compose.apps.yml'], true],
    [['tsconfig.base.json'], true],
    [['apps/customer/look-baselines/home/390x844.png'], true],
    [['packages/ui/look-baselines/kit-buttons/phone/a.png'], true],
    [['apps/customer/src/assets/logo.png'], false],
    [['apps/customer/src/screens/home/index.tsx'], false],
    [[], true],
  ];
  for (const [files, want] of reasonCases) {
    if ((reviewReason(files, manifests) !== null) !== want) {
      console.error('review-marker review-reason self-test failed for', JSON.stringify(files));
      process.exit(1);
    }
  }
  await mergeGroupSelfTest(reviewers, manifests);
  console.log('review-marker self-test ok');
}

/** A `CI review` job object as GitHub's jobs API returns it, with its Verdict step's conclusion. */
export function reviewJob(sha, verdict = 'success', { status = 'completed' } = {}) {
  const done = status === 'completed';
  return {
    name: REVIEW_JOB,
    head_sha: sha,
    status,
    conclusion: done ? (verdict === 'success' ? 'success' : 'failure') : null,
    steps: [
      { name: 'Review', status, conclusion: done ? 'success' : null },
      { name: VERDICT_STEP, status, conclusion: done ? verdict : null },
    ],
  };
}

/** The merge queue seal, offline: a fake GitHub per case. */
async function mergeGroupSelfTest(reviewers, manifests) {
  const fail = (what) => {
    console.error('review-marker merge-group self-test failed:', what);
    process.exit(1);
  };
  const base = 'b'.repeat(40);
  const ref = (n) => `refs/heads/gh-readonly-queue/main/pr-${n}-${base}`;
  const sq = (title, n) => ({ commit: { message: `${title} (#${n})\n\nbody (#9)` } });
  if (squashPrNumber('test(customer): J-cex-spot-01 #8 (#7108) (#7109)') !== 7109) fail('the last (#N) is the squash');
  if (squashPrNumber('Merge pull request #5 from x/y') !== null) fail('a merge commit names no squash');
  if (queueRefPr(ref(12)) !== 12 || queueRefPr('refs/heads/main') !== null) fail('queue ref');
  if (queueRefPr(`refs/heads/gh-readonly-queue/release/2.0/pr-7-${base}`) !== 7) fail('a base branch with a slash');
  if (JSON.stringify(groupPulls([sq('a', 1), sq('b', 2)], ref(2))) !== '[1,2]') fail('a group of two');
  if (groupPulls([sq('a', 1), { commit: { message: 'no number' } }], ref(1)) !== null) fail('an unnamed commit');
  if (groupPulls([sq('a', 1), sq('b', 1)], ref(1)) !== null) fail('a repeated number');
  if (groupPulls([sq('a', 1)], ref(3)) !== null) fail('the queue ref names a pull request the commits do not');
  if (groupPulls([sq('a', 1), sq('b', 2)], ref(1)) !== null) fail('the queue ref names the group head, the last commit');
  if (groupPulls([], ref(1)) !== null) fail('an empty group');

  const shaOf = (n) => String(n).padStart(40, 'c');
  const reviewed = (n, verdict = 'success', base = REVIEW_BASE) => [
    {
      id: 900 + n,
      path: REVIEW_WORKFLOW,
      event: 'pull_request_target',
      head_sha: shaOf(n),
      pull_requests: [{ number: n, base: { ref: base } }],
      jobs: [[reviewJob(shaOf(n), verdict)]],
    },
  ];
  // 1: docs only. 2: money (svc-pay), CI review passed. 3: security (.github), CI review passed.
  // 4: money with no review. 5: money with only a PASS comment and an `Independent review` status from the shared
  // login. 6: closed. 7: money whose CI review said FAIL.
  const world = {
    1: { files: ['docs/x.md'] },
    2: { files: ['services/svc-pay/src/a.ts'], runs: reviewed(2) },
    3: { files: ['.github/workflows/ci.yml'], runs: reviewed(3) },
    4: { files: ['services/svc-pay/src/a.ts'] },
    5: {
      files: ['services/svc-pay/src/a.ts'],
      comments: [{ user: { login: reviewers[0] }, body: `Independent review: PASS ${shaOf(5)}\nReviewer session: session_R1` }],
      statuses: [{ context: STATUS_CONTEXT, state: 'success' }],
    },
    6: { files: ['docs/x.md'], state: 'closed' },
    7: { files: ['services/svc-pay/src/a.ts'], runs: reviewed(7, 'failure') },
    8: { files: ['services/svc-pay/src/a.ts'], runs: reviewed(8, 'success', 'side/b') },
  };
  const io = {
    pull: async (n) => ({
      state: world[n].state ?? 'open',
      head: { sha: shaOf(n) },
      base: { ref: REVIEW_BASE },
      user: { login: 'author' },
    }),
    files: async (n) => world[n].files,
    manifests: async () => manifests,
    reviewRuns: async (sha) => world[Number(sha.replace(/^c+/, ''))].runs ?? [],
    attempts: async (run) => run.jobs,
  };
  const group = async (numbers, opts = {}) =>
    sealMergeGroup({ commits: numbers.map((n) => sq(`t${n}`, n)), headRef: ref(numbers.at(-1)), io, ...opts });
  const cases = [
    [[1, 2, 3], true, 'docs, a reviewed money PR and a reviewed security PR'],
    [[1, 4], false, 'a money PR with no review never merges through the queue'],
    [[4, 1], false, 'nor when it is not the last in the group'],
    [[2, 5], false, 'a PASS comment and status from the shared login count for nothing in the queue either'],
    [[2, 7], false, 'a FAIL verdict holds in the queue'],
    [[6], false, 'a closed pull request is no queue entry'],
    [[8], false, 'a PASS reviewed against a side branch counts for nothing in the queue'],
  ];
  for (const [numbers, want, what] of cases) {
    const got = await group(numbers);
    if (got.ok !== want) fail(`${what}: ${got.lines.join(' | ')}`);
  }
  if (!(await group([6], { dryRun: true })).ok) fail('a dry run reads a closed pull request');
  const bad = await sealMergeGroup({ commits: [{ commit: { message: 'Merge pull request #4' } }], headRef: ref(4), io });
  if (bad.ok || !bad.lines[0].includes('could not be read whole')) fail('an unreadable group fails closed');
}

/**
 * A GitHub GET. In CI it is fetch with the job's token. `--via-gh` (the dry run on a person's machine) reads through the
 * logged-in `gh` CLI instead, so no token is handled here; the answer has the same { ok, status, json() } shape.
 */
async function get(url, init) {
  if (!process.argv.includes('--via-gh')) return fetch(url, init);
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('gh', ['api', '-i', url.replace('https://api.github.com/', '')], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.error) throw new Error(`--via-gh: could not run gh (${r.error.message})`);
  const status = Number(/^HTTP\/[\d.]+ (\d+)/.exec(r.stdout ?? '')?.[1] ?? 0);
  const body = String(r.stdout ?? '')
    .split(/\r?\n\r?\n/)
    .slice(1)
    .join('\n\n');
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) };
}

/** GET a GitHub API path; any failure ends the seal (fail closed), except a 404 when `missingOk` (then null). */
async function api(path, token, { missingOk = false } = {}) {
  const res = await get(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (missingOk && res.status === 404) return null;
  if (!res.ok) {
    console.error(`::error::could not read ${path} (HTTP ${res.status}); sealing fails closed`);
    process.exit(1);
  }
  return res.json();
}

/**
 * Every path the pull request touches, both sides of a rename. More than GitHub lists returns [] (fail closed). The
 * files endpoint shows the pull request's current head, so the list counts only when that head is HEAD_SHA before and
 * after the read; otherwise [] (fail closed), and the newer head gets its own seal run.
 */
async function readChangedFiles(repo, number, sha, token) {
  const headIs = async () => (await api(`/repos/${repo}/pulls/${number}`, token)).head?.sha === sha;
  if (!(await headIs())) return [];
  const files = [];
  for (let page = 1; page <= 30; page++) {
    const batch = await api(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, token);
    for (const f of batch) files.push(f.filename, ...(f.previous_filename ? [f.previous_filename] : []));
    if (batch.length < 100) return (await headIs()) ? files : [];
  }
  return [];
}

/** package.json of each touched package, on the default branch and on the head. */
async function readManifests(repo, files, refs, token) {
  const out = new Map();
  for (const root of new Set(files.map(packageRootOf).filter(Boolean))) {
    const found = [];
    for (const ref of refs) {
      const path = `/repos/${repo}/contents/${root}/package.json?ref=${encodeURIComponent(ref)}`;
      const file = await api(path, token, { missingOk: true });
      if (file?.content) found.push(JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')));
    }
    out.set(root, found);
  }
  return out;
}

/** The commits between a merge group's base and head, oldest first (at most 250: groupPulls refuses the cap). */
async function readGroupCommits(repo, base, head, token) {
  const out = [];
  for (let page = 1; page <= 3; page++) {
    const cmp = await api(`/repos/${repo}/compare/${base}...${head}?per_page=100&page=${page}`, token);
    out.push(...(cmp.commits ?? []));
    if ((cmp.commits ?? []).length < 100) break;
  }
  return out;
}

/** What a seal process keeps between polls, per API reader: trees, the window's bounds, and index runs that hold no verdict. */
const caches = new WeakMap();
const cacheFor = (get) => {
  if (!caches.has(get)) caches.set(get, { trees: new Map(), live: new Map(), foreign: new Map() });
  return caches.get(get);
};

/** A list GitHub can't give whole under one filter (more than 1,000), with the count it reported. */
class TooMany extends Error {
  constructor(what, total) {
    super(`${what}: more than 1,000 listed${total ? ` (${total})` : ''}, not whole; the seal fails closed`);
    this.total = total;
  }
}

/**
 * The runs the verdict needs, each list read whole or the seal fails (a list cut short, or more than GitHub lists for a
 * filter, throws; it never passes as a partial one). `get` is the API reader (tests pass their own).
 *   1. REVIEW_WORKFLOW's runs at this head, every event (ciReviewVerdict keeps only pull_request_target's).
 *   2. Its pull_request_target runs on the pull request's branch: an empty commit after a FAIL.
 *   3. The runs the tree index names for this head's tree, on any head and any branch: the same code pushed again as a
 *      new branch and pull request. One keyed read (the artifacts named reviewIndexName(tree)), then each named run
 *      not already listed. The index only points: ciReviewVerdict checks each run's workflow, event, tree and attempts.
 *   4. Its pull_request_target runs created before the index went live (readIndexLive), which have no index: a window
 *      that stops growing then, read on every poll and in time slices if it ever holds more than 1,000.
 * Nothing reads every run of the workflow, so the seal keeps working however many runs the repository has (before,
 * a list of every pull_request_target run failed every seal closed once it passed 1,000; #7132 finding 2).
 */
export async function readReviewRuns(repo, sha, token, branch, get = api) {
  const file = REVIEW_WORKFLOW.split('/').pop();
  const cache = cacheFor(get);
  const out = new Map();
  // One filtered list, every page, whole or throw. `key` names the list in the result (`workflow_runs`, `artifacts`).
  const whole = async (what, path, key, opts) => {
    const all = [];
    let total = 0;
    for (let page = 1; ; page++) {
      if (page > 10) throw new TooMany(what, total);
      const r = await get(`${path}&per_page=100&page=${page}`, token, opts);
      const batch = r?.[key] ?? [];
      if (!Array.isArray(batch)) throw new Error(`${what}: not a list; the seal fails closed`);
      total = Math.max(total, Number(r?.total_count) || 0);
      if (total > 1000) throw new TooMany(what, total);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    if (all.length < total) throw new Error(`${what}: ${all.length} of ${total} read, not whole; the seal fails closed`);
    return all;
  };
  const runs = (q) =>
    whole(`${file} runs (${decodeURIComponent(q)})`, `/repos/${repo}/actions/workflows/${file}/runs?${q}`, 'workflow_runs', {
      missingOk: true,
    });
  for (const q of [`head_sha=${sha}`, ...(branch ? [`event=pull_request_target&branch=${encodeURIComponent(branch)}`] : [])])
    for (const run of await runs(q)) out.set(run.id, run);

  if (!cache.live.has(repo)) cache.live.set(repo, await readIndexLive(repo, token, get));
  for (const run of await readWindow(runs, cache.live.get(repo))) out.set(run.id, run);

  const name = reviewIndexName(await readTree(repo, sha, token, get));
  for (const a of await whole(`the tree index ${name}`, `/repos/${repo}/actions/artifacts?name=${name}`, 'artifacts')) {
    const id = a?.workflow_run?.id;
    if (a?.name !== name || !Number.isSafeInteger(id) || out.has(id)) continue;
    if (cache.foreign.has(id)) continue;
    // A run the index names but GitHub no longer has (deleted), or a run of another workflow or event (an artifact of
    // the same name planted by any other run), holds no verdict and never will: read once per seal, not every poll. A
    // CI review run is read on every poll, so a new attempt of it is seen.
    const run = await get(`/repos/${repo}/actions/runs/${id}`, token, { missingOk: true });
    if (run?.id !== id || run.path !== REVIEW_WORKFLOW || run.event !== 'pull_request_target') cache.foreign.set(id, true);
    else out.set(id, run);
  }
  return [...out.values()];
}

/**
 * The window's bounds, from GitHub's records (ms since the epoch): `end` is INDEX_PR's `merged_at` plus INDEX_MARGIN_MS,
 * `start` the workflow's `created_at` (no run of it is older). Fails closed when INDEX_PR isn't merged into REVIEW_BASE
 * or a time can't be read.
 */
export async function readIndexLive(repo, token, get = api) {
  const pull = await get(`/repos/${repo}/pulls/${INDEX_PR}`, token);
  const merged = Date.parse(pull?.merged_at ?? '');
  if (!Number.isFinite(merged) || pull?.base?.ref !== REVIEW_BASE)
    throw new Error(
      `#${INDEX_PR}, which added the tree index, isn't merged into ${REVIEW_BASE} (merged_at ${pull?.merged_at ?? 'unread'}), so runs from before the index can't be bounded; the seal fails closed`,
    );
  const workflow = await get(`/repos/${repo}/actions/workflows/${REVIEW_WORKFLOW.split('/').pop()}`, token);
  const start = Date.parse(workflow?.created_at ?? '');
  if (!Number.isFinite(start) || start > merged)
    throw new Error(`${REVIEW_WORKFLOW}: no readable created_at before #${INDEX_PR} merged; the seal fails closed`);
  return { start, end: merged + INDEX_MARGIN_MS };
}

/**
 * The window (readReviewRuns list 4): pull_request_target runs created before `end` (readIndexLive). One list when
 * GitHub can give it whole; otherwise halves of [start, end), each read whole or halved again, and the runs read
 * must number exactly what the single list reported, or the seal fails closed.
 */
async function readWindow(runs, { start, end }) {
  const at = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    return await runs(`event=pull_request_target&created=${encodeURIComponent(`<${at(end)}`)}`);
  } catch (e) {
    if (!(e instanceof TooMany)) throw e;
    const found = new Map();
    const slice = async (from, to) => {
      try {
        for (const run of await runs(`event=pull_request_target&created=${encodeURIComponent(`${at(from)}..${at(to)}`)}`))
          found.set(run.id, run);
      } catch (inner) {
        if (!(inner instanceof TooMany) || to - from < 2000) throw inner;
        const mid = from + Math.floor((to - from) / 2000) * 1000;
        await slice(from, mid);
        await slice(mid + 1000, to);
      }
    };
    await slice(Math.floor(start / 1000) * 1000 - 1000, end - 1000);
    if (!e.total || found.size !== e.total)
      throw new Error(`the window before ${at(end)}: ${found.size} runs read in slices, ${e.total} listed; the seal fails closed`);
    return [...found.values()];
  }
}

/**
 * A commit's tree sha (one GET per head per reader, kept for the seal's later polls). Any failure ends the seal (fail
 * closed). ci-review.mjs names the tree index with this same reader, so the name written and the name read agree.
 */
export async function readTree(repo, sha, token, get = api) {
  const { trees } = cacheFor(get);
  if (!trees.has(sha)) {
    const t = String((await get(`/repos/${repo}/git/commits/${sha}`, token))?.tree?.sha ?? '');
    if (!SHA40.test(t)) throw new Error(`the tree of ${sha} could not be read; the seal fails closed`);
    trees.set(sha, t);
  }
  return trees.get(sha);
}

/** The jobs of every attempt of one run, oldest attempt first, so a FAIL in an earlier attempt is seen. */
async function readAttempts(repo, run, token) {
  const out = [];
  for (let n = 1; n <= Math.max(1, Number(run.run_attempt) || 1); n++) {
    const r = await api(`/repos/${repo}/actions/runs/${run.id}/attempts/${n}/jobs?per_page=100`, token);
    out.push(r?.jobs ?? []);
  }
  return out;
}

/**
 * `merge_group`: MERGE_GROUP_BASE_SHA, MERGE_GROUP_HEAD_SHA and MERGE_GROUP_HEAD_REF from the event. The dry run reads the
 * same way for any two commits of main and a queue branch name, and reads closed pull requests too:
 *   REPO=owner/name node tooling/ci/review-marker.mjs --merge-group-dry-run <base sha> <head sha> <pr of head> --via-gh
 */
async function mainMergeGroup({ repo, token, base, head, headRef, dryRun }) {
  const { default_branch: branch } = await api(`/repos/${repo}`, token);
  const io = {
    pull: (n) => api(`/repos/${repo}/pulls/${n}`, token),
    files: (n, sha) => readChangedFiles(repo, n, sha, token),
    manifests: (files, sha) => readManifests(repo, files, [branch, sha, head], token),
    reviewRuns: (sha, branch) => readReviewRuns(repo, sha, token, branch),
    attempts: (run) => readAttempts(repo, run, token),
    tree: (sha) => readTree(repo, sha, token),
  };
  const commits = await readGroupCommits(repo, base, head, token);
  const { ok, lines } = await sealMergeGroup({ commits, headRef, io, dryRun });
  console.log(`merge group ${base.slice(0, 10)}..${head.slice(0, 10)} (${headRef})${dryRun ? ', dry run' : ''}:`);
  for (const l of lines) console.log(`  ${l}`);
  if (!ok) {
    console.error(
      `::error title=Review sign-off missing in the merge group::${lines.filter((l) => !/not required|found$/.test(l)).join('; ')}. Each queued pull request that needs the independent review must carry a passing CI review for its own head (AGENTS.md item 8).`,
    );
    process.exit(1);
  }
  console.log('every pull request in the merge group carries the review its own seal requires');
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const dry = process.argv.indexOf('--merge-group-dry-run');
  if (dry > 0) {
    const [base, head, pr] = process.argv.slice(dry + 1).filter((a) => !a.startsWith('--'));
    const { GH_TOKEN = 'via-gh', REPO } = process.env;
    if (!REPO || !base || !head || !pr || (!process.env.GH_TOKEN && !process.argv.includes('--via-gh'))) {
      console.error('usage: REPO=owner/name review-marker.mjs --merge-group-dry-run <base sha> <head sha> <pr of head> [--via-gh]');
      process.exit(1);
    }
    const headRef = `refs/heads/gh-readonly-queue/main/pr-${pr}-${base}`;
    return mainMergeGroup({ repo: REPO, token: GH_TOKEN, base, head, headRef, dryRun: true });
  }
  if (process.env.MERGE_GROUP_HEAD_SHA) {
    const { GH_TOKEN, REPO, MERGE_GROUP_BASE_SHA: base, MERGE_GROUP_HEAD_SHA: head, MERGE_GROUP_HEAD_REF: headRef } = process.env;
    if (!GH_TOKEN || !REPO || !base || !headRef) {
      console.error('::error::review-marker on a merge group needs GH_TOKEN, REPO, MERGE_GROUP_BASE_SHA and MERGE_GROUP_HEAD_REF');
      process.exit(1);
    }
    return mainMergeGroup({ repo: REPO, token: GH_TOKEN, base, head, headRef, dryRun: false });
  }
  const { GH_TOKEN, HEAD_SHA, REPO, PR_NUMBER } = process.env;
  if (!GH_TOKEN || !HEAD_SHA || !REPO) {
    console.error('::error::review-marker needs GH_TOKEN, HEAD_SHA and REPO');
    process.exit(1);
  }
  let reason = 'not a pull request';
  // The pull request's branch, so a FAIL on an earlier head with the same tree is read too, and its base now. A pull
  // request into any branch but main is never sealed, so a green seal can't sit on a head that is later pointed at
  // main (the seal doesn't re-run on a retarget; the CI review does, and re-runs a red seal when it passes).
  const pull = PR_NUMBER ? await api(`/repos/${REPO}/pulls/${PR_NUMBER}`, GH_TOKEN) : null;
  const branch = String(pull?.head?.ref ?? '') || undefined;
  if (PR_NUMBER && pull?.base?.ref !== REVIEW_BASE) {
    console.error(
      `::error title=Not into ${REVIEW_BASE}::The seal passes only a pull request into ${REVIEW_BASE}; this one's base is ${pull?.base?.ref ?? 'unreadable'}. Point it at ${REVIEW_BASE}, then re-run this seal.`,
    );
    process.exit(1);
  }
  if (PR_NUMBER) {
    const { default_branch: base } = await api(`/repos/${REPO}`, GH_TOKEN);
    const files = await readChangedFiles(REPO, PR_NUMBER, HEAD_SHA, GH_TOKEN);
    reason = reviewReason(files, await readManifests(REPO, files, [base, HEAD_SHA], GH_TOKEN));
    if (reason === null) {
      console.log('independent review not required: no money, security or gate file changed (owner decision 2026-10-22)');
      return;
    }
    console.log(`independent review required (${reason})`);
  }
  const io = {
    reviewRuns: (sha) => readReviewRuns(REPO, sha, GH_TOKEN, branch),
    attempts: (run) => readAttempts(REPO, run, GH_TOKEN),
    tree: (sha) => readTree(REPO, sha, GH_TOKEN),
  };
  const deadline = Date.now() + REVIEW_WAIT_MS;
  let verdict;
  for (let attempt = 1; ; attempt++) {
    verdict = await lookForSignoff({ sha: HEAD_SHA, io, base: PR_NUMBER ? pull?.base?.ref : REVIEW_BASE, number: PR_NUMBER || undefined });
    if (verdict.ok) {
      console.log(verdict.why);
      return;
    }
    // A FAIL stands for this head and for its code: waiting can't change it.
    if (verdict.state === 'fail' || Date.now() + REVIEW_POLL_MS > deadline) break;
    if (attempt === 1)
      console.log(`${verdict.why}; waiting up to ${REVIEW_WAIT_MS / 60_000} min, checking every ${REVIEW_POLL_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
  }
  console.error(
    `::error title=Review sign-off missing::No passing CI review on ${HEAD_SHA}. This change needs one (${reason}): ${verdict.why}. The CI review job runs on every push to an in-repo pull request and re-runs this seal when it passes (AGENTS.md item 8); a comment or a status counts for nothing.`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
