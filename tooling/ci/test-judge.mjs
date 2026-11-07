#!/usr/bin/env node
/**
 * The test judge (.github/workflows/ci-review.yml, job `Test judge`): one fresh model call per pull request that changes
 * a journey test or the shared code journey tests run on. It answers one question for each affected step: after this
 * change, does the test still exercise and distinguish the behaviour the step's words require? A test that keeps its
 * assertions but no longer reaches the product fails it. The brief is tooling/ci/test-judge/JUDGE.md.
 *
 *   node tooling/ci/test-judge.mjs inputs <out dir>   the judge's input: the diff, the files, the step words, the prompt
 *   node tooling/ci/test-judge.mjs read   <out dir>   the judge's JSON answer into verdict.json (no verdict: exit 1)
 *   node tooling/ci/test-judge.mjs judge  <out dir>   the Verdict step: the job summary, exit 1 on FAIL, 0 on PASS
 *   node tooling/ci/test-judge.mjs local --repo <clone> --base <sha> --head <sha> --words <project-state dir> <out dir>
 *                                                     the same input from a local clone, for the proof runs
 *
 * Why it exists: proof v2's post-merge reach reads voided 545 proofs over one harness change that, judged once in its
 * own PR, altered nothing the tests observe (project-state research/system-design-2026-11-07/E1-RESULT.md). The judge
 * rules before merge instead, and the seal (review-marker.mjs, JUDGE_CHECK) waits for its Verdict step on the exact
 * head whenever judgeReason names a changed file. A FAIL stands for its head and its code, like the CI review's.
 *
 * Like ci-review.mjs, nothing here checks out, builds or runs the pull request's code: the diff and the files are read
 * as text through the API at the event's base and head shas. The step words are private (they live in project-state
 * operation-zero/modules/<module>/acceptance/journeys.md); they are read with PROJECT_STATE_READ_TOKEN, go only into
 * the prompt file, and are never printed: the log carries counts, and the summary carries step ids, verdicts and the
 * judge's reasons, a reason that repeats the step words withheld (redact).
 */
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, readdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The journey tests and the shared code they run on: a pull request that changes any of these is judged. */
export const JUDGE_PATHS = [
  [/^apps\/customer\/tests\/real-app\//, 'the journey tests and their harness'],
  [/^tooling\/scripts\/local-stack-services\//, "the local stack's per-service settings"],
  [/^tooling\/scripts\/local-stack-fixtures\//, "the local stack's fixtures"],
  [/^tooling\/scripts\/local-test-[^/]+$/, 'the local test world and stack tools'],
  [/^tooling\/scripts\/local-(founder-seed|video-store)\.mjs$/, 'the local stack tools the journeys call'],
  [/^tooling\/scripts\/journey-(world|fund|fail-fast|freeze-guard)\.mjs$/, 'the journey harness tools'],
  [/^tooling\/scripts\/seed-[^/]*test[^/]*\.mjs$/, 'the TEST seeds the journeys call'],
  [/^tooling\/scripts\/owner-settings\.mjs$/, 'the owner settings the journeys read'],
  [/^tooling\/profiles\/test-owner-values\//, 'the TEST owner values'],
];
/** Shared code that sets the environment every journey starts in, whether or not a test imports it. */
const ENVIRONMENT = [
  /^tooling\/scripts\/local-stack-services\//,
  /^tooling\/scripts\/local-stack-fixtures\//,
  /^tooling\/profiles\/test-owner-values\//,
  /^tooling\/scripts\/local-test-(stack|world)\.mjs$/,
  /^apps\/customer\/tests\/real-app\/real-app\.playwright\.config\.mjs$/,
];
const UNIT_TEST = /\.test\.(mjs|ts|js)$/;
const REAL_APP = 'apps/customer/tests/real-app';
export const JOURNEY_FILE = /^apps\/customer\/tests\/real-app\/(J-[a-z0-9-]+)\.pw\.mjs$/;
/** The harness files the judge always reads, so it can follow a test's calls into them (E1: W5 and W9). */
export const HARNESS = ['journey.mjs', 'stack.mjs', 'desk.mjs', 'world-restore.mjs'].map((f) => `${REAL_APP}/${f}`);

export const MAX_DIFF_BYTES = 400_000;
/** The whole prompt; Opus 5.5 reads 1M tokens, so this leaves room to think. */
export const MAX_PROMPT_BYTES = 1_500_000;
/** How far whole journey files changed only outside their tests may fill the prompt. */
export const FILE_LEVEL_BYTES = 600_000;
/** Steps whose own test changed, judged one by one; more can't be judged whole in one call. */
export const MAX_OWN_STEPS = 150;
/** Steps a shared or file-level change reaches, sampled so the judge sees what the tests rely on. */
export const SAMPLE_STEPS = 24;
const SHA40 = /^[0-9a-f]{40}$/;

/** Whether a file is shared test code or a journey test the judge rules on. */
export const judgedFile = (f) => !(UNIT_TEST.test(f) && !f.startsWith(`${REAL_APP}/`)) && JUDGE_PATHS.some(([re]) => re.test(f));

/** Why the seal needs the test judge for this change, or null. An empty file list fails closed. */
export function judgeReason(files) {
  if (files.length === 0) return 'no changed files could be read for this head';
  const f = files.find(judgedFile);
  if (!f) return null;
  return `journey test or shared test code: ${f}`;
}

// ── Reading a diff ────────────────────────────────────────────────────────────────────────────────────────────────

/** A unified diff (git or the compare API's) as files, each with the old and new line numbers it changes. */
export function parseDiff(text) {
  const files = [];
  let cur = null;
  let oldLn = 0;
  let newLn = 0;
  const unq = (p) => (p === '/dev/null' ? null : p.replace(/^"?[ab]\//, '').replace(/"$/, ''));
  for (const line of String(text).split('\n')) {
    if (line.startsWith('diff --git ')) {
      oldLn = 0;
      newLn = 0;
      const m = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line);
      cur = { oldPath: m?.[1] ?? null, newPath: m?.[2] ?? null, removed: [], added: [], binary: false, hunk: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (!cur.hunk && line.startsWith('--- ')) {
      cur.oldPath = unq(line.slice(4).trim());
      continue;
    }
    if (!cur.hunk && line.startsWith('+++ ')) {
      cur.newPath = unq(line.slice(4).trim());
      continue;
    }
    if (!cur.hunk && line.startsWith('new file mode')) cur.oldPath = null;
    if (!cur.hunk && line.startsWith('deleted file mode')) cur.newPath = null;
    if (!cur.hunk && (/^Binary files /.test(line) || line.startsWith('GIT binary patch'))) cur.binary = true;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (h) {
      oldLn = Number(h[1]);
      newLn = Number(h[2]);
      cur.hunk = true;
      continue;
    }
    if (!cur.hunk) continue;
    if (line.startsWith('+')) cur.added.push(newLn++);
    else if (line.startsWith('-')) cur.removed.push(oldLn++);
    else if (line.startsWith(' ')) {
      oldLn++;
      newLn++;
    }
  }
  for (const f of files) delete f.hunk;
  return files.map((f) => ({ ...f, path: f.newPath ?? f.oldPath }));
}

// ── Steps in a journey test ───────────────────────────────────────────────────────────────────────────────────────

const TEST_CALL = /^(\s*)test(?:\.(?:skip|fixme|only|fail|slow))?\(\s*[`'"](?:\$\{J\}|(J-[a-z0-9-]+)) #(\d+)\b/;

/** The step tests of one journey file: `{ step: 'J-x-01 #3', start, end }` (1-based lines), as test-hash.mjs cuts them. */
export function testsIn(text, journey) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = TEST_CALL.exec(lines[i]);
    if (!m) continue;
    let end = lines.length;
    for (let k = i + 1; k < lines.length; k++)
      if (lines[k].startsWith(`${m[1]}});`) || (m[1] === '' && lines[k].startsWith('});'))) {
        end = k + 1;
        break;
      }
    out.push({ step: `${m[2] ?? journey} #${Number(m[3])}`, start: i + 1, end });
  }
  return out;
}

/**
 * Which steps a change to one journey file touches. A changed line inside a step's test is that step's own change; a
 * changed line outside every test (an import, a helper, a hook, an in-file route, the `// World:` line) reaches every
 * step in the file. Returns { own: Set, fileLevel: boolean, all: Set }.
 */
export function stepsTouched({ journey, before, after, removed, added }) {
  const old = testsIn(before, journey);
  const neu = testsIn(after, journey);
  const all = new Set([...old, ...neu].map((t) => t.step));
  const own = new Set();
  let fileLevel = false;
  const place = (tests, ln) => tests.find((t) => ln >= t.start && ln <= t.end);
  for (const ln of removed) {
    const t = place(old, ln);
    if (t) own.add(t.step);
    else fileLevel = true;
  }
  for (const ln of added) {
    const t = place(neu, ln);
    if (t) own.add(t.step);
    else fileLevel = true;
  }
  return { own, fileLevel, all };
}

// ── What the journeys import ──────────────────────────────────────────────────────────────────────────────────────

const IMPORT =
  /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|(?:^|[\s;])import\s*['"](\.{1,2}\/[^'"]+)['"]/g;
const TOOL = /\btool\(\s*['"]([\w./-]+\.mjs)['"]/g;

/**
 * For each journey file, every file it reaches through relative imports (and stack.mjs's `tool('<script>')`, which runs
 * tooling/scripts/<script>), read through `read(path)` (null when absent). Returns Map<journeyFile, Set<file>>.
 */
export function reachMap(journeyFiles, read) {
  const memo = new Map();
  const depsOf = (f) => {
    if (memo.has(f)) return memo.get(f);
    const deps = [];
    memo.set(f, deps);
    const text = read(f);
    if (text == null) return deps;
    for (const m of text.matchAll(IMPORT)) deps.push(posix.normalize(posix.join(posix.dirname(f), m[1] ?? m[2] ?? m[3])));
    for (const m of text.matchAll(TOOL)) deps.push(`tooling/scripts/${m[1]}`);
    return deps;
  };
  const out = new Map();
  for (const j of journeyFiles) {
    const seen = new Set();
    const q = [...depsOf(j)];
    while (q.length) {
      const f = q.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      q.push(...depsOf(f));
    }
    out.set(j, seen);
  }
  return out;
}

/** The top-level names a set of changed lines falls in (`function x`, `const x`, `export class x`). */
export function changedNames(text, lines) {
  const src = String(text ?? '').split('\n');
  const names = new Set();
  const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/;
  for (const ln of lines) {
    for (let i = Math.min(ln, src.length) - 1; i >= 0; i--) {
      const m = DECL.exec(src[i]);
      if (m) {
        names.add(m[1]);
        break;
      }
      if (/^\S/.test(src[i]) && !/^[})\]]/.test(src[i]) && i !== ln - 1) break; // another top-level statement
    }
  }
  return names;
}

// ── The step words ────────────────────────────────────────────────────────────────────────────────────────────────

/** One acceptance file's steps: Map<'J-x-01 #3', { title, does, sees }>. Only the "does" and "sees" cells. */
export function parseStepWords(md) {
  const out = new Map();
  let journey = null;
  let title = '';
  let cols = null;
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  for (const line of String(md).split('\n')) {
    const h = /^##\s+(J-[a-z0-9-]+)\s*:\s*(.*)$/.exec(line);
    if (h) {
      journey = h[1];
      title = h[2].trim();
      cols = null;
      continue;
    }
    if (/^#{1,2}\s/.test(line)) journey = null;
    if (!journey || !line.trim().startsWith('|')) continue;
    const c = cells(line);
    if (c[0] === '#') {
      const at = (re) => c.findIndex((x) => re.test(x));
      cols = { does: at(/does/i), sees: at(/see/i) };
      continue;
    }
    if (!cols || !/^\d+$/.test(c[0])) continue;
    out.set(`${journey} #${Number(c[0])}`, { title, does: c[cols.does] ?? '', sees: c[cols.sees] ?? '' });
  }
  return out;
}

// ── Keeping the step words out of the public log ──────────────────────────────────────────────────────────────────

const words = (s) =>
  String(s)
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
/** Every run of N words in the step words given to the judge. */
export function shingles(texts, n = 5) {
  const set = new Set();
  for (const t of texts) {
    const w = words(t);
    for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(' '));
  }
  return set;
}
/** A reason that repeats five words in a row of the step words is withheld from the public summary. */
export function redact(why, set, n = 5) {
  const w = words(why);
  for (let i = 0; i + n <= w.length; i++) if (set.has(w.slice(i, i + n).join(' '))) return '(reason withheld: it repeated the step words)';
  return String(why).replace(/\s+/g, ' ').slice(0, 300);
}

// ── The prompt ────────────────────────────────────────────────────────────────────────────────────────────────────

const fence = (s) => String(s).replace(/^(BEGIN|END) UNTRUSTED/gm, '$1 UNTRUSTED (quoted by the author)');
const stable = (s, salt) => createHash('sha256').update(`${salt}|${s}`).digest('hex');

/**
 * Everything the judge needs, from a `src` that reads text at a sha: `diff(base, head)` (the pull request's diff from
 * the merge base, and that merge base), `read(sha, path)` (null when absent), `journeys()` (the journey files on the
 * default branch) and `readGraph(path)` (the default branch's copy, for what the journeys import). `loadWords()` gives
 * { words: Map of step words, ref }, and is called only when a step needs judging. Pure apart from `src` and
 * `loadWords`, so the tests run offline.
 * Returns { applicable, why, prompt?, required?, schema?, deterministic: [{ step, line }], facts, shingleTexts }.
 */
export async function buildInputs({ src, base, head, pr, brief, loadWords }) {
  const { diff, mergeBase } = await src.diff(base, head);
  const files = parseDiff(diff);
  const judged = files.filter((f) => judgedFile(f.path) || (f.oldPath && judgedFile(f.oldPath)));
  if (judged.length === 0) return { applicable: false, why: 'no journey test or shared test code changed' };
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES)
    return {
      applicable: true,
      tooLarge: `the diff is ${Buffer.byteLength(diff)} bytes, over ${MAX_DIFF_BYTES}; it can't be judged whole; split the pull request`,
    };

  const before = new Map();
  const after = new Map();
  for (const f of judged) {
    if (f.binary) continue;
    before.set(f.path, f.oldPath ? await src.read(mergeBase, f.oldPath) : null);
    after.set(f.path, f.newPath ? await src.read(head, f.newPath) : null);
  }
  // Who imports what: on the default branch, and through the head's copy of the changed files, so a shared file the
  // pull request adds is reached through the changed file that imports it.
  const added = judged.filter((f) => !f.oldPath && JOURNEY_FILE.test(f.path)).map((f) => f.path);
  const journeyFiles = [...new Set([...(await src.journeys()), ...added])].sort();
  const graphReach = reachMap(journeyFiles, (p) => src.readGraph(p));
  const headReach = reachMap(journeyFiles, (p) => (after.has(p) ? after.get(p) : src.readGraph(p)));
  const reach = new Map(journeyFiles.map((j) => [j, new Set([...(graphReach.get(j) ?? []), ...(headReach.get(j) ?? [])])]));

  const own = new Set(); // steps whose own test changed
  const reached = new Map(); // step -> journey file, reached by a shared or file-level change
  const changes = []; // { file, kind, reaches, names }
  const testText = new Map(); // step -> its test body (head, else graph)
  const bodyOf = (text, journey) => {
    const lines = String(text ?? '').split('\n');
    for (const t of testsIn(text, journey)) if (!testText.has(t.step)) testText.set(t.step, lines.slice(t.start - 1, t.end).join('\n'));
  };
  const allStepsOf = (jf) => {
    const journey = JOURNEY_FILE.exec(jf)?.[1];
    const text = after.has(jf) ? after.get(jf) : src.readGraph(jf);
    bodyOf(text, journey);
    return testsIn(text, journey).map((t) => t.step);
  };
  for (const f of judged) {
    const j = JOURNEY_FILE.exec(f.path) ?? (f.oldPath ? JOURNEY_FILE.exec(f.oldPath) : null);
    if (j) {
      const t = stepsTouched({ journey: j[1], before: before.get(f.path), after: after.get(f.path), removed: f.removed, added: f.added });
      bodyOf(after.get(f.path), j[1]);
      bodyOf(before.get(f.path), j[1]);
      for (const s of t.own) own.add(s);
      if (t.fileLevel) {
        changes.push({ file: f.path, kind: 'file-level', reaches: t.all.size, journeys: 1 });
        for (const s of t.all) if (!t.own.has(s)) reached.set(s, f.path);
      }
      continue;
    }
    // Shared code: the journeys that import it on the default branch, or every journey for the stack's environment.
    const users = ENVIRONMENT.some((re) => re.test(f.path))
      ? journeyFiles
      : journeyFiles.filter((jf) => reach.get(jf)?.has(f.path) || (f.oldPath && reach.get(jf)?.has(f.oldPath)));
    if (users.length === 0) continue; // e.g. a look sweep or a file no journey reaches: no step to judge
    const names = new Set([...changedNames(before.get(f.path), f.removed), ...changedNames(after.get(f.path), f.added)]);
    let n = 0;
    for (const jf of users) for (const s of allStepsOf(jf)) if (!own.has(s)) (reached.set(s, reached.get(s) ?? jf), n++);
    changes.push({ file: f.path, kind: 'shared', reaches: n, journeys: users.length, names: [...names] });
  }
  for (const s of own) reached.delete(s);
  if (own.size === 0 && changes.length === 0) return { applicable: false, why: 'the changed shared test code reaches no journey step' };
  if (own.size > MAX_OWN_STEPS)
    return {
      applicable: true,
      tooLarge: `${own.size} steps' own tests changed, over ${MAX_OWN_STEPS}; they can't be judged whole in one call; split the pull request`,
    };
  const { words: stepWords, ref: wordsRef } = await loadWords();

  // The sample: steps whose tests name a changed shared name first, then a fixed spread, one per journey at a time.
  const names = new Set(changes.flatMap((c) => c.names ?? []));
  const named = (s) => [...names].some((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(testText.get(s) ?? ''));
  const pool = [...reached.keys()].filter((s) => stepWords.has(s)).sort((a, b) => (stable(a, head) < stable(b, head) ? -1 : 1));
  const sample = [];
  const seenJ = new Set();
  for (const pass of [(s) => named(s), () => true])
    for (const s of pool) {
      if (sample.length >= SAMPLE_STEPS) break;
      const j = s.split(' #')[0];
      if (sample.includes(s) || !pass(s) || (seenJ.has(j) && pool.length > SAMPLE_STEPS)) continue;
      sample.push(s);
      seenJ.add(j);
    }
  for (const s of pool) if (sample.length < Math.min(SAMPLE_STEPS, pool.length) && !sample.includes(s)) sample.push(s);

  // A step whose test changed but that has no words can't be judged adequate to them: a FAIL line, without the model.
  const deterministic = [];
  const ownList = [...own].sort();
  for (const s of ownList)
    if (!stepWords.has(s))
      deterministic.push({
        step: s,
        line: `no step words for ${s} at project-state ${wordsRef}; a test can't be judged against words that don't exist`,
      });
  const judgedSteps = ownList.filter((s) => stepWords.has(s));
  const required = { steps: [...judgedSteps, ...sample.sort()], changes: changes.map((c) => c.file) };
  if (required.steps.length === 0 && required.changes.length === 0)
    return { applicable: true, wordsRef, deterministic, required, facts: { own: own.size, reached: reached.size, sample: 0, changes } };

  // The prompt, in priority order, until the budget runs out.
  const parts = [];
  let size = 0;
  const left = [];
  const add = (text, { must = false, label } = {}) => {
    const b = Buffer.byteLength(text) + 1;
    // Optional material stops short of the cap, so the lines that must close the prompt always fit.
    if (!must && size + b > MAX_PROMPT_BYTES - 64_000) {
      left.push(label);
      return false;
    }
    parts.push(text);
    size += b;
    return true;
  };
  add(brief.trim(), { must: true });
  add(`\nPull request #${pr}, merge base ${mergeBase}, head ${head}. Step words from project-state at ${wordsRef}.`, { must: true });
  const wordLines = (s, tag) => {
    const w = stepWords.get(s);
    return `${s} [${tag}]\n  Journey: ${w.title}\n  The person does: ${w.does}\n  They see: ${w.sees}`;
  };
  add(
    [
      '\nBEGIN STEP WORDS (trusted; never repeat them in your answer)',
      ...judgedSteps.map((s) => wordLines(s, 'its own test changed')),
      ...sample.sort().map((s) => wordLines(s, 'sampled: its test is reached by a shared or file-level change')),
      'END STEP WORDS',
    ].join('\n'),
    { must: true },
  );
  add(
    [
      '\nANSWER FOR',
      `steps: ${required.steps.join('; ') || '(none)'}`,
      'changes:',
      ...changes.map((c) =>
        c.kind === 'shared'
          ? `  ${c.file} (shared code: reaches ${c.reaches} steps in ${c.journeys} journey files${c.names?.length ? `; changed names: ${c.names.join(', ')}` : ''})`
          : `  ${c.file} (a change outside every test: reaches the file's ${c.reaches} steps)`,
      ),
    ].join('\n'),
    { must: true },
  );
  add(`\nThe diff follows (untrusted).\nBEGIN UNTRUSTED DIFF\n${fence(diff)}\nEND UNTRUSTED DIFF`, { must: true });
  const fileBlock = (when, path, text) => `\nBEGIN UNTRUSTED FILE ${when} ${path}\n${fence(text)}\nEND UNTRUSTED FILE`;
  const sharedFirst = [...judged].sort((a, b) => Number(Boolean(JOURNEY_FILE.test(a.path))) - Number(Boolean(JOURNEY_FILE.test(b.path))));
  const ownFiles = new Set([...own].map((s) => `${REAL_APP}/${s.split(' #')[0]}.pw.mjs`));
  const order = [
    ...sharedFirst.filter((f) => !JOURNEY_FILE.test(f.path)),
    ...sharedFirst.filter((f) => JOURNEY_FILE.test(f.path) && ownFiles.has(f.path)),
  ];
  for (const f of order) {
    const b = before.get(f.path);
    const a = after.get(f.path);
    const must = !JOURNEY_FILE.test(f.path);
    if (b != null) add(fileBlock(`before (merge base ${mergeBase.slice(0, 10)})`, f.oldPath, b), { label: `${f.path} before`, must });
    if (a != null) add(fileBlock(`after (head ${head.slice(0, 10)})`, f.newPath, a), { label: `${f.path} after`, must });
  }
  for (const h of HARNESS) {
    if (after.has(h)) continue;
    const t = await src.read(head, h);
    if (t != null) add(fileBlock(`unchanged (head ${head.slice(0, 10)})`, h, t), { label: `${h} (unchanged harness)` });
  }
  for (const s of sample) {
    const t = testText.get(s);
    if (t)
      add(`\nBEGIN UNTRUSTED TEST ${s} (sampled, from ${reached.get(s)})\n${fence(t)}\nEND UNTRUSTED TEST`, { label: `the test of ${s}` });
  }
  for (const f of sharedFirst.filter((f) => JOURNEY_FILE.test(f.path) && !ownFiles.has(f.path))) {
    // Whole journey files whose change sits outside every test add context, not evidence: the diff shows the change,
    // so they stop at FILE_LEVEL_BYTES and the rest are named as left out.
    const a = after.get(f.path);
    if (a == null) continue;
    if (size > FILE_LEVEL_BYTES) left.push(`${f.path} after`);
    else add(fileBlock(`after (head ${head.slice(0, 10)})`, f.newPath, a), { label: `${f.path} after` });
  }
  if (left.length) add(`\nLeft out for size (judge these from the diff): ${left.join('; ')}`, { must: true });
  add('\nAnswer with the structured verdict only.', { must: true });
  if (size > MAX_PROMPT_BYTES)
    return {
      applicable: true,
      tooLarge: `the shared files and the diff alone are ${size} bytes, over ${MAX_PROMPT_BYTES}; they can't be judged whole; split the pull request`,
    };

  const shingleTexts = [...judgedSteps, ...sample].flatMap((s) => {
    const w = stepWords.get(s);
    return [w.title, w.does, w.sees];
  });
  return {
    applicable: true,
    wordsRef,
    prompt: parts.join('\n'),
    required,
    deterministic,
    shingleTexts,
    facts: {
      own: own.size,
      reached: reached.size,
      sample: sample.length,
      changes: changes.map(({ names: _n, ...c }) => c),
      left: left.length,
      bytes: size,
    },
  };
}

/** The structured answer the judge must give (the reviewer CLI, -p --json-schema). */
export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { step: { type: 'string' }, verdict: { type: 'string', enum: ['still-proves', 'weaker'] }, why: { type: 'string' } },
        required: ['step', 'verdict', 'why'],
        additionalProperties: false,
      },
    },
    changes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { file: { type: 'string' }, verdict: { type: 'string', enum: ['still-proves', 'weaker'] }, why: { type: 'string' } },
        required: ['file', 'verdict', 'why'],
        additionalProperties: false,
      },
    },
  },
  required: ['verdict', 'steps', 'changes'],
  additionalProperties: false,
};

