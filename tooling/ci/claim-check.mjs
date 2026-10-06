#!/usr/bin/env node
/**
 * CLAIM CHECK — is anyone already inside the files you are about to edit?
 *
 * WHY THIS EXISTS. `docs/LIVE-LANES.md` records who owns which MOUNTAIN. That
 * is the right granularity for deciding who builds Pay OS and who builds the
 * trader shell, and it is the wrong granularity for the thing that actually
 * costs us: two people editing the same file on the same afternoon.
 *
 * A concrete example, and the reason this file exists. An agent was dispatched
 * to migrate test isolation in `services/svc-pay`. Lane ownership said Pay was
 * a human mountain, which it read as "do not build pay FEATURES" — and test
 * infrastructure is not a feature, so it proceeded. Meanwhile PR #346 was open
 * and editing `services/svc-pay/src/payment-service.test.ts`: the exact file.
 *
 * Nobody was careless. The board answered the question it was designed to
 * answer. It simply does not carry the information "this file is open on
 * someone's desk right now", and no amount of reading it more carefully would
 * have produced that.
 *
 * The consequence would have been a merge race on test files that TRUNCATE
 * tables — which is the single worst place in this repo to have one, since the
 * losing side's rows vanish mid-assertion and it presents as flakiness.
 *
 * So: ask GitHub what is actually open, and compare it against what you are
 * about to touch. Ten seconds, no judgement required.
 *
 *   pnpm claim:check services/svc-bank    # preferred — paths you are about to edit
 *   pnpm claim:check                      # this branch vs open PRs (exit 2 if clean / no paths)
 *   node tooling/ci/claim-check.mjs --self-test   # hermetic fixtures, no gh/network
 *
 * Exit 0 = clear on the path axis (may still warn if ownership map is incomplete).
 * Exit 1 = open-PR collision or human-claimed mountain — talk before editing.
 * Exit 2 = cannot answer (blank args, clean branch, dashed junk, unmappable path,
 *          gh/git failure, list/files cap, FEATURES shape broken).
 *
 * Interactive mode is ADVISORY (needs gh + network). The hermetic `--self-test`
 * pack is a doctrine gate (`claim-check-selftest`) so a quiet revert of the
 * false-clear fixtures cannot green CI. Overlap is often fine — the failure
 * mode we remove is *unknowing* overlap.
 *
 * Sealed pack (#1414 + W8 L08): blank argv refuse · dashed junk refuse · abs
 * path → repo-relative · FEATURES array shape · rename porcelain · PR list cap ·
 * per-PR files page cap · unmapped-owner honesty. Self-test pins pure helpers.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { touches } from '../scripts/path-collide.mjs';

const PR_LIST_LIMIT = 100;
const GH_FILES_PAGE_CAP = 100;

/** Known flags — never paths. Unknown dashed tokens are junk (false-clear class). */
const KNOWN_FLAGS = new Set(['--self-test']);

const args = process.argv.slice(2);

/**
 * Pure: strip blank + known flags; keep only path-shaped tokens.
 * Dashed junk (`--json`, `-h`) used to become "paths" that no PR touches →
 * exit 0 ✓ clear without checking intent (W8 L08 residual).
 */
export function realArgPaths(argv) {
  return (argv ?? [])
    .map((a) => (typeof a === 'string' ? a.trim() : ''))
    .filter(Boolean)
    .filter((a) => !KNOWN_FLAGS.has(a))
    .filter((a) => !a.startsWith('-'));
}

/**
 * Pure: did argv contain a dashed token that is not a known flag?
 * Used so we can refuse "I checked --json" as clear rather than strip silently
 * when mixed with real paths — silent strip of only-junk is fine (empty mine
 * already exits 2); mixed junk is still a lie about what was checked.
 */
export function hasUnknownDashedArgs(argv) {
  return (argv ?? [])
    .map((a) => (typeof a === 'string' ? a.trim() : ''))
    .filter(Boolean)
    .some((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a));
}

/**
 * Pure: map an absolute / cwd-rooted path onto a repo-relative path so
 * `touches` can match GitHub PR file lists (always relative).
 * Returns null when the path is absolute and outside the repo root —
 * comparing it would always miss, which is a silent false clear.
 */
