#!/usr/bin/env node
/**
 * THE PROJECT TRACKER.
 *
 *   pnpm tracker          render docs/TRACKER.md and print the summary
 *   pnpm tracker:check    fail if TRACKER.md is stale or the registry is invalid (CI)
 *   pnpm tracker ready    just list what is claimable right now
 *   pnpm tracker <module> everything for one module
 *
 * A tracker is only useful if it is TRUE. Two mechanisms keep it honest:
 *
 *   1. `blocked` is COMPUTED, never declared. A feature is blocked when a
 *      dependency is not done — so nobody can mark something ready by wishing.
 *   2. `done` is VALIDATED against the repo. A feature claiming done whose
 *      service does not exist on disk fails the check. You cannot tick a box
 *      for code that is not there.
 *
 * CI runs `tracker:check`, so a PR that ships a feature without updating the
 * registry — or updates the registry without shipping — goes red.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { FEATURES, PHASE_ORDER, PHASE_NAMES } from '../tracker/features.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUTPUT = join(ROOT, 'docs', 'TRACKER.md');
const REGISTRY = join(ROOT, 'tooling', 'tracker', 'features.mjs');
const arg = process.argv[2];
const checkMode = arg === '--check' || arg === 'check';

// ── Validate ────────────────────────────────────────────────────────────────

const byId = new Map(FEATURES.map((f) => [f.id, f]));
const problems = [];

/**
 * Duplicate object keys in the registry SOURCE.
 *
 * This one cannot be caught by looking at `FEATURES`, because by the time the
 * module has been imported the damage is done and invisible: JavaScript keeps
 * the LAST value for a repeated key and discards the earlier ones silently, so
 * a row with two `note:` fields loads as a row with one note and no error
 * anywhere. That happened — `dex.quote-router` carried two, and the ownership
 * sentence in the first ("agents babysit only") never reached docs/TRACKER.md
 * for as long as it was there. Nothing else in this repo would have said so:
 * there is no root ESLint config, so `no-dupe-keys` never ran over this file.
 *
 * So the check has to read the text. Strings and comments are masked first —
 * every `note:` in this file is prose that mentions colons, braces and the word
 * "note" — and then bare and quoted keys are collected per object literal.
 *
 * @param {string} src
 * @returns {string[]} one message per duplicate, empty when clean
 */
function duplicateKeys(src) {
  const CODE = 0;
  const kind = new Uint8Array(src.length); // CODE, or 1 for string/comment body
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const block = src[i + 1] === '*';
      const end = block ? src.indexOf('*/', i + 2) : src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end + (block ? 2 : 0);
      for (let j = i; j < stop; j++) if (src[j] !== '\n') kind[j] = 1;
      i = stop - 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      for (let k = i; k <= Math.min(j, src.length - 1); k++) if (src[k] !== '\n') kind[k] = 1;
      i = j;
      continue;
    }
  }

  const lineOf = (index) => src.slice(0, index).split('\n').length;
  const found = [];
  /** @type {Array<{object: boolean, keys: Map<string, number>}>} */
  const stack = [];
  const isIdent = (c) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

  const declare = (name, at) => {
    const top = stack[stack.length - 1];
    if (!top?.object) return;
    if (top.keys.has(name)) {
      found.push(
        `duplicate key "${name}" at tooling/tracker/features.mjs:${lineOf(at)} — the one at line ${top.keys.get(name)} is silently discarded`,
      );
    } else {
      top.keys.set(name, lineOf(at));
    }
  };

  /** The next code character that is not whitespace or a masked comment. */
  const nextCode = (from) => {
    let j = from;
    while (j < src.length && (kind[j] !== CODE || /\s/.test(src[j]))) j++;
    return j;
  };

  for (let i = 0; i < src.length; i++) {
    if (kind[i] !== CODE) {
      // A quoted key: the string body is masked, but its bounds are not.
      const quote = src[i];
      if (quote === "'" || quote === '"') {
        let j = i + 1;
        while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
        const after = nextCode(j + 1);
        if (src[after] === ':' && src[after + 1] !== ':') declare(src.slice(i + 1, j), i);
        i = j;
      }
      continue;
    }
    const c = src[i];
    if (c === '{') stack.push({ object: true, keys: new Map() });
    else if (c === '[' || c === '(') stack.push({ object: false, keys: new Map() });
    else if (c === '}' || c === ']' || c === ')') stack.pop();
    else if (/[A-Za-z_$]/.test(c) && !isIdent(src[i - 1])) {
      let j = i;
      while (isIdent(src[j])) j++;
      const after = nextCode(j);
      if (src[after] === ':' && src[after + 1] !== ':') declare(src.slice(i, j), i);
      i = j - 1;
    }
  }
  return found;
}