const normStep = (s) =>
  String(s ?? '')
    .replace(/\s*#\s*/, ' #')
    .trim();

/**
 * The reviewer CLI's JSON output to a verdict. Fails closed: an error, no structured answer, an answer outside the
 * schema, or a listed step or change left unanswered is no verdict, never a PASS. The verdict is computed here from
 * the entries: PASS only when every required entry still proves and the judge said PASS.
 */
export function readAnswer(text, required) {
  let out;
  try {
    out = JSON.parse(text);
  } catch {
    return { ok: false, why: 'the judge printed no JSON' };
  }
  if (out?.is_error !== false || out?.subtype !== 'success')
    return { ok: false, why: `the judge ended with an error (${out?.subtype ?? 'no subtype'})` };
  const a = out.structured_output;
  if (!a || typeof a !== 'object') return { ok: false, why: 'the judge gave no structured answer' };
  if (a.verdict !== 'PASS' && a.verdict !== 'FAIL') return { ok: false, why: `the verdict "${a.verdict}" is neither PASS nor FAIL` };
  const good = (e, key) =>
    e && typeof e[key] === 'string' && (e.verdict === 'still-proves' || e.verdict === 'weaker') && typeof e.why === 'string';
  if (!Array.isArray(a.steps) || !a.steps.every((e) => good(e, 'step'))) return { ok: false, why: 'the steps are not well-formed' };
  if (!Array.isArray(a.changes) || !a.changes.every((e) => good(e, 'file'))) return { ok: false, why: 'the changes are not well-formed' };
  const steps = new Map(a.steps.map((e) => [normStep(e.step), e]));
  const changes = new Map(a.changes.map((e) => [String(e.file).trim(), e]));
  const lines = [];
  for (const s of required.steps) {
    const e = steps.get(normStep(s));
    if (!e) return { ok: false, why: `the judge left step ${s} unanswered` };
    lines.push({ kind: 'step', id: s, verdict: e.verdict, why: e.why });
  }
  for (const f of required.changes) {
    const e = changes.get(f);
    if (!e) return { ok: false, why: `the judge left the change to ${f} unanswered` };
    lines.push({ kind: 'change', id: f, verdict: e.verdict, why: e.why });
  }
  const weaker = lines.some((l) => l.verdict === 'weaker');
  const verdict = weaker || a.verdict === 'FAIL' ? 'FAIL' : 'PASS';
  const note = !weaker && a.verdict === 'FAIL' ? 'the judge answered FAIL with every entry still proving: counted as FAIL' : null;
  return { ok: true, verdict, lines, note };
}

/** The job summary's lines: step ids, verdicts and reasons, never the step words. */
export function summaryLines(v, set) {
  const out = [`## Test judge: ${v.verdict} on ${v.head}`, ''];
  if (v.wordsRef) out.push(`Step words read from project-state at ${v.wordsRef} (not shown here).`, '');
  if (v.facts)
    out.push(
      `Own tests changed: ${v.facts.own}; steps reached by shared or file-level changes: ${v.facts.reached}, of which ${v.facts.sample} were sampled for the judge.`,
      '',
    );
  for (const c of v.facts?.changes ?? []) {
    const l = (v.lines ?? []).find((x) => x.kind === 'change' && x.id === c.file);
    if (l) out.push(`- \`${c.file}\` (${c.kind}, reaches ${c.reaches} steps): **${l.verdict}**: ${redact(l.why, set)}`);
  }
  for (const l of (v.lines ?? []).filter((x) => x.kind === 'step')) out.push(`- ${l.id}: **${l.verdict}**: ${redact(l.why, set)}`);
  for (const d of v.deterministic ?? []) out.push(`- ${d.step}: **FAIL**: ${d.line}`);
  for (const f of v.findings ?? []) out.push(`- ${f}`);
  if (v.note) out.push('', `note: ${v.note}`);
  return out;
}

// ── GitHub and git sources ────────────────────────────────────────────────────────────────────────────────────────

async function getText(path, accept, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (res.status === 403 || res.status === 429)
    throw new Error(`GitHub ${res.status} on GET ${path.split('?')[0]}: stopping, not retrying`);
  return { status: res.status, text };
}

/** The step words of every module, from project-state's default branch, with the commit they were read at. */
async function readWordsApi(token) {
  const repo = 'INTAFACED/project-state';
  const ref = await getText(`/repos/${repo}/commits/main`, 'application/vnd.github.sha', token);
  if (ref.status !== 200 || !SHA40.test(ref.text.trim())) throw new Error(`could not read project-state's main: HTTP ${ref.status}`);
  const sha = ref.text.trim();
  const list = await getText(`/repos/${repo}/contents/operation-zero/modules?ref=${sha}`, 'application/vnd.github+json', token);
  if (list.status !== 200) throw new Error(`could not list project-state's modules: HTTP ${list.status}`);
  const words = new Map();
  for (const d of JSON.parse(list.text).filter((e) => e.type === 'dir')) {
    const r = await getText(
      `/repos/${repo}/contents/operation-zero/modules/${d.name}/acceptance/journeys.md?ref=${sha}`,
      'application/vnd.github.raw',
      token,
    );
    if (r.status === 404) continue;
    if (r.status !== 200) throw new Error(`could not read a module's acceptance file: HTTP ${r.status}`);
    for (const [k, v] of parseStepWords(r.text)) words.set(k, v);
  }
  if (words.size === 0) throw new Error("project-state's acceptance files held no steps: refusing to judge against nothing");
  return { words, ref: sha };
}

/** Step words from a local project-state checkout (the proof runs). */
export function readWordsLocal(dir) {
  const words = new Map();
  const root = join(dir, 'operation-zero/modules');
  for (const m of readdirSync(root)) {
    const f = join(root, m, 'acceptance/journeys.md');
    if (existsSync(f)) for (const [k, v] of parseStepWords(readFileSync(f, 'utf8'))) words.set(k, v);
  }
  const ref = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { words, ref };
}

/**
 * In CI: the diff and its merge base from the compare API (two calls), and the files' text from two shallow git fetches
 * of the public repository into the default branch's checkout (no token, and no file is checked out or run), so a PR
 * that touches hundreds of files costs no API calls per file. The import graph is the default branch's checkout.
 */
function ciSource(repo, token, graphRoot) {
  const git = (...a) => execFileSync('git', ['-C', graphRoot, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return {
    diff: async (base, head) => {
      const c = await getText(`/repos/${repo}/compare/${base}...${head}?per_page=1`, 'application/vnd.github+json', token);
      if (c.status !== 200) throw new Error(`could not read the comparison ${base.slice(0, 7)}...${head.slice(0, 7)}: HTTP ${c.status}`);
      const mergeBase = String(JSON.parse(c.text)?.merge_base_commit?.sha ?? '');
      if (!SHA40.test(mergeBase)) throw new Error('the comparison names no merge base');
      const r = await getText(`/repos/${repo}/compare/${base}...${head}`, 'application/vnd.github.v3.diff', token);
      if (r.status !== 200) throw new Error(`could not read the diff ${base.slice(0, 7)}...${head.slice(0, 7)}: HTTP ${r.status}`);
      git('fetch', '--no-tags', '--quiet', '--depth=1', 'origin', mergeBase, head);
      return { diff: r.text, mergeBase };
    },
    read: async (sha, p) => {
      try {
        // Only a regular file's text: a symlink in the pull request is read as its target path, never followed.
        if (!/^100(644|755) blob /.test(git('ls-tree', sha, '--', p))) return null;
        return git('show', `${sha}:${p}`);
      } catch {
        return null;
      }
    },
    journeys: async () =>
      readdirSync(join(graphRoot, REAL_APP))
        .filter((f) => /^J-.*\.pw\.mjs$/.test(f))
        .map((f) => `${REAL_APP}/${f}`)
        .sort(),
    readGraph: (p) => (existsSync(join(graphRoot, p)) ? readFileSync(join(graphRoot, p), 'utf8') : null),
  };
}

export function gitSource(clone, graphSha) {
  const git = (...a) => execFileSync('git', ['-C', clone, ...a], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const show = (sha, p) => {
    try {
      if (!/^100(644|755) blob /.test(git('ls-tree', sha, '--', p))) return null;
      return git('show', `${sha}:${p}`);
    } catch {
      return null;
    }
  };
  return {
    diff: async (base, head) => ({
      diff: git('diff', '--no-color', '--no-ext-diff', '--no-renames', `${base}...${head}`),
      mergeBase: git('merge-base', base, head).trim(),
    }),
    read: async (sha, p) => show(sha, p),
    journeys: async () =>
      git('ls-tree', '--name-only', `${graphSha}:${REAL_APP}`)
        .split('\n')
        .filter((f) => /^J-.*\.pw\.mjs$/.test(f))
        .map((f) => `${REAL_APP}/${f}`)
        .sort(),
    readGraph: (p) => show(graphSha, p),
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────────────────────

function eventPull() {
  const pr = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))?.pull_request;
  const head = String(pr?.head?.sha ?? '');
  const base = String(pr?.base?.sha ?? '');
  if (!pr || !SHA40.test(head) || !SHA40.test(base)) throw new Error('not a pull_request_target event with a base and head sha');
  if (pr.head?.repo?.full_name !== process.env.GITHUB_REPOSITORY) throw new Error('a pull request from a fork gets no test judge');
  return { number: pr.number, head, base };
}

/** Writes the input files; a change with nothing to judge, or too much to judge whole, is decided here. */
export async function writeInputs(dir, { src, base, head, pr, loadWords }) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'head.txt'), head);
  const brief = readFileSync(new URL('./test-judge/JUDGE.md', import.meta.url), 'utf8');
  // The words are read only when a step needs judging, so a PR that changes no test needs no project-state token.
  const got = await buildInputs({ src, base, head, pr, brief, loadWords });
  const done = (verdict, extra) => {
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ head, verdict, lines: [], ...extra }));
    writeFileSync(join(dir, 'skip-judge'), '1');
  };
  if (!got.applicable) {
    done('PASS', { findings: [`not applicable: ${got.why}`] });
    return `not applicable: ${got.why}`;
  }
  if (got.tooLarge) {
    done('FAIL', { findings: [got.tooLarge], wordsRef: got.wordsRef });
    return 'too large: FAIL without asking the judge';
  }
  const meta = { head, wordsRef: got.wordsRef, required: got.required, deterministic: got.deterministic, facts: got.facts };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  writeFileSync(join(dir, 'shingles.json'), JSON.stringify([...shingles(got.shingleTexts ?? [])]));
  if (!got.prompt) {
    done(got.deterministic.length ? 'FAIL' : 'PASS', meta);
    return `decided without the judge: ${got.deterministic.length} step(s) without words`;
  }
  writeFileSync(join(dir, 'prompt.txt'), got.prompt);
  writeFileSync(join(dir, 'schema.json'), JSON.stringify(JUDGE_SCHEMA));
  const f = got.facts;
  return `judging #${pr} at ${head}: ${f.own} own-test step(s), ${f.changes.length} shared or file-level change(s) reaching ${f.reached} step(s), ${f.sample} sampled; prompt ${f.bytes} bytes${f.left ? `, ${f.left} file(s) left out for size` : ''}`;
}

