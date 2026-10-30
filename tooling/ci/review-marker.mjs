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
 * The sessions that wrote a pull request: every session id on a `Claude-Session:` line of its commit messages.
 */
export function commitSessions(messages) {
  const out = new Set();
  for (const msg of messages ?? []) {
    for (const line of String(msg ?? '').split('\n')) {
      if (/^Claude-Session:/i.test(line.trim())) for (const id of line.match(SESSION_ID) ?? []) out.add(id);
    }
  }
  return out;
}

/**
 * The session a PASS names: the ids on its `Reviewer session:` lines (docs/agents/reviewer-brief.md), or, when it has
 * none, every session id in the comment.
 */
export function passSessions(body) {
  const lines = String(body ?? '').split('\n');
  const named = lines.filter((l) => /^Reviewer session:/i.test(l.trim()));
  return new Set((named.length > 0 ? named : lines).flatMap((l) => l.match(SESSION_ID) ?? []));
}

/**
 * A PASS that names the PR's own session does not count (owner decision 2026-10-30, OWNER 124 (4)): the session the
 * comment names is one on the PR's `Claude-Session:` commit lines. Returns that session, or null.
 * `authorSessions` null means the commits could not all be read: no PASS counts then (fail closed).
 */
export function selfPassSession(body, authorSessions) {
  if (authorSessions === null) return "unknown (the pull request's commits could not all be read)";
  for (const id of passSessions(body)) if (authorSessions.has(id)) return id;
  return null;
}

/** True when the newest status of the review context on this head is a success. */
export function hasSignoff(statuses) {
  const mine = statuses.filter((s) => s?.context === STATUS_CONTEXT);
  return mine.length > 0 && mine[0].state === 'success'; // the API lists newest first
}

/**
 * True when a listed reviewer commented a PASS for exactly this head. `comments` are issue comments, `reviewers` are
 * lower-case logins from the default branch's reviewers.json, `author` is the pull request author's login,
 * `authorSessions` the sessions on the PR's `Claude-Session:` commit lines (a PASS naming one of them does not count).
 */
export function hasCommentSignoff({ comments, sha, reviewers, requireDistinctFromAuthor, author, authorSessions = new Set() }) {
  const want = String(sha).toLowerCase();
  return comments.some((c) => {
    const login = String(c?.user?.login ?? '').toLowerCase();
    const m = MARKER.exec(c?.body ?? '');
    if (!m || m[1].toLowerCase() !== want || !reviewers.includes(login)) return false;
    if (selfPassSession(c.body, authorSessions)) return false;
    return !(requireDistinctFromAuthor && login === String(author ?? '').toLowerCase());
  });
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
    ...extra,
  });
  const commentCases = [
    [input([pass('Nino', `Independent review: PASS ${sha}`)]), true],
    [input([pass('eve', `Independent review: PASS ${sha}`)]), false],
    [input([pass('nino', `Independent review: PASS ${'b'.repeat(40)}`)]), false],
    [input([pass('nino', `Independent review: PASS ${sha} but not really`)]), false],
    [input([]), false],
    [input([pass('nino', `Independent review: PASS ${sha}`)], { requireDistinctFromAuthor: true }), false],
    [input([pass('nino', `x\nIndependent review: PASS ${sha}\nReviewer session: s`)]), true],
    [
      input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: https://claude.ai/code/session_R1`)], {
        authorSessions: new Set(['session_A1']),
      }),
      true,
    ],
    [
      input([pass('nino', `Independent review: PASS ${sha}\nReviewer session: https://claude.ai/code/session_A1`)], {
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
  ];
  for (const [args, want] of commentCases) {
    if (hasCommentSignoff(args) !== want) {
      console.error('review-marker comment self-test failed for', JSON.stringify(args));
      process.exit(1);
    }
  }
  const msgs = [
    'feat: x\n\nCo-Authored-By: Claude\nClaude-Session: https://claude.ai/code/session_A1',
    'fix: y',
    'z\nclaude-session: session_B2 ',
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
 * The sessions on the pull request's `Claude-Session:` commit lines, or null when the list cannot be read whole for this
 * head (GitHub lists at most 250 commits; a head that moved during the read) — then no PASS comment counts here.
 */
export async function readAuthorSessions(repo, number, sha, token) {
  const commits = [];
  for (let page = 1; page <= 3; page++) {
    const batch = await api(`/repos/${repo}/pulls/${number}/commits?per_page=100&page=${page}`, token);
    commits.push(...batch);
    if (batch.length < 100) break;
  }
  if (commits.length === 0 || commits.length >= 250 || commits.at(-1)?.sha !== sha) return null;
  return commitSessions(commits.map((c) => c?.commit?.message));
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
  const authorSessions = PR_NUMBER ? await readAuthorSessions(REPO, PR_NUMBER, HEAD_SHA, GH_TOKEN) : null;
  const deadline = Date.now() + REVIEW_WAIT_MS;
  for (let attempt = 1; ; attempt++) {
    if (hasSignoff(await readStatuses(REPO, HEAD_SHA, GH_TOKEN))) {
      console.log(`review sign-off found for ${HEAD_SHA}`);
      return;
    }
    if (PR_NUMBER) {
      const comments = await readComments(REPO, PR_NUMBER, GH_TOKEN);
      if (hasCommentSignoff({ comments, sha: HEAD_SHA, author: PR_AUTHOR, authorSessions, ...config })) {
        console.log(`review sign-off comment found for ${HEAD_SHA}`);
        return;
      }
      const self = comments
        .filter((c) => hasCommentSignoff({ comments: [c], sha: HEAD_SHA, author: PR_AUTHOR, ...config }))
        .map((c) => selfPassSession(c.body, authorSessions))
        .find(Boolean);
      if (self && attempt === 1) console.log(`a PASS for ${HEAD_SHA} names the pull request's own session (${self}): it does not count`);
    }
    if (Date.now() + REVIEW_POLL_MS > deadline) break;
    if (attempt === 1)
      console.log(`no review sign-off yet; waiting up to ${REVIEW_WAIT_MS / 60_000} min, checking every ${REVIEW_POLL_MS / 1000}s`);
    await new Promise((r) => setTimeout(r, REVIEW_POLL_MS));
  }
  console.error(
    `::error title=Review sign-off missing::No success status "${STATUS_CONTEXT}" on ${HEAD_SHA}. This change needs one (${reason}). Get an independent review of this exact head; a listed reviewer comments "Independent review: PASS ${HEAD_SHA}" and the status follows (see AGENTS.md).`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();
