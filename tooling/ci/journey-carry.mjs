/**
 * A push that changes no code a journeys run executes carries the journeys run of the head before it (INTAFACED/intafaced
 * #11076, filed by the owner on 27 Nov 2026: "A push that changes no code reruns no journeys. A later push doesn't cancel
 * a run whose result the PR still needs."). An earlier commit of a pull request is the head's equal for journeys when
 * the head holds it and every file changed since is one no journeys run reads (journey-touch.mjs pathKind `none`: a unit
 * test, an agent doc, a factory script) or a JavaScript or TypeScript file whose change is only to its comments and
 * the blank space between its tokens (stripComments). A journeys run on such a commit ran the same code as the head, so
 * the seal reads it as a run on the head (journey-seal.mjs sealPull), the head's own run leaves out what it covers
 * (journey-touch.mjs --reuse), and the push no longer cancels it (real-app-journeys.yml's concurrency and the touch
 * job's "Stop this pull request's superseded runs"). Anything this can't read for certain counts as code: the head then
 * runs its journeys as before. (Failure it prevents: in the 200 pull request runs from 25 Nov 10:12 to 27 Nov 09:44
 * UTC, 36 were cancelled by the next push; on fix/11043, runs 45952021415 and 45963553721 stopped after 8 and 12
 * minutes for a change to .github/workflows/hl-faucet-activate.yml alone, which no journeys run reads, and ran again.)
 */
import { pathKind } from './journey-touch.mjs';

/** The files whose comments stripComments can tell from code. Not .tsx or .jsx: JSX text is words the app shows. */
export const COMMENT_CODE = /\.(?:[cm]?[jt]s)$/;

/** At most this many earlier commits are read back from the head, and this many code files compared per commit. */
export const CARRY_COMMITS = 10;
export const CARRY_CODE_FILES = 20;

/** GitHub's compare lists at most 300 files: a comparison that reaches it may hold more, so it carries nothing. */
export const COMPARE_FILES_MAX = 300;

