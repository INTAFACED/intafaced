#!/usr/bin/env node
/**
 * The proof read of a pull request's steps, made by the CI review job as a check on the pull request (project-state
 * OWNER.md item 251 (3): "the proof reader becomes a check on the PR, not a separate records PR afterwards"; item 250
 * (2): proof readers run on the cheaper model; project-state #1574). For each step the title claims (less a
 * `Left-or-replaced:` step) and each step whose own test the pull request changes, it asks project-state
 * `tooling/proof-v2/READER.md` step 3's question (its brief here: test-judge/READ.md), in its own call on the readers'
 * model, and publishes the answer as the step's read: the artifact `proof-v2-read-<head>` that project-state's store
 * takes for the merged head (`tooling/proof-v2/ci-read.mjs`), and the commit status `proof v2 read`.
 *
 * It blocks no merge, and no required check reads it (OWNER 257: nothing new may block a merge). The review and its test
 * part (test-judge.mjs, in the review's own call) decide the merge as before; the read only feeds the count, where a
 * WEAK or MISMATCH leaves the step unproven.
 *
 *   node tooling/ci/step-read.mjs prepare <dir>          in the job: the event's pull request, read through the API
 *   node tooling/ci/step-read.mjs read <dir>             the reader's answers into read.json, read-second.json, status.tsv
 *   node tooling/ci/step-read.mjs local --repo <clone> --base <sha> --head <sha> --words <dir> [--title <t>] [--run-id <n>] <dir>
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  HARNESS,
  JOURNEY_FILE,
  MAX_PROMPT_BYTES,
  WORD_FIELDS,
  ciSource,
  fence,
  gitSource,
  journeyOfFile,
  parseDiff,
  readWordsApi,
  readWordsLocal,
  redact,
  shingles,
  stepsTouched,
  testsIn,
} from './test-judge.mjs';

export const READ_BRIEF = new URL('./test-judge/READ.md', import.meta.url);
export const READ_VERDICTS = ['FAITHFUL', 'WEAK', 'MISMATCH'];
/** The most steps one call reads; more, and none is read (the count requests them as before). */
export const MAX_READS = 150;

// The count of record's sample (project-state tooling/truth/SCOREBOARD.md): the second, blind reader is asked for the steps
// the count samples, sha256 of `<step>|run:<this run's id>` below 15%, a seed nobody knows before the run starts; with no
// run id, every step. Money steps get no second reader of their own until launch hardening (project-state OWNER 296).
export const countKey = (step) => String(step).replace(/\s+/g, '');
export function countSample(step, seed) {
  if (!seed) return true;
  const h = createHash('sha256')
    .update(`${countKey(step)}|${seed}`)
    .digest();
  return h.readUInt32BE(0) / 2 ** 32 < 0.15;
}
export const secondReason = (step, { seed }) => (countSample(step, seed) ? '15% sample' : null);

const READ_ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      step: { type: 'string' },
      verdict: { type: 'string', enum: READ_VERDICTS },
      refusal: { type: 'boolean' },
      note: { type: 'string' },
    },
    required: ['step', 'verdict', 'refusal', 'note'],
    additionalProperties: false,
  },
};
/** The structured answer each reader call gives (-p --json-schema). */
export const READ_SCHEMA = { type: 'object', properties: { reads: READ_ITEMS }, required: ['reads'], additionalProperties: false };

