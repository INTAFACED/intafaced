/**
 * EXACT REVERT: whether a pull request undoes one commit and does nothing else. No imports, so main's copy of the
 * test-diff guard can take it beside itself (ci.yml), and the CI review (ci-review.mjs automaticRevert) reads the same
 * rules. Two proofs, either enough:
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