const KEYWORDS_BEFORE_REGEX = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);
const WORD = /[A-Za-z0-9_$#]/;

/**
 * JavaScript or TypeScript text with its comments taken out and each run of blank space written as one space, or one
 * newline when it holds a line break (a line break can end a statement, so it stays), or null when the text can't be
 * read for certain: an unclosed string, template or comment, or a `/` after `)`, `}`, `]`, `++` or `--` (division or
 * a regular expression) on a line that also holds a `/` or a quote. Two texts whose results are equal differ only in
 * comments and blank space. Strings, templates and regular expressions are kept exactly. Pure.
 */
export function stripComments(text) {
  const s = String(text);
  let out = '';
  let pendingSpace = ''; // '', ' ' or '\n': blank space (or a comment) since the last token
  let prev = ''; // the last token's kind: '' (start), 'word:<w>', 'value' (string, template, regex, number), or the punctuator
  const stack = []; // open template substitutions: the brace depth at which each `${` closes
  let depth = 0;
  const flush = () => {
    if (out && pendingSpace) out += pendingSpace;
    pendingSpace = '';
  };
  const space = (nl) => {
    if (nl) pendingSpace = '\n';
    else if (!pendingSpace) pendingSpace = ' ';
  };
  const lineRest = (i) => {
    const e = s.indexOf('\n', i);
    return s.slice(i, e < 0 ? s.length : e);
  };
  // A template's text from `i` (just past a backtick or a `}` that closes a substitution): kept exactly. Returns the index
  // after the closing backtick, or after `${` (with the substitution pushed), or -1 when it never closes.
  const template = (i) => {
    let j = i;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\') j += 2;
      else if (c === '`') {
        out += s.slice(i, j + 1);
        prev = 'value';
        return j + 1;
      } else if (c === '$' && s[j + 1] === '{') {
        out += s.slice(i, j + 2);
        stack.push(depth);
        depth++;
        prev = '{';
        return j + 2;
      } else j++;
    }
    return -1;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const n = s[i + 1];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') {
      space(false);
      i++;
    } else if (c === '\n' || c === '\u2028' || c === '\u2029') {
      space(true);
      i++;
    } else if (c === '/' && n === '/') {
      const e = s.indexOf('\n', i);
      i = e < 0 ? s.length : e;
      space(false);
    } else if (c === '/' && n === '*') {
      const e = s.indexOf('*/', i + 2);
      if (e < 0) return null;
      space(/[\n\u2028\u2029]/.test(s.slice(i + 2, e)));
      i = e + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== c) {
        if (s[j] === '\n') return null;
        j += s[j] === '\\' ? 2 : 1;
      }
      if (j >= s.length) return null;
      flush();
      out += s.slice(i, j + 1);
      prev = 'value';
      i = j + 1;
    } else if (c === '`') {
      flush();
      out += '`';
      i = template(i + 1);
      if (i < 0) return null;
    } else if (c === '/') {
      const p = prev;
      const regex =
        p === '' ||
        (p.startsWith('word:') ? KEYWORDS_BEFORE_REGEX.has(p.slice(5)) : p !== 'value' && !/^[)\]}]$/.test(p) && p !== '++' && p !== '--');
      const unsure = p === ')' || p === '}' || p === ']' || p === '++' || p === '--';
      if (unsure && /[/'"`]/.test(lineRest(i + 1))) return null;
      flush();
      if (regex) {
        let j = i + 1;
        let cls = false;
        for (; j < s.length; j++) {
          const r = s[j];
          if (r === '\n') return null;
          if (r === '\\') j++;
          else if (r === '[') cls = true;
          else if (r === ']') cls = false;
          else if (r === '/' && !cls) break;
        }
        if (j >= s.length) return null;
        j++;
        while (j < s.length && /[a-z]/.test(s[j])) j++;
        out += s.slice(i, j);
        prev = 'value';
        i = j;
      } else {
        out += '/';
        prev = '/';
        i++;
      }
    } else if (WORD.test(c)) {
      let j = i;
      while (j < s.length && WORD.test(s[j])) j++;
      flush();
      const w = s.slice(i, j);
      out += w;
      prev = /^[0-9]/.test(w) ? 'value' : `word:${w}`;
      i = j;
    } else if (c === '}' && stack.length && depth - 1 === stack[stack.length - 1]) {
      flush();
      stack.pop();
      depth--;
      out += '}';
      i = template(i + 1);
      if (i < 0) return null;
    } else {
      flush();
      if (c === '{') depth++;
      else if (c === '}') depth--;
      out += c;
      prev = (c === '+' || c === '-') && n === c ? c + c : c;
      if (prev.length === 2) {
        out += n;
        i += 2;
      } else i++;
    }
  }
  if (stack.length) return null;
  return out;
}

/** Whether a changed path's own kind says no journeys run reads it (journey-touch.mjs pathKind `none`). */
const runsNone = (p) => pathKind(p).kind === 'none';

/**
 * Whether the files changed from an earlier commit to the head (`files`: GitHub's compare list, each { filename,
 * status, previous_filename }) leave every journey as it was: each is one no journeys run reads (runsNone), or a
 * modified JavaScript or TypeScript file whose two texts (`text(path, ref)`, null when missing) differ only in comments
 * and blank space (stripComments). At most CARRY_CODE_FILES are read. Returns { quiet, why }.
 */
