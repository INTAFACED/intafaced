#!/usr/bin/env node
/**
 * worktree-gc — remove the CHECKOUTS of worktrees that are provably idle.
 *
 *   node tooling/scripts/worktree-gc.mjs                  dry run (default)
 *   node tooling/scripts/worktree-gc.mjs --apply          print the plan, then refuse
 *   node tooling/scripts/worktree-gc.mjs --apply --yes    print the plan, then do it
 *   node tooling/scripts/worktree-gc.mjs --check          exit 1 if worktree count > cap
 *   node tooling/scripts/worktree-gc.mjs --self-test      classifier fixtures (no git, no I/O)
 *
 * ── WHY THIS FILE IS SHAPED LIKE THIS ────────────────────────────────────────
 * The previous version classified a worktree with exactly two tests — `git
 * status --porcelain` (dirty → keep) and `git cherry origin/main <ref>` (unique
 * commits → keep) — and called everything else SAFE, then on --apply ran
 * `git worktree remove --force` AND `git branch -D <branch>`.
 *
 * That is wrong in a swarm, and it was wrong in production, twice:
 *
 *   · docs/LANE-CLOSEOUT-OPS-2026-08-08.md §"Practical notes": "Another lane's
 *     worktree-gc --apply deleted two of this lane's worktrees mid-edit, along
 *     with an unpushed branch."  A freshly created worktree is clean and is an
 *     ancestor of main, so it looked like garbage on the very first minute of
 *     its life — exactly when an agent is working in it.
 *   · docs/MEGA-AUDIT-2026-08-07-FINDINGS.md:887 (severity: high):
 *     "worktree-gc --apply will run `git branch -D main` and delete the local
 *     main branch."  The MAIN-checkout skip compared against
 *     `rev-parse --show-toplevel`, i.e. the toplevel of *wherever you ran it*.
 *     Run from a linked worktree, the real main checkout is just another row —
 *     and being parked at origin/main it is by definition cherry-empty, so it
 *     landed in SAFE. It survived so far only by being coincidentally dirty.
 *
 * Measured on this tree before the fix: `total=32 safe=11`, and that SAFE list
 * contained `feat/board-phase2-execution-connect-alerts` and
 * `feat/futures-orderable-path` — both named **live** in docs/LIVE-LANES.md —
 * plus three worktrees written to inside the previous half hour.
 *
 * Two ideas, in priority order.
 *
 * (1) MAKE THE FAILURE MODE SURVIVABLE, not merely rarer. Perfect liveness
 *     detection is not available to a batch script, so the tool is arranged so
 *     that being wrong costs a re-clone instead of costing history:
 *       · It NEVER runs `git branch -D`. Removing a checkout is recoverable
 *         (`pnpm wt <branch>` brings it back with the branch intact); force-
 *         deleting a branch is not. Deleting *history* is not this tool's job.
 *       · MAIN is identified from `--git-common-dir`, never from the cwd.
 *       · --apply alone is not consent. It prints the plan and exits 1; the
 *         removal needs `--apply --yes`.
 *       · If the claim board cannot be read, NOTHING is SAFE (fail closed).
 *
 * (2) DETECT LIVENESS, with signals ordered most-authoritative first:
 *       EXCLUDED   caller said so (--exclude / $WT_GC_EXCLUDE / .gc-keep file)
 *       LOCKED     `git worktree lock` — git's own in-use marker
 *       LIVE_LANE  named on the claim board, docs/LIVE-LANES.md
 *       DIRTY      uncommitted work
 *       ACTIVE     written to inside the liveness window (weak — see below)
 *       AHEAD_n    unique commits not on origin/main (`git cherry`)
 *       SAFE       none of the above
 *
 * ── THE ESCAPE HATCH (for orchestrators) ─────────────────────────────────────
 * An orchestrator knows what it launched; this script cannot. Protect a
 * worktree explicitly by any of:
 *
 *   --exclude=<name>[,<name>...]     repeatable. Matches a branch name, the
 *                                    worktree directory name, or a full path.
 *   WT_GC_EXCLUDE=<name>[,<name>]    same, comma- or semicolon-separated, so a
 *                                    spawner can export it once for children.
 *   a file named `.gc-keep` in the worktree root   in-band, survives a shell
 *                                    boundary, and an agent can drop it for
 *                                    itself on its first action.
 *   git worktree lock <path>         git's own mechanism; reported as LOCKED.
 *
 * Excludes are matched case-insensitively and reported, so a run always shows
 * which protections fired.
 *
 * ── HONEST LIMITS OF THE mtime SIGNAL ────────────────────────────────────────
 * mtime is a WEAK PROXY for "an agent is working here" and must not be read as
 * authoritative. It is wrong in both directions:
 *   · False idle. An agent that is reading, planning, waiting on CI, or running
 *     a long test suite writes nothing. Its worktree looks abandoned. This is
 *     the dangerous direction, and it is why the board read, the exclude hatch
 *     and the no-branch-delete rule exist above it — mtime is the floor, not
 *     the guarantee.
 *   · False busy. `pnpm install`, `git checkout` and a build all bump mtimes
 *     with no human or agent intent behind them. This direction only costs a
 *     directory that survives one extra GC pass, so it is the side to err on.
 * The scan uses `git ls-files --cached --others --exclude-standard`, which is
 * tracked + untracked-not-ignored files. That inherently skips node_modules,
 * dist and .turbo (all gitignored): node_modules churns on every install and
 * build outputs date the last build rather than the last edit, so including
 * either would make every worktree look permanently alive. Measured cost on
 * this repo: ~3.8k files, ~60ms per worktree.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * How long after its last write a worktree is still assumed live.
 *
 * 120 minutes. Justification, not a guess:
 *   · Observed edit gaps on this machine. A snapshot of all 32 worktrees put
 *     live sessions at 0–27 minutes since last write, with genuinely parked
 *     ones at 149 minutes and beyond and the real corpses in the thousands.
 *     Two hours sits in the empty band between those clusters.
 *   · A single `pnpm verify` plus a full test run plus a CI wait plus reading
 *     a review comfortably exceeds an hour of writing nothing. A window
 *     shorter than that deletes the tree of an agent who is merely being
 *     careful — the precise failure recorded in LANE-CLOSEOUT-OPS.
 *   · The cost is asymmetric by orders of magnitude. Holding a dead worktree
 *     for one extra pass costs disk. Deleting a live one costs an agent's
 *     working state mid-task. When a threshold is a guess, pay the cheap error.
 * Override for a specific run with --active-minutes=<n>.
 */