problems.push(...duplicateKeys(readFileSync(REGISTRY, 'utf8')));

for (const feature of FEATURES) {
  for (const dep of feature.dependsOn) {
    if (!byId.has(dep)) problems.push(`${feature.id}: depends on unknown feature "${dep}"`);
  }

  // The anti-wishful-thinking check (L8-2).
  if (feature.status === 'done') {
    if (!feature.requires || feature.requires.length === 0) {
      problems.push(`${feature.id}: claims "done" but has empty requires[] — path evidence is mandatory`);
    }
    for (const path of feature.requires ?? []) {
      if (!existsSync(join(ROOT, path))) {
        problems.push(`${feature.id}: claims "done" but ${path} does not exist`);
      }
      // Service features that claim done should have a mounted router, not only a folder.
      if (/^services\/svc-[^/]+$/.test(path) || /\/src\/index\.ts$/.test(path)) {
        const indexPath = path.endsWith('index.ts') ? path : join(path, 'src', 'index.ts');
        const full = join(ROOT, indexPath);
        if (existsSync(full)) {
          const src = readFileSync(full, 'utf8');
          if (!/fastifyTRPCPlugin|register\(.*trpc|\/trpc/.test(src) && /services\/svc-/.test(path)) {
            // edge/ws may not mount tRPC the same way — only flag classic svc cores
            if (!/svc-edge|svc-ws|svc-matching/.test(path) && !/svc-indexer/.test(path)) {
              if (!/fastifyTRPCPlugin|@trpc\/server\/adapters\/fastify/.test(src)) {
                problems.push(`${feature.id}: claims "done" but ${indexPath} does not register tRPC — demote to ready/wip until mounted`);
              }
            }
          }
        }
      }
    }
  }

  if (feature.status === 'wip' && !feature.owner) {
    problems.push(`${feature.id}: is "wip" with no owner — who is on it?`);
  }
}

const ids = FEATURES.map((f) => f.id);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
for (const id of new Set(duplicates)) problems.push(`duplicate feature id: ${id}`);

/**
 * Cycle detection.
 *
 * A dependency cycle makes `blocked` unresolvable — every feature in the loop
 * waits on another member forever, and the tracker would show a whole branch of
 * work as permanently unstartable with no explanation of why. Cheap to check,
 * invisible if you do not.
 */
{
  const state = new Map();
  const walk = (id, path) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      problems.push(`dependency cycle: ${[...path, id].join(' → ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) walk(dep, [...path, id]);
    state.set(id, 'done');
  };
  for (const feature of FEATURES) walk(feature.id, []);
}

// ── Resolve status ──────────────────────────────────────────────────────────

/**
 * Everything a feature transitively unblocks.
 *
 * This is the number that should drive what gets built next — a feature that
 * unblocks 26 others is worth more than one that unblocks none, regardless of
 * which looks more exciting.
 */
function unblocks(id, seen = new Set()) {
  for (const f of FEATURES) {
    if (f.dependsOn.includes(id) && !seen.has(f.id)) {
      seen.add(f.id);
      unblocks(f.id, seen);
    }
  }
  return seen;
}

/** Declared status, except that unmet dependencies force `blocked`. */
function resolve(feature) {
  if (feature.status === 'done' || feature.status === 'socket') return feature.status;

  const unmet = feature.dependsOn.filter((d) => byId.get(d)?.status !== 'done');
  if (unmet.length > 0) return 'blocked';

  return feature.status;
}

const resolved = FEATURES.map((f) => ({ ...f, resolved: resolve(f) }));
const blockers = (f) => f.dependsOn.filter((d) => byId.get(d)?.status !== 'done');

// ── Render ──────────────────────────────────────────────────────────────────

const ICON = { done: '✅', wip: '🔨', ready: '🟢', blocked: '⛔', socket: '🔌' };

function summary() {
  const counts = { done: 0, wip: 0, ready: 0, blocked: 0, socket: 0 };
  for (const f of resolved) counts[f.resolved]++;
  return counts;
}

function render() {
  const counts = summary();
  const shippable = resolved.filter((f) => f.resolved !== 'socket').length;
  const percent = Math.round((counts.done / shippable) * 100);

  const lines = [];
  lines.push('# Project tracker');
  lines.push('');
  lines.push(
    '> **Not current rules (2026-10-17).** This board is generated status, not instructions. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.',
  );
  lines.push('');
  lines.push('> **Generated — do not edit by hand.** Source of truth is `tooling/tracker/features.mjs`.');
  lines.push('> Run `pnpm tracker` after changing it. CI fails if this file is stale.');
  lines.push('');
  lines.push(
    `**${counts.done} of ${shippable} shipped (${percent}%)** · ${counts.wip} in progress · ${counts.ready} ready to claim · ${counts.blocked} blocked · ${counts.socket} deliberate §13 sockets`,
  );
  lines.push('');
  lines.push('| | meaning |');
  lines.push('|---|---|');
  lines.push('| ✅ done | on `main`, DoD gate green |');
  lines.push('| 🔨 wip | someone is on it — see owner |');
  lines.push('| 🟢 ready | **every dependency is done. Claim it.** |');
  lines.push('| ⛔ blocked | waiting on a dependency — computed, not declared |');
  lines.push('| 🔌 socket | deliberately not in v1 (§13); the interface exists |');
  lines.push('');

  // ── Claim this now ────────────────────────────────────────────────────────
  const ready = resolved.filter((f) => f.resolved === 'ready');
  lines.push('---');
  lines.push('');
  lines.push('## 🟢 Claim these now');
  lines.push('');
  lines.push('Nothing blocks these. Pick one, say so in Telegram, open a branch:');
  lines.push('');
  lines.push('```bash');
  lines.push('pnpm wt feat/<the-thing>');
  lines.push('```');
  lines.push('');

  if (ready.length === 0) {
    lines.push('_Nothing unblocked right now — everything is either shipped, in progress, or waiting._');
  } else {
    lines.push('| Feature | Module | Phase | id |');
    lines.push('|---|---|---|---|');
    for (const f of ready) {
      lines.push(`| ${f.title} | \`${f.module}\` | ${f.phase} | \`${f.id}\` |`);
    }
  }
  lines.push('');

  // ── Leverage ──────────────────────────────────────────────────────────────
  const leverage = resolved
    .filter((f) => f.resolved !== 'done' && f.resolved !== 'socket')
    .map((f) => ({ ...f, unblocks: unblocks(f.id).size }))
    .filter((f) => f.unblocks > 0)
    .sort((a, b) => b.unblocks - a.unblocks)
    .slice(0, 8);

  if (leverage.length > 0) {
    lines.push('## Highest leverage');
    lines.push('');
    lines.push(
      'What each unshipped feature would unblock, transitively. **This is what should drive build order** — a feature that frees 26 others is worth more than one that frees none, whatever else is louder.',
    );
    lines.push('');
    lines.push('| Unblocks | Feature | Status | id |');
    lines.push('|---:|---|---|---|');
    for (const f of leverage) {
      lines.push(`| **${f.unblocks}** | ${f.title} | ${ICON[f.resolved]} ${f.resolved} | \`${f.id}\` |`);
    }
    lines.push('');
  }

  const wip = resolved.filter((f) => f.resolved === 'wip');
  if (wip.length > 0) {
    lines.push('## 🔨 In progress');
    lines.push('');
    lines.push('| Feature | Owner | Module |');
    lines.push('|---|---|---|');
    for (const f of wip) lines.push(`| ${f.title} | **${f.owner}** | \`${f.module}\` |`);
    lines.push('');
  }

  // ── By phase ──────────────────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## Everything, by phase');
  lines.push('');

  for (const phase of PHASE_ORDER) {
    const inPhase = resolved.filter((f) => f.phase === phase);
    if (inPhase.length === 0) continue;

    const done = inPhase.filter((f) => f.resolved === 'done').length;
    const total = inPhase.filter((f) => f.resolved !== 'socket').length;
    const complete = total > 0 && done === total;

    lines.push(`### Phase ${phase} — ${PHASE_NAMES[phase]} ${complete ? '✅' : `(${done}/${total})`}`);
    lines.push('');
    lines.push('| | Feature | Plane | Blocked by | id |');
    lines.push('|---|---|---|---|---|');

    for (const f of inPhase) {
      const blocked =
        f.resolved === 'blocked'
          ? blockers(f)
              .map((b) => `\`${b}\``)
              .join(', ')
          : '';
      const note = f.note ? ` <br/>_${f.note}_` : '';
      lines.push(`| ${ICON[f.resolved]} | ${f.title}${note} | ${f.plane} | ${blocked} | \`${f.id}\` |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## How to use this');
  lines.push('');
  lines.push(
    '**To claim something:** find it in 🟢, set `owner` and `status: "wip"` in `tooling/tracker/features.mjs`, run `pnpm tracker`, and include both files in your first PR. That way nobody duplicates you.',
  );
  lines.push('');
  lines.push(
    '**To ship something:** set `status: "done"` and list the paths it created in `requires`. The check will refuse the claim if those paths are missing.',
  );
  lines.push('');
  lines.push('**Plane:** `F` = Fiat (custodial, compliant) · `P` = Protocol (non-custodial, zero-KYC) · `B` = both. See §22.');
  lines.push('');
  lines.push(
    '**Why blocked is computed:** so the tracker cannot lie about readiness. If you think something is wrongly blocked, the fix is in `dependsOn`, and that edit is reviewable.',
  );
  lines.push('');

  return lines.join('\n');
}

/**
 * The block injected into README.md.
 *
 * Deliberately SHORT. The README's job is "what is this, how do I run it" —
 * a new developer needs that in the first screen. Pasting 103 rows above the
 * setup instructions would bury the one thing they actually came for. So the
 * README carries the score and what is claimable; docs/TRACKER.md carries the
 * detail.
 */
function renderReadmeBlock() {
  const counts = summary();
  const shippable = resolved.filter((f) => f.resolved !== 'socket').length;
  const percent = Math.round((counts.done / shippable) * 100);
  const filled = Math.round(percent / 5);

  const ready = resolved.filter((f) => f.resolved === 'ready');
  const wip = resolved.filter((f) => f.resolved === 'wip');

  const lines = [];
  lines.push(`\`${'█'.repeat(filled)}${'░'.repeat(20 - filled)}\` **${percent}%** — ${counts.done} of ${shippable} features shipped`);
  lines.push('');

  const phaseBits = PHASE_ORDER.map((p) => {
    const inPhase = resolved.filter((f) => f.phase === p && f.resolved !== 'socket');
    if (inPhase.length === 0) return null;
    const done = inPhase.filter((f) => f.resolved === 'done').length;
    return done === inPhase.length ? `**${p}** ✅` : `**${p}** ${done}/${inPhase.length}`;
  }).filter(Boolean);

  lines.push(`Phases: ${phaseBits.join(' · ')}`);
  lines.push('');

  if (wip.length > 0) {
    lines.push('**In progress:** ' + wip.map((f) => `${f.title} (${f.owner})`).join(' · '));
    lines.push('');
  }

  lines.push(`**🟢 ${ready.length} ready to claim** — nothing blocks these:`);
  lines.push('');
  for (const f of ready.slice(0, 8)) {
    lines.push(`- \`${f.id}\` — ${f.title}`);
  }
  if (ready.length > 8) lines.push(`- …and ${ready.length - 8} more`);
  lines.push('');
  lines.push('Full board: **[docs/TRACKER.md](docs/TRACKER.md)** · `pnpm tracker ready`');

  return lines.join('\n');
}

const README = join(ROOT, 'README.md');
const START = '<!-- tracker:start -->';
const END = '<!-- tracker:end -->';

/** Returns the updated README, or null when the markers are absent. */
function injectReadme() {
  if (!existsSync(README)) return null;
  const current = readFileSync(README, 'utf8');
  const start = current.indexOf(START);
  const end = current.indexOf(END);
  if (start === -1 || end === -1 || end < start) return null;

  const updated = current.slice(0, start + START.length) + '\n\n' + renderReadmeBlock() + '\n\n' + current.slice(end);
  return updated === current ? current : updated;
}

// ── Run ─────────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.error(`\n✖ TRACKER REGISTRY INVALID — ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  · ${p}`);
  console.error('');
  process.exit(1);
}

const content = render();

/**
 * Never `process.exit(0)` after writing to stdout: on Windows a piped stdout is
 * asynchronous, and exiting truncates the pending write AND reports a garbage
 * exit code. Let Node finish naturally instead — CI reads these codes.
 */
if (checkMode) {
  const stale = [];

  const existing = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (existing.trim() !== content.trim()) stale.push('docs/TRACKER.md');

  const readme = injectReadme();
  if (readme === null) {
    stale.push('README.md (tracker markers missing — add <!-- tracker:start --> / <!-- tracker:end -->)');
  } else if (readme !== readFileSync(README, 'utf8')) {
    stale.push('README.md');
  }

  if (stale.length > 0) {
    console.error(`\n✖ stale: ${stale.join(', ')}\n  Run \`pnpm tracker\` and commit the result.\n`);
    process.exitCode = 1;
  } else {
    console.log('✓ tracker up to date (docs/TRACKER.md + README.md)');
  }
} else if (arg) {
  // Filters — for humans at a terminal, not for the file.
  const filtered =
    arg === 'ready' ? resolved.filter((f) => f.resolved === 'ready') : resolved.filter((f) => f.module === arg || f.phase === arg);

  if (filtered.length === 0) {
    console.log(`\nNothing matches "${arg}". Try a module id, a phase, or "ready".\n`);
  } else {
    console.log('');
    for (const f of filtered) {
      const blocked = f.resolved === 'blocked' ? `  ← blocked by ${blockers(f).join(', ')}` : '';
      console.log(`  ${ICON[f.resolved]} ${f.id.padEnd(28)} ${f.title}${blocked}`);
    }
    console.log('');
  }
} else {
  writeFileSync(OUTPUT, content + '\n', 'utf8');

  const readme = injectReadme();
  if (readme === null) {
    console.warn('\n⚠ README.md has no tracker markers — add <!-- tracker:start --> and <!-- tracker:end -->');
  } else {
    writeFileSync(README, readme, 'utf8');
  }

  const counts = summary();
  const shippable = FEATURES.filter((f) => f.status !== 'socket').length;
  console.log('\n✓ docs/TRACKER.md written\n');
  console.log(
    `  ✅ ${counts.done} shipped of ${shippable}   🔨 ${counts.wip} wip   🟢 ${counts.ready} ready   ⛔ ${counts.blocked} blocked   🔌 ${counts.socket} sockets\n`,
  );

  if (counts.ready > 0) {
    console.log('  Ready to claim:');
    for (const f of resolved.filter((r) => r.resolved === 'ready')) {
      console.log(`    · ${f.id.padEnd(28)} ${f.title}`);
    }
    console.log('');
  }

  // Nudge, not a failure: a tracker whose file is uncommitted helps nobody.
  try {
    const status = execFileSync('git', ['status', '--porcelain', 'docs/TRACKER.md'], { cwd: ROOT, encoding: 'utf8' }).trim();
    if (status) console.log('  (docs/TRACKER.md changed — commit it so the team sees the same picture)\n');
  } catch {
    /* not a git repo; fine */
  }
}
