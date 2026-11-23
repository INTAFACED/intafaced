// A string a regex accepts, written from the regex itself: for a field whose pattern none of the samples step's stock
// strings match (`/^announcement:[0-9a-f]{16,64}$/`, a business key with its own prefix). It reads the plain part of the
// regex language (literals, escapes, classes, groups, `|`, and the quantifiers) and writes the shortest string each part
// asks for: the first branch of a `|`, the first member of a class, the least a quantifier allows. Anything else (a
// lookaround, a backreference, a named group's reference) gives undefined. The result is a guess: samples.mjs keeps it
// only when the real pattern accepts it, so a wrong one is dropped, never written.

const ESCAPES = { d: '0', w: 'a', s: ' ', t: '\t', n: '\n', r: '\r' };
/** Tried, in order, for a class this can't read a member from (a negated one, or one of escapes only). */
const FILL = ['a', '0', 'A', '-', '_', '.', '/', ' ', '~'];

class Reader {
  constructor(source) {
    this.src = source;
    this.at = 0;
  }
  peek() {
    return this.src[this.at];
  }
  take() {
    return this.src[this.at++];
  }
}

/** One member of the class starting after `[`, or undefined when none can be found. */
function fromClass(r) {
  const start = r.at - 1;
  if (r.peek() === '^') r.take();
  // To the closing `]`; an escaped one is a member.
  for (;;) {
    const c = r.take();
    if (c === undefined) return undefined;
    if (c === '\\') r.take();
    else if (c === ']') break;
  }
  const cls = r.src.slice(start, r.at);
  let re;
  try {
    re = new RegExp(`^${cls}$`, 'u');
  } catch {
    return undefined;
  }
  const body = cls.slice(1, -1);
  const tries = [];
  if (!body.startsWith('^')) {
    // A range's first end, or a plain member, as written.
    const m = /^(?:\\(.)|([^\\]))/u.exec(body);
    if (m?.[2]) tries.push(m[2]);
    else if (m?.[1]) tries.push(ESCAPES[m[1]] ?? m[1]);
  }
  return [...tries, ...FILL].find((c) => re.test(c));
}

/** `{m}`, `{m,}`, `{m,n}`, `*`, `+` or `?` after an atom: the least times it must repeat (lazy `?` after it skipped). */
function least(r) {
  const c = r.peek();
  let n = 1;
  if (c === '*' || c === '?') n = 0;
  else if (c === '{') {
    const m = /^\{(\d+)(?:,\d*)?\}/.exec(r.src.slice(r.at));
    if (!m) return 1;
    r.at += m[0].length - 1;
    n = Number(m[1]);
  } else if (c !== '+') return 1;
  r.take();
  if (r.peek() === '?') r.take();
  return n;
}

/** The first branch of an alternation, up to its `)` or the end; the other branches are skipped unread. */
function branch(r, depth) {
  let out = '';
  while (r.at < r.src.length) {
    const c = r.take();
    let atom;
    if (c === ')') {
      if (depth === 0) return undefined;
      r.at--;
      return out;
    }
    if (c === '|') {
      // The rest of this group is its other branches.
      for (let open = 0; r.at < r.src.length;) {
        const d = r.peek();
        if (d === '\\') r.at += 2;
        else if (d === '[') {
          r.take();
          fromClass(r);
        } else if (d === ')' && open === 0) break;
        else {
          if (d === '(') open++;
          if (d === ')') open--;
          r.take();
        }
      }
      return out;
    }
    if (c === '^' || c === '$') continue;
    if (c === '\\') {
      const e = r.take();
      if (e === undefined || /[1-9kbBpPuxc]/.test(e)) return undefined;
      atom = ESCAPES[e] ?? (/[DWS]/.test(e) ? undefined : e);
      if (atom === undefined) return undefined;
    } else if (c === '[') {
      atom = fromClass(r);
      if (atom === undefined) return undefined;
    } else if (c === '(') {
      if (r.peek() === '?') {
        r.take();
        const kind = r.take();
        // Only a plain non-capturing group: a lookaround or a named group is not read.
        if (kind !== ':') return undefined;
      }
      atom = branch(r, depth + 1);
      if (atom === undefined || r.take() !== ')') return undefined;
    } else if (c === '.') atom = 'a';
    else if (/[*+?{]/.test(c)) return undefined;
    else atom = c;
    out += atom.repeat(least(r));
  }
  return depth === 0 ? out : undefined;
}

/** A string `source` (a regex's source) may accept, or undefined when it holds something this does not read. */
export function fromPattern(source) {
  try {
    return branch(new Reader(source), 0);
  } catch {
    return undefined;
  }
}