const norm = (s) => String(s).replace(/\s+/g, ' ').replace(/ ?# ?/, ' #').trim();

/**
 * The read's input for one pull request at `head`. `src` is test-judge.mjs's source (ciSource or gitSource); the words
 * are loaded only when a step needs reading. Returns { applicable, why } when nothing is read, else { prompt, second,
 * required, secondRequired, read, shingleTexts, wordsRef }.
 */
export async function buildReads({
  src,
  base,
  head,
  pr,
  title = '',
  body = '',
  loadWords,
  runId = null,
  brief = readFileSync(READ_BRIEF, 'utf8'),
}) {
  // Loaded here, not at the top: journey-seal.mjs reaches test-judge.mjs again through review-marker.mjs.
  const { titleSteps, exemptions } = await import('./journey-seal.mjs');
  const leftOut = exemptions(body).steps;
  const claimed = new Set(
    titleSteps(title)
      .filter((k) => !leftOut.has(k))
      .map((k) => k.replace('#', ' #')),
  );
  const { diff, mergeBase } = await src.diff(base, head);
  const changed = parseDiff(diff).filter((f) => JOURNEY_FILE.test(f.path) || (f.oldPath && JOURNEY_FILE.test(f.oldPath)));
  const own = new Set();
  const after = new Map();
  for (const f of changed) {
    if (f.binary || !f.newPath) continue;
    const j = journeyOfFile(f.path) ?? journeyOfFile(f.oldPath);
    const before = f.oldPath ? await src.read(mergeBase, f.oldPath) : null;
    const now = await src.read(head, f.newPath);
    after.set(f.newPath, now);
    const lines = (t) => Array.from({ length: String(t ?? '').split('\n').length }, (_, i) => i + 1);
    const t = stepsTouched({
      journey: j,
      before,
      after: now,
      removed: f.whole === 'old' ? lines(before) : f.removed,
      added: f.whole === 'new' ? lines(now) : f.added,
    });
    for (const s of t.own) own.add(s);
  }
  if (own.size === 0 && claimed.size === 0) return { applicable: false, why: 'the title claims no step and no step’s own test changed' };

  // Each step by its test at the head, in whichever file of its journey holds it (a split journey file included).
  const wanted = new Set([...own, ...claimed].map((s) => s.split(' #')[0]));
  const journeyFiles = [...new Set([...(await src.journeys()), ...after.keys()])].sort();
  const headTests = new Map();
  const headFiles = new Map();
  for (const jf of journeyFiles) {
    const j = journeyOfFile(jf);
    if (!wanted.has(j)) continue;
    const text = after.has(jf) ? after.get(jf) : await src.read(head, jf);
    if (text == null) continue;
    headFiles.set(jf, text);
    for (const t of testsIn(text, j)) if (!headTests.has(t.step)) headTests.set(t.step, jf);
  }
  const notRead = [];
  const asked = [...new Set([...own, ...claimed])].sort();
  for (const s of asked) if (!headTests.has(s)) notRead.push({ step: s, why: 'no test for it at the head' });
  let reads = asked.filter((s) => headTests.has(s));
  if (reads.length === 0) return { applicable: false, why: 'no step has a test at the head', notRead };
  if (reads.length > MAX_READS) return { applicable: false, why: `${reads.length} steps, over ${MAX_READS} in one call`, notRead };
  const { words, ref: wordsRef } = await loadWords();
  const count = { seed: runId ? `run:${runId}` : null };
  for (const s of reads) if (!words.has(s)) notRead.push({ step: s, why: `no step words at project-state ${wordsRef}` });
  reads = reads.filter((s) => words.has(s));
  if (reads.length === 0) return { applicable: false, why: 'no step to read has words', notRead, wordsRef };

  const wordLines = (s) => {
    const w = words.get(s);
    const fields = WORD_FIELDS.filter((k) => w.fields?.[k]).map((k) => `  ${k}: ${w.fields[k]}`);
    const tag = own.has(s) ? 'its own test changed' : 'the title claims it';
    return [`${s} [${tag}]`, `  Journey: ${w.title}`, ...fields, `  The person does: ${w.does}`, `  They see: ${w.sees}`].join('\n');
  };
  const harness = [];
  for (const h of HARNESS) {
    const t = await src.read(head, h);
    if (t != null) harness.push([h, t]);
  }
  const promptFor = (steps) => {
    const parts = [
      brief.trim(),
      `\nPull request #${pr}, head ${head}. Step words from project-state at ${wordsRef}.`,
      ['\nBEGIN STEP WORDS (trusted; never repeat them in your answer)', ...steps.map(wordLines), 'END STEP WORDS'].join('\n'),
      `\nANSWER FOR\n${steps.join('; ')}`,
    ];
    let size = parts.reduce((n, p) => n + Buffer.byteLength(p) + 1, 0);
    const left = [];
    for (const jf of [...new Set(steps.map((s) => headTests.get(s)))].sort()) {
      const block = `\nBEGIN UNTRUSTED FILE at the head (${head.slice(0, 10)}) ${jf}\n${fence(headFiles.get(jf))}\nEND UNTRUSTED FILE`;
      const b = Buffer.byteLength(block) + 1;
      if (size + b > MAX_PROMPT_BYTES - 64_000) left.push(jf);
      else (parts.push(block), (size += b));
    }
    // The harness the tests call into, so a helper's check is read with the test (as the test part reads it).
    for (const [h, t] of harness) {
      const block = `\nBEGIN UNTRUSTED FILE at the head (${head.slice(0, 10)}) ${h}\n${fence(t)}\nEND UNTRUSTED FILE`;
      const b = Buffer.byteLength(block) + 1;
      if (size + b > MAX_PROMPT_BYTES - 64_000) left.push(h);
      else (parts.push(block), (size += b));
    }
    if (left.length) parts.push(`\nLeft out for size: ${left.join('; ')}`);
    parts.push('\nAnswer with the structured reads only.');
    return parts.join('\n');
  };
  const second = reads.filter((s) => secondReason(s, count));
  return {
    applicable: true,
    wordsRef,
    prompt: promptFor(reads),
    second: second.length ? promptFor(second) : null,
    required: reads,
    secondRequired: second,
    read: { steps: reads.map((s) => ({ step: s, test_file: headTests.get(s), own: own.has(s), second: secondReason(s, count) })), notRead },
    shingleTexts: reads.flatMap((s) => {
      const w = words.get(s);
      return [w.title, w.does, w.sees, ...WORD_FIELDS.map((k) => w.fields?.[k] ?? '')];
    }),
  };
}

/** Writes the read's input files; nothing to read writes only `skip.txt`, and no call is made. */
export async function writeReads(dir, opts) {
  mkdirSync(dir, { recursive: true });
  const got = await buildReads(opts);
  if (!got.applicable) {
    writeFileSync(join(dir, 'skip.txt'), got.why);
    return `no read: ${got.why}`;
  }
  const meta = {
    head: opts.head,
    pr: opts.pr,
    wordsRef: got.wordsRef,
    required: got.required,
    secondRequired: got.secondRequired,
    read: got.read,
  };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(dir, 'shingles.json'), JSON.stringify([...shingles(got.shingleTexts)]));
  writeFileSync(join(dir, 'prompt.txt'), got.prompt);
  writeFileSync(join(dir, 'schema.json'), JSON.stringify(READ_SCHEMA));
  if (got.second) {
    mkdirSync(join(dir, 'second'), { recursive: true });
    writeFileSync(join(dir, 'second', 'prompt.txt'), got.second);
    writeFileSync(join(dir, 'second', 'schema.json'), JSON.stringify(READ_SCHEMA));
  }
  return `reading #${opts.pr} at ${opts.head}: ${got.required.length} step(s), ${got.secondRequired.length} with a second reader; ${got.read.notRead.length} not read`;
}

