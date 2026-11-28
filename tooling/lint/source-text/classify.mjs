#!/usr/bin/env node
/**
 * The tests that read source text (`garden/no-source-text-test`), sorted one site at a time: what each test asserts
 * about the text, whether the test guards money, custody, sign-in, permissions or a journey, and the verdict recorded
 * for it in `verdicts/*.json` beside this file, with the guard that verdict names checked to exist.
 *
 * A verdict is one of:
 *   delete   the property is already guarded elsewhere; `guard` names it, and the site's test block is deleted by
 *            `--apply`. Refused for a protected test (money, custody, sign-in, permissions, a journey): those are
 *            only ever rewritten, keeping every protection.
 *   rewrite  the test is rewritten against behaviour, records or events (RECIPE.md); `guard` names the new test.
 *   rule     the read is no source text (a generator's output in a temp folder, data); `note` says why, and the
 *            rule's own test carries the case.
 * A guard is `{ kind, ref }`: `test` with `path#<words of its title>`, `lint` with a rule `.oxlintrc.json` turns on,
 * `type` with `path#<name>` (the type or symbol), `boundary` with a check name in tooling/ci/boundary-scan.mjs.
 *
 * Usage: node tooling/lint/source-text/classify.mjs [path…] [--json] [--check] [--apply]
 *   path     what to lint (default: apps, packages, services, tooling)
 *   --check  exit 1 when a site has no verdict, a guard does not exist, or a protected test would be deleted
 *   --apply  delete each `delete` site's test block (and the read, and the imports nothing uses any more), then re-lint
 * Safe to rerun: a deleted site is gone from the next run's list.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RULE = 'garden/no-source-text-test';
const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SCOPE = ['apps', 'packages', 'services', 'tooling'];

// A test of money, custody, sign-in, permissions or a journey, by its path, its titles or what it asserts.
const PROTECTED = [
  ['journey', /\.pw\.[cm]?[jt]s$|\/tests\/real-app\//],
  ['money', /\b(ledger|money|balance|posting|recipe|amount|settle|payout|withdraw|deposit|chargeback|fee)s?\b/i],
  ['custody', /\bcustod(y|ial)\b|LEDGER_CUSTODY/i],
  ['sign-in', /\b(sign[- ]?in|session|totp|passkey|password|login|auth)\b/i],
  ['permissions', /\b(permission|privileged|dual[- ]control|approval|role|admin:\w+|founder|consumePrivileged|step[- ]?up|scope)s?\b/i],
];

/** The oxlint findings of RULE, as { file, line, target } (target: the path the finding names). */
function sites(paths = SCOPE, root = ROOT) {
  const run = spawnSync(join(root, 'node_modules', '.bin', 'oxlint'), ['-c', '.oxlintrc.json', '--format', 'json', ...paths], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  let parsed;
  try {
    parsed = JSON.parse(run.stdout);
  } catch {
    throw new Error(`oxlint gave no JSON (exit ${run.status}): ${(run.stderr || '').slice(0, 400)}`);
  }
  return (parsed.diagnostics ?? [])
    .filter((d) => String(d.code ?? '').includes(RULE.split('/')[1]))
    .map((d) => ({
      file: String(d.filename).split('\\').join('/'),
      line: d.labels?.[0]?.span?.line ?? 0,
      target: /\(`([^`]*)`\)/.exec(d.message)?.[1] ?? '',
    }))
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Index of the character after the bracket closing the one at `open` (`(`, `{`, `[`), skipping strings, comments,
 *  templates and regex literals; -1 when it never closes. */
export function closeOf(text, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [];
  let prev = '';
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      i = text.indexOf('\n', i);
      if (i < 0) return -1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2) + 1;
      if (i <= 0) return -1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) {
        if (text[i] === '\\') i++;
        else if (c === '`' && text[i] === '$' && text[i + 1] === '{') {
          const e = closeOf(text, i + 1);
          if (e < 0) return -1;
          i = e - 1;
        }
      }
      prev = c;
      continue;
    }
    if (
      c === '/' &&
      (/[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || prev === '' || /\b(return|typeof|in|of)$/.test(text.slice(Math.max(0, i - 8), i).trimEnd()))
    ) {
      let cls = false;
      for (i++; i < text.length; i++) {
        if (text[i] === '\\') {
          i++;
          continue;
        }
        if (text[i] === '[') cls = true;
        else if (text[i] === ']') cls = false;
        else if (text[i] === '/' && !cls) break;
        else if (text[i] === '\n') return -1;
      }
      prev = 'r';
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i + 1;
    }
    if (!/\s/.test(c)) prev = c;
  }
  return -1;
}

const lineStart = (text, line) => {
  let at = 0;
  for (let k = 1; k < line; k++) at = text.indexOf('\n', at) + 1;
  return at;
};
const lineOf = (text, at) => text.slice(0, at).split('\n').length;
const TEST_CALL = /^[ \t]*(?:it|test)(?:\.(?:each|only|skip|concurrent|todo)(?:\s*\([^\n]*?\)\s*)?)?\s*\(/gm;

/** The test blocks of a file: { start, end, title, from, to } (character range of the whole statement, its lines). */
export function blocks(text) {
  const out = [];
  for (const m of text.matchAll(TEST_CALL)) {
    const open = m.index + m[0].length - 1;
    let end = closeOf(text, open);
    if (end < 0) continue;
    while (text[end] === '(') {
      const e = closeOf(text, end);
      if (e < 0) break;
      end = e;
    } // it.each(xs)('t', fn)
    if (text[end] === ';') end++;
    if (text[end] === '\n') end++;
    const title = /^\s*(['"`])((?:\\.|(?!\1).)*)\1/s.exec(text.slice(open + 1))?.[2] ?? '';
    out.push({ start: m.index, end, title, from: lineOf(text, m.index), to: lineOf(text, end - 1) });
  }
  return out;
}

/** The statement at module or describe level that holds `line`: { start, end, name } for a `const x = ...` read. */
function holder(text, line) {
  const at = lineStart(text, line);
  const eol = text.indexOf('\n', at);
  const decl = [
    ...text.slice(0, eol < 0 ? text.length : eol).matchAll(/^[ \t]*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=/gm),
  ].pop();
  if (!decl) return null;
  let end = decl.index + decl[0].length,
    depth = 0;
  for (; end < text.length; end++) {
    // to the `;` or newline ending the statement at depth 0
    const c = text[end];
    if ('([{'.includes(c)) {
      const e = closeOf(text, end);
      if (e < 0) return null;
      end = e - 1;
      continue;
    }
    if (
      c === ';' ||
      (c === '\n' &&
        depth === 0 &&
        !/[,(=+?:.|&>]\s*$/.test(text.slice(decl.index, end)) &&
        !/^\s*[.?:|&]/.test(text.slice(end + 1, end + 40)))
    )
      break;
  }
  if (lineOf(text, end) < line) return null;
  if (text[end] === ';') end++;
  if (text[end] === '\n') end++;
  return { start: decl.index, end, name: decl[1] };
}

/** One site's facts: the test block(s) it sits in or feeds, what they assert, and whether they are protected. */
export function facts(site, text) {
  const bs = blocks(text);
  const inner = bs.filter((b) => b.from <= site.line && site.line <= b.to).sort((a, b) => a.to - a.from - (b.to - b.from))[0];
  const h = inner ? null : holder(text, site.line);
  const fed = inner
    ? [inner]
    : h
      ? bs.filter((b) => new RegExp(`\\b${h.name.replace(/\$/g, '\\$')}\\b`).test(text.slice(b.start, b.end)))
      : [];
  const asserts = fed
    .flatMap((b) =>
      text
        .slice(b.start, b.end)
        .split('\n')
        .filter((l) => /\b(expect|assert)\b/.test(l))
        .map((l) => l.trim()),
    )
    .slice(0, 12);
  const words = [site.file, ...fed.map((b) => b.title), ...asserts, site.target].join('\n');
  const protectedAs = PROTECTED.filter(([, re]) => re.test(words)).map(([k]) => k);
  return { blocks: fed.map(({ title, from, to }) => ({ title, from, to })), holder: h?.name ?? null, asserts, protectedAs };
}

/** The verdicts on record: one entry per site, keyed by file and target. */
function verdicts(dir = join(HERE, 'verdicts')) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')).map((v) => ({ ...v, from: f })));
}
const keyOf = (v) => `${v.file}\u0000${v.target}`;

/** Why a guard does not hold, or null when it exists. read(path) returns a file's text or null. */
export function guardError(g, read) {
  if (!g || !g.kind || !g.ref) return 'no guard named';
  const [path, name] = String(g.ref).split('#');
  if (g.kind === 'lint') {
    const cfg = read('.oxlintrc.json');
    return cfg && new RegExp(`"${g.ref.replace(/[/.]/g, '\\$&')}"\\s*:\\s*"(error|warn)"`).test(cfg)
      ? null
      : `lint rule ${g.ref} is not on in .oxlintrc.json`;
  }
  if (g.kind === 'boundary') return (read('tooling/ci/boundary-scan.mjs') ?? '').includes(g.ref) ? null : `boundary-scan names no ${g.ref}`;
  const text = read(path);
  if (text == null) return `${path} does not exist`;
  if (!name) return g.kind === 'test' ? `${g.ref} names no test title (path#title)` : null;
  if (g.kind === 'test') return blocks(text).some((b) => b.title.includes(name)) ? null : `${path} has no test titled "${name}"`;
  if (g.kind === 'type') return new RegExp(`\\b${name}\\b`).test(text) ? null : `${path} has no ${name}`;
  return `unknown guard kind ${g.kind}`;
}

/** Each site with its facts and verdict, and the problems --check refuses. */
export function classify(list, read, vs) {
  const byKey = new Map(vs.map((v) => [keyOf(v), v]));
  return list.map((s) => {
    const text = read(s.file) ?? '';
    const f = facts(s, text);
    const v = byKey.get(keyOf(s)) ?? null;
    const problems = [];
    if (!v) problems.push('no verdict on record');
    else if (!['delete', 'rewrite', 'rule'].includes(v.verdict)) problems.push(`unknown verdict ${v.verdict}`);
    else if (v.verdict === 'delete') {
      if (f.protectedAs.length) problems.push(`a ${f.protectedAs.join(', ')} test is never deleted, only rewritten`);
      const e = guardError(v.guard, read);
      if (e) problems.push(e);
      if (!f.blocks.length) problems.push('no test block found to delete');
    }
    return { ...s, ...f, verdict: v?.verdict ?? null, guard: v?.guard ?? null, why: v?.why ?? null, problems };
  });
}

/** Delete the `delete` sites' blocks from one file's text: each test block the read sits in or feeds, the module-level
 *  read itself, and the named imports nothing in the file uses any more. Returns the new text, or null when no test is
 *  left in it (the file goes). */
export function applyDeletes(text, rows) {
  const cuts = [];
  for (const r of rows) {
    const bs = blocks(text).filter((b) => r.blocks.some((x) => x.from === b.from && x.title === b.title));
    cuts.push(...bs.map((b) => [b.start, b.end]));
    if (r.holder) {
      const h = holder(text, r.line);
      if (h) cuts.push([h.start, h.end]);
    }
  }
  const merged = [...new Map(cuts.map((c) => [c.join(), c])).values()].sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [a, b] of merged) out = out.slice(0, a) + out.slice(b);
  out = out.replace(/\n{3,}/g, '\n\n');
  if (!blocks(out).length) return null;
  return pruneImports(out);
}

/** Drop the named imports a file no longer uses (and an import left with none). A use after a member dot (`a.X`) is
 *  not a use; one after a spread (`...X`) is. */
export function pruneImports(text) {
  return text.replace(/^import\s+(type\s+)?\{([^}]*)\}\s+from\s+(['"][^'"]+['"]);?[ \t]*\n/gm, (all, type, names, from) => {
    const body = text.replace(all, '');
    const keep = names
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean)
      .filter((n) => {
        const local = n
          .split(/\s+as\s+/)
          .pop()
          .replace(/^type\s+/, '');
        return new RegExp(`(?<![\\w$])(?<!(?<!\\.\\.)\\.)${local.replace(/\$/g, '\\$')}(?![\\w$])`).test(body);
      });
    return keep.length ? `import ${type ?? ''}{ ${keep.join(', ')} } from ${from};\n` : '';
  });
}

function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const paths = argv.filter((a) => !a.startsWith('--'));
  const read = (p) => {
    try {
      return readFileSync(join(ROOT, p), 'utf8');
    } catch {
      return null;
    }
  };
  const rows = classify(sites(paths.length ? paths : SCOPE), read, verdicts());
  if (flags.has('--apply')) {
    const byFile = Map.groupBy(
      rows.filter((r) => r.verdict === 'delete' && !r.problems.length),
      (r) => r.file,
    );
    for (const [file, rs] of byFile) {
      const next = applyDeletes(read(file), rs);
      if (next == null) rmSync(join(ROOT, file));
      else {
        writeFileSync(join(ROOT, file), next);
        spawnSync(join(ROOT, 'node_modules', '.bin', 'prettier'), ['--write', '--log-level', 'warn', file], {
          cwd: ROOT,
          stdio: 'inherit',
        });
      }
      console.log(
        `${next == null ? 'deleted file' : 'deleted'} ${file}: ${rs.map((r) => `${r.target} (guard ${r.guard.kind} ${r.guard.ref})`).join('; ')}`,
      );
    }
    const left = sites(paths.length ? paths : SCOPE);
    console.log(`sites left: ${left.length}`);
    return 0;
  }
  if (flags.has('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    const n = (v) => rows.filter((r) => r.verdict === v).length;
    console.log(
      `${rows.length} sites: ${n('delete')} delete, ${n('rewrite')} rewrite, ${n('rule')} rule, ${n(null)} without a verdict; ${rows.filter((r) => r.protectedAs.length).length} protected`,
    );
    for (const r of rows)
      console.log(
        `${r.file}:${r.line} ${r.target} [${r.verdict ?? '-'}${r.protectedAs.length ? `, ${r.protectedAs.join('/')}` : ''}]${r.guard ? ` guard ${r.guard.kind} ${r.guard.ref}` : ''}${r.problems.length ? `  !! ${r.problems.join('; ')}` : ''}`,
      );
  }
  return flags.has('--check') && rows.some((r) => r.problems.length) ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
