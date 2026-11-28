// Before a push (.githooks/pre-push): a journey branch (`j/...`) whose previous head's Real-app journeys run failed one of
// the branch's own journey files is pushed again only after a local PASS of those files on the tree being pushed
// (`.jr/run.json`, written by `pnpm local:stack journey`, tooling/scripts/journey-local.mjs). On 28 Nov eight journey PRs
// made 61 pushes, about 21 of them fixes pushed after a red run a local run would have caught (#11207: the same 404 four
// times; #11199: the same failure five times): each such round is an 18–35 minute run, a local one 2–8 minutes
// (project-state#4140, from the cost audit project-state#4136).
//
// A safety net, never enforcement: `git push --no-verify` skips it, and CI's journeys run still judges every push.
// It never blocks what it can't judge, and says why in one line: on the Mac, when GitHub can't be read, when the run's
// report can't be read, or when the local run found no free slot (journey-local exit 3). A step red on main is not this
// branch's to pass locally: the merge seal's own rule says which (journey-seal.mjs mainsOwn), read here without its
// "the pull request touches that journey" clause, which a journey branch always meets and which says who repairs it, not
// whether a local run could pass it. Each pass-through and refusal is one JSON line in pre-push-journey-red.jsonl under
// $XDG_STATE_HOME/intafaced (default ~/.local/state/intafaced), to count them.
//   node tooling/scripts/pre-push-journey-red.mjs < <the refs git hands pre-push on stdin>
import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JOURNEYS_WORKFLOW, JOURNEY_TEST, currentReportArtifact, mainReference, mainsOwn } from '../ci/journey-seal.mjs';
import { JOURNEYS_ARTIFACT, readReport, rootInputs } from '../ci/journey-verdict.mjs';

const ZERO = /^0+$/;
const SHA = /^[0-9a-f]{40}$/;
const JOURNEY_DIR = 'apps/customer/tests/real-app/';

/** A run's report states -> its red keys (steps and step-less tests that failed, not those that passed on a retry), each with its file. */
export function failedIn(report) {
  const out = new Map();
  for (const [key, state] of Object.entries(report?.states ?? {})) if (state === 'failed') out.set(key, report.files?.[key] ?? null);
  for (const [key, state] of Object.entries(report?.tests ?? {})) if (state === 'failed') out.set(key, report.testFiles?.[key] ?? null);
  return out;
}

/** The journey test files among `paths` (repo paths), as the base names journey-local records. */
export const journeyFileNames = (paths) =>
  [...new Set((paths ?? []).filter((p) => JOURNEY_TEST.test(p)).map((p) => p.slice(JOURNEY_DIR.length)))].sort();

/**
 * What one pushed ref gets. `push`: { branch, sha, prev }. `io` (every outside read, so the test drives it):
 *   mac: boolean; ownFiles(sha) -> the journey test files this branch changes and still holds at `sha` (base names);
 *   tree(sha) -> its tree; record() -> `.jr/run.json` or null; latestRun(sha) -> the newest Real-app journeys run on a
 *   commit or null; report(run) -> the run's report read by journey-verdict.mjs readReport, or null; mainLatest() ->
 *   main's newest finished full run as mainReference reads it, or null; issues() -> main's open `regression` and `flaky`
 *   issues; money: { step: boolean } (journey-verdict.mjs moneyRule).
 * Returns { kind: 'skip' | 'allow' | 'pass-through' | 'refuse', line?, steps?, files? }. GitHub's reads throwing is a
 * pass-through; nothing here ever throws to its caller.
 */
