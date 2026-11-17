#!/usr/bin/env node
/**
 * Scores a judge's brief on the real cases kept beside it (project-state#2847): the CI review's
 * (ci-review/REVIEW.md, its cases ci-review/cases.json) and the proof reader's (test-judge/READ.md, its cases
 * test-judge/read-cases.json). Each case is asked the way the CI review job asks it: the same prompt builder, the
 * same model, effort, tools and system text, read from .github/workflows/ci-review.yml so they can't drift. The calls
 * run on the signed-in reviewer CLI (`claude`), never in CI.
 *
 *   node tooling/ci/brief-cases.mjs review|read [--brief <file>] [--drop <text>] [--only <id,id>] [--jobs <n>]
 *        [--words <project-state clone>] [--out <dir>]
 *
 * `--drop <text>` scores the brief with the one line holding <text> removed: a case set that scores the same without a
 * line doesn't test it. A change to a brief shows its score before and after in its pull request.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
  const model = /READER_MODEL: (\S+)/.exec(yml);
  const effort = /READER_EFFORT: (\S+)/.exec(yml);
  if (reads.length !== 2 || caps.length < 2 || !review || !model || !effort)
    throw new Error('ci-review.yml no longer has the calls brief-cases.mjs reads; update jobCall');
  return {
    review: { reads: reads[0], model: review[1], effort: review[2], turns: caps[0][0], budget: caps[0][1] },
    read: { reads: reads[1], model: model[1], effort: effort[1], turns: caps.at(-1)[0], budget: caps.at(-1)[1] },
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

/** The tree at `sha`, exported (no .git), for the judge's Read, Grep and Glob. */
function exportTree(sha, dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', ROOT, sha, dir]);
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
    const p = spawn('claude', args, { cwd: empty, stdio: ['pipe', 'pipe', 'pipe'] });
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

async function runReview(c, brief, call, work) {
  const head = git('rev-parse', c.head).trim();
  const base = git('rev-parse', c.base).trim();
  // The diff as the job's local replay makes it (rename detection on, no .gitattributes), from the merge base.
  const { diff } = await gitSource(ROOT, head).diff(base, head);
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES)
    throw new Error(`${c.id}: the diff is over ${MAX_DIFF_BYTES} bytes; pick a case the job reviews in one call`);
  const repo = join(work, 'repo');
  exportTree(base, repo);
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

async function runRead(c, brief, call, work, clone) {
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
  const repo = join(work, 'repo');
  const pics = join(work, 'pictures');
  exportTree(head, repo);
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
      'usage: brief-cases.mjs review|read [--brief <file>] [--drop <text>] [--only <id,id>] [--jobs <n>] [--words <project-state clone>] [--out <dir>]',
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
  console.log(
    `${judge}: ${cases.length} cases on ${call.model} at ${call.effort}${arg('--drop') ? `, without the line holding "${arg('--drop')}"` : ''}; answers in ${out}`,
  );
  const results = [];
  const queue = [...cases];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const work = join(out, c.id);
      mkdirSync(work, { recursive: true });
      let r;
      try {
        r = judge === 'review' ? await runReview(c, brief, call, work) : await runRead(c, brief, call, work, clone);
      } catch (e) {
        r = { score: 0, got: `error: ${e.message}` };
      }
      results.push({ id: c.id, kind: c.kind, ...r });
      console.log(`${c.kind.padEnd(7)} ${c.id.padEnd(24)} ${String(r.score).padEnd(3)} ${r.got}`);
    }
  };
  await Promise.all(Array.from({ length: jobs }, worker));
  writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 1));
  const t = totals(results);
  console.log(`score: bad ${t.bad} of ${t.badOf}; controls passed ${t.controls} of ${t.controlsOf}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
