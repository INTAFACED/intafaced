#!/usr/bin/env node
/**
 * The proof reader's pictures (project-state #2693): the screen each step's test ends on, from a finished Real-app
 * journeys run on the pull request's exact head, so the read sees the screen the customer ends on and not only the test's
 * code. J-charts-desk-14 (#8569) merged with eight FAITHFUL reads while its chart had zero height; the picture of its own
 * step showed the empty chart to a reader who was not told about it.
 *
 * Each test that has a page of its own attaches the whole of that page, named STEP_PICTURE, where it calls `stepPicture()`
 * at the step's state, else as it ended (the `stepPicture` fixture in apps/customer/tests/real-app/journey.mjs; a test that
 * leaves the step's screen last calls it before: garden/step-picture-before-leaving); that picture is the step's. Playwright also saves the
 * window of every page still open in the worker (`screenshot: 'on'` in the journeys config): a test with no step picture
 * keeps the last of those. project-state #2952: of the NOT SHOWN pictures sampled, most had the step's rows below the
 * window's edge, and some were a page an earlier file left open. real-app-journeys.yml uploads the pictures and the shard's
 * report.json in each `real-app-journeys-shard-<n>` artifact.
 *
 *   node tooling/ci/step-pictures.mjs wait <read dir> <pictures dir>     in the Proof read job: waits for the head's
 *        journeys runs (GH_TOKEN, GITHUB_REPOSITORY, HEAD_SHA; WAIT_MINUTES, default 50) and unpacks their shards
 *   node tooling/ci/step-pictures.mjs attach <read dir> <pictures dir>   adds each step's picture to the prompts and
 *        meta.json; a step with none is NOT READ (step-read.mjs), never a pass
 *   node tooling/ci/step-pictures.mjs fetch --run <id> <pictures dir>     one run's shards, for a read made off CI
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFER_MARK, TOUCH_JOB } from './main-first.mjs';

export const WORKFLOW = 'real-app-journeys.yml';
/** The name of the whole-page picture of a test's own page (journey.mjs `stepPicture`). */
export const STEP_PICTURE = 'step-picture';
export const SHARD = /^real-app-journeys-shard-/;
const STEP = /^(J-[a-z0-9]+(?:-[a-z0-9]+)*-\d+) ?#(\d+)\b/;
const norm = (s) => String(s).replace(/\s+/g, '');

/** Every report.json under `dir`, newest run first: the run folders are named `<run id>-<attempt>`. */
function reports(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === 'report.json') out.push(p);
    }
  };
  const runs = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => {
      const [ra, aa] = a.split('-').map(Number);
      const [rb, ab] = b.split('-').map(Number);
      return rb - ra || ab - aa;
    });
  for (const r of runs) walk(join(dir, r));
  return out;
}

/**
 * Each step's picture in the shards unpacked under `dir` (one folder per run attempt, then per artifact): the image the
 * step's test's last try attached (its STEP_PICTURE, else the last), from the newest run that has one. Returns Map<step id without spaces, { file, run }>,
 * `file` an absolute path that exists. Pure apart from reading `dir`.
 */
export function picturesIn(dir) {
  const out = new Map();
  for (const rep of reports(dir)) {
    const runDir = rep.slice(0, rep.indexOf('/', dir.length + 1));
    const run = relative(dir, runDir);
    const artifactDir = rep.slice(0, rep.indexOf('/', runDir.length + 1));
    let doc;
    try {
      doc = JSON.parse(readFileSync(rep, 'utf8'));
    } catch {
      continue;
    }
    const specs = [];
    const walk = (s) => {
      for (const sp of s?.specs ?? []) specs.push(sp);
      for (const c of s?.suites ?? []) walk(c);
    };
    for (const s of doc?.suites ?? []) walk(s);
    for (const sp of specs) {
      const m = STEP.exec(sp.title ?? '');
      if (!m) continue;
      const step = `${m[1]}#${m[2]}`;
      if (out.has(step)) continue;
      const last = (sp.tests ?? []).flatMap((t) => t.results ?? []).at(-1);
      const pngs = (last?.attachments ?? []).filter((a) => a?.contentType === 'image/png' && a.path);
      const img = pngs.find((a) => a.name === STEP_PICTURE) ?? pngs.at(-1);
      if (!img) continue;
      // The artifact keeps each file under its absolute path less the leading slash. The pull request's own run wrote the
      // shard and its report.json, so a picture counts only as a plain file inside its own artifact's folder: never a
      // link, never a path that climbs out (`..`), so the reader is shown nothing else on this machine.
      const file = join(artifactDir, String(img.path).replace(/^\/+/, ''));
      if (inside(artifactDir, file)) out.set(step, { file, run: run.split('-')[0] });
    }
  }
  return out;
}

