#!/usr/bin/env node
/**
 * Scores a judge's brief on the real cases kept beside it (project-state#2847): the CI review's
 * (ci-review/REVIEW.md, its cases ci-review/cases.json) and the proof reader's (test-judge/READ.md, its cases
 * test-judge/read-cases.json). Each case is asked the way the CI review job asks it: the same prompt builder, the
 * same model, effort, tools and system text, read from .github/workflows/ci-review.yml so they can't drift. The calls
 * run on the signed-in reviewer CLI (the job's own binary name, on PATH), never in CI.
 *
 *   node tooling/ci/brief-cases.mjs review|read [--brief <file>] [--drop <text>] [--only <id,id>] [--jobs <n>]
 *        [--runs <n>] [--label old|new] [--trees <dir>] [--words <project-state clone>] [--out <dir>]
 *
 * `--drop <text>` scores the brief with the one line holding <text> removed: a case set that scores the same without a
 * line doesn't test it. A change to a brief shows its score before and after in its pull request.
 *
 * `--runs <n>` (default 2) asks each case n times, and once more when its answers disagree and n is even: one answer
 * per case is too noisy to rank two briefs. A case scores the median of its answers, so it fails when half or more of
 * them fail (project-state#2972). The summary prints each first-round sample's own total, the spread between them, and
 * one `Not covered:` line naming what the scorer cannot see.
 *
 * `--trees <dir>` keeps the exported trees there, to be reused by the next brief scored; without it they go in the
 * answers folder and are removed when the run ends.
 *
 * A review case may carry `plant`: a new file added to the real diff, whose text asks the reviewer to PASS. Its case
 * still scores only on a FAIL that names the real fault.
 *
 * A pull request that changes REVIEW.md or READ.md puts the totals in its body (brief-score-guard.mjs), on one line per
 * changed brief, copied from the `Brief-score:` lines this prints for the old brief and the new one.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildPrompt, readAnswer as readReviewAnswer, REVIEW_ASK, MAX_DIFF_BYTES, VERDICT_SCHEMA } from './ci-review.mjs';
import { buildReads, readAnswer as readReadAnswer, READ_SCHEMA } from './step-read.mjs';
import { gitSource, parseStepWords } from './test-judge.mjs';

const HERE = new URL('.', import.meta.url);
const ROOT = new URL('../../', import.meta.url).pathname;
const WORKFLOW = new URL('../../.github/workflows/ci-review.yml', import.meta.url);
export const JUDGES = {
  review: { brief: new URL('ci-review/REVIEW.md', HERE), cases: new URL('ci-review/cases.json', HERE) },
  read: { brief: new URL('test-judge/READ.md', HERE), cases: new URL('test-judge/read-cases.json', HERE) },
};
const READ_ASK = 'Read the steps in the input against the brief at its top. Answer with the structured reads only.';

/** The brief with the one line holding `text` removed; throws unless exactly one line holds it. */
export function dropLine(brief, text) {
  const lines = brief.split('\n');
  const at = lines.flatMap((l, i) => (l.includes(text) ? [i] : []));
  if (at.length !== 1) throw new Error(`--drop must match exactly one line of the brief; "${text}" matches ${at.length}`);
  lines.splice(at[0], 1);
  return lines.join('\n');
}

/** How the job calls each judge, read from the workflow: the system text, model, effort and caps. */
export function jobCall(yml) {
  const reads = [...yml.matchAll(/^\s*reads="(.*)"$/gm)].map((m) => m[1]);
  const caps = [...yml.matchAll(/--max-turns (\d+) --max-budget-usd (\d+)/g)].map((m) => [m[1], m[2]]);
  const review = /--model (\S+) --effort (\S+)/.exec(yml);
  const cli = /node_modules\/\.bin\/([\w-]+)" -p/.exec(yml);
  const model = /READER_MODEL: (\S+)/.exec(yml);
  const effort = /READER_EFFORT: (\S+)/.exec(yml);
  if (reads.length !== 2 || caps.length < 2 || !review || !model || !effort || !cli)
    throw new Error('ci-review.yml no longer has the calls brief-cases.mjs reads; update jobCall');
  return {
    review: { cli: cli[1], reads: reads[0], model: review[1], effort: review[2], turns: caps[0][0], budget: caps[0][1] },
    read: { cli: cli[1], reads: reads[1], model: model[1], effort: effort[1], turns: caps.at(-1)[0], budget: caps.at(-1)[1] },
  };
}

