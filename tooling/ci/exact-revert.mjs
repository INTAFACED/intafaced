/**
 * EXACT REVERT: whether a pull request undoes one commit and does nothing else. No imports, so main's copy of the
 * test-diff guard can take it beside itself (ci.yml); lint-ratchet, look-drift and the kit-ceilings
 * test (judgedCopy) read autoRevertOf below, and the CI
 * review (ci-review.mjs automaticRevert) reads the same rules. Two proofs, either enough:
 *   exactReverse        the diff alone: every hunk of the commit undone, context lines included, moved together.
 *   revertTreeMatches   git: the head is exactly `git revert <commit>` made on its own parent (same tree, no conflict),
 *                       which still holds when main changed the lines around the commit since it merged (a later
 *                       merge added an import beside the commit's, so the revert's context lines read differently).
 * A line changed by hand fails both. Tests: exact-revert.test.mjs.
 */

/** Each file's hunks, keyed `old\0new`: [{ oldStart, newStart, lines }], a `\ No newline` marker kept on its line.
 *  Null when a section is binary or a file repeats. */
export function hunksOf(diff) {
  const out = new Map();
  const sections = String(diff ?? '')
    .split(/^(?=diff --git )/m)
    .filter((s) => s.startsWith('diff --git '));
  for (const s of sections) {
    if (/^Binary files |^GIT binary patch$/m.test(s)) return null;
    const path = (re) => {
      const m = re.exec(s)?.[1];
      return m === undefined || m === '/dev/null' ? null : m.replace(/^[ab]\//, '');
    };
    const head = /^diff --git a\/(.+) b\/(.+)$/m.exec(s);
    const oldPath = /^--- /m.test(s) ? path(/^--- (.+)$/m) : (head?.[1] ?? null);
    const newPath = /^\+\+\+ /m.test(s) ? path(/^\+\+\+ (.+)$/m) : (head?.[2] ?? null);
    const key = `${oldPath}\0${newPath}`;
    if (out.has(key)) return null;
    const hunks = [];
    let inHunk = false;
    for (const line of s.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) {
        hunks.push({ oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] });
        inHunk = true;
      } else if (inHunk && line.startsWith('\\')) hunks.at(-1).lines.push(`${hunks.at(-1).lines.pop() ?? ''}\n${line}`);
      else if (inHunk && /^[ +-]/.test(line)) hunks.at(-1).lines.push(line);
    }
    out.set(key, hunks);
  }
  return out;
}

/** A hunk's lines undone: + and - swapped, each run of changes written as git writes it, its - lines before its + lines. */
export function undo(lines) {
  const out = [];
  let minus = [];
  let plus = [];
  const flush = () => (out.push(...minus, ...plus), (minus = []), (plus = []));
  for (const l of lines) {
    if (l.startsWith('+')) minus.push(`-${l.slice(1)}`);
    else if (l.startsWith('-')) plus.push(`+${l.slice(1)}`);
    else {
      flush();
      out.push(l);
    }
  }
  flush();
  return out;
}

/**
 * Whether `diff` is exactly the reverse of `culpritDiff`: the same files, each with the same hunks undone, context lines
 * and order included, every hunk of a file moved by one and the same number of lines (main may have moved on above it).
 * Any binary file, or any other difference: false.
 */
export function exactReverse(diff, culpritDiff) {
  const a = hunksOf(diff);
  const b = hunksOf(culpritDiff);
  if (!a || !b || a.size === 0 || a.size !== b.size) return false;
  for (const [key, ch] of b) {
    const [oldPath, newPath] = key.split('\0');
    const rh = a.get(`${newPath}\0${oldPath}`);
    if (!rh || rh.length !== ch.length) return false;
    const shift = rh.length ? rh[0].oldStart - ch[0].newStart : 0;
    for (let i = 0; i < ch.length; i++) {
      if (rh[i].oldStart - ch[i].newStart !== shift || rh[i].newStart - ch[i].oldStart !== shift) return false;
      const want = undo(ch[i].lines);
      if (want.length !== rh[i].lines.length || want.some((l, k) => l !== rh[i].lines[k])) return false;
    }
  }
  return true;
}

/**
 * Whether commit `head` is exactly `git revert <culprit>` made on head's own parent: git's three-way merge of the
 * culprit's parent onto head's parent, with the culprit as the base (what `git revert` does), gives head's tree, with no
 * conflict. This holds when main changed the lines around the culprit since it merged, where exactReverse's diff
 * reading can't (a later merge added an import beside the culprit's, so git's revert wrote other context lines),
 * and it fails for any line changed by hand. `read(args)`: git's output, throwing on a failure (a conflict included).
 * The commits must be in the repository: head, its parent, the culprit and its parent.
 */
export function revertTreeMatches(read, { culprit, head }) {
  try {
    const parents = read(['rev-list', '--parents', '-n', '1', head]).trim().split(' ');
    const cParents = read(['rev-list', '--parents', '-n', '1', culprit]).trim().split(' ');
    if (parents.length !== 2 || cParents.length !== 2) return false;
    const tree = read(['merge-tree', '--write-tree', `--merge-base=${culprit}`, parents[1], cParents[1]])
      .trim()
      .split('\n')[0];
    return /^[0-9a-f]{40}$/.test(tree) && tree === read(['rev-parse', `${head}^{tree}`]).trim();
  } catch {
    return false;
  }
}

