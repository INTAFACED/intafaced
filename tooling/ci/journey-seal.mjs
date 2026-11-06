#!/usr/bin/env node
/**
 * Merge-seal step: a pull request whose title names journey steps (`J-bank-13 #1 #2`, `J-ops-console-22 #1–#5`) is
 * sealed only when, for each named step, a finished Real-app journeys run (real-app-journeys.yml) on the pull request's
 * exact head shows it passing, or the body lists the step under a `Left or replaced` heading. A pull request whose title
 * names no step is unaffected. (Failure it prevents: #7202, the J-bank-13 trial, merged although its own branch run
 * 42162035136 on its exact head had failed all seven steps it named, because Real-app journeys is not a required check
 * and the seal never looked at the pull request's own steps; project-state research/trial-2026-11-06/J-bank-13-SCORE.md.
 * Owner decision 2026-11-06: "done" already means a journey's steps green in the running app on the PR's exact head.)
 *
 * What counts (judgeSteps), read from the Actions API, never from a comment or the pull request body's own claims:
 *   - runs of exactly JOURNEYS_WORKFLOW, from this repository, whose head is this exact sha (a run on an older head of the
 *     same branch counts for nothing, however green);
 *   - any such run not finished yet (a first attempt or a re-run) holds the seal: it fails now and is re-run when the run
 *     finishes (journey-seal-recheck.yml), so a pass is never read while a newer verdict is on its way;
 *   - cancelled and skipped runs say nothing and are passed over;
 *   - per step, the newest finished run (by its current attempt's start) whose merged report lists the step decides:
 *     passed is green; failed or skipped is red. A newer run that failed a step outranks an older pass;
 *   - a run's report is the `real-app-journeys` artifact uploaded during its current attempt (created at or after the
 *     attempt started), so a re-run's verdict is never read from an earlier attempt's report. A run with no such report,
 *     or one that can't be read, is red for every step it could have decided (fail closed), unless a newer run decides;
 *   - a step no finished run on the head reports is not green.
 * `Left or replaced`: a Markdown heading (any level) whose text is `Left or replaced`, up to the next heading of the same
 * or a higher level, outside fenced code. Only full step ids count there (`J-bank-13 #7`); a bare `#7` names no journey
 * (#7202's own section opened with "#7: inferences" about a step it claimed built).
 *
 * The title and body are read from the API at seal time, not from the event, so a re-run reads an edited title.
 * journey-seal-recheck.yml re-runs the seal when a journeys run on a pull request's head finishes and when a title or
 * body that names steps is edited. On a merge queue's commit every queued pull request is judged on its own head the
 * same way, without waiting.
 *
 *   GH_TOKEN=... REPO=owner/name HEAD_SHA=... PR_NUMBER=... node tooling/ci/journey-seal.mjs
 *   GH_TOKEN=... REPO=... MERGE_GROUP_BASE_SHA=... MERGE_GROUP_HEAD_SHA=... MERGE_GROUP_HEAD_REF=... node tooling/ci/journey-seal.mjs
 *   GH_TOKEN=... REPO=... node tooling/ci/journey-seal.mjs --dry-run <pr> [<sha>]   (any pull request, closed too; read only)
 *   GH_TOKEN=... REPO=... SHA=... [PR_NUMBER=...] [OLD_TITLE=...] node tooling/ci/journey-seal.mjs --recheck   (re-runs the seal)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readReport } from './journey-verdict.mjs';
import { groupPulls } from './review-marker.mjs';

export const JOURNEYS_WORKFLOW = '.github/workflows/real-app-journeys.yml';
export const JOURNEYS_ARTIFACT = 'real-app-journeys';
const SHA40 = /^[0-9a-f]{40}$/;
/** A journey id, then one or more `#n` or `#a–#b`, separated by spaces, commas, `and`, `&` or `/`. */
const STEP_RUN = /\b(J-[a-z0-9]+(?:-[a-z0-9]+)*-\d+)((?:(?:\s*(?:,|&|\/|\band\b)\s*|\s+)#\d+(?:\s*(?:[-–—]|\bto\b)\s*#?\d+)?)+)/gi;
const NUMBER = /#(\d+)(?:\s*(?:[-–—]|\bto\b)\s*#?(\d+))?/g;
/** A range longer than this is a typo, not a journey (the longest journey has 12 steps); it names nothing past the cap. */
const RANGE_CAP = 50;
const byStep = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/** Step keys (`J-bank-13#1`, as readReport keys them) named in a piece of text. Journey ids are read in lower case. */
export function stepsIn(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(STEP_RUN)) {
    const id = m[1].toLowerCase().replace(/^j-/, 'J-');
    for (const n of m[2].matchAll(NUMBER)) {
      const a = Number(n[1]);
      const b = n[2] === undefined ? a : Number(n[2]);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (let i = lo; i <= Math.min(hi, lo + RANGE_CAP); i++) out.add(`${id}#${i}`);
    }
  }
  return [...out].sort(byStep);
}

/** The steps a pull request title names. */
export const titleSteps = (title) => stepsIn(title);

/** Step keys listed under a `Left or replaced` heading of a body, outside fenced code. */
export function leftOrReplaced(body) {
  const out = new Set();
  let fence = null;
  let level = 0; // 0: not in the section; else the heading level that opened it
  for (const line of String(body ?? '')
    .replace(/\r/g, '')
    .split('\n')) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length && !line.trim().slice(f[1].length).trim()) fence = null;
      continue;
    }
    if (f && !(f[1][0] === '`' && line.trim().slice(f[1].length).includes('`'))) {
      fence = f[1];
      continue;
    }
    const h = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t#]*$/.exec(line);
    if (h) {
      const text = (h[2] ?? '').replace(/[*_`]/g, '').trim();
      if (/^left or replaced\s*:?$/i.test(text)) level = h[1].length;
      else if (level && h[1].length <= level) level = 0;
      continue;
    }
    if (level) for (const k of stepsIn(line)) out.add(k);
  }
  return out;
}

/**
 * The verdict for one head. `runs`: every JOURNEYS_WORKFLOW run listed for this head (the caller lists by head_sha; this
 * filters again). `reportOf(run)`: { states } of the run's current-attempt report, or { error }. Pure but for reportOf.
 * Returns { ok, state: 'none'|'pass'|'wait'|'fail', lines: [...] }.
 */
export async function judgeSteps({ sha, repo, title, body, runs, reportOf }) {
  const named = titleSteps(title);
  if (named.length === 0) return { ok: true, state: 'none', lines: ['the title names no journey step'] };
  const left = leftOrReplaced(body);
  const lines = [];
  const needed = [];
  for (const k of named) {
    if (left.has(k)) lines.push(`${k}: listed under "Left or replaced"`);
    else needed.push(k);
  }
  if (needed.length === 0) return { ok: true, state: 'pass', lines };
  const mine = (runs ?? []).filter(
    (r) =>
      r?.head_sha === sha && r?.path === JOURNEYS_WORKFLOW && r?.head_repository?.full_name === repo && r?.repository?.full_name === repo,
  );
  const running = mine.filter((r) => r.status !== 'completed');
  if (running.length) {
    const ids = running.map((r) => `${r.id} (attempt ${r.run_attempt ?? 1}, ${r.status})`).join(', ');
    return {
      ok: false,
      state: 'wait',
      lines: [
        ...lines,
        `Real-app journeys run ${ids} on this head has not finished; the seal reads the steps once it does (journey-seal-recheck.yml re-runs it)`,
      ],
    };
  }
  const finished = mine
    .filter((r) => !['cancelled', 'skipped'].includes(r.conclusion))
    .sort((a, b) => Date.parse(b.run_started_at ?? b.created_at) - Date.parse(a.run_started_at ?? a.created_at) || b.id - a.id);
  const reports = new Map();
  const report = async (r) => {
    if (!reports.has(r.id)) {
      let rep;
      try {
        rep = await reportOf(r);
      } catch (e) {
        rep = { error: e.message };
      }
      reports.set(r.id, rep ?? { error: 'no report' });
    }
    return reports.get(r.id);
  };
  let ok = true;
  for (const k of needed) {
    let decided = null;
    for (const r of finished) {
      const rep = await report(r);
      const where = `run ${r.id} (attempt ${r.run_attempt ?? 1})`;
      if (rep.error) {
        decided = { green: false, why: `${where}'s report couldn't be read (${rep.error}), so a failure there can't be ruled out` };
        break;
      }
      const st = rep.states?.[k];
      if (st === undefined) continue;
      decided = st === 'passed' ? { green: true, why: `passed in ${where}` } : { green: false, why: `${st} in ${where}` };
      break;
    }
    if (!decided)
      decided = {
        green: false,
        why: finished.length
          ? `no finished Real-app journeys run on this head reports it (${finished.length} read)`
          : 'no finished Real-app journeys run on this head',
      };
    if (!decided.green) ok = false;
    lines.push(`${k}: ${decided.why}`);
  }
  return { ok, state: ok ? 'pass' : 'fail', lines };
}

