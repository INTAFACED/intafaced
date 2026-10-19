#!/usr/bin/env node
/**
 * RUN LEDGER - durable memory for an autonomous run.
 *
 * WHY THIS EXISTS
 * ---------------
 * The coordinator compacted 22 times across 8.8M tokens and merged 64 near
 * identical PRs without ever noticing it was repeating itself. Nothing on disk
 * held "what I already did", so every compaction started it over. Craft rule:
 * status/disk is memory, context death is expected, resume from the ledger
 * (~/projects/OS/graph-engineering/CRAFT.md #10).
 *
 * WHY NOT docs/AUTONOMOUS-RUN.md (removed)
 * ------------------------------
 * That file already tried this on 2026-07-27 and has the right shape - id,
 * status, proof, terminal-only stop rule. It failed for one reason: it was
 * MAINTAINED BY THE MODEL BY HAND, and nothing has written it since the day it
 * was created. The failure autopsy records it as "lagged / lied mid-flight".
 * So this ledger is written by CODE at every transition, never by an agent
 * deciding to remember. AUTONOMOUS-RUN.md (removed) stays as the historical record of
 * that run and points here.
 *
 * WHY THE FILE IS GITIGNORED
 * --------------------------
 * It is runtime state, not law. Committing it would mean a commit and ~5 CI
 * runs per status transition. Precedent: docs/ops/FREEZE-LIVE.json is ignored
 * the same way. The LAW - that the ledger exists and must be read before
 * choosing work - lives in AGENTS.md, which is in-repo and gate-enforced.
 *
 * DURABILITY
 * ----------
 * Every write is tmp -> fsync -> rename. rename(2) is atomic within a
 * filesystem, so a crash mid-write leaves the previous good file intact rather
 * than a truncated one. This is the single gap the graph-engineering audit said
 * to close first if a runner were ever built.
 *
 * USE
 *   node tooling/scripts/run-ledger.mjs open   <id> <type> [note]
 *   node tooling/scripts/run-ledger.mjs start  <id> [branch]
 *   node tooling/scripts/run-ledger.mjs pr     <id> <url>
 *   node tooling/scripts/run-ledger.mjs done   <id> <url>      # url REQUIRED
 *   node tooling/scripts/run-ledger.mjs block  <id> <reason>   # reason REQUIRED
 *   node tooling/scripts/run-ledger.mjs abandon <id> <reason>
 *   node tooling/scripts/run-ledger.mjs status                 # what a resuming agent reads
 *   node tooling/scripts/run-ledger.mjs open-count             # exit 1 if any row is non-terminal
 *   node tooling/scripts/run-ledger.mjs --self-test
 *
 * Law: docs/ops/FINISH-ONTOLOGY.md - a run is finished when every row is
 * terminal WITH PROOF, never when some PRs were opened.
 */
import { readFileSync, writeFileSync, existsSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.RUN_LEDGER_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LEDGER = join(ROOT, 'docs/ops/RUN-LEDGER.json');
const VERSION = 1;

/** terminal = the run may stop on it. Everything else means work remains. */
export const TERMINAL = new Set(['done', 'blocked', 'abandoned']);
export const STATUSES = ['pending', 'in_progress', 'verify_failed', 'pr_open', 'done', 'blocked', 'abandoned'];

export function emptyLedger() {
  return { version: VERSION, updated: null, claims: [] };
}

export function load(path = LEDGER) {
  if (!existsSync(path)) return emptyLedger();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.claims)) return emptyLedger();
    return raw;
  } catch {
    // A corrupt ledger must never look like an empty one - an empty ledger reads
    // as "nothing to do" and would silently authorise a fresh start.
    throw new Error(`run-ledger: ${path} is unreadable. Do NOT treat this as an empty run. Restore it or move it aside deliberately.`);
  }
}

/** tmp -> fsync -> rename. A crash leaves the previous good file, never a partial one. */
export function save(data, path = LEDGER) {
  data.updated = new Date().toISOString();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  return path;
}

/**
 * The one rule the model cannot talk its way past: a row reaches `done` only
 * with a proof link, and `blocked` only with a reason. "Made good progress" is
 * not a state this ledger can represent.
 */
export function transition(data, id, status, { pr, reason, branch, note } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`run-ledger: unknown status ${status}`);
  if (status === 'done' && !pr) throw new Error(`run-ledger: ${id} cannot be done without a proof link`);
  if ((status === 'blocked' || status === 'abandoned') && !reason) {
    throw new Error(`run-ledger: ${id} cannot be ${status} without a reason a human can read`);
  }
  let row = data.claims.find((c) => c.id === id);
  if (!row) {
    row = {
      id,
      type: note || 'claim',
      status: 'pending',
      branch: null,
      pr: null,
      started: new Date().toISOString(),
      updated: null,
      evidence: [],
      blocked_reason: null,
      attempts: 0,
    };
    data.claims.push(row);
  }
  if (status === 'in_progress' && row.status !== 'in_progress') row.attempts += 1;
  row.status = status;
  row.updated = new Date().toISOString();
  if (branch) row.branch = branch;
  if (pr) {
    row.pr = pr;
    if (!row.evidence.includes(pr)) row.evidence.push(pr);
  }
  if (reason) row.blocked_reason = reason;
  return row;
}