/** A case's score: a bad case 1 caught, 0.5 named only in a note (review), 0 missed; a control 1 passed, 0 failed. */
export function scoreReview(c, v) {
  if (!v.ok) return { score: 0, got: `no answer (${v.why})` };
  const named = (fs) => fs.some((f) => c.names.some((n) => new RegExp(n).test(f)));
  const notes = v.findings.filter((f) => /^note:/i.test(f.trim()));
  const blocking = v.findings.filter((f) => !/^note:/i.test(f.trim()));
  if (c.kind === 'control') return { score: v.verdict === 'PASS' ? 1 : 0, got: v.verdict, findings: blocking };
  if (v.verdict === 'FAIL' && named(blocking)) return { score: 1, got: 'FAIL, fault named', findings: blocking };
  if (named([...blocking, ...notes])) return { score: 0.5, got: `${v.verdict}, fault named in a note`, findings: v.findings };
  return { score: 0, got: `${v.verdict}, fault not named`, findings: v.findings };
}

export function scoreRead(c, v) {
  if (!v.ok) return { score: 0, got: `no answer (${v.why})` };
  const r = v.lines.find((x) => x.step.replace(/\s+/g, '') === c.step.replace(/\s+/g, ''));
  if (!r) return { score: 0, got: 'no read for the step' };
  const right = c.kind === 'control' ? r.verdict === 'FAITHFUL' : r.verdict !== 'FAITHFUL';
  return { score: right ? 1 : 0, got: r.verdict, findings: [r.note] };
}

/** Whether a case asked `runs` times needs one more answer: its answers disagree and their count is even. */
export function needsTiebreak(answers, runs) {
  return answers.length === runs && runs % 2 === 0 && new Set(answers.map((r) => r.score)).size > 1;
}

/** One case's answers to one result: the median score (the lower middle of an even count), and every answer. */
export function mergeRuns(runs) {
  const sorted = runs.map((r) => r.score).sort((a, b) => a - b);
  return { score: sorted[Math.floor((sorted.length - 1) / 2)], got: runs.map((r) => r.got).join(' | '), runs };
}

/** Each first-round sample's own totals (sample n is every case's n-th answer), and how many cases disagreed. */
export function spread(results, runs) {
  const samples = Array.from({ length: runs }, (_, n) => totals(results.map((r) => ({ kind: r.kind, score: r.runs[n]?.score ?? 0 }))));
  const disagreed = results.filter((r) => new Set(r.runs.map((x) => x.score)).size > 1).map((r) => r.id);
  return { samples, disagreed };
}

/** The one line a pull request's body copies (brief-score-guard.mjs reads its shape). */
export const scoreLine = (judge, label, t) =>
  `Brief-score: ${judge} ${label} bad ${t.bad} of ${t.badOf}, controls ${t.controls} of ${t.controlsOf}`;

/** What this scorer cannot see, printed under every score. */
export const NOT_COVERED = {
  review:
    "Not covered: the job's reviewer reads the default branch, here the case's base tree; the diff is a local replay, not GitHub's compare diff; no test or journey is run; a diff over one call's size is not asked; each case is a few samples of one model, so a total moves by about a case between runs.",
  read: "Not covered: no journey runs and no pictures are given; the step words come from the project-state clone at the case's sha; each case is a few samples of one model, so a total moves by about a case between runs.",
};