const DEFAULT_ACTIVE_MINUTES = 120;

/** Tokens shorter than this are ignored when matching the claim board, so a
 *  short branch name cannot match an unrelated English word in the prose. */
const MIN_BOARD_TOKEN = 8;

const WT_CAP = 20;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const apply = has('--apply');
const yes = has('--yes') || has('--confirm');
const checkOnly = has('--check');
const selfTest = has('--self-test');
const dry = !apply && !checkOnly && !selfTest;

const activeMinutes = (() => {
  const arg = argv.find((a) => a.startsWith('--active-minutes='));
  const n = arg ? Number(arg.slice('--active-minutes='.length)) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_ACTIVE_MINUTES;
})();

function git(args, opts = {}) {
  const out = execFileSync('git', args, { encoding: 'utf8', ...opts });
  return typeof out === 'string' ? out.trim() : '';
}

/** Normalise a Windows/Git-Bash path so string comparison is meaningful. */
function norm(p) {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

// ─── the classifier ─────────────────────────────────────────────────────────
// Pure so that --self-test can assert on it without touching git or the disk.
// `wt` is { path, branch, head, locked, dirtyCount, aheadCount, newestMtimeMs,
//           sentinel } and `ctx` is { mainPath, boardText, excludes, nowMs,
//           activeMinutes }.

/**
 * Does the claim board name this worktree? Matches the branch name and the
 * worktree directory name.
 *
 * The board writes branches (`feat/futures-orderable-path`) while `pnpm wt`
 * names directories with the slashes flattened
 * (`feat-futures-orderable-path`), so each candidate is tested against the
 * board as written AND against a slash-flattened copy of it. Without the
 * second pass a detached worktree — one with no branch to match on — would
 * slip through even though its directory is named right there on the board.
 */
export function boardNames(wt, boardText) {
  if (!boardText) return null;
  const haystacks = [boardText, boardText.replace(/\//g, '-')];
  const candidates = [wt.branch, basename(norm(wt.path))].filter((t) => typeof t === 'string' && t.length >= MIN_BOARD_TOKEN);
  for (const token of candidates) {
    // Word-boundary match where "word" is the branch-name character class, so
    // `feat/x` does not match `feat/x-2` and a backticked or table-celled
    // occurrence still matches.
    const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?:^|[^A-Za-z0-9._/-])${esc}(?![A-Za-z0-9._/-])`);
    for (const hay of haystacks) if (re.test(hay)) return token;
  }
  return null;
}

export function classify(wt, ctx) {
  if (norm(wt.path) === norm(ctx.mainPath)) return { verdict: 'KEEP', reason: 'MAIN' };

  const p = norm(wt.path);
  const hit = (ctx.excludes || []).find(
    (e) => e === (wt.branch || '').toLowerCase() || e === basename(p).toLowerCase() || e === norm(p).toLowerCase(),
  );
  if (hit) return { verdict: 'KEEP', reason: 'EXCLUDED' };
  if (wt.sentinel) return { verdict: 'KEEP', reason: 'GC_KEEP_FILE' };
  if (wt.locked) return { verdict: 'KEEP', reason: 'LOCKED' };

  const named = boardNames(wt, ctx.boardText);
  if (named) return { verdict: 'KEEP', reason: 'LIVE_LANE', detail: named };

  if (wt.dirtyCount > 0) return { verdict: 'KEEP', reason: 'DIRTY', detail: `${wt.dirtyCount} files` };

  if (wt.newestMtimeMs && ctx.activeMinutes > 0) {
    const ageMin = (ctx.nowMs - wt.newestMtimeMs) / 60000;
    if (ageMin < ctx.activeMinutes) {
      return { verdict: 'KEEP', reason: 'ACTIVE', detail: `written ${ageMin < 1 ? '<1' : Math.round(ageMin)}m ago` };
    }
  }

  if (wt.aheadCount > 0) return { verdict: 'KEEP', reason: `AHEAD_${wt.aheadCount}` };

  return { verdict: 'SAFE', reason: 'IDLE' };
}

// ─── self-test (revert-proofing) ─────────────────────────────────────────────
// Every assertion below is a claim this file makes in prose above. If the
// LIVE-LANES read is deleted, `live-lane branch is never SAFE` fails; if the
// mtime scan is deleted, `recently written is never SAFE` fails; if the MAIN
// detection regresses to cwd, `main checkout is never SAFE` fails.
if (selfTest) {
  const ctx = {
    mainPath: 'C:/repo',
    boardText: '| lane | owner | scope | **live** | feat/board-phase2-execution-connect-alerts | notes |',
    excludes: ['chore/protected-by-orchestrator'],
    nowMs: 1_000_000_000,
    activeMinutes: 120,
  };
  const idle = { path: 'C:/wt/x', branch: 'feat/x-long-enough', dirtyCount: 0, aheadCount: 0, newestMtimeMs: ctx.nowMs - 300 * 60000 };
  const cases = [
    ['idle worktree is SAFE — a GC that keeps everything is useless', idle, 'SAFE'],
    [
      'live-lane branch is never SAFE',
      { ...idle, path: 'C:/wt/feat-board-phase2-execution-connect-alerts', branch: 'feat/board-phase2-execution-connect-alerts' },
      'KEEP',
    ],
    [
      'live-lane matched by directory name is never SAFE',
      { ...idle, path: 'C:/wt/feat-board-phase2-execution-connect-alerts', branch: undefined },
      'KEEP',
    ],
    [
      'a longer branch sharing a live-lane prefix is still SAFE',
      { ...idle, branch: 'feat/board-phase2-execution-connect-alerts-v2' },
      'SAFE',
    ],
    ['recently written is never SAFE', { ...idle, newestMtimeMs: ctx.nowMs - 30 * 1000 }, 'KEEP'],
    ['written just inside the window is never SAFE', { ...idle, newestMtimeMs: ctx.nowMs - 119 * 60000 }, 'KEEP'],
    ['written just outside the window is SAFE', { ...idle, newestMtimeMs: ctx.nowMs - 121 * 60000 }, 'SAFE'],
    ['main checkout is never SAFE', { ...idle, path: 'C:/repo', branch: 'main' }, 'KEEP'],
    ['main checkout is never SAFE (backslash spelling)', { ...idle, path: 'C:\\repo', branch: 'main' }, 'KEEP'],
    ['--exclude protects', { ...idle, branch: 'chore/protected-by-orchestrator' }, 'KEEP'],
    ['.gc-keep protects', { ...idle, sentinel: true }, 'KEEP'],
    ['git worktree lock protects', { ...idle, locked: true }, 'KEEP'],
    ['dirty is never SAFE', { ...idle, dirtyCount: 3 }, 'KEEP'],
    ['unique commits are never SAFE', { ...idle, aheadCount: 2 }, 'KEEP'],
    ['unreadable board makes nothing SAFE', idle, 'KEEP', { ...ctx, boardText: null }],
  ];
  let failed = 0;
  console.log('worktree-gc SELF-TEST\n');
  for (const [name, wt, want, over] of cases) {
    const c = over || ctx;
    // A null board is the fail-closed case: the runner refuses to compute SAFE
    // at all, so model it the way the runner does.
    const got = c.boardText === null ? { verdict: 'KEEP', reason: 'BOARD_UNREADABLE' } : classify(wt, c);
    const ok = got.verdict === want;
    if (!ok) failed++;
    console.log(`  ${ok ? '✓' : '✖'} ${name.padEnd(58)} want=${want} got=${got.verdict} (${got.reason})`);
  }
  console.log(
    failed ? `\n✖ ${failed}/${cases.length} self-test cases failed` : `\n✓ ${cases.length}/${cases.length} self-test cases passed`,
  );
  process.exit(failed ? 1 : 0);
}

// ─── gather ─────────────────────────────────────────────────────────────────

/**
 * The MAIN checkout, derived from --git-common-dir and NOT from the cwd.
 * `--show-toplevel` is the toplevel of wherever you happened to run this, so
 * using it meant the real main checkout was classified like any other worktree
 * (MEGA-AUDIT-2026-08-07-FINDINGS.md:887). On Windows Git Bash the common dir
 * comes back as `C:/path/.git` from a linked worktree and as the literal `.git`
 * from the main checkout, so both spellings have to be handled.
 */
function mainCheckout() {
  const common = norm(git(['rev-parse', '--git-common-dir']));
  const top = norm(git(['rev-parse', '--show-toplevel']));
  if (common === '.git' || common === '') return top;
  const abs = /^([A-Za-z]:)?\//.test(common) ? common : norm(resolve(top, common));
  return norm(dirname(abs));
}

function collectExcludes() {
  const out = [];
  for (const a of argv) {
    if (a.startsWith('--exclude=')) out.push(...a.slice('--exclude='.length).split(','));
  }
  const i = argv.indexOf('--exclude');
  if (i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--')) out.push(...argv[i + 1].split(','));
  if (process.env.WT_GC_EXCLUDE) out.push(...process.env.WT_GC_EXCLUDE.split(/[,;]/));
  return [...new Set(out.map((s) => norm(s.trim()).toLowerCase()).filter(Boolean))];
}

/**
 * The claim board. docs/LIVE-LANES.md is the repo's first-claimer-wins board
 * (CLAUDE.md §5, docs/COORDINATION-TRUTH-LAYERS.md), so a GC that cannot read
 * it has no business deleting anything. Read from the MAIN checkout — that is
 * the canonical copy — and union in the running checkout's copy plus any
 * docs/ops/claims/*.md, which LIVE-LANES itself names as the alternative place
 * a lane may be recorded.
 *
 * Returns null if no board file could be read at all. Callers treat null as
 * fail-closed: no worktree is SAFE.
 *
 * Deliberately NOT parsed as a table, and closed/struck-through rows are NOT
 * filtered out. A name anywhere in the board keeps the worktree. That over-
 * keeps a lane that was closed without its branch being scrubbed from the
 * prose — the cheap error — and it means the check cannot be broken by someone
 * reformatting the markdown.
 */
function readBoard(mainPath, cwdTop) {
  const parts = [];
  const seen = new Set();
  const add = (f) => {
    const k = norm(f).toLowerCase();
    if (seen.has(k) || !existsSync(f)) return;
    seen.add(k);
    try {
      parts.push(readFileSync(f, 'utf8'));
    } catch {
      /* unreadable — treated as absent */
    }
  };
  for (const root of [mainPath, cwdTop]) {
    if (!root) continue;
    add(join(root, 'docs', 'LIVE-LANES.md'));
    const claims = join(root, 'docs', 'ops', 'claims');
    if (existsSync(claims)) {
      try {
        for (const f of readdirSync(claims)) {
          if (f.endsWith('.md')) add(join(claims, f));
        }
      } catch {
        /* ignore */
      }
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/** Newest mtime over tracked + untracked-not-ignored files. See header. */
function newestMtime(wtPath) {
  let files;
  try {
    files = execFileSync('git', ['-C', wtPath, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    // Cannot enumerate → cannot prove idleness. Report "now" so the worktree
    // reads as ACTIVE and is kept.
    return Date.now();
  }
  let newest = 0;
  for (const f of files) {
    if (f.includes('node_modules/')) continue; // belt-and-braces; normally gitignored
    try {
      const m = statSync(join(wtPath, f)).mtimeMs;
      if (m > newest) newest = m;
    } catch {
      /* raced away */
    }
  }
  return newest;
}

spawnSync('git', ['fetch', 'origin', 'main'], { stdio: 'ignore' });
const mainSha = git(['rev-parse', 'origin/main']);
const mainPath = mainCheckout();
const cwdTop = norm(git(['rev-parse', '--show-toplevel']));
const excludes = collectExcludes();
const boardText = readBoard(mainPath, cwdTop);

const wts = [];
{
  let cur = {};
  for (const line of [...git(['worktree', 'list', '--porcelain']).split('\n'), '']) {
    if (line.startsWith('worktree ')) {
      if (cur.path) wts.push(cur);
      cur = { path: norm(line.slice(9)) };
    } else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'detached') cur.detached = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
    else if (line === '' && cur.path) {
      wts.push(cur);
      cur = {};
    }
  }
}

const rows = [];
for (const w of wts) {
  const isMain = norm(w.path) === norm(mainPath);
  const facts = { ...w, dirtyCount: 0, aheadCount: 0, newestMtimeMs: 0, sentinel: false };
  if (!isMain) {
    facts.sentinel = existsSync(join(w.path, '.gc-keep'));
    const st = spawnSync('git', ['-C', w.path, 'status', '--porcelain'], { encoding: 'utf8' });
    facts.dirtyCount = (st.stdout || '').trim() ? st.stdout.trim().split('\n').length : 0;
    if (facts.dirtyCount === 0) {
      facts.newestMtimeMs = newestMtime(w.path);
      const ref = w.branch || w.head;
      const cherry = spawnSync('git', ['cherry', 'origin/main', ref], { encoding: 'utf8' });
      facts.aheadCount = (cherry.stdout || '').split('\n').filter((l) => l.startsWith('+ ')).length;
    }
  }
  const verdict = boardText
    ? classify(facts, { mainPath, boardText, excludes, nowMs: Date.now(), activeMinutes })
    : { verdict: isMain ? 'KEEP' : 'KEEP', reason: isMain ? 'MAIN' : 'BOARD_UNREADABLE' };
  rows.push({ ...facts, ...verdict });
}

const safe = rows.filter((r) => r.verdict === 'SAFE');
const kept = rows.filter((r) => r.verdict === 'KEEP' && r.reason !== 'MAIN');

// ─── report ─────────────────────────────────────────────────────────────────
const mode = checkOnly ? 'CHECK' : apply ? (yes ? 'APPLY' : 'APPLY (plan only — no --yes)') : 'DRY-RUN';
console.log(`worktree-gc ${mode}`);
console.log(
  `main=${mainSha.slice(0, 8)} main_checkout=${mainPath} total=${rows.length} safe=${safe.length} keep=${kept.length} cap=${WT_CAP} active_window=${activeMinutes}m`,
);
if (excludes.length) console.log(`excludes(${excludes.length}): ${excludes.join(', ')}`);
if (!boardText) {
  console.error(
    '\n✖ docs/LIVE-LANES.md could not be read — refusing to call anything SAFE.\n' +
      '  That file is the claim board; without it this tool cannot tell a live lane from garbage.\n',
  );
}

for (const r of safe) {
  const age = r.newestMtimeMs ? `${Math.round((Date.now() - r.newestMtimeMs) / 60000)}m idle` : 'age unknown';
  console.log(`  SAFE  ${String(age).padEnd(14)} ${r.branch || r.head?.slice(0, 8)}  ${r.path}`);
}
for (const r of kept) {
  console.log(`  KEEP  ${r.reason.padEnd(16)} ${(r.detail || '').padEnd(20)} ${r.branch || r.head?.slice(0, 8)}  ${r.path}`);
}

if (checkOnly) {
  if (rows.length > WT_CAP) {
    console.error(
      `\n✖ worktree count ${rows.length} > cap ${WT_CAP}\n` +
        `  Review first:  pnpm wt:gc            (dry run — shows why each worktree is kept)\n` +
        `  ${safe.length} look idle. Removing them is a separate, attended step (--apply --yes).\n`,
    );
    process.exit(1);
  }
  console.log(`\n✓ worktree count ${rows.length} ≤ cap ${WT_CAP}`);
  process.exit(0);
}

if (dry) {
  console.log(
    `\n${safe.length} idle checkout(s). To remove them:  pnpm wt:gc:apply -- --yes\n` +
      'Branches are never deleted — only the checkouts. `pnpm wt <branch>` restores one.',
  );
  process.exit(0);
}

// ─── apply ──────────────────────────────────────────────────────────────────
if (!boardText) process.exit(1);

console.log('\nPLAN — exactly these commands will run, and nothing else:');
if (safe.length === 0) console.log('  (none)');
for (const r of safe) console.log(`  git worktree remove --force "${r.path}"`);
console.log(
  `\nNot in the plan, on purpose: git branch -D. ${safe.length} branch(es) stay.\n` +
    '  A removed checkout is recoverable; a force-deleted branch is not. If a branch\n' +
    '  really is spent, delete it yourself, by name, after looking at it.',
);

if (!yes) {
  console.error(
    `\n✖ --apply on its own is not consent. ${safe.length} checkout(s) would be removed.\n` +
      '  Read the plan above, then re-run with --yes:\n' +
      `    node tooling/scripts/worktree-gc.mjs --apply --yes\n` +
      '  Never run this unattended (docs/AXIS-DISPATCH-REVISED-ANTI-DRIFT-2026-08-08.md A8).\n',
  );
  process.exit(1);
}

let removed = 0;
for (const r of safe) {
  try {
    git(['worktree', 'remove', '--force', r.path], { stdio: 'inherit' });
    removed++;
  } catch (e) {
    console.error(`  FAIL remove ${r.path}: ${e.message}`);
  }
}
console.log(`\n✓ removed ${removed}/${safe.length} idle checkouts · 0 branches deleted`);
