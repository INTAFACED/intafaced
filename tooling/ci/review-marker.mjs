#!/usr/bin/env node
/**
 * Merge-seal step: a pull request is sealed only when the commit status `Independent review` is a success on its
 * current head. That status is posted by .github/workflows/review-signoff.yml (tooling/ci/review-signoff.mjs) when a
 * listed reviewer (tooling/ci/reviewers.json) comments `Independent review: PASS <full head sha>`, or when the same
 * patch is carried across a clean rebase. A comment by anyone else, or for another sha, creates no status.
 *
 *   node tooling/ci/review-marker.mjs --self-test
 *   GH_TOKEN=... HEAD_SHA=... REPO=owner/name node tooling/ci/review-marker.mjs
 *
 * The sign-off workflow re-runs a failed seal after it posts the status, so nobody re-runs it by hand. The seal also
 * waits up to REVIEW_WAIT_MS for the review before it fails. Measured 2026-10-22/23: 106 of about 146 red first
 * attempts of PR CI runs were only this step, and 44 of 74 such reviews landed within 20 minutes of the red. Each red
 * wakes the author's thread, which then reads it; waiting turns most of them into one green. Same requirement, later
 * verdict: a head without the review still fails.
 *
 * The seal also accepts the comment itself: a PASS for this exact head by a login listed in reviewers.json on the
 * default branch (never the pull request's copy). The sign-off workflow can wait 30 minutes for a runner when the
 * free plan's 20 concurrent jobs are taken, while this job already holds one; reading the comment here keeps the review
 * off that queue. The meaning is unchanged: a listed reviewer, the exact head, the same line format.
 *
 * Only money, security, gate-file and look-baseline changes need it (owner decisions 2026-10-22 and, for baselines,
 * 2026-10-26: a builder never approves its own picture; test-diff-guard.mjs also wants the room named). Every other pull request is sealed
 * on its checks alone; the automated code review AGENTS.md asks for before a pull request opens is not checked here.
 * The seal runs the default branch's copy of this file, so a pull request cannot change which of its files need the
 * review. A pull request that edits the workflow itself touches .github/, which always needs the review.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { gateFilesTouched } from '../scripts/gate-file-guard.mjs';
import { BASELINE } from './look-baselines.mjs';

/** How long the seal waits for the review before it fails, and how often it looks. ci.yml's merge-seal timeout covers it. */
const REVIEW_WAIT_MS = 20 * 60_000;
const REVIEW_POLL_MS = 60_000; // two reads a minute per waiting seal, far under the token's hourly limit

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

function selfTest() {
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
    [input([pass('nino', `Independent review: PASS ${sha}`)], { requireDistinctFromAuthor: true }), false],
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
  console.log('review-marker self-test ok');
}

async function readStatuses(repo, sha, token) {
  const res = await fetch(`https://api.github.com/repos/${repo}/commits/${sha}/statuses?per_page=100`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
  });
  if (!res.ok) {
    console.error(`::error::could not read commit statuses (HTTP ${res.status}); sealing fails closed`);
    process.exit(1);
  }
  return res.json();
}

/** GET a GitHub API path; any failure ends the seal (fail closed), except a 404 when `missingOk` (then null). */
async function api(path, token, { missingOk = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
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

/** The reviewer list comes from the default branch, so a pull request cannot add itself to it. */
async function readReviewConfig(repo, token) {
  const { default_branch: ref } = await api(`/repos/${repo}`, token);
  const file = await api(`/repos/${repo}/contents/tooling/ci/reviewers.json?ref=${encodeURIComponent(ref)}`, token);
  const c = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  return {
    reviewers: (c.reviewers ?? []).map((l) => String(l).toLowerCase()),
    requireDistinctFromAuthor: c.requireDistinctFromAuthor === true,
  };
}

async function readComments(repo, number, token) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api(`/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`, token);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

/**
 * The sessions on the pull request's session-trailer commit lines for this head (sessionsForHead), or null when the
 * commits cannot be read whole: then no PASS comment counts here (a status from the sign-off workflow still does).
 */
async function readAuthorSessions(repo, number, sha, token) {
  const commits = [];
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    });
    if (!res.ok) return null;
    const batch = await res.json();
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  return sessionsForHead(commits, sha);
}

async function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const { GH_TOKEN, HEAD_SHA, REPO, PR_NUMBER, PR_AUTHOR } = process.env;
  if (!GH_TOKEN || !HEAD_SHA || !REPO) {
    console.error('::error::review-marker needs GH_TOKEN, HEAD_SHA and REPO');
    process.exit(1);
  }
  let reason = 'not a pull request';
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
  const config = PR_NUMBER ? await readReviewConfig(REPO, GH_TOKEN) : null;
  const refusals = [];
  let authorSessions = null; // the PR's sessions once read whole (see the poll below)
  const told = new Set();
  const deadline = Date.now() + REVIEW_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    if (hasSignoff(await readStatuses(REPO, HEAD_SHA, GH_TOKEN))) {
      console.log(`review sign-off found for ${HEAD_SHA}`);
      return;
    }
    if (PR_NUMBER) {
      const who = { sha: HEAD_SHA, author: PR_AUTHOR, ...config };
      const comments = (await readComments(REPO, PR_NUMBER, GH_TOKEN)).filter((c) => markerFits(c, who));
      // Read only when a PASS comment fits; an unreadable list (null) is read again on the next poll.
      if (comments.length > 0 && !(authorSessions instanceof Set))
        authorSessions = await readAuthorSessions(REPO, PR_NUMBER, HEAD_SHA, GH_TOKEN);
      const verdict = commentSignoff({ comments, authorSessions, ...who });
      if (verdict.ok) {
        console.log(`review sign-off comment found for ${HEAD_SHA}`);
        return;
      }
      for (const r of verdict.refused.filter((x) => !told.has(x.id))) {
        told.add(r.id);
        refusals.push(r.reason);
        console.log(`a PASS for ${HEAD_SHA} does not count: ${r.reason}`);
      }
    }
    if (Date.now() + REVIEW_POLL_MS > deadline) break;
    if (attempt === 1)
      console.log(`no review sign-off yet; waiting up to ${REVIEW_WAIT_MS / 60_000} min, checking every ${REVIEW_POLL_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
  }
  console.error(
    `::error title=Review sign-off missing::No success status "${STATUS_CONTEXT}" on ${HEAD_SHA}. This change needs one (${reason}). Get an independent review of this exact head; a listed reviewer comments "Independent review: PASS ${HEAD_SHA}" and the status follows (see AGENTS.md).${refusals.length ? ` A PASS here did not count: ${refusals.at(-1)}.` : ''}`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