export function openRows(data) {
  return data.claims.filter((c) => !TERMINAL.has(c.status));
}

/**
 * Family of a claim: its id with digits stripped. `l3-wave-197` and `l3-wave-232`
 * are the same family; `fix-wallet-rpc-auth` is its own.
 */
export function family(id) {
  return (
    String(id)
      .replace(/\d+/g, '')
      .replace(/[^a-zA-Z]+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'unnamed'
  );
}

/**
 * Repetition, which is the thing a compaction summary throws away.
 *
 * Measured 2026-08-07: project law survives every compaction verbatim, so the mill was
 * NOT caused by losing its instructions. The carried-forward summary is what fails — it
 * preserves the *intent to continue* ("continuing...", merges #913-#938 listed as
 * progress) and discards the *evidence of futility*. Nothing in it said "you have done
 * this sixty times and it produced nothing."
 *
 * A task list would have survived compaction and still not have stopped the mill. A
 * COUNT does. This is the line the summary can never compress away.
 */
export function repetition(data, warnAt = REPEAT_WARN) {
  const counts = new Map();
  for (const c of data.claims) counts.set(family(c.id), (counts.get(family(c.id)) || 0) + 1);
  let top = '';
  let n = 0;
  for (const [k, v] of counts) if (v > n) [top, n] = [k, v];
  return { family: top, n, total: data.claims.length, warn: n >= warnAt, warnAt };
}

const REPEAT_WARN = Number(process.env.RUN_LEDGER_REPEAT_WARN || 8);

/** What a resuming agent reads. Deliberately plain text - it is read after a compaction. */
export function statusReport(data) {
  const open = openRows(data);
  const done = data.claims.filter((c) => c.status === 'done');
  const blocked = data.claims.filter((c) => c.status === 'blocked');
  const lines = [
    `run-ledger: ${data.claims.length} claim(s) - ${done.length} done, ${open.length} open, ${blocked.length} blocked`,
    `  updated: ${data.updated || 'never'}`,
  ];
  if (!data.claims.length) {
    lines.push('  EMPTY - no run in progress. Choose work from the board, then open a claim here FIRST.');
    return lines.join('\n');
  }
  const rep = repetition(data);
  if (rep.warn) {
    lines.push(`  ⚠ REPEATING - ${rep.n} of ${rep.total} claims are the same family "${rep.family}".`);
    lines.push('    A compaction summary carries the intent to continue and drops the evidence of futility.');
    lines.push('    This is that evidence. Name what the last one delivered, or work a different lane.');
  }
  if (open.length) {
    lines.push('  RESUME HERE - these are not finished. Do not start new work while any row is open:');
    for (const c of open)
      lines.push(
        `    ${c.status.padEnd(13)} ${c.id}${c.branch ? `  (${c.branch})` : ''}${c.attempts > 1 ? `  attempts=${c.attempts}` : ''}`,
      );
  } else {
    lines.push('  ALL ROWS TERMINAL - this run is finished. Every row has proof or a named blocker.');
  }
  for (const c of done) lines.push(`    done          ${c.id}  ${c.pr}`);
  for (const c of blocked) lines.push(`    blocked       ${c.id}  ${c.blocked_reason}`);
  return lines.join('\n');
}

function selfTest() {
  const fails = [];
  const ok = (c, m) => {
    if (!c) fails.push(m);
  };
  const tmpPath = join(process.env.TMPDIR || '/tmp', `run-ledger-selftest-${process.pid}.json`);

  let d = emptyLedger();
  transition(d, 'A-1', 'in_progress', { branch: 'feat/x' });
  ok(openRows(d).length === 1, 'an in_progress row is open');
  ok(d.claims[0].attempts === 1, 'first start counts one attempt');

  // done requires proof - the noise ban, enforced in code
  let threw = false;
  try {
    transition(d, 'A-1', 'done');
  } catch {
    threw = true;
  }
  ok(threw, 'done WITHOUT a proof link must throw');
  transition(d, 'A-1', 'done', { pr: 'https://example/pr/1' });
  ok(openRows(d).length === 0, 'done closes the row');

  threw = false;
  try {
    transition(d, 'A-2', 'blocked');
  } catch {
    threw = true;
  }
  ok(threw, 'blocked WITHOUT a reason must throw');
  transition(d, 'A-2', 'blocked', { reason: 'needs Denon' });
  ok(openRows(d).length === 0, 'blocked is terminal');

  // durability: the file survives, and a corrupt file never reads as empty
  save(d, tmpPath);
  ok(load(tmpPath).claims.length === 2, 'ledger round-trips through disk');
  ok(!existsSync(`${tmpPath}.tmp`), 'no .tmp file is left behind');
  writeFileSync(tmpPath, '{ this is not json', 'utf8');
  threw = false;
  try {
    load(tmpPath);
  } catch {
    threw = true;
  }
  ok(threw, 'a CORRUPT ledger must throw, never read as an empty run');
  unlinkSync(tmpPath);

  // resume text must tell a cold agent what to do, not just count
  const resume = statusReport(
    (() => {
      const r = emptyLedger();
      transition(r, 'B-1', 'in_progress', { branch: 'feat/y' });
      return r;
    })(),
  );
  ok(/RESUME HERE/.test(resume), 'an open row tells a resuming agent to resume');
  ok(/B-1/.test(resume), 'the open row is named');
  ok(/EMPTY/.test(statusReport(emptyLedger())), 'an empty ledger says so plainly');
  ok(/ALL ROWS TERMINAL/.test(statusReport(d)), 'a finished run says finished');

  // Repetition — the signal a compaction summary destroys. Law survives compaction
  // verbatim (measured); the summary's loss of "you already did this 60 times" is what
  // let the mill run. A task list alone would not have stopped it. A count does.
  ok(family('l3-wave-197') === family('l3-wave-232'), 'digits do not make a new family');
  ok(family('fix-wallet-rpc-auth') !== family('l3-wave-1'), 'different work is a different family');
  const mill = emptyLedger();
  for (let i = 1; i <= 9; i++) transition(mill, `l3-wave-${i}`, 'done', { pr: `https://example/pr/${i}` });
  const r = repetition(mill);
  ok(r.warn && r.n === 9, 'nine of one family raises the repeat warning');
  ok(/REPEATING/.test(statusReport(mill)), 'the resume text names the repetition');
  const varied = emptyLedger();
  for (const id of ['fix-wallet-auth', 'feat-trade-convert', 'docs-adr-dark-feed', 'fix-ready-settle', 'chore-keeper-assert']) {
    transition(varied, id, 'done', { pr: `https://example/pr/${id}` });
  }
  ok(!repetition(varied).warn, 'varied real work does NOT raise it');
  ok(!/REPEATING/.test(statusReport(varied)), 'no false alarm on varied work');

  if (fails.length) {
    console.error('run-ledger --self-test FAIL:');
    for (const f of fails) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`run-ledger --self-test OK (19 assertions)`);
  process.exit(0);
}

const [cmd, id, arg] = process.argv.slice(2);
if (cmd === '--self-test') selfTest();

/** A corrupt ledger is an operator problem, not a stack trace. Never exit 0 on it. */
function loadOrExplain() {
  try {
    return load();
  } catch (e) {
    console.error(`  x ${e.message}`);
    console.error('    A run was in progress and its record is damaged. Do not start fresh work:');
    console.error(`    restore ${LEDGER} from a backup, or move it aside deliberately and say so.`);
    process.exit(2);
  }
}

if (!cmd || cmd === 'status') {
  console.log(statusReport(loadOrExplain()));
  process.exit(0);
}

if (cmd === 'open-count') {
  const open = openRows(loadOrExplain());
  console.log(String(open.length));
  process.exit(open.length ? 1 : 0);
}

const MAP = {
  open: () => transition(load(), id, 'pending', { note: arg }),
  start: () => transition(load(), id, 'in_progress', { branch: arg }),
  pr: () => transition(load(), id, 'pr_open', { pr: arg }),
  done: () => transition(load(), id, 'done', { pr: arg }),
  block: () => transition(load(), id, 'blocked', { reason: arg }),
  abandon: () => transition(load(), id, 'abandoned', { reason: arg }),
};

if (!MAP[cmd]) {
  console.error(`run-ledger: unknown command ${cmd}. See the header for usage.`);
  process.exit(2);
}
if (!id) {
  console.error(`run-ledger: ${cmd} needs a claim id`);
  process.exit(2);
}

const data = loadOrExplain();
try {
  const row = transition(
    data,
    id,
    { open: 'pending', start: 'in_progress', pr: 'pr_open', done: 'done', block: 'blocked', abandon: 'abandoned' }[cmd],
    {
      pr: cmd === 'pr' || cmd === 'done' ? arg : undefined,
      reason: cmd === 'block' || cmd === 'abandon' ? arg : undefined,
      branch: cmd === 'start' ? arg : undefined,
      note: cmd === 'open' ? arg : undefined,
    },
  );
  save(data);
  console.log(`run-ledger: ${row.id} -> ${row.status}`);
} catch (e) {
  console.error(`  x ${e.message}`);
  process.exit(1);
}