/** One reader call's answer (`--output-format json`) checked against the steps it was asked, or why it can't be used. */
export function readAnswer(path, required) {
  if (!existsSync(path)) return { ok: false, why: 'the reader wrote no answer' };
  let out;
  try {
    out = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { ok: false, why: 'the reader printed no JSON' };
  }
  if (out?.is_error !== false || out?.subtype !== 'success')
    return { ok: false, why: `the reader ended with an error (${out?.subtype ?? 'none'})` };
  const given = out.structured_output?.reads;
  const good = (e) =>
    e && typeof e.step === 'string' && READ_VERDICTS.includes(e.verdict) && typeof e.refusal === 'boolean' && typeof e.note === 'string';
  if (!Array.isArray(given) || !given.every(good)) return { ok: false, why: 'the reads are not well-formed' };
  const by = new Map();
  for (const e of given) {
    // A step answered twice has no one answer: no read, rather than whichever came last.
    if (by.has(norm(e.step))) return { ok: false, why: `the reader answered ${e.step} twice` };
    by.set(norm(e.step), e);
  }
  const lines = [];
  for (const s of required) {
    const e = by.get(norm(s));
    if (!e) return { ok: false, why: `the reader left ${s} unanswered` };
    lines.push({ step: s, verdict: e.verdict, refusal: e.refusal, note: e.note });
  }
  return { ok: true, lines };
}

/**
 * The count of record's read of this head, by this run (project-state tooling/proof-v2/README.md "Reads"): one reader
 * per call, its id the run that made it, never the builder. intafaced is public, so it holds step ids, verdicts and
 * notes (any that repeat the step words withheld), never the words; the store adds their hash at `words_ref`.
 */
export function readDoc(meta, lines, { reader, run, builder, set }) {
  const byStep = new Map(meta.read.steps.map((s) => [s.step, s]));
  return {
    kind: 'step',
    pr: `#${meta.pr}`,
    read_sha: meta.head,
    brief: 'intafaced tooling/ci/test-judge/READ.md (the question of project-state tooling/proof-v2/READER.md step 3)',
    words_ref: meta.wordsRef,
    builder_thread: builder,
    steps: lines.map((l) => ({
      step: countKey(l.step),
      test_file: byStep.get(l.step)?.test_file ?? null,
      read_sha: meta.head,
      red_before: null,
      green_after: null,
      readers: [{ thread: `${run}/${reader}`, verdict: l.verdict, refusal: l.refusal, note: redact(l.note, set) }],
    })),
    not_read: meta.read.notRead.map((n) => ({ step: countKey(n.step), why: n.why })),
  };
}

