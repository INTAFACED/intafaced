#!/usr/bin/env node
/**
 * Swarm stack (Wave 1) — status-lane print — machine free-claim freeze, status, reports, next paste.
 *
 * Plan: OS/harvest/WAVE-1-SWARM-STACK-PLAN-2026-08-03.md (judgment, not cargo-cult).
 * Does NOT spawn agents, merge PRs, or edit product shell code.
 *
 *   pnpm swarm:freeze   → docs/ops/FREEZE-LIVE.md + stdout summary
 *   pnpm swarm:status   → short tip + free/blocked counts + churn + Actions 24h
 *   pnpm swarm:lanes    → P0–P3 ladder enumeration (stranded / partner-red / thin TRK)
 *   pnpm swarm:report   → docs/ops/R00 R01 R02 + DASHBOARD.md
 *   pnpm swarm:next [--all] → first free claim paste, or all free product pastes
 *   pnpm swarm:claim <id>   → write docs/ops/claims/<id>.md lock file
 *   pnpm swarm:heartbeat <id> → touch claim heartbeat timestamp
 *
 * Exit 0 always when the tool answered honestly (including "0 free").
 * Exit 2 when gh/git cannot answer (same spirit as claim-check).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { touches } from './path-collide.mjs';
import { throwOnGitHubRefusal } from './github-refusal.mjs';
import { checkoutStaleness } from '../ci/checkout-staleness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OPS = join(ROOT, 'docs', 'ops');
const CLAIMS_DIR = join(OPS, 'claims');
const cmd = process.argv[2] || 'status';
const args = process.argv.slice(3);
// Written plainly again: the vendor directory is `upstream-exchange`, which
// carries no forbidden token, so the assemble-at-runtime trick this line needed
// is gone. `vendor-money-inventory.mjs` still uses that trick and should — there
// it redacts vendor identity out of OUTPUT rather than building a path.
const SHELL = 'vendor/upstream-exchange/05_Web_Front';
const shell = (...parts) => [SHELL, ...parts].join('/');

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function ghJson(args) {
  try {
    return JSON.parse(execFileSync('gh', args, { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    throwOnGitHubRefusal(error);
    return { __error: error.stderr?.toString().trim() || error.message };
  }
}

/** REGROUP product claims — paths from tip docs/REGROUP-2026-08-03.md (removed) §5–6 */
const REGROUP_CLAIMS = [
  {
    id: 'RP1',
    rank: 10,
    track: 'REGROUP',
    title: 'Exchange.vue call sites → ix-money (money-on-wire finish)',
    paths: [
      shell('src', 'pages', 'exchange', 'Exchange.vue'),
      shell('src', 'assets', 'js', 'ix-money.js'),
      shell('src', 'assets', 'js', 'book-honesty.js'),
      shell('src', 'assets', 'js', 'ix-trade.js'),
    ],
    note: 'Branch origin/fix/shell-money-on-the-wire may already have module — finish call sites',
  },
  {
    id: 'RP2',
    rank: 20,
    track: 'REGROUP',
    title: 'Index.vue landing honesty (null / green ▲ / PRICE TREND)',
    paths: [
      shell('src', 'pages', 'index', 'Index.vue'),
      shell('src', 'assets', 'lang', 'en.js'),
      shell('src', 'assets', 'js', 'ix-trade.js'),
    ],
    note: 'Sole Index owner vs AFK-INDEX — claim one only',
    blocks: ['AFK-INDEX'],
  },
  {
    id: 'RP3',
    rank: 30,
    track: 'REGROUP',
    title: 'Announcement strip stated reason (sockets / IxNoSurface)',
    paths: [
      shell('src', 'assets', 'js', 'sockets.js'),
      shell('src', 'components', 'IxNoSurface.vue'),
      shell('src', 'pages', 'index', 'Index.vue'),
    ],
    note: 'May share Index paths with RP2 — check freeze',
  },
  {
    id: 'RP4',
    rank: 40,
    track: 'REGROUP',
    title: 'ix-wire golden + adopt schemas on ix-trade reads',
    paths: [shell('src', 'assets', 'js', 'ix-wire.js'), shell('src', 'assets', 'js', 'ix-trade.js')],
    note: 'Branch origin/fix/shell-wire-validation may have schemas',
  },
  {
    id: 'RP-LAND-MONEY',
    rank: 15,
    track: 'LANDER',
    title: 'Open/finish PR from origin/fix/shell-money-on-the-wire',
    paths: [shell('src', 'assets', 'js', 'ix-money.js'), shell('src', 'assets', 'js', 'book-honesty.js')],
    note: 'Prefer land branch; do not rewrite from zero',
  },
  {
    id: 'RP-LAND-LANDING',
    rank: 25,
    track: 'LANDER',
    title: 'Open/finish PR from origin/fix/shell-landing-honesty',
    paths: [shell('src', 'assets', 'lang', 'en.js')],
    note: 'Strings only until RP2 wires Index',
  },
  {
    id: 'RP-LAND-WIRE',
    rank: 35,
    track: 'LANDER',
    title: 'Open/finish PR from origin/fix/shell-wire-validation',
    paths: [shell('src', 'assets', 'js', 'ix-wire.js')],
    note: 'Schemas exist; golden + adopt is RP4',
  },
  {
    id: 'P-WS-REPORT',
    rank: 5,
    track: 'INTEGRITY',
    title: 'WS market-ID + /ws→/stream integrity report (no depth UI)',
    paths: ['services/svc-ws', 'services/svc-matching', 'services/svc-edge', shell('nginx.conf')],
    note: 'Report/handoff first; implement only if path-clear vs Denon open PRs',
  },
];

/** Default path prefixes for residual ids when register has no paths field */
const RESIDUAL_PATH_HINTS = {
  'AFK-UC-COMP': [shell('src', 'components', 'uc')],
  'AFK-IDENT': [shell('src', 'pages', 'uc', 'IdentBusiness.vue')],
  'AFK-LAB-PASS': [shell('src', 'pages', 'intafaced')],
  'AFK-INDEX': [shell('src', 'pages', 'index', 'Index.vue')],
  'AFK-CMDK-ROUTES': [shell('src', 'assets', 'js', 'cmd-palette.js')],
  'AFK-HELP-DETAIL': [shell('src', 'pages', 'cms', 'HelpDetail.vue')],
  // AFK-WHITEPAPER retired — no WhitePaper.vue anywhere in shell (route removed).
  'AFK-APPDOWNLOAD': [shell('src', 'pages', 'uc', 'AppDownload.vue')],
  'AFK-FOOTER': [shell('src', 'App.vue')],
  'AFK-RESCAN': [SHELL],
  B12: [shell('src', 'pages')],
  B13: [SHELL],
  'META-STEAL': ['docs/refs'],
  'META-CRITIQUE': ['docs/refs'],
  'META-ORCA': [],
  'P0.4': ['tooling/uiproof'],
};

/** Hints that must not appear in free spawn (no target on disk). */
const RETIRED_RESIDUAL_IDS = new Set(['AFK-WHITEPAPER']);

/**
 * Fail closed: a path hint that points at nothing means collision detection
 * can never fire for that id (false free). Empty path lists are allowed.
 */
function validateResidualPathHints() {
  const missing = [];
  for (const [id, paths] of Object.entries(RESIDUAL_PATH_HINTS)) {
    if (RETIRED_RESIDUAL_IDS.has(id)) continue;
    for (const p of paths || []) {
      if (!p) continue;
      const abs = join(ROOT, p);
      if (!existsSync(abs)) missing.push(`${id} → ${p}`);
    }
  }
  if (missing.length) {
    const msg = 'swarm.mjs RESIDUAL_PATH_HINTS points at missing paths (collision detection would fail open):\n  ' + missing.join('\n  ');
    console.error(msg);
    throw new Error(msg);
  }
}

/**
 * Money-class prefix — used to label rows in reports only.
 * Implementability is deps + spec; no Nitro allowlist (removed 2026-08-21).
 */
const MONEY_PREFIX_RE = /^(trade|pay|bank|venue|p2p|market)\./;

function trkSpecPath(featureId) {
  return join(OPS, 'trk', `${featureId}.md`);
}

/**
 * Repo-relative, forward-slashed, for anything that gets WRITTEN DOWN.
 *
 * The previous form was `abs.replace(ROOT + '/', '')`, which is a POSIX
 * assumption: on Windows `ROOT` is `C:\…` with backslashes, so the needle
 * `C:\…/` never matches, the strip silently no-ops, and the absolute path of
 * whichever worktree happened to run the generator lands in a committed file.
 * That is how 34 lines of `C:\Users\…\plug-x-inta-worktrees\<branch>\…` reached
 * `docs/ops/FREEZE-LIVE.md`.
 *
 * It stayed invisible because those rows only appear once the tracker actually
 * loads — and it did not, on Windows, for a separate path bug in this same file.
 * Two POSIX assumptions in one script, the second hidden behind the first.
 */