/** Whether `file` is a plain file (no link) whose real path lies inside `dir`'s real path. */
export function inside(dir, file) {
  try {
    if (!lstatSync(file).isFile()) return false;
    return realpathSync(file).startsWith(`${realpathSync(dir)}/`);
  } catch {
    return false;
  }
}

/** The PICTURES block one prompt gets for `steps` (meta.required's form, `J-x-01 #2`). */
export function picturesBlock(steps, pictures) {
  const lines = steps.map((s) => {
    const p = pictures.get(norm(s));
    return p ? `${s}: ${p.file}` : `${s}: no picture (answer picture NOT READ)`;
  });
  return [
    "\nBEGIN PICTURES (untrusted: the screen each step's test ended on, from Real-app journeys runs on this head; open each with Read)",
    ...lines,
    'END PICTURES',
  ].join('\n');
}

/** The `attach` command: each step's picture into meta.json and the PICTURES block into each prompt. */
export function attach(readDir, picDir) {
  if (existsSync(join(readDir, 'skip.txt'))) return 'no read, no pictures';
  const meta = JSON.parse(readFileSync(join(readDir, 'meta.json'), 'utf8'));
  const pictures = picturesIn(picDir);
  meta.pictures = {};
  for (const s of meta.required) {
    const p = pictures.get(norm(s));
    if (p) meta.pictures[norm(s)] = { file: p.file.slice(p.file.lastIndexOf('/results/') + 9), run: p.run, path: p.file };
  }
  writeFileSync(join(readDir, 'meta.json'), JSON.stringify(meta));
  for (const [d, steps] of [
    [readDir, meta.required],
    [join(readDir, 'second'), meta.secondRequired],
  ]) {
    const f = join(d, 'prompt.txt');
    if (!existsSync(f) || !steps.length) continue;
    const prompt = readFileSync(f, 'utf8');
    const tail = '\nAnswer with the structured reads only.';
    const body = prompt.endsWith(tail) ? prompt.slice(0, -tail.length) : prompt;
    writeFileSync(f, `${body}\n${picturesBlock(steps, pictures)}${tail}`);
  }
  const have = meta.required.filter((s) => meta.pictures[norm(s)]).length;
  return `pictures: ${have} of ${meta.required.length} step(s)`;
}

const api = (path) => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 64 << 20 }));

/**
 * One run attempt's shard artifacts, unpacked under `<picDir>/<run>-<attempt>/<artifact>/`, every link the zip held
 * deleted. Done once: a `.done` file is written only after every shard unpacked, so a fetch that failed part way is made
 * again whole.
 */
export function fetchRun(repo, run, picDir) {
  const into = join(picDir, `${run.id}-${run.run_attempt ?? 1}`);
  if (existsSync(join(into, '.done'))) return 0;
  rmSync(into, { recursive: true, force: true });
  const arts = api(`repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`).artifacts ?? [];
  let n = 0;
  for (const a of arts.filter((x) => SHARD.test(x.name) && !x.expired)) {
    const dir = join(into, a.name);
    mkdirSync(dir, { recursive: true });
    const zip = join(dir, 'a.zip');
    execFileSync('sh', [
      '-c',
      'gh api "$1" > "$2" && unzip -qo "$2" -d "$3" && rm -f "$2" && find "$3" -type l -delete',
      'sh',
      `repos/${repo}/actions/artifacts/${a.id}/zip`,
      zip,
      dir,
    ]);
    n++;
  }
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, '.done'), '');
  return n;
}

