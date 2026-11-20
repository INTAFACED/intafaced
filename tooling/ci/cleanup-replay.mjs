#!/usr/bin/env node
/**
 * Whether a pull request's product diff is exactly what a committed clean-up script (a codemod) writes. CI reruns the
 * script on the pull request's merge base and compares its output with the head; the builder's word decides nothing.
 * journey-touch.mjs journeyTouch then runs only the journeys the touched-journeys map gives for those paths, plus the
 * CANARY journeys, which boot the whole stack and the app (the start-up check), and never falls back to the full run.
 * Main's full run after the merge, main-bisect and its revert judge the rest, as for every change.
 *
 * The rule (the owner's decision of 20 Nov 2026, part 2): a clean-up change passes on types, build, start-up check, unit
 * tests, the before-and-after replay and only the journeys its area reaches. (Failure it prevents: the 12 newest merged
 * clean-up pull requests before it took 28 to 95 minutes each, nearly all of it full journeys runs, for diffs a script
 * could have written; #9132 changed 22+20 lines and paid for 5 full runs.)
 *
 * The pull request names its script on one line of its body: `Codemod: <name>`. The script is
 * `tooling/codemods/<name>.mjs` at the merge base, so it is already on main and reviewed, never the pull request's own
 * copy: a script the pull request adds or changes beside its output proves nothing, and its output is judged by
 * today's rules. It is run with Node alone (no installed packages, no network needed), in a clean checkout of the merge
 * base, from its root, with a bare environment. The pull request's diff passes when:
 *   - the script ran, exited 0 and changed at least one file;
 *   - every path it changed is changed by the pull request, to exactly the script's bytes (a deletion is a deletion);
 *   - every product path the pull request changes (apps/, services/, packages/, other than unit tests: journey-touch's
 *     `product`) is one the script changed. A hand edit beside it, or a slice of its output, fails, and today's rules
 *     judge the pull request.
 * Paths the script does not write (a unit test, a doc) keep their own kind.
 *
 *   node tooling/ci/cleanup-replay.mjs --base <sha> --head <sha> --name <name> --files-from <f>   (prints the verdict as JSON)
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The body line that names the script: `Codemod: <name>`, a name of lower-case letters, digits and dashes. */
export const CODEMOD_LINE = /^Codemod:[ \t]*([a-z0-9][a-z0-9-]{0,63})[ \t]*$/m;
/** Where the scripts live, at the merge base. */
export const CODEMOD_DIR = 'tooling/codemods';
/** How long a script may run. */
export const CODEMOD_TIMEOUT_MS = 5 * 60 * 1000;
const SHA40 = /^[0-9a-f]{40}$/;

/** The script a pull request body names, or null. Two different names: null (one script a change). */
export function codemodOf(body) {
  const names = new Set([...String(body ?? '').matchAll(new RegExp(CODEMOD_LINE.source, 'gm'))].map((m) => m[1]));
  return names.size === 1 ? [...names][0] : null;
}

/**
 * The verdict from what the script changed (`changed`: paths), what the pull request changes (`paths`), which of those
 * are product paths (`isProduct`), and the paths the script wrote that differ from the head (`differs`). Pure.
 * Returns { ok: true, name, paths: Set } or { ok: false, why }.
 */
export function judgeReplay({ name, changed, paths, isProduct, differs }) {
  const pr = new Set(paths);
  const out = new Set(changed);
  if (!out.size) return { ok: false, why: `codemod ${name} changes nothing at the merge base` };
  const extra = [...out].filter((p) => !pr.has(p)).sort();
  if (extra.length) return { ok: false, why: `codemod ${name} changes ${extra[0]}, which this pull request does not` };
  if (differs.length) return { ok: false, why: `${[...differs].sort()[0]} differs from codemod ${name}'s output` };
  const hand = [...pr].filter((p) => isProduct(p) && !out.has(p)).sort();
  if (hand.length) return { ok: false, why: `${hand[0]} is product code codemod ${name} does not write (a hand edit)` };
  return { ok: true, name, paths: out };
}

const git = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 2 ** 20, ...opts });

/**
 * Reruns codemod `name` on `base` in a clean worktree of the git checkout at `root` and judges `head` against it
 * (judgeReplay). Both commits are fetched from `origin` when missing. Any failure is a verdict, never a throw:
 * { ok: false, why }.
 */
export function replayCodemod({ root = '.', base, head, name, paths, isProduct }) {
  if (!SHA40.test(String(base)) || !SHA40.test(String(head))) return { ok: false, why: 'the merge base or the head is not a commit' };
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(name))) return { ok: false, why: 'no codemod name' };
  const dir = mkdtempSync(join(tmpdir(), 'codemod-'));
  const wt = join(dir, 'base');
  let added = false;
  try {
    for (const sha of [base, head]) {
      try {
        git(root, ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
      } catch {
        git(root, ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin', sha], { stdio: 'ignore' });
      }
    }
    git(root, ['worktree', 'add', '--quiet', '--detach', wt, base], { stdio: 'ignore' });
    added = true;
    const script = `${CODEMOD_DIR}/${name}.mjs`;
    try {
      git(wt, ['cat-file', '-e', `${base}:${script}`], { stdio: 'ignore' });
    } catch {
      return { ok: false, why: `${script} is not on the merge base (a codemod lands on main before its output)` };
    }
    const run = spawnSync(process.execPath, [script], {
      cwd: wt,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C.UTF-8' },
      encoding: 'utf8',
      timeout: CODEMOD_TIMEOUT_MS,
      maxBuffer: 64 * 2 ** 20,
    });
    if (run.status !== 0) return { ok: false, why: `codemod ${name} failed (${run.error?.message ?? `exit ${run.status ?? run.signal}`})` };
    git(wt, ['add', '-A']);
    const changed = git(wt, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD']).split('\0').filter(Boolean);
    // The index is the merge base plus the script's output; the head is the merge base plus the pull request's diff.
    const out = new Set(changed);
    const differs = git(wt, ['diff', '--cached', '--name-only', '--no-renames', '-z', head])
      .split('\0')
      .filter((p) => p && out.has(p));
    return judgeReplay({ name, changed, paths, isProduct, differs });
  } catch (e) {
    return { ok: false, why: `codemod ${name} could not be replayed (${String(e?.message ?? e).split('\n')[0]})` };
  } finally {
    if (added) {
      rmSync(wt, { recursive: true, force: true });
      try {
        git(root, ['worktree', 'prune'], { stdio: 'ignore' });
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : undefined);
  const { pathKind } = await import('./journey-touch.mjs');
  const paths = readFileSync(arg('--files-from'), 'utf8').split('\n').filter(Boolean);
  const v = replayCodemod({
    base: arg('--base'),
    head: arg('--head'),
    name: arg('--name'),
    paths,
    isProduct: (p) => Boolean(pathKind(p).product),
  });
  console.log(JSON.stringify(v.ok ? { ok: true, paths: [...v.paths] } : v));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