/** The artifact that holds a run's current-attempt report: named JOURNEYS_ARTIFACT, not expired, made at or after the
 *  attempt started; the newest if more than one. Null when there is none. */
export function currentReportArtifact(run, artifacts) {
  const start = Date.parse(run?.run_started_at ?? run?.created_at ?? '');
  const fits = (artifacts ?? []).filter(
    (a) => a?.name === JOURNEYS_ARTIFACT && !a.expired && Number.isFinite(start) && Date.parse(a.created_at) >= start,
  );
  return fits.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0] ?? null;
}

// ---- GitHub reads (GET only; a refusal or an unreadable list fails the seal closed) ----

async function api(path, token, { raw = false } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

async function listWhole(path, key, token, what) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const r = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, token);
    if (!Array.isArray(r?.[key])) throw new Error(`${what}: not a list`);
    all.push(...r[key]);
    if (r[key].length < 100) {
      if (Number.isSafeInteger(r.total_count) && all.length < r.total_count)
        throw new Error(`${what}: ${all.length} of ${r.total_count} read`);
      return all;
    }
  }
  throw new Error(`${what}: more than 1,000 listed, not whole`);
}

export function makeIo(repo, token) {
  const file = JOURNEYS_WORKFLOW.split('/').pop();
  return {
    pull: (n) => api(`/repos/${repo}/pulls/${n}`, token),
    runs: (sha) =>
      listWhole(`/repos/${repo}/actions/workflows/${file}/runs?head_sha=${sha}`, 'workflow_runs', token, `${file} runs on ${sha}`),
    async reportOf(run) {
      const arts = await listWhole(
        `/repos/${repo}/actions/runs/${run.id}/artifacts?name=${JOURNEYS_ARTIFACT}`,
        'artifacts',
        token,
        `run ${run.id}'s artifacts`,
      );
      const art = currentReportArtifact(run, arts);
      if (!art) return { error: `no ${JOURNEYS_ARTIFACT} artifact from its current attempt` };
      const dir = mkdtempSync(join(tmpdir(), 'journey-seal-'));
      try {
        const zip = join(dir, 'a.zip');
        writeFileSync(zip, await api(`/repos/${repo}/actions/artifacts/${art.id}/zip`, token, { raw: true }));
        const text = execFileSync('unzip', ['-p', zip, 'report.json'], { maxBuffer: 256 * 2 ** 20, encoding: 'utf8' });
        return { states: readReport(JSON.parse(text)).states, artifact: art.id };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    compare: (base, head) => api(`/repos/${repo}/compare/${base}...${head}?per_page=250`, token),
  };
}

/** One pull request's head, judged. */
export async function sealPull({ repo, number, sha, io, requireOpen = true }) {
  const pull = await io.pull(number);
  const head = String(pull?.head?.sha ?? '');
  if (!SHA40.test(head)) return { ok: false, lines: [`#${number}: its head could not be read`] };
  if (sha && head !== sha)
    return { ok: false, lines: [`#${number}: its head is now ${head}, not ${sha}; the newer head gets its own seal run`] };
  if (requireOpen && pull.state !== 'open') return { ok: false, lines: [`#${number}: is ${pull.state}`] };
  const v = await judgeSteps({
    sha: head,
    repo,
    title: pull.title,
    body: pull.body,
    runs: titleSteps(pull.title).length ? await io.runs(head) : [],
    reportOf: (r) => io.reportOf(r),
  });
  return { ...v, lines: v.lines.map((l) => `#${number} (${head.slice(0, 10)}): ${l}`) };
}

export const SEAL = 'CI merge seal';
const SEAL_POLL_MS = 20_000;
const SEAL_POLLS = 75; // 25 minutes: a running seal may be waiting out the CI review (review-marker.mjs, 20 minutes)

/**
 * What to do about a head's seal once its steps' inputs changed (a journeys run finished, a title or body was edited):
 * re-run it whatever its colour, since a newer run or an edit can turn a green seal red as well as a red one green.
 * `checkRuns`: the head's check runs named SEAL; `runStatus`: the status of the CI run holding the newest, once read.
 * Pure, so the table is testable.
 */
export function recheckStep(checkRuns, runStatus) {
  const seal = (checkRuns ?? []).filter((c) => c.name === SEAL).sort((a, b) => b.id - a.id)[0];
  if (!seal || seal.status === 'queued') return { act: 'done', msg: 'the seal has not started; it will read the steps itself' };
  if (seal.status !== 'completed') return { act: 'wait', msg: 'the seal is running and may have read the steps before this change' };
  const runId = /\/actions\/runs\/(\d+)/.exec(seal.details_url ?? '')?.[1];
  const jobId = /\/job\/(\d+)/.exec(seal.details_url ?? '')?.[1] ?? String(seal.id);
  if (!runId) return { act: 'fail', msg: `the seal check run ${seal.id} names no workflow run` };
  if (runStatus === undefined) return { act: 'run', runId, msg: `reading run ${runId}` };
  if (runStatus !== 'completed') return { act: 'wait', runId, msg: `run ${runId} is still finishing` };
  return { act: 'rerun', runId, jobId };
}

/** Re-run the seal job on `sha` (recheckStep). `post`/`get` are the API (tests pass their own). */
export async function rerunSealJob({ repo, sha, get, post, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  for (let poll = 1; ; poll++) {
    const c = await get(`/repos/${repo}/commits/${sha}/check-runs?check_name=${encodeURIComponent(SEAL)}&filter=all&per_page=100`);
    let step = recheckStep(c?.check_runs);
    if (step.act === 'run') step = recheckStep(c.check_runs, (await get(`/repos/${repo}/actions/runs/${step.runId}`))?.status);
    if (step.act === 'done') return step.msg;
    if (step.act === 'fail') throw new Error(step.msg);
    if (step.act === 'rerun') {
      const status = await post(`/repos/${repo}/actions/jobs/${step.jobId}/rerun`);
      if (status === 403) return `run ${step.runId} is already re-running`;
      if (status !== 201) throw new Error(`could not re-run the seal job ${step.jobId} of run ${step.runId}: HTTP ${status}`);
      return `re-ran the seal job ${step.jobId} of run ${step.runId}`;
    }
    if (poll >= SEAL_POLLS)
      throw new Error(`${step.msg} after ${(SEAL_POLLS * SEAL_POLL_MS) / 60_000} min; re-run the seal once it finishes`);
    if (poll === 1) log(`${step.msg}; checking every ${SEAL_POLL_MS / 1000}s`);
    await sleep(SEAL_POLL_MS);
  }
}

/**
 * journey-seal-recheck.yml: the open pull requests whose head is `sha` and whose title names steps now (or named them
 * before an edit, OLD_TITLE), each with its seal re-run. A head no open pull request names is left alone.
 */
async function recheck({ repo, token }) {
  const { SHA, PR_NUMBER, OLD_TITLE = '' } = process.env;
  if (!SHA40.test(SHA ?? '')) throw new Error('recheck needs SHA');
  const get = (path) => api(path, token);
  const post = async (path) =>
    (
      await fetch(`https://api.github.com${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' },
      })
    ).status;
  const pulls = PR_NUMBER
    ? [await get(`/repos/${repo}/pulls/${PR_NUMBER}`)]
    : await get(`/repos/${repo}/commits/${SHA}/pulls?per_page=100`);
  const mine = (pulls ?? []).filter((p) => p?.state === 'open' && p?.head?.sha === SHA && p?.base?.repo?.full_name === repo);
  const named = mine.filter((p) => titleSteps(p.title).length || titleSteps(OLD_TITLE).length);
  if (!named.length) return console.log(`no open pull request on ${SHA} names journey steps; the seal is left as it is`);
  console.log(
    `#${named.map((p) => p.number).join(', #')} on ${SHA} name journey steps: ${await rerunSealJob({ repo, sha: SHA, get, post })}`,
  );
}

function report({ ok, lines }, how) {
  for (const l of lines) console.log(l);
  if (ok) return console.log(`journey steps: ${how}`);
  console.error(
    `::error title=Named journey steps not green on this head::${lines
      .filter((l) => !/Left or replaced"$/.test(l))
      .join('; ')
      .slice(
        0,
        3000,
      )}. A pull request whose title names journey steps needs each one passing in a finished Real-app journeys run on its exact head (dispatch real-app-journeys.yml on the branch; the seal re-runs when it finishes), or the step listed by its full id under a "Left or replaced" heading in the body.`,
  );
  process.exit(1);
}

async function main() {
  const { GH_TOKEN, REPO } = process.env;
  if (!GH_TOKEN || !REPO) {
    console.error('::error::journey-seal needs GH_TOKEN and REPO');
    process.exit(1);
  }
  if (process.argv.includes('--recheck')) return recheck({ repo: REPO, token: GH_TOKEN });
  const io = makeIo(REPO, GH_TOKEN);
  const dry = process.argv.indexOf('--dry-run');
  if (dry > 0) {
    const [n, sha] = process.argv.slice(dry + 1);
    return report(await sealPull({ repo: REPO, number: Number(n), sha: sha || undefined, io, requireOpen: false }), 'dry run');
  }
  if (process.env.MERGE_GROUP_HEAD_SHA) {
    const { MERGE_GROUP_BASE_SHA: base, MERGE_GROUP_HEAD_SHA: head, MERGE_GROUP_HEAD_REF: headRef } = process.env;
    const commits = (await io.compare(base, head))?.commits;
    const numbers = groupPulls(commits, headRef);
    if (!numbers) return report({ ok: false, lines: [`the merge group ${headRef} could not be read whole`] }, '');
    const all = { ok: true, lines: [] };
    for (const n of numbers) {
      const v = await sealPull({ repo: REPO, number: n, io });
      all.ok &&= v.ok;
      all.lines.push(...v.lines);
    }
    return report(all, 'every queued pull request that names steps has them green or left on its own head');
  }
  const { HEAD_SHA, PR_NUMBER } = process.env;
  if (!PR_NUMBER) return console.log('not a pull request: no journey steps to read');
  if (!SHA40.test(HEAD_SHA ?? '')) {
    console.error('::error::journey-seal needs HEAD_SHA on a pull request');
    process.exit(1);
  }
  return report(
    await sealPull({ repo: REPO, number: Number(PR_NUMBER), sha: HEAD_SHA, io }),
    'each named step is green or left on this head',
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => {
    console.error(`::error title=Named journey steps unreadable::${e.message}; the seal fails closed`);
    process.exit(1);
  });