/** The commit status for this head: success only when every reader read every step FAITHFUL; counts only (public). */
export function readStatus(lines) {
  const vs = lines.map((l) => l.verdict);
  const counts = READ_VERDICTS.filter((v) => vs.includes(v)).map((v) => `${vs.filter((x) => x === v).length} ${v}`);
  return {
    state: vs.every((v) => v === 'FAITHFUL') ? 'success' : 'failure',
    description: `${counts.join(', ')} (the CI review's proof read)`,
  };
}

/** The `read` command: the answers in `<dir>` into read.json (and read-second.json) and status.tsv. */
export function cmdRead(dir, env = process.env) {
  if (existsSync(join(dir, 'skip.txt'))) return { ok: true, why: `no read: ${readFileSync(join(dir, 'skip.txt'), 'utf8')}` };
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const first = readAnswer(join(dir, 'answer.json'), meta.required);
  if (!first.ok) return first;
  const second = meta.secondRequired.length ? readAnswer(join(dir, 'second', 'answer.json'), meta.secondRequired) : { ok: true, lines: [] };
  if (!second.ok) return { ok: false, why: `the second reader: ${second.why}` };
  let builder = 'unknown';
  try {
    const login = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))?.pull_request?.user?.login;
    if (login) builder = `github:${login}`;
  } catch {
    /* no event: a local run */
  }
  const run = env.GITHUB_RUN_ID
    ? `ci:${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT ?? 1}`
    : 'ci:local';
  const set = new Set(JSON.parse(readFileSync(join(dir, 'shingles.json'), 'utf8')));
  const out = ['read.json'];
  writeFileSync(join(dir, 'read.json'), JSON.stringify(readDoc(meta, first.lines, { reader: 'reader', run, builder, set }), null, 1));
  if (second.lines.length) {
    const doc = { ...readDoc(meta, second.lines, { reader: 'second', run, builder, set }), second_of: 'read.json' };
    writeFileSync(join(dir, 'read-second.json'), JSON.stringify(doc, null, 1));
    out.push('read-second.json');
  }
  const status = readStatus([...first.lines, ...second.lines]);
  writeFileSync(join(dir, 'status.tsv'), `${status.state}\t${status.description}\n`);
  return { ok: true, why: `${status.state}: ${status.description}; files: ${out.join(', ')}` };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dir = rest.filter((a) => !a.startsWith('--')).at(-1);
  const arg = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
  if (cmd === 'prepare') {
    const { GITHUB_REPOSITORY: repo, GITHUB_EVENT_PATH: path, GH_TOKEN, PROJECT_STATE_READ_TOKEN: words } = process.env;
    const pull = JSON.parse(readFileSync(path, 'utf8')).pull_request;
    if (!pull?.base?.sha || !pull?.head?.sha) throw new Error('not a pull request event with a base and head sha');
    if (pull.head.repo?.full_name !== repo) throw new Error('a pull request from a fork gets no read');
    return void console.log(
      await writeReads(dir, {
        src: ciSource(repo, GH_TOKEN, process.env.GITHUB_WORKSPACE),
        base: pull.base.sha,
        head: pull.head.sha,
        pr: pull.number,
        title: pull.title ?? '',
        body: pull.body ?? '',
        loadWords: async () => {
          if (!words) throw new Error('no PROJECT_STATE_READ_TOKEN, so the step words are unreadable');
          return readWordsApi(words);
        },
        runId: process.env.GITHUB_RUN_ID ?? null,
      }),
    );
  }
  if (cmd === 'local')
    return void console.log(
      await writeReads(dir, {
        src: gitSource(arg('--repo'), arg('--base')),
        base: arg('--base'),
        head: arg('--head'),
        pr: arg('--pr') ?? 'local',
        title: arg('--title') ?? '',
        loadWords: async () => readWordsLocal(arg('--words')),
        runId: arg('--run-id') ?? null,
      }),
    );
  if (cmd === 'read') {
    const v = cmdRead(dir);
    if (!v.ok) {
      console.error(`::warning::no proof read of this head: ${v.why} (it blocks nothing; a re-run of the job reads again)`);
      process.exit(1);
    }
    return void console.log(`proof read: ${v.why}`);
  }
  console.error(
    'usage: step-read.mjs prepare|read <dir> | local --repo <clone> --base <sha> --head <sha> --words <dir> [--run-id <n>] <dir>',
  );
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => {
    console.error(`::warning::step-read: ${e.message} (it blocks nothing)`);
    process.exit(1);
  });
