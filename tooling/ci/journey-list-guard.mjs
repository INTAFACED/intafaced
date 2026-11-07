#!/usr/bin/env node
/**
 * PR-only guard: the journey list is the finish line, so a pull request can't shrink it quietly. INTAFACED is finished
 * when every live journey in docs/roadmap/journeys.json passes in the running app on main, and scope never shrinks
 * (owner decision OWNER 1). Before this, the list was guarded only by the `gate:` title rule and a human read: the read of
 * #7438 planted faults and found that a slice id that doesn't exist passed every check, that a dropped journey failed
 * only `roadmap.mjs --check`, which a regenerated docs/ROADMAP.md silences, and that no workflow ran `--check` at all
 * (intafaced #7438, comment 6705940437).
 *
 * It refuses a pull request (its checkout against the base ref) that:
 *   - drops a journey or a step that is on the base: removes it from journeys.json, or takes a live one out of the live
 *     count (a new `Parked:` or `Deferred:` line, or PARKED or DEFERRED in a step's Slices cell; roadmap.mjs isLiveJourney
 *     and isLiveStep), unless the body retires it on a strict line (below);
 *   - names, in a step of journeys.json, a slice id that isn't in docs/roadmap/slices.json, the slice records journeys.json
 *     is built from (roadmap.mjs `--index` keeps only ids that are slice headings, so an unknown one was typed by hand);
 *   - has a journeys.json that isn't the shape `--index` writes (a journey id used twice, a step number used twice, ...);
 *   - has a docs/ROADMAP.md other than the one the base's roadmap.mjs builds from the pull request's slices.json and
 *     journeys.json (what `roadmap.mjs --check` checks, with the base's code, so a pull request can't change both the
 *     page and the code that writes it).
 * The drop check reads journeys.json, never ROADMAP.md, so regenerating the page hides nothing.
 *
 * A journey or step may still be retired, on one strict machine line in the body, modelled on the seal's
 * `Left-or-replaced:` line (journey-seal.mjs): `Journey-retired: J-bank-13 #2 #3, J-bank-14 (OWNER 240)`, at column 0,
 * outside any fenced code block and any HTML comment, holding only journey ids (a whole journey) or journey ids with step
 * numbers, then the owner decision that retires them in parentheses. Anything else that looks like one (any case, indented,
 * in a list, with no OWNER number, or with anything else on it) fails closed and is named. The body is read only when
 * something is dropped: from the API when GH_TOKEN, REPO and PR_NUMBER are set (so re-running the job reads an edited
 * body), else from PR_BODY.
 *
 * CI runs the default branch's copy from the `gates` job of ci.yml, in a worktree of the base, so its import of
 * roadmap.mjs (what is live, and how the page is built) is the base's too; the pull request's copy runs only while the
 * base has none (the pull request that adds it). Its tests are tooling/ci/journey-list-guard.test.mjs.
 *
 *   node tooling/ci/journey-list-guard.mjs [--base-ref origin/main]     (from the pull request's checkout)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, liveJourneys } from '../scripts/roadmap.mjs';
import { linesOutsideCode } from './journey-seal.mjs';

export const JOURNEYS_PATH = 'docs/roadmap/journeys.json';
export const SLICES_PATH = 'docs/roadmap/slices.json';
export const ROADMAP_PATH = 'docs/ROADMAP.md';

/** The retirement line, exactly: column 0, this case, a colon, then the items and `(OWNER <n>)` last. */
const RETIRE_LINE = /^Journey-retired:(.*)$/;
/** Anything that looks like a retirement line, wherever it sits and however it is written. */
const LOOKS_RETIRE = /journey[ \t]*-[ \t]*retired[ \t]*:/i;
const OWNER_TAIL = /^(.*\S)[ \t]+\(OWNER ([1-9]\d*)\)$/;
const ITEM = /^(J-[a-z0-9]+(?:-[a-z0-9]+)*-\d+)((?:[ \t]+#[1-9]\d*)*)$/;
const JOURNEY_ID = /^J-[a-z0-9]+(?:-[a-z0-9]+)*-\d+$/;
const byKey = (a, b) => a.localeCompare(b, 'en', { numeric: true });

/**
 * What a body retires: { journeys: Map<id, owner>, steps: Map<'J-x-01#2', owner>, problems: [line] }. Only lines outside
 * code and comments count (journey-seal.mjs linesOutsideCode).
 */
export function retirements(body) {
  const journeys = new Map();
  const steps = new Map();
  const problems = [];
  for (const line of linesOutsideCode(body)) {
    if (!LOOKS_RETIRE.test(line)) continue;
    const m = RETIRE_LINE.exec(line);
    const tail = m ? OWNER_TAIL.exec(m[1].trim()) : null;
    const items = tail ? tail[1].split(',').map((x) => ITEM.exec(x.trim())) : [];
    if (!tail || !items.length || items.some((x) => !x)) {
      problems.push(line.trim());
      continue;
    }
    const owner = Number(tail[2]);
    for (const [, id, nums] of items) {
      const ns = [...nums.matchAll(/#(\d+)/g)].map((x) => Number(x[1]));
      if (!ns.length) journeys.set(id, owner);
      for (const n of ns) steps.set(`${id}#${n}`, owner);
    }
  }
  return { journeys, steps, problems };
}

/** Problems with the shape `roadmap.mjs --index` writes: an array of journeys with unique ids and unique step numbers. */
export function shapeProblems(journeys) {
  if (!Array.isArray(journeys)) return [`${JOURNEYS_PATH} is not a list of journeys`];
  const out = [];
  const ids = new Set();
  for (const [i, j] of journeys.entries()) {
    const id = j?.id;
    if (typeof id !== 'string' || !JOURNEY_ID.test(id)) {
      out.push(`journey ${i} has no valid id (${JSON.stringify(id)})`);
      continue;
    }
    if (ids.has(id)) out.push(`${id} is used twice`);
    ids.add(id);
    if (!Array.isArray(j.steps)) {
      out.push(`${id} has no steps list`);
      continue;
    }
    const ns = new Set();
    for (const st of j.steps) {
      if (!Number.isInteger(st?.n) || st.n < 1) out.push(`${id} has a step with no valid number (${JSON.stringify(st?.n)})`);
      else if (ns.has(st.n)) out.push(`${id} #${st.n} is used twice`);
      else ns.add(st.n);
      if (!Array.isArray(st?.slices) || st.slices.some((s) => typeof s !== 'string'))
        out.push(`${id} #${st?.n}: its slices are not a list of slice ids`);
    }
  }
  return out;
}

/** Each step slice id that is not a slice record: `J-x-01 #2: XX-01`. */
export function unknownSlices(journeys, slices) {
  const known = new Set((slices ?? []).map((s) => s?.id));
  const out = [];
  for (const j of journeys ?? [])
    for (const st of j?.steps ?? []) for (const id of st?.slices ?? []) if (!known.has(id)) out.push(`${j.id} #${st.n}: ${id}`);
  return out;
}

function present(journeys) {
  const ids = new Set();
  const keys = new Set();
  for (const j of journeys) {
    ids.add(j.id);
    for (const st of j.steps ?? []) keys.add(`${j.id}#${st.n}`);
  }
  return { ids, keys };
}
function live(journeys) {
  return present(liveJourneys(journeys));
}

/**
 * What the head drops from the base: { journeys: [{ id, how }], steps: [{ key, how }] }. A journey is dropped when it is
 * gone, or live on the base and not on the head; a step of a journey not dropped, the same. `how` says which.
 */
export function drops(base, head) {
  const [bAll, hAll, bLive, hLive] = [present(base), present(head), live(base), live(head)];
  const journeys = [];
  for (const id of bAll.ids) {
    if (!hAll.ids.has(id)) journeys.push({ id, how: 'removed' });
    else if (bLive.ids.has(id) && !hLive.ids.has(id)) journeys.push({ id, how: 'taken out of the live count' });
  }
  const gone = new Set(journeys.map((j) => j.id));
  const steps = [];
  for (const key of bAll.keys) {
    if (gone.has(key.split('#')[0])) continue;
    if (!hAll.keys.has(key)) steps.push({ key, how: 'removed' });
    else if (bLive.keys.has(key) && !hLive.keys.has(key)) steps.push({ key, how: 'taken out of the live count' });
  }
  return { journeys: journeys.sort((a, b) => byKey(a.id, b.id)), steps: steps.sort((a, b) => byKey(a.key, b.key)) };
}

/** The exact line that would retire `d` (drops()), with a placeholder for the owner decision. */
export function retireLine(d) {
  const by = new Map(d.journeys.map((j) => [j.id, []]));
  for (const { key } of d.steps) {
    const [id, n] = key.split('#');
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(`#${n}`);
  }
  return `Journey-retired: ${[...by].map(([id, ns]) => [id, ...ns].join(' ')).join(', ')} (OWNER <n>)`;
}

/**
 * The verdict. `body` is read only when something is dropped (a function, so the caller fetches it only then).
 * `roadmapFresh`: the pull request's docs/ROADMAP.md is what the base's roadmap.mjs builds. Returns { ok, lines }.
 */
export async function judge({ base, head, slices, roadmapFresh, body }) {
  const lines = [];
  const shape = shapeProblems(head);
  if (shape.length) return { ok: false, lines: shape.map((p) => `${JOURNEYS_PATH}: ${p}`) };
  for (const u of unknownSlices(head, slices)) lines.push(`${JOURNEYS_PATH} names a slice that isn't in ${SLICES_PATH}: ${u}`);
  if (!roadmapFresh)
    lines.push(
      `${ROADMAP_PATH} is not what the base's roadmap.mjs builds from this pull request's ${SLICES_PATH} and ${JOURNEYS_PATH}; run \`node tooling/scripts/roadmap.mjs\``,
    );
  const d = drops(base, head);
  if (d.journeys.length || d.steps.length) {
    const r = retirements(typeof body === 'function' ? await body() : body);
    if (r.problems.length)
      for (const p of r.problems)
        lines.push(
          `"${p.slice(0, 160)}" looks like a retirement but isn't one: write \`Journey-retired: J-bank-13 #2, J-bank-14 (OWNER 240)\` at the start of a line, outside code`,
        );
    const left = {
      journeys: d.journeys.filter((j) => !r.journeys.has(j.id)),
      steps: d.steps.filter((s) => !r.journeys.has(s.key.split('#')[0]) && !r.steps.has(s.key)),
    };
    for (const j of d.journeys)
      if (r.journeys.has(j.id)) console.log(`journey-list-guard: ${j.id} ${j.how}, retired by OWNER ${r.journeys.get(j.id)}`);
    for (const s of d.steps) {
      const owner = r.steps.get(s.key) ?? r.journeys.get(s.key.split('#')[0]);
      if (owner) console.log(`journey-list-guard: ${s.key.replace('#', ' #')} ${s.how}, retired by OWNER ${owner}`);
    }
    for (const j of left.journeys)
      lines.push(`${j.id} is on the base and this pull request ${j.how === 'removed' ? 'removes it' : 'takes it out of the live count'}`);
    for (const s of left.steps)
      lines.push(
        `${s.key.replace('#', ' #')} is on the base and this pull request ${s.how === 'removed' ? 'removes it' : 'takes it out of the live count'}`,
      );
    if (left.journeys.length || left.steps.length)
      lines.push(
        `the journey list is the finish line and scope never shrinks (OWNER 1). To retire these on an owner decision, add this line to the body, at the start of a line and outside code, with that decision's OWNER number, then re-run the Doctrine gates job: ${retireLine(left)}`,
      );
  }
  return { ok: lines.length === 0, lines };
}

async function bodyFromEnv() {
  const { GH_TOKEN, REPO, PR_NUMBER, PR_BODY } = process.env;
  if (!(GH_TOKEN && REPO && PR_NUMBER)) return PR_BODY ?? '';
  const res = await fetch(`https://api.github.com/repos/${REPO}/pulls/${PR_NUMBER}`, {
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'journey-list-guard' },
  });
  // A refusal stops here; the guard fails closed rather than judge a body it could not read.
  if (!res.ok) throw new Error(`reading pull request ${PR_NUMBER}'s body: ${res.status} ${await res.text()}`);
  return (await res.json()).body ?? '';
}

async function main(argv) {
  const at = argv.indexOf('--base-ref');
  const baseRef = at === -1 ? 'origin/main' : argv[at + 1];
  const cwd = process.cwd();
  const read = (p) => readFileSync(join(cwd, p), 'utf8');
  let baseText;
  try {
    baseText = execFileSync('git', ['show', `${baseRef}:${JOURNEYS_PATH}`], { cwd, encoding: 'utf8', maxBuffer: 64 * 2 ** 20 });
  } catch {
    // Only "the base has no journeys.json" may pass as an empty base; a missing ref fails.
    execFileSync('git', ['rev-parse', '--verify', `${baseRef}^{commit}`], { cwd, stdio: 'ignore' });
    baseText = '[]';
  }
  const base = JSON.parse(baseText);
  const head = JSON.parse(read(JOURNEYS_PATH));
  const slices = JSON.parse(read(SLICES_PATH));
  const roadmap = existsSync(join(cwd, ROADMAP_PATH)) ? read(ROADMAP_PATH) : '';
  const roadmapFresh = shapeProblems(head).length ? false : (await compose(slices, head, roadmap)) === roadmap;
  const v = await judge({ base, head, slices, roadmapFresh, body: bodyFromEnv });
  for (const l of v.lines) console.error(`journey-list-guard: ${l}`);
  if (v.ok) console.log(`journey-list-guard: ok (${head.length} journeys against ${baseRef}'s ${base.length})`);
  return v.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`journey-list-guard: ${e.message}`);
      process.exit(1);
    },
  );
}