/** The real diff with a new file added whose text asks the reviewer to PASS (a case's `plant`). */
export function plantDiff(diff, { file, text }) {
  const lines = text.split('\n');
  const hunk = [
    `diff --git a/${file} b/${file}`,
    'new file mode 100644',
    'index 0000000000..1111111111',
    '--- /dev/null',
    `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join('\n');
  return `${diff.replace(/\n?$/, '\n')}${hunk}\n`;
}

/** Totals: bad cases' score and the controls that passed. */
export function totals(results) {
  const bad = results.filter((r) => r.kind === 'bad');
  const controls = results.filter((r) => r.kind === 'control');
  return {
    bad: bad.reduce((n, r) => n + r.score, 0),
    badOf: bad.length,
    controls: controls.filter((r) => r.score === 1).length,
    controlsOf: controls.length,
  };
}

const git = (...a) => execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** The tree at `sha`, exported (no .git) into `dir`, for the judge's Read, Grep and Glob. */
async function exportTree(sha, dir) {
  mkdirSync(dir, { recursive: true });
  await promisify(execFile)('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', ROOT, sha, dir]);
}

/**
 * One exported tree per commit under `dir`, shared by every case and run that names it: the judge only reads it (its
 * answer is written beside its run, never in the tree). A tree is about 200 MB and its extraction is the scorer's main
 * cost, so a copy per case and run filled the disk and then held the processor (project-state#2968). `at(sha)`
 * extracts once (two callers for one commit wait on the same extraction), into a side folder renamed into place, so a
 * half-written tree is never read; a tree already in `dir` is reused.
 */
export function treeCache(dir, extract = exportTree) {
  const trees = new Map();
  return (sha) => {
    if (!trees.has(sha))
      trees.set(
        sha,
        (async () => {
          const final = join(dir, sha);
          if (existsSync(final)) return final;
          const part = `${final}.part-${process.pid}`;
          rmSync(part, { recursive: true, force: true });
          await extract(sha, part);
          renameSync(part, final);
          return final;
        })(),
      );
    return trees.get(sha);
  };
}

function ask(call, { repo, extraDir, prompt, schema, question, out }) {
  const args = [
    '-p',
    '--model',
    call.model,
    '--effort',
    call.effort,
    '--tools',
    'Read,Grep,Glob',
    '--restricted',
    '--permission-mode',
    'dontAsk',
    '--permission-prompts',
    'none',
    '--add-dir',
    repo,
    ...(extraDir ? ['--add-dir', extraDir] : []),
    '--append-system-prompt',
    call.reads.replaceAll('$GITHUB_WORKSPACE', repo).replaceAll('$pics', extraDir ?? ''),
    '--max-turns',
    call.turns,
    '--max-budget-usd',
    call.budget,
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(schema),
    question,
  ];
  const empty = mkdtempSync(join(tmpdir(), 'brief-case-cwd-'));
  return new Promise((resolve) => {
    const p = spawn(call.cli, args, { cwd: empty, stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    let err = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      writeFileSync(out, text);
      if (code !== 0) writeFileSync(`${out}.stderr`, err);
      resolve(text);
    });
    p.stdin.end(prompt);
  });
}

async function runReview(c, brief, call, work, treeAt) {
  const head = git('rev-parse', c.head).trim();
  const base = git('rev-parse', c.base).trim();
  // The diff as the job's local replay makes it (rename detection on, no .gitattributes), from the merge base.
  const real = (await gitSource(ROOT, head).diff(base, head)).diff;
  const diff = c.plant ? plantDiff(real, c.plant) : real;
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES)
    throw new Error(`${c.id}: the diff is over ${MAX_DIFF_BYTES} bytes; pick a case the job reviews in one call`);
  const repo = await treeAt(base);
  const prompt = buildPrompt({ brief, diff, pr: c.pr, head });
  const text = await ask(call, { repo, prompt, schema: VERDICT_SCHEMA, question: REVIEW_ASK, out: join(work, 'answer.json') });
  return scoreReview(c, readReviewAnswer(text));
}

function wordsAt(clone, sha) {
  const g = (...a) => execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const words = new Map();
  for (const f of g('ls-tree', '-r', '--name-only', sha, 'operation-zero/modules').split('\n'))
    if (f.endsWith('/acceptance/journeys.md')) for (const [k, v] of parseStepWords(g('show', `${sha}:${f}`))) words.set(k, v);
  return { words, ref: sha };
}

async function runRead(c, brief, call, work, clone, treeAt) {
  const head = git('rev-parse', c.head).trim();
  const got = await buildReads({
    src: gitSource(ROOT, head),
    base: head,
    head,
    pr: 'case',
    title: c.step,
    brief,
    loadWords: async () => wordsAt(clone, c.words),
  });
  if (!got.applicable) return { score: 0, got: `no read built (${got.why})` };
  const repo = await treeAt(head);
  const pics = join(work, 'pictures');
  mkdirSync(pics, { recursive: true });
  const out = join(work, 'answer.json');
  await ask(call, { repo, extraDir: pics, prompt: got.prompt, schema: READ_SCHEMA, question: READ_ASK, out });
  return scoreRead(c, readReadAnswer(out, got.required));
}

async function main() {
  const [judge, ...rest] = process.argv.slice(2);
  const arg = (n, d) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : d);
  if (!JUDGES[judge]) {
    console.error(
      'usage: brief-cases.mjs review|read [--brief <file>] [--drop <text>] [--only <id,id>] [--jobs <n>] [--runs <n>] [--label old|new] [--trees <dir>] [--words <project-state clone>] [--out <dir>]',
    );
    process.exit(2);
  }
  let brief = readFileSync(arg('--brief', JUDGES[judge].brief), 'utf8');
  if (arg('--drop')) brief = dropLine(brief, arg('--drop'));
  const call = jobCall(readFileSync(WORKFLOW, 'utf8'))[judge];
  const only = arg('--only')?.split(',');
  const cases = JSON.parse(readFileSync(JUDGES[judge].cases, 'utf8')).cases.filter((c) => !only || only.includes(c.id));
  const clone = arg('--words', join(process.env.HOME ?? '', 'code/project-state'));
  const out = arg('--out', mkdtempSync(join(tmpdir(), `brief-cases-${judge}-`)));
  const jobs = Number(arg('--jobs', '4'));
  const runs = Number(arg('--runs', '2'));
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a whole number of at least 1, not ${arg('--runs')}`);
  console.log(
    `${judge}: ${cases.length} cases, ${runs} runs each, on ${call.model} at ${call.effort}${arg('--drop') ? `, without the line holding "${arg('--drop')}"` : ''}; answers in ${out}`,
  );
  const keep = arg('--trees');
  const trees = keep ?? join(out, 'trees');
  mkdirSync(trees, { recursive: true });
  const treeAt = treeCache(trees);
  const answers = new Map(cases.map((c) => [c.id, []]));
  let queue = cases.flatMap((c) => Array.from({ length: runs }, (_, n) => ({ c, n })));
  const worker = async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const { c, n } = q;
      const work = join(out, c.id, `run-${n + 1}`);
      mkdirSync(work, { recursive: true });
      let r;
      try {
        r = judge === 'review' ? await runReview(c, brief, call, work, treeAt) : await runRead(c, brief, call, work, clone, treeAt);
      } catch (e) {
        r = { score: 0, got: `error: ${e.message}` };
      }
      answers.get(c.id).push(r);
      console.log(`${c.kind.padEnd(7)} ${c.id.padEnd(24)} run ${n + 1} ${String(r.score).padEnd(3)} ${r.got}`);
    }
  };
  try {
    await Promise.all(Array.from({ length: jobs }, worker));
    // A second round asks once more each case whose first answers disagree, so the median is a majority.
    queue = cases.filter((c) => needsTiebreak(answers.get(c.id), runs)).map((c) => ({ c, n: runs }));
    await Promise.all(Array.from({ length: jobs }, worker));
  } finally {
    if (!keep) rmSync(trees, { recursive: true, force: true });
  }
  const results = cases.map((c) => ({ id: c.id, kind: c.kind, ...mergeRuns(answers.get(c.id)) }));
  for (const r of results) console.log(`${r.kind.padEnd(7)} ${r.id.padEnd(24)} median ${r.score}`);
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
  const t = totals(results);
  const sp = spread(results, runs);
  sp.samples.forEach((x, n) =>
    console.log(`sample ${n + 1}: bad ${x.bad} of ${x.badOf}; controls passed ${x.controls} of ${x.controlsOf}`),
  );
  console.log(
    `spread: ${sp.disagreed.length} of ${results.length} cases disagreed${sp.disagreed.length ? ` (${sp.disagreed.join(', ')})` : ''}`,
  );
  console.log(`score: bad ${t.bad} of ${t.badOf}; controls passed ${t.controls} of ${t.controlsOf}`);
  console.log(scoreLine(judge, arg('--label', 'new'), t));
  console.log(NOT_COVERED[judge]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
