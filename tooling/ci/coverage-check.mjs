#!/usr/bin/env node
/**
 * COVERAGE CHECK — the gate §25:740 specified and nobody built.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `INTAFACED_DEFINITIVE_BUILD.md` §25, line 740, says verbatim:
 *
 *   "Coverage check: every named feature in Vol. I chapters I–XIX appears above
 *    exactly once with an owner and phase. CI carries `coverage-check`: this
 *    matrix is machine-readable (`tooling/coverage.yaml`); any Vol. I feature
 *    without a green DoD at its phase gate blocks the drop phase that promised
 *    it. Never half done — enforced."
 *
 * Neither the file nor the job existed. The consequence, found by hand in
 * `docs/audit/BUILD-COVERAGE-AUDIT-2026-08-03.md`: forty law-specified
 * capabilities with no tracker row, twenty of which are the whole of §27–§37 —
 * every word of law written after v2.0, with zero board presence, and nothing
 * anywhere saying so. Two of those twenty are phased at 2, the phase being
 * worked now. That audit had to be done by hand precisely because the machine
 * that was supposed to answer the question was never built.
 *
 * This gate is that machine. It answers one question on every push: is anything
 * in the law absent from the board without someone having said so out loud? —
 * and its mirror, is anything on the board claiming a law that does not say it?
 *
 * WHAT IT ASSERTS
 * ───────────────
 *   1. Every `## N ·` chapter of the law appears in `sections:` — so a chapter
 *      cannot be written and go unnoticed the way §27–§37 did.
 *   2. Every capability cites a law line that RESOLVES: the section exists and
 *      the line falls inside it. An invented cite fails.
 *   3. Every capability is exactly one of: mapped to tracker rows · `exempt`
 *      with a written reason and a recorded decision · `gap` with an audit cite.
 *      There is no fourth state, and silence is not one of the three.
 *   4. Every tracker row is claimed by a capability, or listed in
 *      `tracker_extra` with a basis that exists on disk. Both directions.
 *   5. The ratchet: the SET of gap ids and of orphan ids must equal the recorded
 *      baseline, by name. New drift fails on arrival; closing drift warns until
 *      the line comes out (a fix never fails; owner decision 2026-10-27). See "LANDING" below.
 *   6. Drop phases (§11): a phase marked `promised: true` whose capabilities
 *      are not all `done` fails — that is §25's "blocks the drop phase that
 *      promised it", enforced at the moment someone actually promises one.
 *
 * LANDING — why a ratchet and not a red gate
 * ──────────────────────────────────────────
 * Forty missing rows means a strict gate is red on `main` the hour it lands,
 * and a gate that is red on arrival gets disabled within a day. The two ways
 * out of that are (a) narrow what it checks until it passes — which recreates
 * the exact blindness this exists to fix — or (b) write today's gaps down, NAME
 * them, and refuse to let the set grow. This is (b). Precedent in this repo:
 * `BASELINE` in `fabricated-money-scan.mjs` (deleted 2026-10-13), where every frozen finding is
 * written out by its exact text and matched exactly.
 *
 * Named, and not counted, for one specific reason. The first version of this
 * gate froze two integers — `gaps: 41`, `orphans: 1` — and an integer cannot
 * distinguish "nothing changed" from "one closed and one opened". A PR that
 * fixes one gap and introduces another leaves the count at 41 and goes green
 * over exactly the new drift the ratchet was built to stop. Identity has no
 * such hole: the new id is not in the list, and it fails on arrival.
 *
 * An id that is a gap today and is not in the baseline is new drift and fails
 * loudly. An id in the baseline that is no longer a gap warns, with the line to
 * delete: a fix never fails the build (owner decision 2026-10-27). The cost is
 * that a stale id which re-opens before its line is deleted passes quietly, so
 * the warning names the line.
 *
 * WHAT IT DOES NOT DO — a gate that cries wolf gets disabled
 * ─────────────────────────────────────────────────────────
 * It reads structured data only: this YAML, `tooling/tracker/features.mjs` as a
 * module, and the law's `## N ·` chapter headings. It does not grep prose, does
 * not pattern-match commentary, and skips fenced code blocks when indexing the
 * law, so an example that happens to look like a heading cannot fire it.
 *
 * DEVIATIONS FROM §25 AS WRITTEN — declared, not silent
 * ────────────────────────────────────────────────────
 * See `tooling/coverage.yaml` → `meta.deviations`. Summary: Vol. I is a PDF and
 * is not machine-readable from this repo, so the enumerated axis is §25's own
 * matrix (plus the §30 and §38 addenda that extend it) rather than Vol. I
 * itself; and "owner" is read from the tracker row, which is where ownership
 * actually lives, rather than duplicated into this file.
 *
 * WHERE IT IS WIRED
 * ─────────────────
 * `pnpm verify` (after `tracker:check`, which it reads) and the `gates` job of
 * `.github/workflows/ci.yml`. That is how every other scan on `main` is wired.
 *
 * Wired through `tooling/ci/gates.mjs` (GATES entry `coverage`) and therefore
 * through `pnpm gates` / the `gates` job of `.github/workflows/ci.yml`. The
 * older note that said gates.mjs lived only on a stranded branch is obsolete —
 * gates.mjs is on main and this scan is one of its rows.
 *
 * Usage:
 *   node tooling/ci/coverage-check.mjs            run every check
 *   node tooling/ci/coverage-check.mjs --report   print the coverage report only
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const LAW_PATH = 'INTAFACED_DEFINITIVE_BUILD.md';
const YAML_PATH = 'tooling/coverage.yaml';
const TRACKER_PATH = 'tooling/tracker/features.mjs';

const problems = [];
/** @param {string} check @param {string} msg @param {string} [fix] */
function fail(check, msg, fix) {
  problems.push({ check, msg, fix });
}