export async function decide(push, io) {
  if (!push.branch.startsWith('j/') || !SHA.test(push.sha) || !SHA.test(push.prev) || ZERO.test(push.prev)) return { kind: 'skip' };
  const own = io.ownFiles(push.sha);
  if (!own.length) return { kind: 'skip' };
  const via = (line) => ({ kind: 'pass-through', line: `pre-push: journey re-push check passed through: ${line}` });
  if (io.mac) return via('on the Mac');
  let run;
  let red;
  try {
    run = await io.latestRun(push.prev);
    if (!run || run.status !== 'completed' || run.conclusion !== 'failure') return { kind: 'skip' };
    const report = await io.report(run);
    if (!report) return via(`run ${run.id}'s report could not be read`);
    const ownSet = new Set(own);
    red = [...failedIn(report)].filter(([, file]) => ownSet.has(file));
  } catch (e) {
    return via(
      `GitHub could not be read (${String(e?.message ?? e)
        .split('\n')[0]
        .slice(0, 120)})`,
    );
  }
  if (!red.length) return { kind: 'skip' };
  let blocking;
  try {
    const latest = await io.mainLatest();
    const issues = await io.issues();
    const asSeal = red.map(([step, file]) => ({ step, file, why: 'failed', money: io.money?.[step] ?? true }));
    blocking = mainsOwn({ blocking: asSeal, latest, issues, touches: { shared: false, paths: [], journeys: new Set() } }).blocking;
  } catch (e) {
    return via(
      `main's reds could not be read (${String(e?.message ?? e)
        .split('\n')[0]
        .slice(0, 120)})`,
    );
  }
  if (!blocking.length) return { kind: 'allow', line: `pre-push: run ${run.id}'s reds in this branch's journeys are all red on main too` };
  const steps = blocking.map((x) => x.step);
  const files = [...new Set(blocking.map((x) => x.file))].sort();
  const rec = io.record();
  const covers = rec && rec.tree && rec.tree === io.tree(push.sha) && Array.isArray(rec.files) && files.every((f) => rec.files.includes(f));
  if (covers && rec.code === 0) return { kind: 'allow', line: `pre-push: local PASS of ${files.join(' ')} on this tree` };
  if (covers && rec.code === 3) return via('the local run found no free slot (journey-local exit 3)');
  const ids = files.map((f) => f.replace(/\.pw\.mjs$/, ''));
  return {
    kind: 'refuse',
    steps,
    files,
    line: [
      `  ✖ ${push.branch}: run ${run.id} on ${push.prev.slice(0, 9)} failed ${steps.slice(0, 6).join(', ')}${steps.length > 6 ? ` and ${steps.length - 6} more` : ''}, in this branch's own journey files;`,
      `    this push has no local PASS of ${files.join(' ')} on the tree it pushes${rec ? ` (.jr/run.json: ${rec.tree === io.tree(push.sha) ? '' : 'another tree, '}files ${(rec.files ?? []).join(' ') || 'none'}, exit ${rec.code})` : ' (no .jr/run.json)'}.`,
      `    Run it here first (2–8 minutes, against an 18–35 minute CI round): pnpm local:stack journey ${ids.join(' ')}`,
      '    then commit what it needs and push. On no free slot (exit 3) the push goes through.',
    ].join('\n'),
  };
}

// ── The real outside world ──────────────────────────────────────────────────

const TIMEOUT = 30_000;
const gh = (args, opts = {}) =>
  new Promise((done, fail) =>
    execFile('gh', args, { timeout: TIMEOUT, maxBuffer: 512 * 2 ** 20, encoding: 'utf8', ...opts }, (e, out) =>
      e ? fail(new Error(`gh ${args[1] ?? args[0]}: ${String(e.message).split('\n')[0]}`)) : done(out),
    ),
  );
const api = async (path) => JSON.parse(await gh(['api', path]));