function repoRelative(absPath) {
  return relative(ROOT, absPath).split('\\').join('/');
}

function trkSpecLineCount(featureId) {
  const p = trkSpecPath(featureId);
  if (!existsSync(p)) return 0;
  return readFileSync(p, 'utf8').split('\n').length;
}

/**
 * Compute implementable + non-implementable free tracker rows from features.mjs.
 * residual-own does not hide implementable (mandate).
 */
function loadTrackerRows() {
  try {
    // Dynamic import sync is not available — use a child `node -e`. The specifier
    // MUST be a file:// URL: on Windows an absolute path begins `C:\…`, which the
    // ESM loader reads as the scheme `c:` and rejects with
    // ERR_UNSUPPORTED_ESM_URL_SCHEME. That throws into the catch below, so the board
    // prints `freeTracker=0` — not "the tracker could not be read", but a confident
    // zero — on every Windows run.
    //
    // This was found and fixed once, and the fix was lost: the rewrite that added
    // depsDone/money/wave1ex went back to the raw path. Do not inline it again.
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { FEATURES } from ${JSON.stringify(pathToFileURL(join(ROOT, 'tooling/tracker/features.mjs')).href)};
         const MONEY_PREFIX_RE = ${MONEY_PREFIX_RE.toString()};
         const done = new Set(FEATURES.filter((f) => f.status === 'done').map((f) => f.id));
         const rows = FEATURES.filter((f) => f.status === 'ready' && !f.owner).map((f) => {
           const deps = f.dependsOn || [];
           const depsDone = deps.every((d) => done.has(d));
           const money = MONEY_PREFIX_RE.test(f.id);
           return {
             featureId: f.id,
             title: f.title || f.id,
             paths: f.requires || [],
             status: f.status,
             dependsOn: deps,
             depsDone,
             money,
           };
         });
         process.stdout.write(JSON.stringify(rows));`,
      ],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 },
    );
    const rows = JSON.parse(out);
    const implementable = [];
    const notYet = [];
    for (const r of rows) {
      const lines = trkSpecLineCount(r.featureId);
      const impl = r.depsDone;
      const claim = {
        id: 'TRK-' + r.featureId,
        rank: impl ? 50 : 300,
        track: impl ? 'IMPLEMENTABLE' : 'TRACKER',
        title: r.title,
        paths: r.paths.length ? r.paths : [repoRelative(trkSpecPath(r.featureId))],
        featureId: r.featureId,
        implementable: impl,
        note: impl
          ? `implementable TRK (deps done${lines ? ` · spec ${lines} lines` : ''}) — Class N`
          : [!r.depsDone && 'dep-blocked'].filter(Boolean).join(' · ') || 'dep-blocked',
      };
      if (impl) implementable.push(claim);
      else notYet.push(claim);
    }
    return { implementable, notYet };
  } catch (e) {
    return { error: String(e.message || e), implementable: [], notYet: [] };
  }
}

function loadTrackerFree() {
  const t = loadTrackerRows();
  if (t.error) return { error: t.error };
  // legacy: free tracker = non-implementable ready rows (research backlog)
  return t.notYet;
}

/**
 * A9 — the work no agent free board can see: socket rows + owned non-done rows.
 * Read-only derivation over features.mjs. Never a gate. Never re-decides socket
 * basis. Renders into FREEZE so "what is waiting on a human / chain owner" has
 * one place, not six docs with no count (axis plan A9).
 */
function loadInvisibleBoard() {
  try {
    const out = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { FEATURES } from ${JSON.stringify(pathToFileURL(join(ROOT, 'tooling/tracker/features.mjs')).href)};
         const sockets = FEATURES.filter((f) => f.status === 'socket').map((f) => ({
           id: f.id,
           title: f.title || f.id,
           owner: f.owner || '(unowned)',
           plane: f.plane || 'F',
           note: (f.note || '').slice(0, 160),
         }));
         const owned = FEATURES.filter((f) => f.owner && f.status !== 'done' && f.status !== 'socket').map((f) => ({
           id: f.id,
           title: f.title || f.id,
           owner: f.owner,
           status: f.status,
           note: (f.note || '').slice(0, 160),
         }));
         process.stdout.write(JSON.stringify({
           socketCount: sockets.length,
           socketUnowned: sockets.filter((s) => s.owner === '(unowned)').length,
           sockets: sockets.sort((a, b) => a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id)),
           ownedCount: owned.length,
           owned: owned.sort((a, b) => a.owner.localeCompare(b.owner) || a.id.localeCompare(b.id)),
         }));`,
      ],
      { encoding: 'utf8', cwd: ROOT, maxBuffer: 10 * 1024 * 1024 },
    );
    return JSON.parse(out);
  } catch (e) {
    return { error: String(e.message || e), socketCount: 0, sockets: [], ownedCount: 0, owned: [] };
  }
}

function listClaimLocks() {
  if (!existsSync(CLAIMS_DIR)) return [];
  return readdirSync(CLAIMS_DIR)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .map((n) => n.replace(/\.md$/, ''));
}

/**
 * Claim-lock authority (P4): docs/ops/claims/<id>.md wins over residual-register
 * and over open-PR path collision for "is this claim free to spawn?"
 * status residual-own | merged | retired → closed (not free)
 * status claimed | pr-open | missing status → active lock
 */
function readClaimLock(id) {
  const path = join(CLAIMS_DIR, `${id}.md`);
  if (!existsSync(path)) return null;
  const body = readFileSync(path, 'utf8');
  const m = body.match(/\*\*status:\*\*\s*(\S+)/i);
  const status = (m && m[1] ? m[1].toLowerCase() : 'claimed').replace(/[,.]$/, '');
  const proof = (body.match(/\*\*proof:\*\*\s*(.+)/i) || [])[1] || '';
  return { id, status, proof: proof.trim(), path };
}

function claimLockCloses(id) {
  const lock = readClaimLock(id);
  if (!lock) return false;

  // A SPENT lock does not close a feature. Fixed 2026-08-07.
  //
  // `merged` used to close the row permanently, and that is the defect that
  // emptied the board. A claim covers ONE SLICE, not a whole feature: an agent
  // shipped Stage-1 of `academy.ambassadors` on 2026-08-05, wrote `merged`, and
  // the row vanished for good — while `features.mjs` still said `status: ready,
  // owner: none`, i.e. real, unbuilt, claimable work.
  //
  // Six live features were invisible this way (academy.ambassadors/.curriculum/
  // .tournaments, ops.affiliates/.analytics/.notifications). The board reported
  // freeProduct=0, and SWARM-MANDATE says freeProduct=0 means "do not idle —
  // mint Stage-N slices". So the swarm manufactured catalog modules instead of
  // building the features sitting right there. 151 of those were deleted as
  // unreachable in #953. The make-work rule was downstream of THIS line.
  //
  // Scoped to TRK- deliberately. A tracker row is a MULTI-STAGE feature and
  // `features.mjs` is the authority on whether it is finished — status `done`
  // already excludes it upstream of here, so a spent lock needs to close nothing.
  //
  // A residual id (RP*, AFK-*, B12, META-*) has NO tracker row. Its claim file
  // IS the completion record: RP1 `merged` means "#468 shipped Exchange.vue
  // money-on-wire", and that work must never be handed out again. So a spent
  // lock still closes those.
  //
  // Written as an explicit prefix test rather than relying on the caller: the
  // REGROUP branch above happens to read `closed || active`, which is always
  // true while a lock file exists and would mask a mistake here. Do not depend
  // on that — it is a tautology, not a guard.
  if (['merged', 'retired', 'done', 'closed'].includes(lock.status)) {
    return !String(id).startsWith('TRK-');
  }

  // residual-own: hides non-TRK residual (research finished). TRK residual-own = awaiting implement — free board.
  if (lock.status === 'residual-own' && !String(id).startsWith('TRK-')) return true;
  return false;
}

/** Hides free spawn: closed locks OR claimed/pr-open/wip. TRK residual-own does not hide. */
function claimLockHidesFree(id) {
  const lock = readClaimLock(id);
  if (!lock) return false;
  if (claimLockCloses(id)) return true;
  return ['claimed', 'pr-open', 'wip'].includes(lock.status);
}

function claimLockActive(id) {
  const lock = readClaimLock(id);
  if (!lock) return false;
  return !claimLockCloses(id);
}