// ───────────────────────────────────────────────────────────────────────────
// A deliberately tiny YAML reader.
//
// This gate has no dependency budget: it runs in the `gates` step before
// anything is built, and adding a parser to the root manifest to read one file
// is a lockfile every open PR would then conflict on. So this reads the exact
// subset `coverage.yaml` is written in — block mappings, block sequences, flow
// sequences, folded block scalars, quoted and bare scalars — and THROWS on
// anything it does not recognise. It can refuse to read; it cannot silently
// misread, which is the only property that matters for a file a gate makes
// decisions from.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Folded/literal block scalars are resolved during tokenisation and parked
 * here; the line parser below then only ever sees single-line values. The
 * handle is a control character, which cannot appear in the YAML source.
 */
const LITERALS = [];
const LIT = String.fromCharCode(1);

function parseScalar(raw, where) {
  let s = raw.trim();
  if (s === '') return '';
  if (s.startsWith(LIT)) return LITERALS[Number(s.slice(1))];
  if (s.startsWith("'") || s.startsWith('"')) {
    const q = s[0];
    let out = '';
    let i = 1;
    for (; i < s.length; i++) {
      if (s[i] === q) {
        if (q === "'" && s[i + 1] === "'") {
          out += "'";
          i++;
          continue;
        }
        break;
      }
      out += s[i];
    }
    if (i >= s.length) throw new Error(`${where}: unterminated ${q} string`);
    const rest = s.slice(i + 1).trim();
    if (rest !== '' && !rest.startsWith('#')) throw new Error(`${where}: trailing junk after quoted scalar: ${rest}`);
    return out;
  }
  const hash = s.indexOf(' #'); // YAML ends a bare scalar at " #"
  if (hash !== -1) s = s.slice(0, hash).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function parseFlowSeq(raw, where) {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((p) => parseScalar(p, where));
}

/** Split "key: value" respecting quotes. Null when the line is not a mapping entry. */
function splitKey(content) {
  let q = null;
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (q) {
      if (c === q) q = null;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      continue;
    }
    if (c === ':' && (i + 1 === content.length || content[i + 1] === ' ')) {
      return [content.slice(0, i).trim(), content.slice(i + 1).trim()];
    }
  }
  return null;
}

/** Fold a block scalar body per the `>`/`|` style, with `-` chomping. */
function foldBlock(bodyLines, style) {
  const fold = style.startsWith('>');
  const text = fold
    ? bodyLines.reduce((acc, l) => (l === '' ? acc + '\n' : acc === '' || acc.endsWith('\n') ? acc + l : acc + ' ' + l), '')
    : bodyLines.join('\n');
  return style.endsWith('-') ? text.replace(/\s+$/, '') : text;
}