/** A run's report, downloaded with gh and read as the seal reads one; null when it has none. */
async function downloadReport(repo, run) {
  const arts = await api(`repos/${repo}/actions/runs/${run.id}/artifacts?name=${JOURNEYS_ARTIFACT}&per_page=100`);
  const art = currentReportArtifact(run, arts?.artifacts);
  if (!art) return null;
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-journey-red-'));
  try {
    const zip = join(dir, 'a.zip');
    execFileSync('sh', ['-c', 'gh api "$1" > "$2"', 'sh', `repos/${repo}/actions/artifacts/${art.id}/zip`, zip], {
      timeout: 120_000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const text = execFileSync('unzip', ['-p', zip, 'report.json'], { maxBuffer: 512 * 2 ** 20, encoding: 'utf8' });
    return readReport(JSON.parse(text));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function realIo(top) {
  const git = (...a) => execFileSync('git', a, { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let repo = null;
  const repoName = () =>
    (repo ??=
      /github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(git('remote', 'get-url', 'origin'))?.[1] ??
      (() => {
        throw new Error('origin is not a GitHub repository');
      })());
  const reports = new Map();
  const report = (run) => {
    if (!reports.has(run.id)) reports.set(run.id, downloadReport(repoName(), run));
    return reports.get(run.id);
  };
  const file = JOURNEYS_WORKFLOW.split('/').pop();
  return {
    mac: process.platform === 'darwin',
    ownFiles: (sha) => {
      try {
        const base = git('merge-base', sha, 'refs/remotes/origin/main');
        const changed = git('diff', '--name-only', '--diff-filter=AMR', base, sha, '--', JOURNEY_DIR).split('\n');
        return journeyFileNames(changed);
      } catch {
        return [];
      }
    },
    tree: (sha) => git('rev-parse', `${sha}^{tree}`),
    record: () => {
      try {
        return JSON.parse(readFileSync(join(top, '.jr', 'run.json'), 'utf8'));
      } catch {
        return null;
      }
    },
    latestRun: async (sha) => {
      const r = await api(`repos/${repoName()}/actions/workflows/${file}/runs?head_sha=${sha}&per_page=20`);
      if (!Array.isArray(r?.workflow_runs)) throw new Error('the journeys runs are not a list');
      return r.workflow_runs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0] ?? null;
    },
    report,
    mainLatest: async () => {
      const r = await api(`repos/${repoName()}/actions/workflows/${file}/runs?branch=main&status=completed&per_page=100`);
      if (!Array.isArray(r?.workflow_runs)) throw new Error("main's journeys runs are not a list");
      // The seal's reading of main's newest finished full run, its verdict here the report's failed keys alone.
      return mainReference({
        repo: repoName(),
        mainRuns: r.workflow_runs,
        contains: async () => true,
        reportOf: async (run) => (await report(run)) ?? { error: 'no report' },
        verdictOf: (rep) => ({ red: [...failedIn(rep).keys()].map((step) => ({ step, why: 'failed' })), missing: [] }),
      });
    },
    issues: async () =>
      (
        await Promise.all(
          ['regression', 'flaky'].map(async (label) => {
            const r = await api(`repos/${repoName()}/issues?labels=${label}&state=open&per_page=100`);
            if (!Array.isArray(r)) throw new Error(`open ${label} issues: not a list`);
            return r;
          }),
        )
      ).flat(),
    get money() {
      try {
        return rootInputs(top).money;
      } catch {
        return {};
      }
    },
  };
}

/** One line a pass-through or refusal leaves, to count them. */
export function logLine(push, got, now = new Date()) {
  return `${JSON.stringify({ at: now.toISOString(), branch: push.branch, sha: push.sha, prev: push.prev, kind: got.kind, line: got.line?.split('\n')[0] ?? '' })}\n`;
}

function log(push, got) {
  try {
    const dir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'intafaced');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'pre-push-journey-red.jsonl'), logLine(push, got));
  } catch {}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const io = realIo(top);
  let refused = false;
  for (const l of readFileSync(0, 'utf8').split('\n')) {
    const [, sha, ref, prev] = l.trim().split(/\s+/);
    if (!ref?.startsWith('refs/heads/')) continue;
    const push = { branch: ref.slice('refs/heads/'.length), sha, prev };
    let got;
    try {
      got = await decide(push, io);
    } catch (e) {
      got = {
        kind: 'pass-through',
        line: `pre-push: journey re-push check passed through: it failed (${String(e?.message ?? e).split('\n')[0]})`,
      };
    }
    if (got.kind === 'skip') continue;
    if (got.kind === 'refuse') {
      refused = true;
      console.error(got.line);
    } else console.log(got.line);
    if (got.kind !== 'allow') log(push, got);
  }
  process.exit(refused ? 1 : 0);
}