function writeClaimFile(id, claim) {
  mkdirSync(CLAIMS_DIR, { recursive: true });
  const path = join(CLAIMS_DIR, `${id}.md`);
  if (existsSync(path)) {
    return { path, existed: true };
  }
  const body = [
    `# Claim ${id}`,
    '',
    `**status:** claimed`,
    `**started:** ${new Date().toISOString()}`,
    `**heartbeat:** ${new Date().toISOString()}`,
    `**title:** ${(claim && claim.title) || id}`,
    `**track:** ${(claim && claim.track) || '?'}`,
    `**paths:**`,
    ...((claim && claim.paths) || []).map((p) => `- ${p}`),
    '',
    '## Done bar',
    '',
    '- [ ] Implemented',
    '- [ ] claim:check clean or residual-owned',
    '- [ ] pnpm verify (or FE-VERIFY when available)',
    '- [ ] Proof: fleet OR proof_missing: fleet-blocked (NO-FLEET)',
    '- [ ] PR link',
    '',
    '## Law',
    '',
    '- Do not hand-edit docs/LIVE-LANES.md mid-wave (inside Denon open PRs).',
    '- Do not invent money/depth. No Shehzad implement. No dual-edit Denon open files.',
    '',
  ].join('\n');
  writeFileSync(path, body, 'utf8');
  return { path, existed: false };
}

/** Consecutive tip merges that touch only docs/ (churn). */
function countOpsOnlyChurn(limit = 30) {
  const log = git(['log', 'origin/main', `-${limit}`, '--name-only', '--pretty=format:---%H']);
  if (!log) return { consecutive: 0, sample: [] };
  const chunks = log
    .split(/^---/m)
    .map((s) => s.trim())
    .filter(Boolean);
  let consecutive = 0;
  const sample = [];
  for (const chunk of chunks) {
    const lines = chunk
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const sha = (lines[0] || '').slice(0, 8);
    const files = lines.slice(1);
    if (!files.length) continue;
    const docsOnly = files.every((f) => f.startsWith('docs/') || f.endsWith('.md'));
    if (docsOnly) {
      consecutive++;
      sample.push(sha);
    } else break;
  }
  return { consecutive, sample };
}

function worktreeCount() {
  const raw = git(['worktree', 'list', '--porcelain']);
  if (!raw) return 0;
  return raw.split('\n').filter((l) => l.startsWith('worktree ')).length;
}

/** Partner-owned branch prefixes — real work, never ours to land. */
const FOREIGN_LANE = /^feat\/spine-/;
/** Residue of previous stamp mills. Delete, never land. */
const JUNK_BRANCH = /(r07-cycle|keepalive|babysit|cycle\d+)/i;

/**
 * Mill meter — shape-independent.
 *
 * RESTORED 2026-08-07: #967 ("delete thrift") removed this as collateral while
 * relocating checkoutStaleness out of thrift-preflight. It never depended on thrift.
 * Found by re-deriving the board at the end of a run instead of trusting a mid-run
 * result — the same discipline this meter exists to enforce. Every previous stamp-mill gate was written
 * for one family and the next family evaded it:
 *
 *   grind loop        07-30 → 08-01   18 PRs
 *   R0x cycle         08-03 → 08-04  135 PRs  ┐ three families at once
 *   P-WS still        08-03 → 08-04   58 PRs  ├ value-gate landed 08-04 09:09
 *   invent re-scan    08-03 → 08-04   68 PRs  ┘ all three dead within the hour
 *   free-TRK wave     08-05 → 08-07   74 PRs    value-gate could not see it
 *
 * Per-PR title similarity is evadable by varying nouns — the wave family scored
 * 0.63–0.77 against a 0.80 threshold, 64 times. Aggregate concentration is not:
 * to lower it you must actually vary the work.
 *
 * Threshold set from this repo's own history, not taste. Across 851 windows:
 * the highest share any LEGITIMATE family ever reached was 15% ("docs ops trk
 * research"); mill families reach 100%. WARN at 30% is double the legitimate
 * ceiling and fires roughly 12 PRs into a mill instead of 64.
 *
 * Meter only, never a block: it is a lagging indicator, and a hard gate here
 * would also block the PRs that fix the mill.
 */
const MILL_WARN_PCT = Number(process.env.SWARM_MILL_WARN_PCT || 30);

