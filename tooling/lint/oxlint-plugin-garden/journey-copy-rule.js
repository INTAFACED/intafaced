// garden/no-copied-journey-function: a journey spec never holds a copy of a function another journey file already has.
// Journey specs grew by copy and paste: on main at f8cfd166fa, 541 top-level functions in apps/customer/tests/real-app/*.pw.mjs
// were word-for-word copies of one in another spec (178 groups, 4,267 lines), and ten files copied one retry loop before
// garden/no-action-in-retry stopped it. A fix to a set-up step then has to land in every copy, and a missed copy keeps the bug.
// A function is the same when its whole text, comments and `export` dropped and whitespace collapsed, matches a multi-line
// top-level function (`function f(`, `async function f(`, `const f = (…) => {`) in another `.mjs` file directly in that folder.
// Judged by the lint ratchet: a new copy fails, the copies on main are the baseline and fold into helpers only when their file
// is rewritten for another reason (a rewrite would void the steps those files prove). The ratchet lints a tree holding only
// the touched files, so it names the checkout to compare against in GARDEN_TREE; without it, the linted file's own folder is.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'apps/customer/tests/real-app/';
const SPEC = /(?:^|\/)(apps\/customer\/tests\/real-app\/[^/]+\.pw\.mjs)$/u;
const START = /^(export\s+)?(?:(?:async\s+)?function\*?\s+([\w$]+)\s*\(|const\s+([\w$]+)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{\s*$)/u;

const blankComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//gu, (m) => m.replace(/[^\n]/gu, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/gu, '$1');

/** The multi-line top-level functions of one file: { name, exported, line (1-based), key }. A function ends at the first
 * later line that starts with `}`, as the repo's formatter writes a top-level body. */
export function topFunctions(text) {
  const lines = blankComments(text).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = START.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('}') && !START.test(lines[j])) j++;
    if (j >= lines.length || !lines[j].startsWith('}')) continue;
    const key = lines
      .slice(i, j + 1)
      .join('\n')
      .replace(/^export\s+/u, '')
      .replace(/\s+/gu, ' ')
      .trim();
    out.push({ name: m[2] ?? m[3], exported: !!m[1], line: i + 1, key });
    i = j;
  }
  return out;
}

const indexes = new Map();
/** key → [{ file, name, exported, helper }] over every `.mjs` file directly in the journey folder under `root`. */
function indexOf(root) {
  let index = indexes.get(root);
  if (index) return index;
  index = new Map();
  let names = [];
  try {
    names = readdirSync(join(root, DIR)).filter((f) => f.endsWith('.mjs'));
  } catch {
    names = [];
  }
  for (const f of names) {
    let text;
    try {
      text = readFileSync(join(root, DIR, f), 'utf8');
    } catch {
      continue;
    }
    const helper = !/\.(?:pw|test|spec|config)\.mjs$/u.test(f);
    for (const fn of topFunctions(text)) {
      const list = index.get(fn.key) ?? [];
      list.push({ file: f, name: fn.name, exported: fn.exported, helper });
      index.set(fn.key, list);
    }
  }
  indexes.set(root, index);
  return index;
}

const noCopiedJourneyFunction = {
  meta: {
    type: 'problem',
    docs: { description: 'A journey spec imports a shared function; it never copies one from another journey file.' },
  },
  create(context) {
    const file = String(context.filename ?? context.getFilename())
      .split('\\')
      .join('/');
    const m = SPEC.exec(file);
    if (!m) return {};
    const rel = m[1];
    const own = rel.slice(DIR.length);
    const root = process.env.GARDEN_TREE || file.slice(0, file.length - rel.length) || '.';
    return {
      Program(node) {
        const text = context.sourceCode?.text ?? context.getSourceCode().text;
        const index = indexOf(root);
        for (const fn of topFunctions(text)) {
          const others = (index.get(fn.key) ?? []).filter((o) => o.file !== own);
          if (!others.length) continue;
          const shared = others.find((o) => o.helper && o.exported);
          const fix = shared
            ? `import { ${shared.name} } from './${shared.file}' instead`
            : `move it into a journey helper module in ${DIR} (export it there, beside the helpers this folder already has) and ` +
              'import it here; a proven file that already holds a copy keeps it until it is rewritten for another reason';
          const where = others
            .slice(0, 3)
            .map((o) => `${o.file} (${o.name})`)
            .join(', ');
          const more = others.length > 3 ? ` and ${others.length - 3} more` : '';
          context.report({
            node,
            loc: { start: { line: fn.line, column: 0 }, end: { line: fn.line, column: 1 } },
            message: `\`${fn.name}\` is a copy of a function in ${where}${more}: ${fix}`,
          });
        }
      },
    };
  },
};

export const journeyCopyRules = { 'no-copied-journey-function': noCopiedJourneyFunction };