/** main-bisect's revert: its branch, the App that opens it, and the line its one commit carries (journeys-revert.mjs). */
export const AUTO_REVERT_BRANCH = /^revert\/auto-([0-9a-f]{10})$/;
export const AUTO_REVERT_AUTHOR = 'intafaced-mac-agents[bot]';
export const REVERTS_COMMIT = /^This reverts commit ([0-9a-f]{40})\.$/m;

/**
 * The commit this pull request reverts, when it is main-bisect's automatic revert by every proof; else null: a
 * `revert/auto-<sha10>` branch in this repository, opened by the factory App as a Bot, exactly one commit whose message
 * says it reverts the commit the branch names, that commit a non-merge main holds, and the pull request's diff exactly
 * its reverse (exactReverse, else revertTreeMatches). `pr`: { ref, author, authorType, commits, headRepo, repo, headSha };
 * `base`: main; `read(args)`: git's output, throwing on a failure.
 */
export function autoRevert(pr, base, read) {
  const branch = AUTO_REVERT_BRANCH.exec(String(pr?.ref ?? ''));
  if (!branch || pr.author !== AUTO_REVERT_AUTHOR || pr.authorType !== 'Bot' || String(pr.commits) !== '1') return null;
  if (!pr.repo || pr.headRepo !== pr.repo || !/^[0-9a-f]{40}$/.test(String(pr.headSha ?? ''))) return null;
  try {
    const culprit = REVERTS_COMMIT.exec(read(['log', '-1', '--format=%B', pr.headSha]))?.[1];
    if (!culprit || !culprit.startsWith(branch[1])) return null;
    if (read(['rev-list', '--parents', '-n', '1', culprit]).trim().split(' ').length !== 2) return null;
    read(['merge-base', '--is-ancestor', culprit, base]);
    const diff = read(['diff', '--no-renames', `${base}...${pr.headSha}`]);
    const was = read(['diff', '--no-renames', `${culprit}^`, culprit]);
    return exactReverse(diff, was) || revertTreeMatches(read, { culprit, head: pr.headSha }) ? culprit : null;
  } catch {
    return null;
  }
}

/**
 * autoRevert for the pull request CI is judging, read from the env ci.yml's Doctrine gates job sets (PR_HEAD_REF,
 * PR_AUTHOR, PR_AUTHOR_TYPE, PR_COMMITS, PR_HEAD_REPO, GITHUB_REPOSITORY, PR_HEAD_SHA); null off CI or for any other pull
 * request. The gates that compare a pull request with main (test-diff-guard, lint-ratchet, look-drift) judge a proven
 * revert of X against X^, the state it restores, so a culprit that deleted code today's rules count can still be
 * reverted (project-state#3635: intafaced #9482, the revert of #9426, failed both ratchets on the code it restored).
 */
export const autoRevertOf = (env, base, read) =>
  autoRevert(
    {
      ref: env.PR_HEAD_REF,
      author: env.PR_AUTHOR,
      authorType: env.PR_AUTHOR_TYPE,
      commits: env.PR_COMMITS,
      headRepo: env.PR_HEAD_REPO,
      repo: env.GITHUB_REPOSITORY,
      headSha: env.PR_HEAD_SHA,
    },
    base,
    read,
  );

/** `a` and `b` together, the larger at each entry: lists joined (a's order, then what only b holds), tables key by key,
 *  numbers the higher. Either missing (null or undefined): the other. */
function widest(a, b) {
  if (a == null || b == null) return a ?? b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b.filter((x) => !a.includes(x))];
  if (typeof a === 'number' && typeof b === 'number') return Math.max(a, b);
  if (typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b))
    return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, widest(a[k], b[k])]));
  return a;
}

/**
 * A committed JSON list or table that may only shrink or fall (kit-ceilings.json, or a list), as the change is
 * judged against: its copy at `fork`, where the change left main, and for main-bisect's proven revert of X (autoRevertOf)
 * widest of that and X^'s copy, the tree the revert restores. So the revert may put back what X^ held, never more, and
 * every other change is judged against main alone (project-state#3697: 13 of 18 reverts in a week closed unmerged, most
 * on these lists). A ref without the file counts as none; null when no ref holds it. `read(args)`: git's output, throwing.
 */
export function judgedCopy(path, { env, main, fork, read }) {
  const culprit = autoRevertOf(env, main, read);
  let out = null;
  for (const at of culprit ? [fork, `${culprit}^`] : [fork]) {
    let text;
    try {
      text = read(['show', `${at}:${path}`]);
    } catch (e) {
      if (/does not exist|exists on disk, but not in/u.test(String(e.stderr ?? e.message))) continue;
      throw e;
    }
    out = widest(out, JSON.parse(text));
  }
  return out;
}