function millConcentration(window = 40) {
  const raw = git(['log', 'origin/main', `-${window}`, '--format=%s']);
  if (!raw) return null;
  const subjects = raw.split('\n').filter(Boolean);
  if (subjects.length < window) return null; // too little history to judge
  const stem = (s) =>
    s
      .replace(/\(#\d+\)/g, '')
      .replace(/\d+/g, '')
      .replace(/[^a-zA-Z ]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 4)
      .join(' ');
  const counts = new Map();
  for (const s of subjects) {
    const k = stem(s);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let stemTop = '';
  let n = 0;
  for (const [k, v] of counts) if (v > n) [stemTop, n] = [k, v];
  return { stem: stemTop, n, window: subjects.length, share: Math.round((n / subjects.length) * 100) };
}

/**
 * P1 — stranded branches, QUALIFIED.
 *
 * Measured 2026-08-07: the previous version returned 40 branches of which ~65% were not
 * work. 11 had been squash-merged and DELETED on origin but survived as stale local
 * tracking refs (`remote.origin.prune` is unset); 15 were partner-owned `feat/spine-*`.
 * It sorted BIGGEST-FIRST while the display truncates to 15, so the cheap wins were
 * exactly the ones hidden and a 220-file / 179-conflict branch sat at rank #1. And the
 * `feat|fix|chore|docs` allow-list made `audit/*` and `land/*` structurally invisible —
 * one of those was independently classified as landable work.
 *
 * A router's whole job is to not miss work, so the prefix gate is an EXCLUDE list now:
 * the next new branch convention is included by default instead of dropped in silence.
 *
 * `git ls-remote` is the authority on existence. One network call settles the phantom
 * problem at its root and needs no merged-PR window to page through.
 */
function listStrandedBranches(openPrs) {
  const openHeads = new Set((openPrs || []).map((p) => p.headRefName).filter(Boolean));

  // Fail LOUD. An empty answer here would silently report "no work" — the confident-zero
  // failure that let 12 landable branches sit for 39 hours.
  const lsRemote = git(['ls-remote', '--heads', 'origin']);
  if (!lsRemote) {
    return { error: 'git ls-remote failed — cannot tell which branches still exist on origin. Refusing to report a count.' };
  }
  const live = new Set(
    lsRemote
      .split('\n')
      .map((l) => l.split('\t')[1])
      .filter(Boolean)
      .map((r) => r.replace(/^refs\/heads\//, '')),
  );

  const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin']).split('\n').filter(Boolean);
  const ours = [];
  const foreign = [];
  const junk = [];
  const phantom = [];
  for (const ref of refs) {
    if (ref === 'origin/main' || ref.endsWith('/HEAD')) continue;
    const b = ref.replace(/^origin\//, '');
    if (openHeads.has(b)) continue;
    if (!live.has(b)) {
      phantom.push(b); // merged and deleted upstream — a stale tracking ref, not work
      continue;
    }
    const r = spawnSync('git', ['merge-base', '--is-ancestor', ref, 'origin/main'], { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
    if (r.status === 0) continue; // already on main
    const files = git(['diff', '--name-only', `origin/main...${ref}`])
      .split('\n')
      .filter(Boolean);
    if (!files.length) continue; // commits ahead but no content — commit-ahead is not content-ahead
    const ahead = Number(git(['rev-list', '--count', `origin/main..${ref}`]) || 0);
    const row = { branch: b, ahead, files: files.length };
    if (JUNK_BRANCH.test(b)) junk.push(row);
    else if (FOREIGN_LANE.test(b)) foreign.push(row);
    else ours.push(row);
  }
  // Smallest first: the fastest proof the lane is unblocked is a branch that lands now.
  const bySize = (a, b) => a.files - b.files || a.branch.localeCompare(b.branch);
  ours.sort(bySize);
  foreign.sort(bySize);
  junk.sort(bySize);
  return { ours, foreign, junk, phantom };
}

/** Back-compat: callers that just want the landable list. */
function strandedOurs(res) {
  return res && !res.error ? res.ours : [];
}

function touchClaimFile(id, patch = {}) {
  const path = join(CLAIMS_DIR, `${id}.md`);
  if (!existsSync(path)) return { path, ok: false, reason: 'missing' };
  let body = readFileSync(path, 'utf8');
  const now = new Date().toISOString();
  if (/\*\*heartbeat:\*\*/i.test(body)) {
    body = body.replace(/\*\*heartbeat:\*\*\s*.*/i, `**heartbeat:** ${now}`);
  } else {
    body = body.replace(/(\*\*started:\*\*[^\n]*\n)/i, `$1**heartbeat:** ${now}\n`);
  }
  if (patch.status) {
    body = body.replace(/\*\*status:\*\*\s*\S+/i, `**status:** ${patch.status}`);
  }
  writeFileSync(path, body, 'utf8');
  return { path, ok: true, heartbeat: now };
}

function countActionsRuns24h() {
  // optional — needs gh; return null on failure (CI has no gh auth)
  try {
    const runs = JSON.parse(
      execFileSync('gh', ['run', 'list', '--limit', '1000', '--json', 'createdAt,name,conclusion,event'], {
        encoding: 'utf8',
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    const cut = Date.now() - 24 * 3600 * 1000;
    const last24 = runs.filter((r) => new Date(r.createdAt).getTime() >= cut);
    const byName = {};
    for (const r of last24) {
      byName[r.name || 'unknown'] = (byName[r.name || 'unknown'] || 0) + 1;
    }
    // if we hit the API page cap, flag so status does not under-report billing risk
    const capped = runs.length >= 1000;
    return { total: last24.length, byName, capped };
  } catch (error) {
    throwOnGitHubRefusal(error);
    return null;
  }
}

function buildLanes(m) {
  const stranded = m.strandedBranches || strandedOurs(listStrandedBranches(m.openPrs || []));
  // P2: partner red needing comment — needs second gh call for statusCheckRollup
  let partnerRed = [];
  try {
    const detail = JSON.parse(
      execFileSync(
        'gh',
        ['pr', 'list', '--state', 'open', '--limit', '40', '--json', 'number,title,author,mergeable,statusCheckRollup,url'],
        { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    );
    partnerRed = detail
      .filter((p) => p.author?.login && p.author.login !== 'ZenYoda3')
      .filter((p) => (p.statusCheckRollup || []).some((c) => c.conclusion === 'FAILURE'))
      .map((p) => ({
        number: p.number,
        title: p.title,
        author: p.author.login,
        fails: (p.statusCheckRollup || []).filter((c) => c.conclusion === 'FAILURE').map((c) => c.name),
        url: p.url,
      }));
  } catch (error) {
    throwOnGitHubRefusal(error);
    partnerRed = [];
  }
  // P3 thin TRK
  let thinTrk = [];
  try {
    const trkDir = join(OPS, 'trk');
    if (existsSync(trkDir)) {
      thinTrk = readdirSync(trkDir)
        .filter((n) => n.endsWith('.md') && n !== 'README.md' && !n.startsWith('TRK-'))
        .map((n) => {
          const body = readFileSync(join(trkDir, n), 'utf8');
          const lines = body.split('\n').length;
          return { file: n, lines };
        })
        .filter((x) => x.lines < 100)
        .sort((a, b) => a.lines - b.lines);
    }
  } catch {
    thinTrk = [];
  }
  return {
    p0: (m.freeProduct || []).map((c) => c.id),
    p1: stranded,
    p2: partnerRed,
    p3: thinTrk,
    counts: {
      p0: (m.freeProduct || []).length,
      p1: stranded.length,
      p2: partnerRed.length,
      p3: thinTrk.length,
    },
  };
}

function printLanes(m) {
  const L = buildLanes(m);
  console.log(`swarm:lanes  tip=${m.tip}`);
  console.log(`  P0 free product: ${L.counts.p0}`);
  const sr = m.strandedRes || {};
  if (sr.error) {
    console.log(`  P1 stranded branches: UNKNOWN — ${sr.error}`);
  } else {
    const extra = [
      sr.foreign?.length ? `${sr.foreign.length} partner-lane` : null,
      sr.junk?.length ? `${sr.junk.length} mill junk` : null,
      sr.phantom?.length ? `${sr.phantom.length} phantom (merged+deleted upstream — run git fetch --prune)` : null,
    ].filter(Boolean);
    console.log(`  P1 stranded branches: ${L.counts.p1} landable${extra.length ? `  (excluded: ${extra.join(', ')})` : ''}`);
    for (const s of L.p1.slice(0, 15)) console.log(`    STRANDED ${s.branch} (${s.files} files, +${s.ahead})`);
    if (L.p1.length > 15) console.log(`    … +${L.p1.length - 15} more`);
  }
  console.log(`  P2 partner NEW-red: ${L.counts.p2}`);
  for (const p of L.p2.slice(0, 10)) console.log(`    #${p.number} @${p.author} fails=${p.fails.join(',')}`);
  console.log(`  P3 thin TRK (<100 lines): ${L.counts.p3}`);
  for (const t of L.p3.slice(0, 12)) console.log(`    ${t.file} (${t.lines} lines)`);
  if (L.counts.p0 + L.counts.p1 + L.counts.p2 + L.counts.p3 === 0) {
    console.log('  ALL LANES 0 — F-STANDBY idle is valid. Re-check 30–45m. Do NOT open a stamp PR.');
  }
}

function loadResidual() {
  const p = join(ROOT, 'tooling/frontend/residual-register.json');
  if (!existsSync(p)) return { items: [], error: 'residual-register.json missing' };
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { items: [], error: String(e.message || e) };
  }
}

function buildModel() {
  const tip = git(['rev-parse', '--short', 'origin/main']) || git(['rev-parse', '--short', 'HEAD']);
  const tipFull = git(['rev-parse', 'origin/main']) || git(['rev-parse', 'HEAD']);
  const tipSubject = git(['log', '-1', '--format=%s', 'origin/main']) || '';

  const prs = ghJson(['pr', 'list', '--state', 'open', '--limit', '80', '--json', 'number,title,author,headRefName,url,mergeable,files']);
  if (prs.__error) {
    return { error: prs.__error, tip, tipFull, tipSubject };
  }

  const openFiles = [];
  for (const pr of prs) {
    for (const f of pr.files || []) {
      openFiles.push({ path: f.path, pr: pr.number, author: pr.author?.login || '?', title: pr.title });
    }
  }

  const residual = loadResidual();
  const claims = [];

  // P4: claim-lock files are spawn authority (residual-register is advisory only).
  for (const c of REGROUP_CLAIMS) {
    const hits = openFiles.filter((o) => c.paths.some((p) => touches(p, o.path)));
    const blocked = hits.length > 0;
    const closed = claimLockCloses(c.id);
    const active = claimLockActive(c.id);
    let status = blocked ? 'blocked' : closed || active ? 'claimed' : 'free';
    const collisions = blocked
      ? hits.slice(0, 12).map((h) => `#${h.pr}@${h.author} ${h.path}`)
      : closed || active
        ? ['claim file docs/ops/claims/' + c.id + '.md']
        : [];
    const lock = readClaimLock(c.id);
    claims.push({
      ...c,
      status,
      collisions,
      priority: c.rank,
      note:
        (c.note || '') +
        (closed ? ' · residual-own/merged (claim-lock)' : active ? ' · CLAIMED (claim-lock)' : '') +
        (lock && lock.proof ? ' · proof: ' + lock.proof.slice(0, 80) : ''),
    });
  }

  const afkItems = (residual.items || []).filter(
    (i) =>
      i.afk_safe !== false &&
      !RETIRED_RESIDUAL_IDS.has(i.id) &&
      i.status !== 'retired' &&
      !claimLockCloses(i.id) &&
      (i.status === 'open' || i.status === 'partial') &&
      !claimLockActive(i.id),
  );
  for (const i of afkItems) {
    const paths = RESIDUAL_PATH_HINTS[i.id] || [SHELL];
    const hits = paths.length === 0 ? [] : openFiles.filter((o) => paths.some((p) => touches(p, o.path)));
    const rp2Free = claims.find((c) => c.id === 'RP2' && c.status === 'free');
    let status = hits.length > 0 ? 'blocked' : 'free';
    let collisions = hits.length > 0 ? hits.slice(0, 12).map((h) => `#${h.pr}@${h.author} ${h.path}`) : [];
    let note = i.next_action || i.blocker || '';
    if (i.id === 'AFK-INDEX' && rp2Free) {
      status = 'blocked';
      note = 'Blocked while RP2 free (sole Index.vue owner)';
      collisions = ['RP2 owns Index'];
    }
    claims.push({
      id: i.id,
      rank: 100 + (i.priority ?? 50),
      track: 'AFK',
      title: i.title || i.id,
      paths,
      status,
      collisions,
      priority: i.priority ?? 50,
      note,
      residualStatus: i.status,
    });
  }

  const trackerRows = loadTrackerRows();
  if (trackerRows.error) {
    // non-fatal
  } else {
    for (const c of [...(trackerRows.implementable || []), ...(trackerRows.notYet || [])]) {
      const hides = claimLockHidesFree(c.id);
      const closed = claimLockCloses(c.id);
      let status = 'free';
      let collisions = [];
      if (closed) {
        status = 'blocked';
        collisions = ['claim closed: ' + (readClaimLock(c.id)?.status || '?')];
      } else if (hides) {
        status = 'claimed';
        collisions = ['claim file docs/ops/claims/' + c.id + '.md'];
      }
      claims.push({
        ...c,
        status,
        collisions,
        priority: c.rank,
        note: c.note + (status === 'claimed' ? ' · CLAIMED' : status === 'blocked' ? ' · CLOSED' : ''),
      });
    }
  }

  // Hygiene / babysit always-on non-writer rows
  claims.push({
    id: 'BABYSIT-MATRIX',
    rank: 200,
    track: 'OPS',
    title: 'Babysit open partner PRs (comment/CI only)',
    paths: [],
    status: 'free',
    collisions: [],
    priority: 200,
    note: 'Shehzad #346 + Denon open — no implement',
  });
  claims.push({
    id: 'REPORTS',
    rank: 210,
    track: 'OPS',
    title: 'Refresh R00–R02 via pnpm swarm:report',
    paths: ['docs/ops'],
    status: 'free',
    collisions: [],
    priority: 210,
    note: 'Coord-OPS',
  });

  claims.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999) || String(a.id).localeCompare(b.id));

  const free = claims.filter((c) => c.status === 'free');
  const blocked = claims.filter((c) => c.status === 'blocked');

  // Spawnable free product: shell craft + implementable TRK (SWARM-MANDATE).
  // freeShell and freeImplementable are printed separately so freeShell=0 / freeProduct
  // cannot be misread as "nothing to do" when implementable TRK is open.
  const freeShell = free.filter((c) => c.track === 'REGROUP' || c.track === 'AFK' || c.track === 'LANDER' || c.track === 'INTEGRITY');
  const freeImplementable = free.filter((c) => c.track === 'IMPLEMENTABLE');
  const freeProduct = free.filter(
    (c) => c.track === 'REGROUP' || c.track === 'AFK' || c.track === 'LANDER' || c.track === 'INTEGRITY' || c.track === 'IMPLEMENTABLE',
  );
  const freeTracker = free.filter((c) => c.track === 'TRACKER');
  const productIds = new Set(
    claims.filter((c) => ['REGROUP', 'AFK', 'LANDER', 'INTEGRITY', 'IMPLEMENTABLE'].includes(c.track)).map((c) => c.id),
  );
  // freeProduct already excludes claim locks (hides → status claimed). So:
  //   free_spawnable = free product rows still needing a writer
  //   claimed_product_locks = product claim files that hide free (already claimed)
  // They are different sets — "gap" must NOT be read as free_spawnable − locks.
  const activeSpawned = listClaimLocks().filter((id) => productIds.has(id) && claimLockHidesFree(id)).length;
  const available = freeProduct.length;
  const underGap = available; // free_spawnable count (name kept for FREEZE JSON compat)
  // Mandate: do not idle with freeProduct>0 (SWARM-MANDATE spawn width). Fail open on free board.
  const underSpawnFail = available > 0;
  const underSpawnNote = underSpawnFail
    ? `anti-under-spawn FAIL: free_spawnable=${available} (shell=${freeShell.length} implementable=${freeImplementable.length}) claimed_product_locks=${activeSpawned} — spawn path-disjoint Class N (width 3–6 TRK / 6–8 shell). free_spawnable already excludes claimed locks; do not subtract them again.`
    : `anti-under-spawn OK: free_spawnable=0 shell=0 implementable=0 claimed_product_locks=${activeSpawned}.`;

  const opsChurn = countOpsOnlyChurn(30);
  const strandedRes = listStrandedBranches(prs);
  const strandedBranches = strandedOurs(strandedRes);
  const wtCount = worktreeCount();
  const actionsRuns24h = countActionsRuns24h();
  const invisible = loadInvisibleBoard();
  // F-STANDBY only when BOTH shell and implementable boards are empty.
  // freeShell=0 alone is NOT idle when freeImplementable>0 (or P1 still has work).
  const fStandby =
    freeShell.length === 0 && freeImplementable.length === 0
      ? 'F-STANDBY — freeShell=0 and freeImplementable=0; continue P1–P5 only with Board-Delta. Idle only if every path-clear P1 is named blocked. freeProduct=0 is never platform-done.'
      : null;

  return {
    tip,
    tipFull,
    tipSubject,
    generatedAt: new Date().toISOString(),
    invisible,
    openPrCount: prs.length,
    openPrs: prs.map((p) => ({
      number: p.number,
      title: p.title,
      author: p.author?.login,
      headRefName: p.headRefName,
      url: p.url,
      mergeable: p.mergeable,
      fileCount: (p.files || []).length,
    })),
    residualError: residual.error,
    residualUpdated: residual.updated,
    residualTipNote: residual.tip_note,
    claims,
    free,
    blocked,
    freeShell,
    freeProduct,
    freeImplementable,
    freeTracker,
    available,
    activeSpawned,
    underGap,
    underSpawnFail,
    underSpawnNote,
    opsChurn,
    strandedBranches,
    strandedRes,
    strandedCount: strandedBranches.length,
    worktreeCount: wtCount,
    worktreeOverCap: wtCount > 20,
    actionsRuns24h,
    fStandby,
    spawnWidthTarget:
      freeImplementable.length > 0 && freeShell.length === 0
        ? '3-6 (implementable TRK)'
        : freeProduct.length > 0
          ? '6-8'
          : '3-6 (P1–P3 only)',
    mandate:
      'freeProduct = freeShell(REGROUP/AFK/LANDER/INTEGRITY) + freeImplementable TRK. residual-own does not hide TRK implementable. Money-class rows implement when deps done + spec ≥100 lines (no Nitro allowlist). freeShell=0 is not all-clear when freeImplementable>0.',
    // AFK anti-drift (docs/ops/SWARM-MANDATE.md ladder) — freeShell=0 alone must not kill spawn
    afkLadder:
      freeImplementable.length > 0
        ? `P0 SPAWN_NOW freeImplementable=${freeImplementable.length} path-disjoint (width 3–6 TRK). freeShell=${freeShell.length}. Stamp mill still banned.`
        : freeShell.length > 0
          ? 'P0 SPAWN_NOW free shell product path-disjoint (width 6–8). Stamp mill still banned.'
          : 'P1 stranded-branch land · P2 partner unblock (exact CI comment) · P3 TRK deepen · P4 invent/P-WS only on real delta · P5 hygiene. BAN: R07/R01/P-WS tip-bump cycles when board unchanged. freeShell=0 freeImplementable=0 is NOT platform-done.',
    stampMillBan:
      'Do not open docs(ops) R07/R01/P-WS “cycle N” PRs solely because freeShell=0 or freeProduct=0. Ship only on board delta or P1–P3 deliverable. Law: docs/ops/SWARM-MANDATE.md',
  };
}

function renderFreezeMd(m) {
  const lines = [];
  lines.push('# FREEZE-LIVE (generated)');
  lines.push('');
  // Committed FREEZE is a snapshot, not cold-start law. The on-disk banner was
  // sealed as residual honesty; the generator used to omit it, so the next
  // honest `pnpm swarm:freeze` erased the stamp (W8 L08 / #1399 class).
  lines.push(
    '> **STALE SNAPSHOT — not cold-start law.** Tip SHA below must match `origin/main` or regenerate: `pnpm swarm:freeze`. Numbers (free claims, Actions, worktrees) go bad in hours. Prefer live `pnpm wt:gc` (dry run) over any command line printed here; never force-remove a worktree or delete a branch.',
  );
  lines.push('');
  lines.push('**Do not hand-edit.** Regenerate: `pnpm swarm:freeze` (also rewrites R00–R02 + DASHBOARD) or `pnpm swarm:report`');
  lines.push('');
  lines.push(`- **Tip:** \`${m.tip}\` — ${m.tipSubject}`);
  lines.push(`- **Generated:** ${m.generatedAt}`);
  lines.push(`- **Open PRs:** ${m.openPrCount}`);
  lines.push(
    `- **Free claims:** free=${m.free.length} freeShell=${(m.freeShell || []).length} freeImplementable=${(m.freeImplementable || []).length} freeTracker=${(m.freeTracker || []).length} blocked=${m.blocked.length} (freeProduct=${m.freeProduct.length}=shell+implementable)`,
  );
  lines.push(
    `- **Spawn accounting:** free_spawnable=${m.available ?? m.freeProduct.length} · claimed_product_locks=${m.activeSpawned ?? '?'} · width_target=${m.spawnWidthTarget || '6-8'}`,
  );
  lines.push(`- **Anti-under-spawn:** ${m.underSpawnNote}`);
  lines.push(`- **Mandate:** ${m.mandate || 'shell product only'}`);
  lines.push(`- **AFK ladder:** ${m.afkLadder || 'see docs/ops/SWARM-MANDATE.md'}`);
  lines.push(`- **Stamp-mill ban:** ${m.stampMillBan || 'no R07/R01 tip-bump spam when board unchanged'}`);
  if (m.fStandby) lines.push(`- **Finish state:** ${m.fStandby}`);
  const churn = m.opsChurn || { consecutive: 0 };
  lines.push(
    `- **Ops churn:** ${churn.consecutive} consecutive docs-only tip merges${churn.consecutive >= 5 ? ' ⚠ CHURN (≥5) — value gate + Board-Delta required' : ''}`,
  );
  lines.push(`- **Stranded branches (P1):** ${m.strandedCount ?? (m.strandedBranches || []).length}`);
  // Recommend the DRY RUN, never the destructive form. A cap warning is a
  // count, not a diagnosis: it cannot tell an abandoned checkout from four
  // live agents. Pointing an operator straight at a bulk-removal mode is how
  // "Another lane's worktree-gc --apply deleted two of this lane's worktrees
  // mid-edit" happened (docs/LANE-CLOSEOUT-OPS-2026-08-08.md, removed).
  lines.push(
    `- **Worktrees:** ${m.worktreeCount ?? '?'} ${m.worktreeOverCap ? '⚠ OVER CAP 20 — review with `pnpm wt:gc` (dry run; it prints why each one is kept). It removes nothing: remove only your own worktree with `git worktree remove <path>` (never --force, never delete a branch).' : '(cap 20)'}`,
  );
  if (m.actionsRuns24h) {
    const by = Object.entries(m.actionsRuns24h.byName || {})
      .map(([n, c]) => `${n}=${c}`)
      .join(', ');
    lines.push(
      `- **Actions runs (24h):** ${m.actionsRuns24h.total}${by ? ` (${by})` : ''} — informational only; the bill is zero, a 403 or 429 is a stop`,
    );
  } else {
    lines.push('- **Actions runs (24h):** (gh unavailable — re-run with network)');
  }
  lines.push(
    '- **Proof mode:** NO-FLEET until Docker present — static build + scans; never fake UI done. UI proof tooling exists (`pnpm ui:proof` + `docs/archive/styleboard/ (removed)`) — NO-FLEET is Docker, not "never seen UI".',
  );
  lines.push('- **Claims:** docs/ops/claims/<id>.md (do not hand-edit LIVE-LANES mid-wave)');
  lines.push(
    '- **Cold resume:** this file + `docs/COORDINATION-TRUTH-LAYERS.md` (removed) § Agent cold-start · human blockers: `docs/BOARD-CLEAR-HUMAN-BLOCKERS.md` (removed) · value gate: `tooling/ci/value-gate.mjs`',
  );
  if (m.residualError) lines.push(`- **Residual error:** ${m.residualError}`);
  else lines.push(`- **Residual:** updated=${m.residualUpdated} tip_note=${m.residualTipNote || '—'}`);
  lines.push('');
  if ((m.freeShell || []).length === 0 && (m.freeImplementable || []).length === 0) {
    lines.push('## freeShell=0 freeImplementable=0 — F-STANDBY (real work, not stamp cycles)');
    lines.push('');
    lines.push(
      'Shell craft and implementable TRK are both empty. **freeProduct=0 is not platform-done.** Session may continue on P1–P5. Producing a stamp PR is not required.',
    );
    lines.push('');
    lines.push('1. **P1** Land stranded `origin/feat/*` / `fix/*` after path-intersect vs open partner PRs. (`pnpm swarm:lanes`)');
    lines.push('2. **P2** Partner babysit: extract exact CI fails; one NEW comment only; never merge partners.');
    lines.push('3. **P3** Deepen thin `docs/ops/trk/*` for tracker ready non-shehzad rows (code-grounded).');
    lines.push('4. **P4** Invent re-scan only after shell code change; P-WS report only if partner matrix changed.');
    lines.push('5. **P5** Review and verify the change; merge when done once required protection checks pass.');
    lines.push('');
    lines.push(
      '**BAN:** `docs(ops): R07 cycleN freeProduct=0` style PRs when freeShell+freeImplementable stay 0 and partner matrix unchanged.',
    );
    lines.push(
      '**Metric:** L0 value gate (`tooling/ci/value-gate.mjs`) + `Board-Delta:` trailer — see `docs/BOARD-CLEAR-PROCESS-LOOPS.md` (removed) L0.',
    );
    lines.push('');
  }
  lines.push('## Free (spawn one worker each)');
  lines.push('');
  lines.push('| rank | id | track | title | paths (sample) | note |');
  lines.push('| ---: | --- | --- | --- | --- | --- |');
  for (const c of m.free) {
    const paths = (c.paths || []).slice(0, 2).join('; ') || '—';
    lines.push(
      `| ${c.rank} | **${c.id}** | ${c.track} | ${(c.title || '').replace(/\|/g, '/')} | ${paths.replace(/\|/g, '/')} | ${(c.note || '').replace(/\|/g, '/')} |`,
    );
  }
  lines.push('');
  lines.push('## Blocked (do not implement)');
  lines.push('');
  lines.push('| id | track | title | collisions |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of m.blocked) {
    lines.push(
      `| **${c.id}** | ${c.track} | ${(c.title || '').replace(/\|/g, '/')} | ${(c.collisions || []).join('<br>').replace(/\|/g, '/')} |`,
    );
  }
  lines.push('');
  // A9 — invisible to freeProduct (sockets + owned non-done). Report only.
  const inv = m.invisible || {};
  lines.push('## Invisible to freeProduct (A9 — report only, never a gate)');
  lines.push('');
  if (inv.error) {
    lines.push(`_Could not derive: ${inv.error}_`);
  } else {
    lines.push(
      `**Sockets:** ${inv.socketCount ?? 0} (${inv.socketUnowned ?? 0} unowned) · **Owned non-done (non-socket):** ${inv.ownedCount ?? 0}`,
    );
    lines.push('');
    lines.push(
      'These rows are deliberately off the free implementable board. They still exist — a quarter of the platform when sockets alone are counted. Ranked for humans, not for spawn.',
    );
    lines.push('');
    lines.push('### Socket rows');
    lines.push('');
    lines.push('| id | owner | plane | title |');
    lines.push('| --- | --- | --- | --- |');
    for (const s of inv.sockets || []) {
      lines.push(`| **${s.id}** | ${s.owner} | ${s.plane || '—'} | ${(s.title || '').replace(/\|/g, '/')} |`);
    }
    lines.push('');
    lines.push('### Owned non-done (human or named agent claim)');
    lines.push('');
    lines.push('| id | owner | status | title |');
    lines.push('| --- | --- | --- | --- |');
    for (const o of inv.owned || []) {
      lines.push(`| **${o.id}** | ${o.owner} | ${o.status} | ${(o.title || '').replace(/\|/g, '/')} |`);
    }
  }
  lines.push('');
  lines.push('## Open PR snapshot');
  lines.push('');
  for (const p of m.openPrs) {
    lines.push(`- #${p.number} @${p.author} · ${p.fileCount} files · ${p.mergeable || '?'} · ${p.title}`);
  }
  lines.push('');
  lines.push('## NEVER-TOUCH mid-wave (open multi-PR clusters)');
  lines.push('');
  lines.push('- `docs/LIVE-LANES.md` — inside Denon open PRs (#436/#428); use `docs/ops/claims/<id>.md` instead');
  lines.push('- `tooling/tracker/features.mjs` / `docs/TRACKER.md` — batch at wave end');
  lines.push(
    '- `package.json` / `tooling/ci/brand-scan.mjs` / `gates.mjs` / `.github/workflows/ci.yml` — multi-PR pile; use `node tooling/scripts/swarm.mjs` if aliases conflict',
  );
  lines.push('- Visual proof on :8090 if `lsof` path is not your worktree (stale squatter risk)');
  lines.push('- Full fleet proof if Docker missing — stamp `proof_missing: fleet-blocked` (NO-FLEET mode)');
  lines.push('');
  lines.push('## Claim files');
  lines.push('');
  lines.push('Atomic claim: `pnpm swarm:claim <id>` → `docs/ops/claims/<id>.md` (first writer wins).');
  lines.push('');
  lines.push('## Law');
  lines.push('');
  lines.push(
    '- `docs/ops/SWARM-MANDATE.md` (AFK priority ladder + stamp-mill ban) · `docs/SWARM-ALL-OUT-ORIENT-2026-08-03.md` (removed) · `docs/REGROUP-2026-08-03.md` (removed)',
  );
  lines.push('- Before edit: `pnpm claim:check <paths>` · worktree only · no invent money/depth');
  lines.push('- Shehzad protocol/INTACHAIN babysit only · no dual-edit Denon open PR files');
  lines.push('');
  return lines.join('\n');
}

function writeFreeze(m) {
  mkdirSync(OPS, { recursive: true });
  const path = join(OPS, 'FREEZE-LIVE.md');
  writeFileSync(path, renderFreezeMd(m), 'utf8');
  // machine JSON for next/report
  writeFileSync(join(OPS, 'FREEZE-LIVE.json'), JSON.stringify(m, null, 2), 'utf8');
  return path;
}

function printStatus(m) {
  const freeShellN = (m.freeShell || []).length;
  const freeImplN = (m.freeImplementable || []).length;
  const freeProdN = (m.freeProduct || []).length;
  console.log(`swarm:status  tip=${m.tip}  openPRs=${m.openPrCount}`);
  // Canonical lane — freeShell vs freeImplementable must both be visible.
  // freeProduct is shell+implementable (spawn total); never the sole idle signal.
  console.log(
    `  free=${m.free.length} freeShell=${freeShellN} freeImplementable=${freeImplN} freeTracker=${(m.freeTracker || []).length} blocked=${m.blocked.length}`,
  );
  console.log(
    `  spawn: freeProduct=${freeProdN}(=shell+implementable) free_spawnable=${m.available ?? freeProdN} claimed_product_locks=${m.activeSpawned ?? '?'} width_target=${m.spawnWidthTarget || '6-8'}`,
  );
  if (freeShellN === 0 && freeImplN > 0) {
    console.log(
      `  lane-read: freeShell=0 is NOT all-clear — freeImplementable=${freeImplN} spawnable (SPAWN_NOW). freeProduct=${freeProdN}.`,
    );
  } else if (freeShellN === 0 && freeImplN === 0) {
    console.log(
      `  lane-read: freeShell=0 freeImplementable=0 freeProduct=0 — NOT platform-done; run P1–P5 (stranded=${m.strandedCount ?? 0}).`,
    );
  }
  console.log(`  ${m.underSpawnNote}`);
  console.log(`  mandate: ${m.mandate || 'shell product only'}`);
  if (m.afkLadder) console.log(`  afk-ladder: ${m.afkLadder}`);
  if (m.stampMillBan) console.log(`  stamp-mill: BAN — ${m.stampMillBan}`);
  if (m.fStandby) console.log(`  finish: ${m.fStandby}`);
  const churn = m.opsChurn || { consecutive: 0, sample: [] };
  console.log(
    `  ops-churn: ${churn.consecutive} consecutive docs-only tip merges${churn.consecutive >= 5 ? ' ⚠ CHURN' : ''}${churn.sample?.length ? ` (${churn.sample.slice(0, 5).join(',')})` : ''}`,
  );
  const mill = millConcentration();
  if (mill) {
    console.log(
      `  mill-meter: top family ${mill.n}/${mill.window} = ${mill.share}% "${mill.stem}" (warn ≥${MILL_WARN_PCT}%, highest legit ever 15%)${mill.share >= MILL_WARN_PCT ? ' ⚠ MILL — vary the work, not the nouns' : ''}`,
    );
  }
  console.log(`  stranded(P1): ${m.strandedCount ?? 0}`);
  // Dry run only — same reasoning as the markdown report above.
  console.log(`  worktrees: ${m.worktreeCount ?? '?'}${m.worktreeOverCap ? ' ⚠ OVER CAP 20 — review: pnpm wt:gc (dry run)' : ''}`);
  if (m.actionsRuns24h) {
    const by = Object.entries(m.actionsRuns24h.byName || {})
      .sort((a, b) => b[1] - a[1])
      .map(([n, c]) => `${n}=${c}`)
      .join(' ');
    console.log(
      `  actions-24h: total=${m.actionsRuns24h.total}${m.actionsRuns24h.capped ? '+' : ''} ${by}${m.actionsRuns24h.capped ? ' (list capped — true total may be higher)' : ''}`,
    );
  } else {
    console.log('  actions-24h: (gh unavailable)');
  }
  console.log('  free shell ids:', (m.freeShell || []).map((c) => c.id).join(', ') || '(none)');
  console.log('  free implementable ids:', (m.freeImplementable || []).map((c) => c.id).join(', ') || '(none)');
  console.log('  free product ids (shell+impl):', m.freeProduct.map((c) => c.id).join(', ') || '(none)');
  if (m.blocked.length) {
    console.log('  blocked ids:', m.blocked.map((c) => c.id).join(', '));
  }
}

function writeReports(m) {
  mkdirSync(OPS, { recursive: true });
  const r00 = [
    '# R00 inventory (generated)',
    '',
    `Generated: ${m.generatedAt}`,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| Tip | \`${m.tip}\` |`,
    `| Tip subject | ${m.tipSubject} |`,
    `| Open PRs | ${m.openPrCount} |`,
    `| Free claims | ${m.free.length} |`,
    `| freeShell (REGROUP/AFK/LANDER/INTEGRITY) | ${(m.freeShell || []).length} |`,
    `| freeImplementable (TRK Stage-1) | ${(m.freeImplementable || []).length} |`,
    `| freeProduct (shell+implementable) | ${m.freeProduct.length} |`,
    `| Blocked | ${m.blocked.length} |`,
    `| Residual tip_note | ${m.residualTipNote || '—'} |`,
    '',
    m.underSpawnNote,
    '',
    'Regenerate: `pnpm swarm:report`',
    '',
  ].join('\n');
  writeFileSync(join(OPS, 'R00-INVENTORY.md'), r00, 'utf8');

  const r01 = [
    '# R01 PR matrix (generated)',
    '',
    `Tip \`${m.tip}\` · ${m.generatedAt}`,
    '',
    '| # | author | files | mergeable | title | action |',
    '| ---: | --- | ---: | --- | --- | --- |',
    ...m.openPrs.map((p) => {
      let action = 'babysit';
      if (p.author === 'ZenYoda3') action = 'own — verify affected changes and merge when required protection checks pass';
      else if (p.author === 'shehzad002') action = 'babysit only — never implement';
      else if (p.author === 'Phantom-X-007') action = 'no dual-edit files';
      return `| ${p.number} | @${p.author} | ${p.fileCount} | ${p.mergeable || '?'} | ${(p.title || '').replace(/\|/g, '/')} | ${action} |`;
    }),
    '',
    'Regenerate: `pnpm swarm:report`',
    '',
  ].join('\n');
  writeFileSync(join(OPS, 'R01-PR-MATRIX.md'), r01, 'utf8');

  const r02 = [
    '# R02 free claims (generated)',
    '',
    `Tip \`${m.tip}\` · ${m.generatedAt}`,
    '',
    '## Free',
    '',
    ...m.free.map((c) => `- **${c.id}** [${c.track}] ${c.title}`),
    '',
    '## Blocked',
    '',
    ...m.blocked.map((c) => `- **${c.id}** [${c.track}] ${c.title} — ${(c.collisions || []).join('; ')}`),
    '',
    'Regenerate: `pnpm swarm:report` · source FREEZE: `pnpm swarm:freeze`',
    '',
  ].join('\n');
  writeFileSync(join(OPS, 'R02-FREE-CLAIMS.md'), r02, 'utf8');

  const dash = [
    '# Swarm ops dashboard (generated index)',
    '',
    `Last report: ${m.generatedAt} · tip \`${m.tip}\``,
    '',
    '| Report | Path |',
    '| --- | --- |',
    '| Live FREEZE | [FREEZE-LIVE.md](./FREEZE-LIVE.md) |',
    '| R00 inventory | [R00-INVENTORY.md](./R00-INVENTORY.md) |',
    '| R01 PR matrix | [R01-PR-MATRIX.md](./R01-PR-MATRIX.md) |',
    '| R02 free claims | [R02-FREE-CLAIMS.md](./R02-FREE-CLAIMS.md) |',
    '',
    '## At a glance',
    '',
    `- freeShell: **${(m.freeShell || []).length}** · freeImplementable: **${(m.freeImplementable || []).length}** · freeProduct: **${m.freeProduct.length}**`,
    `- Blocked: **${m.blocked.length}**`,
    `- Open PRs: **${m.openPrCount}**`,
    '',
    m.underSpawnNote,
    '',
    m.mandate || '',
    '',
    `- Spawn accounting: free_spawnable=${m.available ?? m.freeProduct.length} · claimed_product_locks=${m.activeSpawned ?? '?'} · width_target=${m.spawnWidthTarget || '6-8'}`,
    '',
    'Commands: `pnpm swarm:freeze` · `pnpm swarm:status` · `pnpm swarm:report` · `pnpm swarm:next`',
    '',
  ].join('\n');
  writeFileSync(join(OPS, 'DASHBOARD.md'), dash, 'utf8');
  const html = `<!doctype html><meta charset=utf-8><title>Swarm dashboard</title>
<style>body{font:16px/1.4 system-ui;max-width:52rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem} .ok{color:#0a0} .warn{color:#a60} code{background:#f4f4f4;padding:.1rem .3rem}</style>
<h1>Swarm dashboard</h1>
<p>Tip <code>${m.tip}</code> · ${m.generatedAt}</p>
<p class=warn>freeShell: <b>${(m.freeShell || []).length}</b> · freeImplementable: <b>${(m.freeImplementable || []).length}</b> · freeProduct: <b>${m.freeProduct.length}</b> · freeTracker: <b>${(m.freeTracker || []).length}</b> · Blocked: <b>${m.blocked.length}</b> · Open PRs: <b>${m.openPrCount}</b></p>
<p>${m.underSpawnNote}</p>
<p><a href="./FREEZE-LIVE.md">FREEZE-LIVE</a> · <a href="./R00-INVENTORY.md">R00</a> · <a href="./R01-PR-MATRIX.md">R01</a> · <a href="./R02-FREE-CLAIMS.md">R02</a></p>
<p>Regenerate: <code>pnpm swarm:report</code></p>`;
  writeFileSync(join(OPS, 'DASHBOARD.html'), html, 'utf8');
  return OPS;
}

function pasteFor(claim) {
  const paths = (claim.paths || []).join('\n  ') || '(none — research/ops/tracker)';
  return [
    `swarm:next → ${claim.id} [${claim.track}]`,
    `  ${claim.title}`,
    '',
    '--- worker paste ---',
    'FIRST: follow AGENTS.md, use a worktree, and check open PRs for overlapping files. Swarm reports and claims are optional discovery aids.',
    `You own ONLY claim: ${claim.id}`,
    `Scope: ${claim.title}`,
    `Allowed paths:\n  ${paths}`,
    `Note: ${claim.note || '—'}`,
    'Forbidden: Shehzad protocol/INTACHAIN implement; dual-edit Denon open PR files; invent money/depth; apps/web product; main checkout; mid-wave features.mjs thrash.',
    'Proof: if no Docker — NO-FLEET (proof_missing: fleet-blocked). If :8090 listener cwd ≠ your worktree — visual proof invalid.',
    'PRE-PUSH: format and check the changed files. Review and verify the affected behavior; honor required protection checks. Before merging, run node tooling/scripts/merge-gate.mjs <pr> --head <sha> from an up-to-date origin/main checkout; merge only after it passes.',
    'Worktree from current origin/main. One service per PR; parallel PRs stay. Record checkable evidence of the change.',
    'Coord width: 6–8 concurrent path-disjoint writers when free claims allow.',
    '--- end paste ---',
  ].join('\n');
}

function printNext(m, all = false) {
  const list = m.freeProduct.length ? m.freeProduct : m.free.filter((c) => c.track !== 'OPS');
  if (!list.length) {
    console.log('swarm:next — no free shell or implementable claims. Board empty or only blocked/OPS/tracker.');
    console.log('swarm:next — freeShell=0 freeImplementable=0 is NOT a kill switch (docs/ops/SWARM-MANDATE.md):');

    // P1 is COMPUTED here, not described. Until 2026-08-07 this printed one line of
    // static prose that NAMED path-intersection and computed none of it, so the branch
    // lane was never a candidate for swarm:next at all. Twelve landable branches sat for
    // 39 hours while the swarm minted waves — because the only lane with a defined next
    // action was the wrong one. Work selection follows definitional clarity, so the
    // highest-priority lane has to be the most clearly defined one.
    const sr = m.strandedRes || {};
    if (sr.error) {
      console.log(`  P1 UNKNOWN — ${sr.error}`);
      console.log('     Do NOT read this as "no work". Restore remote access and re-run.');
    } else if (sr.ours?.length) {
      const next = sr.ours[0];
      console.log(`  P1 → LAND THIS: ${next.branch}  (${next.files} file(s), +${next.ahead} commit(s)) — smallest first`);
      console.log(`     pnpm wt ${next.branch} · git rebase origin/main · pnpm verify · pnpm pr -- …`);
      if (sr.ours.length > 1) {
        const rest = sr.ours
          .slice(1, 5)
          .map((b) => `${b.branch}(${b.files})`)
          .join(' · ');
        console.log(`     then ${sr.ours.length - 1} more: ${rest}${sr.ours.length > 5 ? ' …' : ''}`);
      }
      console.log('     IDLE IS NOT VALID while this lane is non-empty (docs/ops/FINISH-ONTOLOGY.md §3).');
    } else {
      const why = [
        sr.foreign?.length ? `${sr.foreign.length} partner-lane` : null,
        sr.junk?.length ? `${sr.junk.length} mill junk (delete, do not land)` : null,
        sr.phantom?.length ? `${sr.phantom.length} phantom (merged+deleted upstream — git fetch --prune)` : null,
      ].filter(Boolean);
      console.log(`  P1 → none landable${why.length ? `. Excluded: ${why.join(', ')}` : ''}`);
    }
    console.log('  P2 partner unblock: exact CI fail extract + one NEW comment; never merge partners');
    console.log('  P3 deepen thin docs/ops/trk/* for ready non-shehzad tracker rows');
    console.log('  P4 invent re-scan only after shell code change; P-WS report only if #433/#432 changed');
    console.log('  P5 Review and verify the change; merge when done once required protection checks pass');
    console.log('  BAN: R07/R01/P-WS tip-bump “cycle N” PRs when freeShell+freeImplementable stay 0 and matrix unchanged');
    return;
  }
  if (all) {
    console.log(`swarm:next --all → ${list.length} free product claims\n`);
    for (const c of list) {
      console.log(pasteFor(c));
      console.log('');
    }
    console.log(
      `ANTI-UNDER-SPAWN: free_spawnable=${list.length} claimed_product_locks=${m.activeSpawned ?? 0} — spawn or residual-own every id above (width target 6–8 path-disjoint).`,
    );
    return;
  }
  console.log(pasteFor(list[0]));
  console.log('');
  console.log(`Remaining free product after this: ${list.length - 1}`);
  console.log('Tip: pnpm swarm:next --all  for every free product paste.');
}

// --- main ---
try {
  validateResidualPathHints();
} catch (e) {
  console.error('swarm — RESIDUAL_PATH_HINTS invalid (fail closed).');
  console.error(`  ${e.message || e}`);
  process.exit(2);
}

// The board is what agents steer by, so a stale board silently redirects the
// whole swarm. Measured 2026-08-07: a checkout 178 commits behind reported
// `freeImplementable=6 blocked=0` while origin/main reported `0` and `15` —
// an agent on the stale copy spawns workers onto work that does not exist.
// Announce before any number is printed; a reader
// who stops at line one must still learn the numbers may be wrong.
const behind = checkoutStaleness();
if (behind && behind > 0) {
  console.log(`  STALE CHECKOUT — this board is ${behind} commit(s) behind origin/main.`);
  console.log('  Every count below may be wrong. git pull, or re-run from a worktree at origin/main.');
}

const m = buildModel();
if (m.error) {
  console.error('swarm — CANNOT ANSWER: gh/git failed.');
  console.error(`  ${m.error}`);
  console.error('  Not reporting clear free board.');
  process.exit(2);
}

switch (cmd) {
  case 'freeze': {
    // Co-write R00/R01/R02/DASHBOARD so freeze tip never desyncs from report tip
    // (L15 meters honesty: freeze-only left FREEZE hours ahead of DASHBOARD).
    const path = writeFreeze(m);
    const dir = writeReports(m);
    printStatus(m);
    console.log(`  wrote ${repoRelative(path)}`);
    console.log(`  wrote docs/ops/FREEZE-LIVE.json`);
    console.log(`  wrote reports under ${repoRelative(dir)}`);
    break;
  }
  case 'status': {
    printStatus(m);
    break;
  }
  case 'report': {
    writeFreeze(m);
    const dir = writeReports(m);
    printStatus(m);
    console.log(`  wrote reports under ${repoRelative(dir)}`);
    break;
  }
  case 'next': {
    writeFreeze(m);
    printNext(m, args.includes('--all'));
    break;
  }
  case 'claim': {
    const id = args[0];
    if (!id) {
      console.error('Usage: pnpm swarm:claim <id>');
      process.exit(1);
    }
    writeFreeze(m);
    const claim = m.claims.find((c) => c.id === id);
    if (!claim) {
      console.error(`Unknown claim id ${id} — run pnpm swarm:freeze and pick an id`);
      process.exit(1);
    }
    if (claim.status === 'blocked') {
      console.error(`Claim ${id} is blocked: ${(claim.collisions || []).join('; ')}`);
      process.exit(1);
    }
    const r = writeClaimFile(id, claim);
    console.log(r.existed ? `claim exists: ${r.path}` : `claim locked: ${r.path}`);
    break;
  }
  case 'lanes': {
    printLanes(m);
    break;
  }
  case 'heartbeat': {
    const id = args[0];
    if (!id) {
      console.error('Usage: pnpm swarm:heartbeat <id>');
      process.exit(1);
    }
    const r = touchClaimFile(id);
    if (!r.ok) {
      console.error(`heartbeat failed: ${r.reason || 'unknown'} (${r.path})`);
      process.exit(1);
    }
    console.log(`heartbeat: ${id} → ${r.heartbeat}`);
    break;
  }
  default:
    console.error(`Usage: node tooling/scripts/swarm.mjs <freeze|status|lanes|report|next|claim|heartbeat>`);
    process.exit(1);
}
