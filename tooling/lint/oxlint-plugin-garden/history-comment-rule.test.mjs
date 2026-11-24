// garden/no-history-comment on planted files: each kind fires in product code and names its fix, the fix drops a listed
// citation and nothing else, and constraint comments, outside links, test markers and tooling stay quiet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixText, kindOf } from './history-comment-rule.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden(no-history-comment)';

/** Lints planted files with the root config; with fix, returns the files' text after `oxlint --fix`. */
function run(files, { fix = false } = {}) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-history-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...(fix ? ['--fix'] : []), ...Object.keys(files)], {
        cwd: dir,
        encoding: 'utf8',
      });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    const texts = Object.fromEntries(Object.keys(files).map((n) => [n, readFileSync(join(dir, n), 'utf8')]));
    return { lines: out.split('\n').filter((l) => l.includes(RULE)), texts };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('each kind is named by its text', () => {
  assert.equal(kindOf(' At launch we hold no customer money (OWNER 226). '), 'private-record');
  assert.equal(kindOf(' Steps live in project-state operation-zero. '), 'private-record');
  assert.equal(kindOf(' The body limit refuses first (#6228). '), 'history');
  assert.equal(kindOf(' This formerly read the cache. '), 'history');
  assert.equal(kindOf(' A workaround until the engine is fixed. '), 'workaround');
});

test('a constraint, an outside link, a code span, a test marker and a directive are not findings', () => {
  for (const text of [
    ' The address book is never read as "ready" when it cannot be read. ',
    ' Workaround for https://github.com/oven-sh/bun/issues/1234: the socket closes early. ',
    ' Safari drops the header (vercel/next.js#51234). ',
    ' Matches `#1234` in the venue reply. ',
    ' regression: #4321 ',
    ' oxlint-disable-next-line garden/no-double-cast -- the vendor type is wrong (#5555) ',
    ' This is not a workaround: the engine requires it. ',
    ' J-agents-02 #4 and J-bank-14 #12 prove it. ',
  ])
    assert.equal(kindOf(text), null, text);
});

test('the fix drops a citation from a list or parentheses and leaves the words', () => {
  assert.equal(fixText(' holds no money (OWNER 226). '), ' holds no money. ');
  assert.equal(fixText(' wallet (J-merchant-04, launch money model, OWNER 226): it '), ' wallet (J-merchant-04, launch money model): it ');
  assert.equal(fixText(' side (OWNER 288, the honest reconcile): a break '), ' side (the honest reconcile): a break ');
  assert.equal(fixText(' book (project-state OWNER.md item 288; b2 change 3): our '), ' book (b2 change 3): our ');
  assert.equal(fixText(' tests refused (#8305, project-state #2615). '), ' tests refused. ');
  assert.equal(fixText(' The trading clear (OWNER 258 (4)): only gates '), ' The trading clear: only gates ');
  assert.equal(fixText(' (`standard`, OWNER 108: an ordinary business) '), ' (`standard`, an ordinary business) ');
});

test('the fix leaves a citation that carries the sentence to be reworded by hand', () => {
  assert.equal(fixText(' Since OWNER 258 (1) a dev process screens with the test list. '), null);
  assert.equal(fixText(' It is the first PR of two (#6517) and formerly read the cache. '), null);
});

test('in product code each kind fires and names its fix; tooling is not judged', skip, () => {
  const { lines } = run({
    'services/svc-x/src/a.ts': [
      '// At launch we hold no customer money (OWNER 226).',
      'export const a = 1;',
      '/** The body limit refuses first (#6228). */',
      'export const b = 2;',
      '// A hack until the engine answers.',
      'export const c = 3;',
      '// The address book is never read as ready when it cannot be read.',
      'export const d = 4;',
    ].join('\n'),
    'tooling/ci/b.mjs': '// Reads project-state OWNER 226 (#6228).\nexport const e = 1;\n',
  });
  assert.equal(lines.length, 3, lines.join('\n'));
  assert.ok(lines[0].includes('[private-record]') && lines[0].includes("in the code's own words"), lines[0]);
  assert.ok(lines[1].includes('[history]') && lines[1].includes('git keeps that'), lines[1]);
  assert.ok(lines[2].includes('[workaround]') && lines[2].includes('link the outside issue'), lines[2]);
  assert.ok(
    lines.every((l) => l.startsWith('services/')),
    'tooling/ is not product code',
  );
});

test('oxlint --fix rewrites only the comment and leaves the code', skip, () => {
  const file = 'packages/p/src/c.ts';
  const { texts, lines } = run(
    { [file]: '/** Own funds at each place (a venue account, a treasury wallet; OWNER 288). */\nexport const k = "OWNER 288 (#6228)";\n' },
    { fix: true },
  );
  assert.equal(
    texts[file],
    '/** Own funds at each place (a venue account, a treasury wallet). */\nexport const k = "OWNER 288 (#6228)";\n',
  );
  assert.deepEqual(lines, []);
});
