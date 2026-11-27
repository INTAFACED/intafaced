import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { CARRY_CODE_FILES, carriedHeads, quietDelta, stripComments, supersededRuns } from './journey-carry.mjs';

const same = (a, b) => stripComments(a) !== null && stripComments(a) === stripComments(b);

test('stripComments: a change to comments or blank space alone reads as the same code', () => {
  assert.ok(same('const a = 1; // one\n', 'const a = 1; // uno\n'));
  assert.ok(same('/** doc */\nexport function f() { return 1 }', '/** new doc\n * more */\nexport function f() { return 1 }'));
  assert.ok(same('const t = `a${ x /* c */ }b`;', 'const t = `a${ x /* d */ }b`;'));
  assert.ok(same('a = b / c / d; // c', 'a = b / c / d; // d'));
  assert.ok(same('f(a,  b)', 'f(a, b)'));
});

test('stripComments: any change to code, a string, a template or a regular expression reads as code', () => {
  assert.ok(!same('const a = 1;\n', 'const a = 2;\n'));
  assert.ok(!same('const u = `https://a`;\n', 'const u = `https://b`;\n'));
  assert.ok(!same('const u = "https://a";', 'const u = "https://b";'));
  assert.ok(!same("const u = 'a /* b */ c';", "const u = 'a /* d */ c';"));
  assert.ok(!same('const r = /\\/\\/a/; // x', 'const r = /\\/\\/b/; // x'));
  assert.ok(!same('const r = /[/]a/;', 'const r = /[/]b/;'));
  assert.ok(!same('const t = `a${ {b:1}.b }c // words`;', 'const t = `a${ {b:1}.b }c // changed`;'));
  // A comment that held a line break can end a statement (`return` then a line break returns undefined).
  assert.ok(!same('return /*\n*/ x', 'return /* */ x'));
  assert.ok(!same('a\n(b)', 'a (b)'));
});

test("stripComments: what it can't read for certain is null, never a guess", () => {
  // `/` after `)` is division or a regular expression; with another `/` or a quote on its line it can't tell.
  assert.equal(stripComments('if (x) /re/.test(y) // c'), null);
  assert.equal(stripComments('const s = "open'), null);
  assert.equal(stripComments('const t = `open'), null);
  assert.equal(stripComments('/* open'), null);
  assert.equal(stripComments('const r = /open\n'), null);
});

test("stripComments: no change to any token of this repository's own code goes unseen", () => {
  // Every identifier and string in the carry and journey-touch.mjs, each changed in turn, changes the result.
  for (const f of ['tooling/ci/journey-carry.mjs', 'tooling/ci/journey-touch.mjs']) {
    const text = readFileSync(f, 'utf8');
    const base = stripComments(text);
    assert.notEqual(base, null, f);
    let n = 0;
    for (const m of text.matchAll(/(?<![A-Za-z0-9_$])[A-Za-z_$][A-Za-z0-9_$]*|'[^'\n\\]{1,20}'/g)) {
      if (n++ > 400) break;
      const at = m.index + (m[0].startsWith("'") ? 1 : 0);
      const changed = text.slice(0, at) + 'Q' + text.slice(at);
      // Inside a comment the change is no code change; elsewhere it must show.
      const inComment = stripComments(changed) === base;
      if (inComment) {
        const line = text.slice(text.lastIndexOf('\n', m.index) + 1, m.index);
        assert.ok(
          /\/\/|^\s*\*|\/\*/.test(line),
          `${f}: ${JSON.stringify(m[0])} at ${m.index} read as a comment in ${JSON.stringify(line)}`,
        );
      }
    }
  }
});

const text = (files) => async (p, ref) => files[`${ref}:${p}`] ?? null;

test('quietDelta: files no journeys run reads, and code with only its comments changed, are quiet', async () => {
  const files = [
    { filename: 'services/svc-bank/src/accounts.test.ts', status: 'modified' },
    { filename: '.github/workflows/hl-faucet-activate.yml', status: 'modified' },
    { filename: 'services/svc-bank/src/accounts.ts', status: 'modified' },
  ];
  const got = await quietDelta({
    files,
    before: 'a',
    after: 'b',
    text: text({ 'a:services/svc-bank/src/accounts.ts': 'x(); // old\n', 'b:services/svc-bank/src/accounts.ts': 'x(); // new words\n' }),
  });
  assert.equal(got.quiet, true, got.why);
});