function tokenize(text, file) {
  const raw = text.split(/\r?\n/);
  const toks = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (line.includes('\t')) throw new Error(`${file}:${i + 1}: tabs are not YAML indentation`);
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) throw new Error(`${file}:${i + 1}: indentation must be a multiple of 2`);
    let content = line.trim();

    // Block scalar: "key: >-", "- key: |", or a bare "- >-" sequence item.
    const bs = /^(- )?(?:(.+?):\s*)?(>-|>|\|-|\|)$/.exec(content);
    if (bs && (bs[2] || bs[1])) {
      const body = [];
      let j = i + 1;
      let bodyIndent = null;
      for (; j < raw.length; j++) {
        const l = raw[j];
        if (l.trim() === '') {
          body.push('');
          continue;
        }
        const ind = l.length - l.trimStart().length;
        if (ind <= indent) break;
        if (bodyIndent === null) bodyIndent = ind;
        body.push(l.slice(Math.min(ind, bodyIndent)));
      }
      while (body.length && body[body.length - 1] === '') body.pop();
      if (body.length === 0) throw new Error(`${file}:${i + 1}: block scalar with no body`);
      const handle = LIT + (LITERALS.push(foldBlock(body, bs[3])) - 1);
      content = `${bs[1] ?? ''}${bs[2] ? bs[2] + ': ' : ''}${handle}`;
      i = j - 1;
      toks.push({ indent, content, n: i + 1 });
      continue;
    }

    // Flow sequence that prettier has wrapped across lines.
    const kv = splitKey(content);
    const flowStart = kv && kv[1].startsWith('[') ? kv[1] : content.startsWith('[') ? content : null;
    if (flowStart && !balanced(flowStart)) {
      let acc = content;
      let j = i + 1;
      for (; j < raw.length && !balanced(acc); j++) acc += ' ' + raw[j].trim();
      if (!balanced(acc)) throw new Error(`${file}:${i + 1}: flow sequence never closes`);
      toks.push({ indent, content: acc.replace(/,\s*\]/, ']'), n: i + 1 });
      i = j - 1;
      continue;
    }

    toks.push({ indent, content, n: i + 1 });
  }
  return toks;
}

function balanced(s) {
  let d = 0;
  for (const c of s) {
    if (c === '[') d++;
    else if (c === ']') d--;
  }
  return d === 0;
}

function parseYaml(text, file) {
  const lines = tokenize(text, file);
  let pos = 0;

  function parseBlock(indent) {
    if (pos >= lines.length) return null;
    if (lines[pos].content.startsWith('- ')) {
      const out = [];
      while (pos < lines.length && lines[pos].indent === indent && lines[pos].content.startsWith('- ')) {
        const { content, n } = lines[pos];
        const item = content.slice(2).trim();
        const kv = splitKey(item);
        if (kv) {
          lines[pos] = { indent: indent + 2, content: item, n }; // "- key: v" is a mapping at indent+2
          out.push(parseBlock(indent + 2));
        } else {
          pos++;
          out.push(parseScalar(item, `${file}:${n}`));
        }
      }
      return out;
    }
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent) {
      const { content, n } = lines[pos];
      if (content.startsWith('- ')) break;
      const kv = splitKey(content);
      if (!kv) throw new Error(`${file}:${n}: not a "key: value" line: ${content}`);
      const [key, rawVal] = kv;
      if (key in obj) throw new Error(`${file}:${n}: duplicate key "${key}"`);
      pos++;
      if (rawVal === '' || rawVal.startsWith('#')) {
        const childIndent = pos < lines.length ? lines[pos].indent : -1;
        // prettier moves a long flow sequence onto its own line under the key.
        if (childIndent > indent && lines[pos].content.startsWith('[')) obj[key] = parseFlowSeq(lines[pos++].content, `${file}:${n}`);
        else if (childIndent > indent) obj[key] = parseBlock(childIndent);
        else if (childIndent === indent && pos < lines.length && lines[pos].content.startsWith('- ')) obj[key] = parseBlock(indent);
        else obj[key] = null;
      } else if (rawVal.startsWith('[')) {
        obj[key] = parseFlowSeq(rawVal, `${file}:${n}`);
      } else {
        obj[key] = parseScalar(rawVal, `${file}:${n}`);
      }
    }
    return obj;
  }

  const doc = parseBlock(0);
  if (pos !== lines.length) throw new Error(`${file}:${lines[pos].n}: unexpected indentation — parser stopped here`);
  return doc;
}

// ── Load the three inputs ──────────────────────────────────────────────────
if (!existsSync(join(ROOT, YAML_PATH))) {
  console.error(`\n✖ coverage-check: ${YAML_PATH} does not exist.\n`);
  console.error('  §25:740 names this file by path as the machine-readable form of the coverage matrix.');
  console.error('  Without it nothing can answer "are we building everything?" — which is how forty');
  console.error('  law capabilities went missing from the board with nobody noticing.\n');
  process.exit(1);
}