export async function quietDelta({ files, before, after, text }) {
  if (!Array.isArray(files)) return { quiet: false, why: 'its changed files could not be read' };
  if (files.length >= COMPARE_FILES_MAX) return { quiet: false, why: `GitHub lists ${files.length} changed files, perhaps not all` };
  let read = 0;
  let comments = 0;
  for (const f of files) {
    const p = String(f?.filename ?? '');
    const was = f?.previous_filename ? String(f.previous_filename) : null;
    if (!p) return { quiet: false, why: 'a changed file has no name' };
    if (runsNone(p) && (!was || runsNone(was))) continue;
    if (f?.status !== 'modified' || was || !COMMENT_CODE.test(p)) return { quiet: false, why: `${p} is code a journeys run may run` };
    if (++read > CARRY_CODE_FILES) return { quiet: false, why: `more than ${CARRY_CODE_FILES} code files changed` };
    let a;
    let b;
    try {
      [a, b] = await Promise.all([text(p, before), text(p, after)]);
    } catch (e) {
      return { quiet: false, why: `${p} could not be read (${String(e?.message ?? e).slice(0, 120)})` };
    }
    if (typeof a !== 'string' || typeof b !== 'string') return { quiet: false, why: `${p} could not be read at both commits` };
    const x = stripComments(a);
    const y = stripComments(b);
    if (x === null || y === null) return { quiet: false, why: `${p}'s comments could not be told from its code for certain` };
    if (x !== y) return { quiet: false, why: `${p} changes code, not only its comments` };
    comments++;
  }
  return {
    quiet: true,
    why: `${files.length} changed file(s), none a journeys run executes${comments ? ` (${comments} with only comments or blank space changed)` : ''}`,
  };
}

/**
 * The earlier commits of a pull request whose journeys runs count for its head (quietDelta), newest first, read back
 * from the head through `commits` (the pull request's commit shas, oldest first, as GitHub lists them) and stopping at
 * the first that is not, or after CARRY_COMMITS. `compare(base, head)`: GitHub's compare; the head must hold the commit
 * (status `ahead`). `text(path, ref)`: a file's text at a commit, null when missing. Returns { heads: [sha], lines }.
 * Any read that fails ends the walk there: the commits found so far still count, and none past it.
 */
export async function carriedHeads({ head, commits, compare, text }) {
  // Only the commits before the head in the list: a run on a head a later push has passed reads back from itself.
  const all = [...new Set((commits ?? []).map(String))];
  const at = all.indexOf(head);
  const shas = (at >= 0 ? all.slice(0, at) : all).filter((c) => /^[0-9a-f]{40}$/.test(c));
  const heads = [];
  const lines = [];
  for (const c of shas.reverse().slice(0, CARRY_COMMITS)) {
    let cmp;
    try {
      cmp = await compare(c, head);
    } catch (e) {
      lines.push(`${c.slice(0, 10)}: its comparison with the head could not be read (${String(e?.message ?? e).slice(0, 120)})`);
      break;
    }
    if (cmp?.status !== 'ahead') {
      lines.push(`${c.slice(0, 10)}: the head does not hold it (${cmp?.status ?? 'unknown'})`);
      break;
    }
    const q = await quietDelta({ files: cmp.files, before: c, after: head, text });
    if (!q.quiet) {
      lines.push(`${c.slice(0, 10)}: ${q.why}, so its journeys runs do not count for the head`);
      break;
    }
    heads.push(c);
    lines.push(`${c.slice(0, 10)}: ${q.why}, so its journeys runs count for the head`);
  }
  return { heads, lines };
}

/**
 * The journeys runs a pull request's run on `head` stops: this pull request's own runs of the workflow (event
 * pull_request, this repository's, on its branch `branch`) still going on a commit that is neither the head nor one whose
 * runs count for it (`carried`), started before this run (`self`). Run on the pull request's current head only, so a
 * run on an older head never stops a newer one. Pure. Returns [run id].
 */
export function supersededRuns(runs, { head, carried = [], self, repo, branch, workflow = '.github/workflows/real-app-journeys.yml' }) {
  const keep = new Set([head, ...carried]);
  return (runs ?? [])
    .filter(
      (r) =>
        r?.event === 'pull_request' &&
        r?.path === workflow &&
        r?.head_branch === branch &&
        r?.repository?.full_name === repo &&
        r?.head_repository?.full_name === repo &&
        r?.status !== 'completed' &&
        !keep.has(r?.head_sha) &&
        Number(r?.id) < Number(self),
    )
    .map((r) => r.id);
}
