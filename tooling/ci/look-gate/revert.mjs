/**
 * Whether the pull request this look gate judges is main-bisect's proven revert of a culprit X, and the build look-pr.yml
 * made of X^ (`--parent`) is X^: then the gate judges the head's new findings against X^ too (policy.mjs
 * restoredFindings), so a revert may put back what X^ already drew, never more (project-state#3697).
 *
 * The proof is exact-revert.mjs autoRevertOf, from the env ci.yml sets for the pull request (look-pr.yml passes the same).
 * look-pr.yml runs main's copy of the gate and puts main's exact-revert.mjs beside it, so it is main's proof that runs;
 * in the repository (tests, a dispatch) the gate's own neighbour is read.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const beside = new URL('./exact-revert.mjs', import.meta.url);
const { autoRevertOf } = await import(
  existsSync(fileURLToPath(beside)) ? beside.href : new URL('../exact-revert.mjs', import.meta.url).href
);

/** The file look-pr.yml writes into the parent build: the commit it built. */
export const BUILT_FROM = 'look-built-from.txt';

/**
 * `{ culprit, parent }` when `env` describes main-bisect's revert of `culprit` by every proof (autoRevertOf against
 * `base`) and the build in `dir` says it was made from `culprit^`; else `{ why }`, and the gate judges the pull request as
 * any other. `read(args)`: git's output, throwing on a failure.
 */
export function revertParent({ env, base, read, dir }) {
  const culprit = autoRevertOf(env, base, read);
  if (!culprit) return { why: "not main-bisect's proven revert: judged as any pull request" };
  let parent;
  try {
    parent = read(['rev-parse', `${culprit}^`]).trim();
  } catch {
    return { why: `the culprit ${culprit.slice(0, 10)} has no parent to read` };
  }
  const file = join(dir ?? '', BUILT_FROM);
  const built = dir && existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
  if (built !== parent)
    return {
      why: `the parent build is ${built ?? 'missing'}, not ${parent.slice(0, 10)} (${culprit.slice(0, 10)}^): judged as any pull request`,
    };
  return { culprit, parent };
}