let doc;
try {
  doc = parseYaml(readFileSync(join(ROOT, YAML_PATH), 'utf8'), YAML_PATH);
} catch (err) {
  console.error(`\n✖ coverage-check: ${YAML_PATH} could not be read.\n  ${err.message}\n`);
  console.error('  The reader supports a deliberate subset (see the header of this file).');
  console.error('  It refuses rather than guesses: a gate that misreads its own input is worse than none.\n');
  process.exit(1);
}

const law = readFileSync(join(ROOT, LAW_PATH), 'utf8').split(/\r?\n/);

/** Chapter headings of the law. Code fences excluded so an example cannot fire this. */
const chapters = [];
{
  let inFence = false;
  for (let i = 0; i < law.length; i++) {
    if (/^\s*```/.test(law[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^## (\d+) · (.+)$/.exec(law[i]);
    if (m) chapters.push({ id: Number(m[1]), title: m[2].trim(), line: i + 1 });
  }
  for (let i = 0; i < chapters.length; i++) {
    chapters[i].endLine = i + 1 < chapters.length ? chapters[i + 1].line - 1 : law.length;
  }
}
const chapterById = new Map(chapters.map((c) => [c.id, c]));

const { FEATURES } = await import(pathToFileURL(join(ROOT, TRACKER_PATH)).href);
const featureById = new Map(FEATURES.map((f) => [f.id, f]));

const sections = doc.sections ?? [];
const capabilities = doc.capabilities ?? [];
const trackerExtra = doc.tracker_extra ?? [];
const dropPhases = doc.drop_phases ?? [];
const baseline = doc.baseline ?? {};

const MIN_REASON = 40;
const MIN_NOTE = 20;

// ── 0 · This gate walked something ─────────────────────────────────────────
//
// Every check below is a loop over `chapters`, `capabilities` or `FEATURES`.
// Any one of those arriving empty makes its checks a no-op, and the run then
// prints a tick for a question it never asked. That is not hypothetical for a
// gate whose inputs are three separate files reached by path: rename the law,
// change the `## N ·` heading style, break the tracker export, and discovery
// returns `[]` while every path still resolves.
//
// The house rule is `tooling/ci/fabricated-money-scan.mjs` (deleted 2026-10-13): discovery finding
// nothing is a REPORT, never a silent pass. There it is a loud exit 0, because
// the Vue shell may legitimately be gone. Here every one of the three is a
// FAILURE, because there is no state of this repo in which the law has no
// chapters, the coverage map no capabilities, or the tracker no rows — an empty
// walk here is a broken input, and passing it would clear the gate for every
// check that follows.
{
  const empty = [];
  if (chapters.length === 0) {
    empty.push(
      `${LAW_PATH} yielded NO "## N ·" chapters. Either the law moved, or its heading style changed and this ` +
        'gate is now reading a file it cannot see into. Fix the reader — do not let checks 1 and 2 pass on nothing.',
    );
  }
  if (capabilities.length === 0) {
    empty.push(
      `${YAML_PATH} has no capabilities:. Checks 2, 3 and 4 each iterate that list, so an empty one makes all ` +
        'three no-ops and the ratchet a comparison of zero against zero.',
    );
  }
  if (FEATURES.length === 0) {
    empty.push(
      `${TRACKER_PATH} exported an empty FEATURES. Every "does this row answer to something?" check reads it, ` +
        'so an empty export reports perfect coverage of a board with nothing on it.',
    );
  }
  if (empty.length > 0) {
    console.error('\n✖ coverage-check: THIS GATE OPENED NOTHING.\n');
    for (const e of empty) console.error(`  · ${e}\n`);
    console.error('  A clean run over an empty input is the failure this gate was written to catch, one level up.\n');
    process.exit(1);
  }
}

// ── 1 · Every chapter of the law is accounted for ──────────────────────────
// The check that would have caught §27–§37: eleven chapters written, none of
// them listed anywhere, and no gate that could notice.
{
  const listed = new Map();
  for (const s of sections) {
    if (typeof s?.id !== 'number') {
      fail('sections', `a sections entry has no numeric id: ${JSON.stringify(s)}`);
      continue;
    }
    if (listed.has(s.id)) fail('sections', `§${s.id} is listed twice in sections:`);
    listed.set(s.id, s);
    const ch = chapterById.get(s.id);
    if (!ch) {
      fail('sections', `sections: lists §${s.id}, which is not a chapter of ${LAW_PATH}.`, 'Remove it, or fix the number.');
      continue;
    }
    if (s.title && !ch.title.startsWith(String(s.title))) {
      fail('sections', `§${s.id} title drifted. coverage.yaml: "${s.title}" · law ${LAW_PATH}:${ch.line}: "${ch.title}"`);
    }
    if (s.disposition !== 'mapped' && s.disposition !== 'exempt') {
      fail('sections', `§${s.id} disposition must be "mapped" or "exempt", got ${JSON.stringify(s.disposition)}`);
    }
    if (s.disposition === 'exempt' && (typeof s.reason !== 'string' || s.reason.length < MIN_REASON)) {
      fail(
        'sections',
        `§${s.id} is exempt with no real reason (needs at least ${MIN_REASON} characters).`,
        'Out of scope is a legitimate answer. Saying nothing is not.',
      );
    }
  }
  for (const ch of chapters) {
    if (!listed.has(ch.id)) {
      fail(
        'sections',
        `§${ch.id} "${ch.title}" (${LAW_PATH}:${ch.line}) is a chapter of the law with NO entry in coverage.yaml sections:.`,
        'Add it with disposition: mapped (and capabilities citing it), or disposition: exempt with a written reason.\n' +
          '      This is the exact failure that hid §27–§37 — twenty capabilities, zero board presence, nothing saying so.',
      );
    }
  }
}

// ── 2 · Capabilities: the cite resolves, the disposition is one of three ───
const capIds = new Set();
const lawCiteOwner = new Map();
const claimedRows = new Map(); // tracker id -> capability ids that claim it
/** WHICH capabilities are gaps, not how many — see the ratchet at check 5. */
const gapIds = [];
const sectionsCited = new Set();

/** A cite is "<section>:<line>" and must land inside that section. */
function resolveCite(cite) {
  const m = typeof cite === 'string' ? /^(\d+):(\d+)$/.exec(cite) : null;
  if (!m) return { ok: false, why: `must be "<section>:<line>", got ${JSON.stringify(cite)}` };
  const sec = Number(m[1]);
  const line = Number(m[2]);
  const ch = chapterById.get(sec);
  if (!ch) return { ok: false, why: `cites §${sec}, which is not a chapter of the law` };
  if (line < ch.line || line > ch.endLine) {
    return { ok: false, why: `cites ${LAW_PATH}:${line} as §${sec}, but §${sec} spans lines ${ch.line}–${ch.endLine}` };
  }
  if (law[line - 1].trim() === '') return { ok: false, why: `cites ${LAW_PATH}:${line}, which is a blank line` };
  return { ok: true, sec, line };
}

for (const cap of capabilities) {
  const id = cap?.id;
  const at = `capability ${id ?? JSON.stringify(cap)}`;
  if (typeof id !== 'string' || id === '') {
    fail('capabilities', `a capabilities entry has no id: ${JSON.stringify(cap)}`);
    continue;
  }
  if (capIds.has(id)) fail('capabilities', `${at}: duplicate capability id.`);
  capIds.add(id);

  if (typeof cap.capability !== 'string' || cap.capability.length < 4) {
    fail('capabilities', `${at}: needs a "capability:" saying what the law promised.`);
  }

  const cite = resolveCite(cap.law);
  if (!cite.ok) {
    fail('capabilities', `${at}: law ${cite.why}.`, 'A capability cannot rest on a line the law does not have.');
  } else {
    sectionsCited.add(cite.sec);
    if (lawCiteOwner.has(cap.law)) {
      fail(
        'capabilities',
        `${at}: law line ${cap.law} is already claimed by "${lawCiteOwner.get(cap.law)}".`,
        '§25:740 — "appears above exactly once". One law line, one capability.',
      );
    } else {
      lawCiteOwner.set(cap.law, id);
    }
  }

  const states = ['tracker', 'exempt', 'gap'].filter((k) => cap[k] != null);
  if (states.length !== 1) {
    fail(
      'capabilities',
      `${at}: must have exactly one of tracker:, exempt:, gap: — found ${states.length ? states.join(' + ') : 'none'}.`,
      'The three states are: it is on the board · someone decided it is out of scope · it is a recorded gap.\n' +
        '      There is no fourth state, and silence is not one of the three.',
    );
    continue;
  }

  if (cap.tracker != null) {
    const rows = Array.isArray(cap.tracker) ? cap.tracker : [cap.tracker];
    if (rows.length === 0) fail('capabilities', `${at}: tracker: is empty. Use gap: or exempt: rather than an empty claim.`);
    for (const rowId of rows) {
      if (!featureById.has(rowId)) {
        fail(
          'capabilities',
          `${at}: claims tracker row "${rowId}", which does not exist in ${TRACKER_PATH}.`,
          'Either the row was removed and this capability is now a gap, or the id is a typo.\n' +
            '      Both mean the board no longer says what this file claims it says.',
        );
      } else {
        if (!claimedRows.has(rowId)) claimedRows.set(rowId, []);
        claimedRows.get(rowId).push(id);
      }
    }
  }

  if (cap.exempt != null) {
    const ex = cap.exempt;
    if (typeof ex !== 'object' || Array.isArray(ex)) {
      fail('capabilities', `${at}: exempt: must be a mapping with reason: and decided:.`);
    } else {
      if (typeof ex.reason !== 'string' || ex.reason.length < MIN_REASON) {
        fail(
          'capabilities',
          `${at}: exempt: needs a reason of at least ${MIN_REASON} characters.`,
          'Out of scope is a legitimate answer — "§27–§37 are not in scope for phase 2" is a decision\n' +
            '      somebody can make and record. What must be impossible is an exemption nobody wrote down.',
        );
      }
      if (typeof ex.decided !== 'string' || ex.decided === '') {
        fail('capabilities', `${at}: exempt: needs decided: — where the decision is recorded (a repo path, or a law cite).`);
      } else if (/^\d+:\d+$/.test(ex.decided)) {
        const d = resolveCite(ex.decided);
        if (!d.ok) fail('capabilities', `${at}: exempt.decided ${d.why}.`);
      } else if (!existsSync(join(ROOT, ex.decided))) {
        fail(
          'capabilities',
          `${at}: exempt.decided points at "${ex.decided}", which does not exist on disk.`,
          'An exemption resting on a document nobody wrote is a silent exemption with extra steps.',
        );
      }
    }
  }

  if (cap.gap != null) {
    const g = cap.gap;
    if (typeof g !== 'object' || Array.isArray(g)) {
      fail('capabilities', `${at}: gap: must be a mapping with audit: and note:.`);
    } else {
      if (typeof g.audit !== 'string' || g.audit === '') fail('capabilities', `${at}: gap: needs audit: — where this gap was established.`);
      if (typeof g.note !== 'string' || g.note.length < MIN_NOTE) {
        fail('capabilities', `${at}: gap: needs a note of at least ${MIN_NOTE} characters saying what is missing.`);
      }
      gapIds.push(id);
    }
  }
}

// A section declared "mapped" that nothing cites is a section that quietly
// stopped being covered.
for (const s of sections) {
  if (s?.disposition === 'mapped' && chapterById.has(s.id) && !sectionsCited.has(s.id)) {
    fail(
      'sections',
      `§${s.id} is marked disposition: mapped but no capability cites it.`,
      'Add the capabilities, or change it to exempt with a reason.',
    );
  }
}

// ── 3 · The other direction: every tracker row answers to something ────────
const orphanIds = [];
const VALID_BASIS = new Set(['adr', 'spec', 'decision', 'law-extension', 'orphan']);
const extraIds = new Set();

for (const ex of trackerExtra) {
  const id = ex?.id;
  const at = `tracker_extra ${id ?? JSON.stringify(ex)}`;
  if (typeof id !== 'string') {
    fail('tracker_extra', `an entry has no id: ${JSON.stringify(ex)}`);
    continue;
  }
  if (extraIds.has(id)) fail('tracker_extra', `${at}: listed twice.`);
  extraIds.add(id);
  if (!featureById.has(id)) {
    fail('tracker_extra', `${at}: no such row in ${TRACKER_PATH}. Remove the entry — it describes a row that is gone.`);
  }
  // `law-extension` means "implements law AND goes past it" — the §13 socket
  // arithmetic — so an overlap there is the honest state. Every other basis
  // asserts the row has NO law behind it, and a claim proves otherwise.
  if (claimedRows.has(id) && ex.basis !== 'law-extension') {
    fail(
      'tracker_extra',
      `${at}: basis "${ex.basis}" says no law covers this row, but capability "${claimedRows.get(id).join(', ')}" claims it does.`,
      'One of the two is wrong. Either drop the claim, or the row is not extra-legal after all.',
    );
  }
  if (!VALID_BASIS.has(ex.basis)) {
    fail('tracker_extra', `${at}: basis: must be one of ${[...VALID_BASIS].join(' | ')}, got ${JSON.stringify(ex.basis)}`);
    continue;
  }
  if (typeof ex.reason !== 'string' || ex.reason.length < MIN_REASON) {
    fail('tracker_extra', `${at}: needs a reason of at least ${MIN_REASON} characters. A row with no law and no reason is an orphan.`);
  }
  if (ex.basis === 'adr' || ex.basis === 'spec' || ex.basis === 'decision') {
    if (typeof ex.source !== 'string' || !existsSync(join(ROOT, ex.source))) {
      fail(
        'tracker_extra',
        `${at}: basis "${ex.basis}" needs source: pointing at a document that exists. Got ${JSON.stringify(ex.source)}.`,
        'This is the mirror of an invented law cite: a row cannot claim a decision nobody wrote.',
      );
    }
  }
  if (ex.basis === 'law-extension' && (typeof ex.extends !== 'number' || !chapterById.has(ex.extends))) {
    fail('tracker_extra', `${at}: basis "law-extension" needs extends: <section number> that exists. Got ${JSON.stringify(ex.extends)}.`);
  }
  if (ex.basis === 'orphan') orphanIds.push(id);
}

for (const f of FEATURES) {
  if (!claimedRows.has(f.id) && !extraIds.has(f.id)) {
    fail(
      'tracker_extra',
      `tracker row "${f.id}" ("${f.title}") is claimed by no capability and is not in tracker_extra:.`,
      'Either it implements a law line — map it — or it does not, and it needs a written basis.\n' +
        '      A row on the board answering to nothing is how "audited leaders, profit share" got rendered as claimable.',
    );
  }
}

// ── 4 · Drop phases (§11) — "blocks the drop phase that promised it" ───────
const dropReport = [];
for (const dp of dropPhases) {
  const at = `drop_phase ${dp?.id ?? JSON.stringify(dp)}`;
  const caps = Array.isArray(dp?.capabilities) ? dp.capabilities : [];
  if (typeof dp?.id !== 'string') fail('drop_phases', `${at}: needs a string id (the §11 drop phase).`);
  const cite = resolveCite(dp?.law);
  if (!cite.ok) fail('drop_phases', `${at}: law ${cite.why}.`);
  const notReady = [];
  for (const capId of caps) {
    const cap = capabilities.find((c) => c?.id === capId);
    if (!cap) {
      fail('drop_phases', `${at}: names capability "${capId}", which is not in capabilities:.`);
      continue;
    }
    const rows = cap.tracker == null ? [] : Array.isArray(cap.tracker) ? cap.tracker : [cap.tracker];
    if (rows.length === 0) notReady.push(`${capId} (no tracker row at all)`);
    else {
      const red = rows.filter((r) => featureById.get(r)?.status !== 'done');
      if (red.length) notReady.push(`${capId} → ${red.map((r) => `${r}:${featureById.get(r)?.status ?? '?'}`).join(', ')}`);
    }
  }
  dropReport.push({ id: dp?.id, name: dp?.name, promised: dp?.promised === true, total: caps.length, notReady });
  if (dp?.promised === true && notReady.length) {
    fail(
      'drop_phases',
      `${at} is marked promised: true but ${notReady.length} of its ${caps.length} capabilities have no green DoD:\n        · ${notReady.join('\n        · ')}`,
      '§25:740 — "any Vol. I feature without a green DoD at its phase gate blocks the drop phase that\n' +
        '      promised it." Either the drop is not promised yet, or those rows finish first.',
    );
  }
}

// ── 5 · The ratchet ────────────────────────────────────────────────────────
//
// BY NAME, NOT BY NUMBER. This was `gaps: 41` and `orphans: 1` — two integers
// compared against two counts — and that is a ratchet with a hole straight
// through the middle of it: close one gap in the same PR that opens another and
// the count is still 41, so the gate goes green over a swap it never saw. The
// two events cancel, and the one that cancels them is precisely the new drift
// this gate exists to catch. A count cannot tell "nothing changed" from "two
// things changed in opposite directions", and only one of those is fine.
//
// So the baseline records WHICH, exactly as `BASELINE` does in
// `tooling/ci/fabricated-money-scan.mjs` (deleted 2026-10-13): every frozen row written out by its
// own identity, matched exactly —
//
//   · an id that is a gap today and is not in the list  → NEW. Fail.
//   · an id in the list that is no longer a gap         → STALE. Warn, with the
//     line to delete (owner decision 2026-10-27: a fix never fails the build).
//
// It also makes the frozen debt legible. `41` names nothing; a list names the
// forty-one capabilities somebody has to come back for, and a reviewer can see
// which one a PR is actually moving.
function ratchet(label, actual, recorded, what, singular) {
  if (!Array.isArray(recorded)) {
    fail(
      'baseline',
      `baseline.${label} must be a LIST of ids — it is the whole ratchet.`,
      'A count was the previous shape and it could not see a swap: one closed and one opened in the\n' +
        '      same PR leaves the number identical. Write the ids out, one per line.',
    );
    return;
  }

  const seen = new Set();
  for (const id of recorded) {
    if (seen.has(id)) fail('baseline', `baseline.${label} lists "${id}" twice.`);
    seen.add(id);
  }

  const frozen = new Set(recorded);
  const current = new Set(actual);

  for (const id of actual) {
    if (!frozen.has(id)) {
      fail(
        'baseline',
        `NEW ${singular}: "${id}" is ${what}, and it is not in baseline.${label}.`,
        'This is new drift, and it is the thing this gate exists to stop. Close it — or, if it is a\n' +
          `      deliberate decision, record it as an exemption with a reason and add it to baseline.${label} knowingly.`,
      );
    }
  }
  for (const id of recorded) {
    if (!current.has(id)) {
      const msg = `STALE baseline.${label} entry: "${id}" is no longer ${what} — good; delete that line from baseline.${label} in ${YAML_PATH}.`;
      console.log(process.env.GITHUB_ACTIONS ? `::warning title=Coverage check::${msg}` : `  ! ${msg}`);
    }
  }
}
ratchet('gaps', gapIds, baseline.gaps, 'a law capability with no tracker row and no exemption', 'gap');
ratchet('orphans', orphanIds, baseline.orphans, 'a tracker row with no law basis and no written decision', 'orphan');

// ── Report ─────────────────────────────────────────────────────────────────
const mapped = capabilities.filter((c) => c?.tracker != null).length;
const exempt = capabilities.filter((c) => c?.exempt != null).length;

console.log('\n══ COVERAGE CHECK (§25:740) ══\n');
console.log(`  law chapters        ${chapters.length} in ${LAW_PATH}, ${sections.length} accounted for in ${YAML_PATH}`);
console.log(`  capabilities        ${capabilities.length}  ·  mapped ${mapped}  ·  exempt ${exempt}  ·  gap ${gapIds.length}`);
console.log(
  `  tracker rows        ${FEATURES.length}  ·  claimed ${claimedRows.size}  ·  extra-legal ${extraIds.size} (orphans ${orphanIds.length})`,
);
console.log(
  `  ratchet             gaps ${gapIds.length}/${Array.isArray(baseline.gaps) ? baseline.gaps.length : '?'}` +
    `  ·  orphans ${orphanIds.length}/${Array.isArray(baseline.orphans) ? baseline.orphans.length : '?'}` +
    `  — frozen BY NAME, so a close and an open in the same PR cannot cancel`,
);
if (dropReport.length) {
  console.log('\n  drop phases (§11) — a phase blocks only once it is promised:');
  for (const d of dropReport) {
    const state = d.notReady.length === 0 ? 'shippable' : `${d.notReady.length}/${d.total} not green`;
    console.log(`    ${d.promised ? '●' : '○'} ${String(d.id).padEnd(4)} ${String(d.name ?? '').padEnd(16)} ${state}`);
  }
}

if (process.argv.includes('--report')) {
  console.log('');
  process.exit(0);
}

if (problems.length) {
  const byCheck = new Map();
  for (const p of problems) {
    if (!byCheck.has(p.check)) byCheck.set(p.check, []);
    byCheck.get(p.check).push(p);
  }
  console.error(`\n✖ coverage-check failed — ${problems.length} problem(s)\n`);
  for (const [check, list] of byCheck) {
    console.error(`── ${check} ──`);
    for (const p of list) {
      console.error(`  · ${p.msg}`);
      if (p.fix) console.error(`      ${p.fix}`);
    }
    console.error('');
  }
  console.error('  This gate is the law\'s own answer to "are we building everything?" (§25:740).');
  console.error('  Do not make it pass by checking less. Record the decision instead.\n');
  process.exit(1);
}

console.log('\n✓ coverage-check clean — every law chapter accounted for, every tracker row answers to something\n');