export function toRepoRelative(p, repoRoot) {
  if (typeof p !== 'string' || p.length === 0) return p;
  let x = p.replace(/\\/g, '/');
  const root = typeof repoRoot === 'string' ? repoRoot.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  if (root && (x === root || x.startsWith(`${root}/`))) {
    x = x.slice(root.length).replace(/^\//, '');
  }
  // Leading "./" only — do not strip a bare absolute outside root.
  x = x.replace(/^\.\//, '');
  // Absolute or Windows drive left after root strip → unmappable.
  if (x.startsWith('/') || /^[A-Za-z]:\//.test(x)) return null;
  return x;
}

/**
 * Pure: porcelain status line → real path(s).
 * Renames/copies yield both sides so touches() can match.
 */
export function pathsFromPorcelainLine(line) {
  if (typeof line !== 'string' || line.length < 4) return [];
  const body = line.slice(3);
  if (body.includes(' -> ')) {
    return body
      .split(' -> ')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter(Boolean);
  }
  const p = body.trim().replace(/^"|"$/g, '');
  return p ? [p] : [];
}

/** Pure: whether a PR file list is untrustworthy (silent truncate risk). */
export function prFilesTruncated(files, cap = GH_FILES_PAGE_CAP) {
  return (files ?? []).length >= cap;
}

/** Pure: whether open PR list hit the inspect cap. */
export function prListAtCap(prs, limit = PR_LIST_LIMIT) {
  return Array.isArray(prs) && prs.length >= limit;
}

/** Login and display name on a gh author object, or a string fixture. No gh call. */
export function prAuthorIds(author) {
  if (typeof author === 'string') return author.length > 0 ? [author] : [];
  if (!author || typeof author !== 'object') return [];
  return [author.login, author.name].filter((id) => typeof id === 'string' && id.length > 0);
}

/**
 * This checkout's own open PR only when the branch name and the author both match.
 * headRefName is only the branch name. A fork, or any other PR, can reuse it.
 */
export function isThisCheckoutOpenPr(pr, branch, checkoutAuthor) {
  if (!pr || pr.headRefName !== branch) return false;
  if (typeof checkoutAuthor !== 'string' || checkoutAuthor.length === 0) return false;
  return prAuthorIds(pr.author).includes(checkoutAuthor);
}

/**
 * Open PRs that touch `mine`, skipping only this checkout's own PR.
 * Pure: no gh, no git. `author` is this checkout's author (git user.name).
 */
export function openPrCollisions(prs, { branch, author, mine }) {
  const collisions = [];
  for (const pr of prs) {
    if (isThisCheckoutOpenPr(pr, branch, author)) continue;
    const overlap = (pr.files ?? []).map((f) => f.path).filter((p) => mine.some((m) => touches(m, p)));
    if (overlap.length > 0) collisions.push({ pr, overlap });
  }
  return collisions;
}

/**
 * Path-axis print/exit for fixture PRs. Exit 0 and a clear line is the
 * false-clear a same-named PR from another author must not produce.
 */
export function prCollisionVerdict({ prs, branch, author, mine }) {
  const collisions = openPrCollisions(prs, { branch, author, mine });
  if (collisions.length === 0) {
    return {
      exitCode: 0,
      clear: true,
      line: '  ✓ clear — no open PR touches these paths, and none is human-claimed',
      collisions,
    };
  }
  const lines = [`  ✖ ${collisions.length} open PR(s) are already inside these paths:`];
  for (const { pr, overlap } of collisions) {
    const login = typeof pr.author === 'string' ? pr.author : pr.author?.login;
    lines.push(`      #${pr.number} @${login} — ${pr.title}`);
    lines.push(`          branch: ${pr.headRefName}`);
    for (const p of overlap.slice(0, 8)) lines.push(`          · ${p}`);
  }
  return { exitCode: 1, clear: false, line: lines.join('\n'), collisions };
}

function selfTest() {
  const fails = [];
  const assert = (c, m) => {
    if (!c) fails.push(m);
  };

  // Blank / whitespace argv must not invent a path to check.
  assert(realArgPaths(['']).length === 0, 'blank string argv is not a path');
  assert(realArgPaths(['  ', '\t']).length === 0, 'whitespace argv is not a path');
  assert(realArgPaths(['', 'services/svc-bank']).join() === 'services/svc-bank', 'blank entries stripped');
  assert(realArgPaths(['--self-test']).length === 0, '--self-test is not a path');

  // Dashed junk is not a path (W8 L08 false-clear: --json → exit 0 clear).
  assert(realArgPaths(['--json']).length === 0, '--json is not a path');
  assert(realArgPaths(['-h', 'services/svc-bank']).join() === 'services/svc-bank', 'strip -h keep path');
  assert(hasUnknownDashedArgs(['--json']) === true, '--json is unknown dashed');
  assert(hasUnknownDashedArgs(['--self-test']) === false, '--self-test is known');
  assert(hasUnknownDashedArgs(['services/svc-bank']) === false, 'path is not dashed');

  // Abs → repo-relative so touches matches PR lists.
  const root = '/Users/Nitro/projects/Sovereign';
  assert(toRepoRelative(`${root}/tooling/ci/gates.mjs`, root) === 'tooling/ci/gates.mjs', 'abs under root becomes relative');
  assert(toRepoRelative('tooling/ci/gates.mjs', root) === 'tooling/ci/gates.mjs', 'relative unchanged');
  assert(toRepoRelative('/etc/passwd', root) === null, 'abs outside root unmappable');
  assert(toRepoRelative(`${root}/tooling/ci/gates.mjs`, root) !== null, 'in-repo abs mappable');
  assert(
    touches(toRepoRelative(`${root}/tooling/ci/gates.mjs`, root), 'tooling/ci/gates.mjs') === true,
    'abs-normalized collides with PR relative path',
  );

  // Rename porcelain: both sides must be real paths (not "a -> b" as one path).
  assert(pathsFromPorcelainLine('R  old/path.ts -> new/path.ts').join('|') === 'old/path.ts|new/path.ts', 'rename yields both paths');
  assert(pathsFromPorcelainLine(' M tooling/ci/claim-check.mjs').join() === 'tooling/ci/claim-check.mjs', 'modified path');
  assert(pathsFromPorcelainLine('R  "old x" -> "new y"').join('|') === 'old x|new y', 'quoted rename paths');

  // Caps refuse silent clear.
  assert(prListAtCap(new Array(PR_LIST_LIMIT).fill({}), PR_LIST_LIMIT) === true, 'list at cap');
  assert(prListAtCap(new Array(PR_LIST_LIMIT - 1).fill({}), PR_LIST_LIMIT) === false, 'list under cap');
  assert(prFilesTruncated(new Array(GH_FILES_PAGE_CAP).fill({ path: 'a' })) === true, 'files at page cap');
  assert(prFilesTruncated(new Array(GH_FILES_PAGE_CAP - 1).fill({ path: 'a' })) === false, 'files under page cap');

  // touches shared with path-collide (trailing-slash wall) still holds here.
  assert(touches('tooling/', 'tooling/ci/claim-check.mjs') === true, 'trailing-slash wall touches child');

  // Same branch name is not identity. Another author's PR that touches the path
  // must not print clear / exit 0. This checkout (same author) may still be skipped.
  const sameName = 'fix/same-name';
  const checkoutAuthor = 'this-checkout';
  const checked = 'tooling/ci/claim-check.mjs';
  const foreignPr = {
    number: 910,
    title: 'fork PR with the same branch name',
    headRefName: sameName,
    author: { login: 'fork-user', name: 'Fork User' },
    files: [{ path: checked }],
  };
  const ownPr = {
    number: 911,
    title: 'this checkout open PR',
    headRefName: sameName,
    author: { login: checkoutAuthor },
    files: [{ path: checked }],
  };
  const foreignVerdict = prCollisionVerdict({ prs: [foreignPr], branch: sameName, author: checkoutAuthor, mine: [checked] });
  assert(foreignVerdict.exitCode !== 0 && foreignVerdict.clear === false, 'same-name other author must not clear');
  assert(
    foreignVerdict.collisions.some((c) => c.pr.number === 910),
    'same-name other author that touches the path is a collision',
  );
  const ownVerdict = prCollisionVerdict({ prs: [ownPr], branch: sameName, author: checkoutAuthor, mine: [checked] });
  assert(ownVerdict.exitCode === 0 && ownVerdict.clear === true, 'same branch and same author may still be skipped');
  assert(isThisCheckoutOpenPr(foreignPr, sameName, checkoutAuthor) === false, 'other author is not this checkout');
  assert(isThisCheckoutOpenPr(ownPr, sameName, checkoutAuthor) === true, 'same author and branch is this checkout');

  if (fails.length) {
    console.error('claim-check --self-test FAIL:');
    for (const f of fails) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log('claim-check --self-test OK');
  console.log('  fixture blank argv · dashed junk · abs→relative · rename porcelain · list/files caps · trailing-slash wall · same-name other author');
  process.exit(0);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun && args.includes('--self-test')) selfTest();

/** `gh` returns JSON on stdout; anything else means we cannot answer honestly. */
function gh(jsonArgs) {
  try {
    return JSON.parse(execFileSync('gh', jsonArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (error) {
    return { __error: error.stderr?.toString().trim() || error.message };
  }
}

/** Git failures must not be swallowed into a silent empty mine (false clear). */
let gitFailed = false;
let gitFailDetail = '';
function git(gitArgs) {
  try {
    return execFileSync('git', gitArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    gitFailed = true;
    gitFailDetail = error.stderr?.toString().trim() || error.message || 'git failed';
    return '';
  }
}

/** This checkout's author. Local git identity only — not a gh call. Blank if unset. */
function checkoutAuthor() {
  try {
    return execFileSync('git', ['config', 'user.name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * What am I about to touch?
 *
 * With paths given, those paths. Without, the files this branch changes versus
 * `origin/main` PLUS uncommitted work — because the most dangerous moment is
 * before the first commit, when nothing is pushed and nothing is visible to
 * anyone else at all.
 */
function myFiles() {
  // Blank / whitespace-only argv used to count as "paths" and print ✓ clear
  // without checking anything real (exit 0). Same false-clear class as empty
  // no-args — strip them so the length===0 refuse below can fire.
  if (args.length > 0) {
    // Dashed junk alone (or mixed) is not a path check. Refuse before we map
    // "--json" onto an empty collision set and print ✓ clear (W8 L08).
    if (hasUnknownDashedArgs(args)) {
      return { source: 'arguments', files: [], dashedJunk: true };
    }
    const root = git(['rev-parse', '--show-toplevel']) || process.cwd();
    const rel = [];
    for (const raw of realArgPaths(args)) {
      const mapped = toRepoRelative(raw, root);
      if (mapped === null) {
        return { source: 'arguments', files: [], unmappable: raw };
      }
      rel.push(mapped);
    }
    return { source: 'arguments', files: rel };
  }

  const base = git(['merge-base', 'origin/main', 'HEAD']) || 'origin/main';
  const committed = git(['diff', '--name-only', `${base}...HEAD`])
    .split('\n')
    .filter(Boolean);
  const working = git(['status', '--porcelain'])
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => pathsFromPorcelainLine(l));

  return { source: 'this branch (committed + working tree)', files: [...new Set([...committed, ...working])] };
}

if (isDirectRun) await runClaimCheck();

async function runClaimCheck() {
  const { source, files: mine, dashedJunk, unmappable } = myFiles();

  // Branch-mode only: if git could not answer, refuse rather than invent "clear".
  // Path-mode does not need git for the mine set — except abs→relative above.
  if (source !== 'arguments' && gitFailed) {
    console.error('  claim-check — CANNOT ANSWER: `git` failed while listing this branch.');
    console.error(`      ${gitFailDetail}`);
    console.error('      Not reporting "clear" — this tool has not checked anything.');
    process.exit(2);
  }

  if (dashedJunk) {
    console.error('  claim-check — CANNOT ANSWER: dashed flag is not a path.');
    console.error('      Pass real paths, e.g. `pnpm claim:check services/svc-bank`.');
    console.error('      Known flag: --self-test. Anything else starting with `-` is junk.');
    console.error('      Not reporting "clear" — this tool has not checked anything.');
    process.exit(2);
  }

  if (unmappable) {
    console.error('  claim-check — CANNOT ANSWER: path is outside this repo (cannot match open PR files).');
    console.error(`      ${unmappable}`);
    console.error('      Pass a path inside the worktree, relative or absolute under the repo root.');
    console.error('      Not reporting "clear" — this tool has not checked anything.');
    process.exit(2);
  }

  if (mine.length === 0) {
    // Exit 2 = cannot answer (same class as gh failure). Exit 0 used to look like
    // "lane free" when an agent forgot to pass paths — the soft false-clear that
    // ships agents into someone else's desk with a green checkmark. Blank /
    // whitespace-only argv used to take the same exit-0 path (#1252 residual).
    console.error('  claim-check — CANNOT ANSWER: no real paths given (empty args or clean branch).');
    console.error('      Pass the paths you are about to edit, e.g. `pnpm claim:check services/svc-bank`.');
    console.error('      Not reporting "clear" — this tool has not checked anything.');
    process.exit(2);
  }

  const prs = gh(['pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT), '--json', 'number,title,author,headRefName,files']);

  if (prs.__error) {
    // Refuse rather than reassure. "No conflicts found" when we could not look is
    // the one output that would make this tool worse than not having it.
    console.error('  claim-check — CANNOT ANSWER: `gh` failed.');
    console.error(`      ${prs.__error}`);
    console.error('      Not reporting "clear" — this tool has not checked anything.');
    process.exit(2);
  }

  // Hitting the list cap means more open PRs may exist unseen — clear would be a lie.
  if (prListAtCap(prs, PR_LIST_LIMIT)) {
    console.error(`  claim-check — CANNOT ANSWER: open PR list hit the cap (${PR_LIST_LIMIT}).`);
    console.error('      Some open PRs were not inspected. Not reporting "clear".');
    console.error('      Raise PR_LIST_LIMIT or close/merge open work, then re-run.');
    process.exit(2);
  }

  // `gh pr list --json files` returns at most ~100 paths per PR (GitHub GraphQL
  // page). A PR that hits that cap may have more files we never saw — reporting
  // clear on an unlisted path is a silent false-clear (L15 A3 / W5 park).
  if (Array.isArray(prs)) {
    const truncated = prs.filter((pr) => prFilesTruncated(pr.files, GH_FILES_PAGE_CAP));
    if (truncated.length > 0) {
      console.error(`  claim-check — CANNOT ANSWER: ${truncated.length} open PR(s) hit the per-PR files cap (${GH_FILES_PAGE_CAP}).`);
      for (const pr of truncated.slice(0, 8)) {
        console.error(`      #${pr.number} ${pr.title} — files listed: ${(pr.files ?? []).length}`);
      }
      if (truncated.length > 8) console.error(`      … and ${truncated.length - 8} more`);
      console.error('      Overlap against unlisted paths was not checked. Not reporting "clear".');
      console.error('      Fetch full file lists per PR (gh pr view N --json files) or shrink the PR.');
      process.exit(2);
    }
  }

  /**
   * HUMAN-CLAIMED MOUNTAINS — the question this tool did NOT answer, and should.
   *
   * On 2026-08-03 five agents were dispatched into features locked to a named
   * human. `claim:check` reported `✓ clear` for every one of them, and that is
   * what produced the confidence to dispatch.
   *
   * It was not wrong — it answered "is this file open in someone's PR right now",
   * which was all it was built to do. But an UNSTARTED human mountain has no open
   * PR by definition, so the emptier the lane, the greener the check. Exactly
   * backwards for the question people were actually asking it.
   *
   * Three of the five agents caught the lock themselves by reading
   * `tooling/tracker/features.mjs`. A tool that a careful reader has to
   * second-guess is worse than no tool, so it reads that file now.
   */
  let ownershipError = null;

  async function ownedPaths() {
    try {
      const mod = await import(pathToFileURL(join(process.cwd(), 'tooling/tracker/features.mjs')).href);
      // Missing or non-array FEATURES used to become `[]` via `?? []` and print
      // full clear on the ownership axis while the tracker was broken (W8 L08).
      if (!Array.isArray(mod.FEATURES)) {
        ownershipError = 'FEATURES export is missing or not an array';
        return null;
      }
      const out = [];
      /** @type {{ id: string, owner: string, status: string }[]} */
      const unmapped = [];
      for (const f of mod.FEATURES) {
        if (!f.owner) continue;
        // `done` means the mountain already shipped. A leftover owner field is a
        // ghost, not a live human claim — fencing agents on it is a false block
        // (infra.ui-tokens + web.shell both sit done+owner:Nitro today).
        // ready/wip/socket with an owner still fence; only done is ignored.
        if (f.status === 'done') continue;

        // Declared paths, where a feature bothers to list them.
        const reqs = f.requires ?? [];
        for (const req of reqs) out.push({ path: req, owner: f.owner, id: f.id ?? '' });

        // Module fallback ONLY when the row names no paths. Rows that declare
        // `requires: ['services/svc-trade/src/futures']` must not also invent
        // `services/svc-trade` and whole-lock the service (W4 A0 / LANE-STOP-TRADE).
        // Empty-requires owners still need the fallback — that is how trade.otc /
        // bank.earn / pay.fraud were caught when agents were wrongly dispatched.
        //
        // `services/svc-<module>` is the convention throughout this repo.
        if (f.module && reqs.length === 0) {
          out.push({ path: `services/svc-${f.module}`, owner: f.owner, id: f.id ?? '' });
        }

        // Owner + non-done with neither requires nor module → invisible fence.
        // Agents get ✓ clear on every path while a human still owns the mountain
        // (connect.venue-vault @shehzad002 was the live case). Surface them —
        // never pretend the ownership axis is complete.
        if (reqs.length === 0 && !f.module) {
          unmapped.push({ id: f.id ?? '', owner: f.owner, status: f.status ?? '' });
        }
      }
      return { paths: out, unmapped };
    } catch (error) {
      // Cannot read = cannot claim clear on this axis. Surfaced, never swallowed:
      // a silent failure here reproduces the exact bug this check was added for.
      ownershipError = error.message;
      return null;
    }
  }

  const owned = await ownedPaths();
  const lockHits = [];
  /** @type {{ id: string, owner: string, status: string }[]} */
  let unmappedOwners = [];
  if (owned === null) {
    console.error('  claim-check — CANNOT ANSWER: tracker ownership could not be read.');
    console.error(`      ${ownershipError}`);
    console.error('      The human-mountain check did NOT run. Not reporting clear.');
    process.exit(2);
  } else {
    unmappedOwners = owned.unmapped;
    for (const o of owned.paths) {
      if (mine.some((m) => touches(m, o.path))) {
        if (!lockHits.some((h) => h.path === o.path && h.owner === o.owner)) lockHits.push(o);
      }
    }
  }

  const self = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const collisions = openPrCollisions(prs, { branch: self, author: checkoutAuthor(), mine });

  console.log(`  claim-check — ${mine.length} path(s) from ${source}, against ${prs.length} open PR(s)\n`);

  if (lockHits.length > 0) {
    console.error(`  ✖ ${lockHits.length} path(s) belong to a HUMAN-CLAIMED mountain:`);
    for (const h of lockHits) {
      console.error(`      ${h.path} — owner @${h.owner}${h.id ? ` (${h.id})` : ''}`);
    }
    console.error('');
    console.error('  An agent must NOT implement here. The documented unlock is the owner');
    console.error('  commenting `agents free on <path>`, or a PR moving the `owner` field in');
    console.error('  tooling/tracker/features.mjs and the ownership docs.');
    console.error('');
    console.error('  Reading it, babysitting CI, and reporting findings are all still fine.');
    process.exit(1);
  }

  if (collisions.length === 0) {
    if (unmappedOwners.length > 0) {
      // Path axis is clear. Ownership axis is incomplete — do not print the full
      // "none is human-claimed" lie while a named owner has zero fenceable paths.
      console.log('  ✓ clear of open PRs for these paths');
      console.error(
        `  ⚠ ownership axis incomplete — ${unmappedOwners.length} human-owned mountain(s) have no path map (requires/module empty):`,
      );
      for (const u of unmappedOwners.slice(0, 12)) {
        console.error(`      ${u.id || '(no id)'} — @${u.owner} (${u.status || 'unknown'})`);
      }
      if (unmappedOwners.length > 12) {
        console.error(`      … and ${unmappedOwners.length - 12} more`);
      }
      console.error('      Fix: add requires[] or module on the tracker row, or clear the owner.');
      console.error('      Not claiming "none is human-claimed" until every owned mountain is fenceable.');
      process.exit(0);
    }
    console.log('  ✓ clear — no open PR touches these paths, and none is human-claimed');
    process.exit(0);
  }

  console.error(`  ✖ ${collisions.length} open PR(s) are already inside these paths:\n`);
  for (const { pr, overlap } of collisions) {
    console.error(`      #${pr.number} @${pr.author.login} — ${pr.title}`);
    console.error(`          branch: ${pr.headRefName}`);
    for (const p of overlap.slice(0, 8)) console.error(`          · ${p}`);
    if (overlap.length > 8) console.error(`          · … and ${overlap.length - 8} more`);
    console.error('');
  }

  console.error('  Overlap is not automatically a problem — but it should be a conversation,');
  console.error('  not a merge conflict discovered later. Talk to the author, or pick different work.');
  process.exit(1);
}