test('quietDelta: product code, a rename, a new file, JSX, an unreadable file or too many files are not quiet', async () => {
  const t = text({ 'a:p.ts': 'x(1)', 'b:p.ts': 'x(2)' });
  const not = async (files, tx = t) => (await quietDelta({ files, before: 'a', after: 'b', text: tx })).quiet;
  assert.equal(await not([{ filename: 'p.ts', status: 'modified' }]), false);
  assert.equal(await not([{ filename: 'services/svc-bank/src/a.ts', status: 'added' }]), false);
  assert.equal(
    await not([{ filename: 'services/svc-bank/src/b.ts', previous_filename: 'services/svc-bank/src/a.ts', status: 'renamed' }]),
    false,
  );
  assert.equal(await not([{ filename: 'apps/customer/src/A.tsx', status: 'modified' }], async () => '<a>// x</a>'), false);
  assert.equal(await not([{ filename: 'services/svc-bank/src/a.ts', status: 'modified' }], async () => null), false);
  const many = Array.from({ length: CARRY_CODE_FILES + 1 }, (_, i) => ({ filename: `services/svc-bank/src/f${i}.ts`, status: 'modified' }));
  assert.equal(await not(many, async () => 'x(); // same'), false);
  assert.equal(await not(Array.from({ length: 300 }, (_, i) => ({ filename: `AGENTS${i}.md`, status: 'modified' }))), false);
  assert.equal(await not(null), false);
  // A doc the journeys run reads (DOCS_READ) and the journeys workflow itself are not quiet.
  assert.equal(await not([{ filename: 'docs/runbooks/journey-baseline.json', status: 'modified' }]), false);
  assert.equal(await not([{ filename: '.github/workflows/real-app-journeys.yml', status: 'modified' }]), false);
});

const sha = (c) => c.repeat(40);

test('carriedHeads: reads back from the head and stops at the first commit that changed code', async () => {
  const [a, b, c, h] = ['a', 'b', 'c', 'd'].map(sha);
  const files = {
    [c]: [{ filename: 'AGENTS.md', status: 'modified' }],
    [b]: [{ filename: 'services/svc-bank/src/a.test.ts', status: 'modified' }],
    [a]: [{ filename: 'services/svc-bank/src/a.ts', status: 'modified' }],
  };
  const got = await carriedHeads({
    head: h,
    commits: [a, b, c, h],
    compare: async (base) => ({ status: 'ahead', files: files[base] }),
    text: async (_, ref) => (ref === a ? 'x(1)' : 'x(2)'),
  });
  assert.deepEqual(got.heads, [c, b]);
  assert.match(got.lines.at(-1), /services\/svc-bank\/src\/a\.ts changes code, not only its comments/);
});

test('carriedHeads: on a head a later push has passed, it reads back from that head, past none of the later commits', async () => {
  const [a, b, h] = ['a', 'b', 'c'].map(sha);
  const asked = [];
  const got = await carriedHeads({
    head: b,
    commits: [a, b, h],
    compare: async (base) => (asked.push(base), { status: 'ahead', files: [{ filename: 'AGENTS.md', status: 'modified' }] }),
    text: async () => null,
  });
  assert.deepEqual(got.heads, [a]);
  assert.deepEqual(asked, [a]);
});

test("carriedHeads: a commit the head doesn't hold, or a comparison that can't be read, carries nothing past it", async () => {
  const [a, h] = ['a', 'd'].map(sha);
  assert.deepEqual(
    (await carriedHeads({ head: h, commits: [a, h], compare: async () => ({ status: 'diverged', files: [] }), text: async () => null }))
      .heads,
    [],
  );
  const boom = await carriedHeads({
    head: h,
    commits: [a, h],
    compare: async () => {
      throw new Error('HTTP 502');
    },
    text: async () => null,
  });
  assert.deepEqual(boom.heads, []);
  assert.match(boom.lines[0], /could not be read/);
});

test("supersededRuns: stops this pull request's runs still going on another commit, never one the head carries", () => {
  const repo = 'INTAFACED/intafaced';
  const base = {
    event: 'pull_request',
    path: '.github/workflows/real-app-journeys.yml',
    head_branch: 'b1',
    repository: { full_name: repo },
    head_repository: { full_name: repo },
  };
  const runs = [
    { ...base, id: 1, head_sha: sha('a'), status: 'in_progress' },
    { ...base, id: 2, head_sha: sha('b'), status: 'queued' },
    { ...base, id: 3, head_sha: sha('c'), status: 'completed' },
    { ...base, id: 4, head_sha: sha('d'), status: 'in_progress' },
    { ...base, id: 5, head_sha: sha('a'), status: 'in_progress', head_branch: 'other' },
    { ...base, id: 6, head_sha: sha('a'), status: 'in_progress', event: 'workflow_dispatch' },
    { ...base, id: 9, head_sha: sha('a'), status: 'queued' },
  ];
  assert.deepEqual(supersededRuns(runs, { head: sha('d'), carried: [sha('b')], self: 8, repo, branch: 'b1' }), [1]);
});

test('the touch job and the seal read the same carried commits (journey-touch.mjs --carried, journey-seal.mjs sealPull)', () => {
  const seal = readFileSync('tooling/ci/journey-seal.mjs', 'utf8');
  const touch = readFileSync('tooling/ci/journey-touch.mjs', 'utf8');
  assert.match(seal, /carriedHeads\(\{ head, commits: await io\.prCommits\(number\), compare: io\.compare, text \}\)/);
  assert.match(touch, /carriedHeads\(\{ head: sha, commits, compare:/);
  assert.match(readFileSync('.github/workflows/real-app-journeys.yml', 'utf8'), /journey-touch\.mjs" --carried/);
});