function cmdRead(dir) {
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const a = readAnswer(readFileSync(join(dir, 'answer.json'), 'utf8'), meta.required);
  if (!a.ok) {
    console.error(`::error::no verdict: ${a.why}. Re-run the job; nothing about this head is decided yet.`);
    process.exit(1);
  }
  const verdict = a.verdict === 'PASS' && meta.deterministic.length === 0 ? 'PASS' : 'FAIL';
  writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ ...meta, verdict, lines: a.lines, note: a.note }));
  console.log(`verdict ${verdict}`);
}

export function cmdJudge(dir, { exit = true } = {}) {
  const v = JSON.parse(readFileSync(join(dir, 'verdict.json'), 'utf8'));
  const set = existsSync(join(dir, 'shingles.json')) ? new Set(JSON.parse(readFileSync(join(dir, 'shingles.json'), 'utf8'))) : new Set();
  const lines = summaryLines(v, set);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  console.log(lines.join('\n'));
  if (v.verdict !== 'PASS' && exit) {
    console.error(
      `::error title=Test judge FAIL::a test no longer proves its step on ${v.head}; this FAIL stands for this head and its code, so push a fix that changes it (see the job summary)`,
    );
    process.exit(1);
  }
  return v.verdict;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const dir = rest.filter((a) => !a.startsWith('--')).at(-1);
  if (cmd === 'inputs') {
    const pull = eventPull();
    const src = ciSource(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN, process.env.GITHUB_WORKSPACE);
    const loadWords = async () => {
      const t = process.env.PROJECT_STATE_READ_TOKEN;
      if (!t)
        throw new Error(
          'the ci-review environment has no PROJECT_STATE_READ_TOKEN secret, so the step words are unreadable and nothing is decided',
        );
      return readWordsApi(t);
    };
    console.log(await writeInputs(dir, { src, base: pull.base, head: pull.head, pr: pull.number, loadWords }));
    return;
  }
  if (cmd === 'local') {
    const arg = (n) => (rest.includes(n) ? rest[rest.indexOf(n) + 1] : undefined);
    const clone = arg('--repo');
    const base = arg('--base');
    const head = arg('--head');
    const src = gitSource(clone, base);
    console.log(
      await writeInputs(dir, { src, base, head, pr: arg('--pr') ?? 'local', loadWords: async () => readWordsLocal(arg('--words')) }),
    );
    return;
  }
  if (cmd === 'read') return cmdRead(dir);
  if (cmd === 'judge') return void cmdJudge(dir);
  console.error('usage: test-judge.mjs inputs|read|judge <dir> | local --repo <clone> --base <sha> --head <sha> --words <dir> <dir>');
  process.exit(2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href)
  main().catch((e) => {
    console.error(`::error::test-judge: ${e.message}`);
    process.exit(1);
  });