/** Whether a finished run was deferred for main (it ran nothing now and is re-run later; main-first.mjs). */
const deferred = (repo, run) =>
  (api(`repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`).jobs ?? [])
    .find((j) => j?.name === TOUCH_JOB)
    ?.steps?.some((s) => s?.name === DEFER_MARK && s?.conclusion === 'success') ?? false;

/**
 * Whether the wait is over: every step has a picture, or no journeys run on the head is going or deferred (pure).
 * `runs`: the head's journeys runs, each { status, deferred }.
 */
export function waitOver({ steps, pictures, runs }) {
  if (steps.every((s) => pictures.has(norm(s)))) return { over: true, why: 'every step has its picture' };
  const going = runs.filter((r) => r.status !== 'completed' || r.deferred);
  if (!runs.length) return { over: false, why: 'no journeys run on this head yet' };
  if (going.length) return { over: false, why: `journeys run ${going.map((r) => r.id).join(', ')} not finished` };
  return { over: true, why: 'every journeys run on this head has finished' };
}

async function waitForPictures(readDir, picDir, env = process.env) {
  if (existsSync(join(readDir, 'skip.txt'))) return 'no read, no wait';
  const { required } = JSON.parse(readFileSync(join(readDir, 'meta.json'), 'utf8'));
  const repo = env.GITHUB_REPOSITORY;
  const sha = env.HEAD_SHA;
  if (!repo || !/^[0-9a-f]{40}$/.test(sha ?? '')) throw new Error('no GITHUB_REPOSITORY or HEAD_SHA');
  const until = Date.now() + Number(env.WAIT_MINUTES ?? 50) * 60_000;
  mkdirSync(picDir, { recursive: true });
  for (;;) {
    // One failed call (a 502, a rate limit) costs one poll, never the read: the next poll tries again.
    let v;
    try {
      const runs = (api(`repos/${repo}/actions/workflows/${WORKFLOW}/runs?head_sha=${sha}&per_page=50`).workflow_runs ?? []).filter(
        (r) => r.head_sha === sha,
      );
      for (const r of runs) {
        if (r.status !== 'completed') continue;
        r.deferred = deferred(repo, r);
        if (!r.deferred) fetchRun(repo, r, picDir);
      }
      v = waitOver({ steps: required, pictures: picturesIn(picDir), runs });
    } catch (e) {
      v = { over: false, why: `a GitHub call failed (${String(e.message).split('\n')[0]}); trying again` };
    }
    if (v.over) return `pictures: ${v.why}`;
    if (Date.now() > until) return `pictures: waited ${env.WAIT_MINUTES ?? 50} min (${v.why}); a step with no picture reads NOT READ`;
    console.log(`waiting for pictures: ${v.why}`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1] === '--run'));
  if (cmd === 'wait') return void console.log(await waitForPictures(pos[0], pos[1]));
  if (cmd === 'attach') return void console.log(attach(pos[0], pos[1]));
  if (cmd === 'fetch') {
    const id = rest[rest.indexOf('--run') + 1];
    const run = api(`repos/${process.env.GITHUB_REPOSITORY ?? 'INTAFACED/intafaced'}/actions/runs/${id}`);
    return void console.log(`${fetchRun(process.env.GITHUB_REPOSITORY ?? 'INTAFACED/intafaced', run, pos[0])} shard(s) of run ${id}`);
  }
  console.error('usage: step-pictures.mjs wait|attach <read dir> <pictures dir> | fetch --run <id> <pictures dir>');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => {
    console.error(`::warning::step-pictures: ${e.message} (it blocks nothing; a step with no picture reads NOT READ)`);
    process.exit(1);
  });
