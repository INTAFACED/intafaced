// The call-records codemod's own pieces, on small inputs (the codemod itself is proven by its runs: run.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { answerChecks, Changes, pruneImports, recordName, rewriteSite } from './index.mjs';
import { applyEdits, freeNames, load, text } from './ast.mjs';
import { findSites } from './sites.mjs';
import { CALL_METHOD, doublesIn } from './doubles.mjs';

test('a record is named by its module and path, a leading segment that repeats the module dropped', () => {
  assert.equal(recordName('bank', 'deposits.addresses.list'), 'BANK_DEPOSITS_ADDRESSES_LIST');
  assert.equal(recordName('notify', 'notify.unreadCount'), 'NOTIFY_UNREAD_COUNT');
  assert.equal(recordName('notify', 'statusPage.templates.define'), 'NOTIFY_STATUS_PAGE_TEMPLATES_DEFINE');
});

test('an import read only as a JSX tag or a re-export stays; one nothing reads goes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const file = join(dir, 'a.tsx');
  writeFileSync(
    file,
    [
      "import { Button, Unused } from './ui';",
      "import { Icons } from './icons';",
      "import { kept } from './kept';",
      "import './side-effect';",
      'export const A = () => <Button><Icons.Coin /></Button>;',
      'export { kept };',
      '',
    ].join('\n'),
  );
  pruneImports(file);
  const out = readFileSync(file, 'utf8');
  assert.match(out, /import \{ Button \} from '\.\/ui';/);
  assert.match(out, /import \{ Icons \} from '\.\/icons';/);
  assert.match(out, /import \{ kept \} from '\.\/kept';/);
  assert.match(out, /import '\.\/side-effect';/);
  assert.doesNotMatch(out, /Unused/);
});

test("a schema's free names leave out property keys, member names and its own parameters", () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const file = join(dir, 'b.ts');
  writeFileSync(file, 'const s = z.object({ amount: amountString, n: z.number().refine((v) => v > LIMIT) });\n');
  const p = load(file);
  const init = p.program.body[0].declarations[0].init;
  assert.deepEqual([...freeNames(p, init).keys()].sort(), ['LIMIT', 'amountString', 'z']);
});

test('the step scripts load without running', async () => {
  await import('./run.mjs');
  await import('./refusals.mjs');
  await import('./samples.mjs');
});

test("a caller's own check on the answer is found, through its consts, so the call is left for its check to move to `accept`", () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const file = join(dir, 'c.ts');
  writeFileSync(
    file,
    [
      'const row = z.object({ id: z.string() });',
      'const mine = row.refine((r) => r.id === me);',
      'export const a = api.mutate("notify", "notify.x", {}, z.object({ alert: mine }));',
      'export const b = api.mutate("notify", "notify.y", {}, z.object({ alert: row }));',
      '',
    ].join('\n'),
  );
  const p = load(file);
  const [a, b] = p.program.body.slice(2).map((s) => s.declaration.declarations[0].init.arguments[3]);
  assert.equal(answerChecks(p, a).length, 1);
  assert.match(answerChecks(p, a)[0], /^\.refine\(\) \(.*c\.ts:2\)$/);
  assert.deepEqual(answerChecks(p, b), []);
});

test("a test's API client double gets a call that sends the record to its own query or mutate", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const file = join(dir, 'a.test.ts');
  writeFileSync(file, 'export const api = { query: () => 1, mutate: () => 2 };\nexport const done = { query: 1, mutate: 2, call: 3 };\n');
  assert.equal(doublesIn(file).out.length, 1, 'a double with call already is left');
  const sent = [];
  const api = {
    query: (...a) => (sent.push(['query', ...a]), 'q'),
    mutate: (...a) => (sent.push(['mutate', ...a]), 'm'),
  };
  const method = CALL_METHOD.replace(/^call\(\s*this:[^\n]*\n/, 'call(\n')
    .replace(/: \{ kind[^}]*\}/, '')
    .replace(/\?: unknown/g, '')
    .replace(/,$/, '');
  const double = new Function('api', `return { ...api, ${method} };`)(api);
  const record = { kind: 'query', module: 'notify', path: 'notify.list', output: 'schema' };
  assert.equal(double.call(record, { limit: 1 }, { signal: 's' }), 'q');
  assert.equal(double.call({ ...record, kind: 'mutation' }, { id: 'x' }), 'm');
  assert.deepEqual(sent, [
    ['query', 'notify', 'notify.list', { limit: 1 }, 'schema', { signal: 's' }],
    ['mutate', 'notify', 'notify.list', { id: 'x' }, 'schema', undefined],
  ]);
});

test("a schema the caller's own function builds is an answer check, so its call stays", () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const file = join(dir, 'f.ts');
  writeFileSync(
    file,
    "import { z } from 'zod';\nexport function mine(id: string) { return z.object({ id: z.literal(id) }); }\nexport const a = mine('u1');\nexport const b = z.object({ id: z.string() });\n",
  );
  const p = load(file);
  const init = (name) => p.program.body.find((s) => s.declaration?.declarations?.[0]?.id.name === name).declaration.declarations[0].init;
  assert.match(answerChecks(p, init('a'))[0], /^mine\(\) builds the schema/);
  assert.deepEqual(answerChecks(p, init('b')), []);
});

test('a useBankRead, payCall and founderEdgeCall call each moves to its record form, its other arguments kept', () => {
  const repo = mkdtempSync(join(tmpdir(), 'call-records-'));
  const put = (path, lines) => {
    mkdirSync(join(repo, dirname(path)), { recursive: true });
    writeFileSync(join(repo, path), `${lines.join('\n')}\n`);
  };
  const money = 'apps/customer/src/features/money';
  put(`${money}/contracts-cards.ts`, ["import { z } from 'zod';", "export const cardsReads = { 'cards.list': z.array(z.string()) };"]);
  put(`${money}/contracts.ts`, ["import { cardsReads } from './contracts-cards';", 'export const bankReads = { ...cardsReads } as const;']);
  put(`${money}/components.tsx`, [
    "import { bankReads } from './contracts';",
    'export function useBankRead(p, i, e = true) { return bankReads[p]; }',
  ]);
  put(`${money}/Cards.tsx`, [
    "import { useBankRead } from './components';",
    "export const Cards = () => useBankRead('cards.list', { limit: 5 }, open);",
  ]);
  put('apps/admin/src/lib/pay.ts', [
    "import { payCall, parseWith } from '@/lib/merchants/pay-call';",
    "import { founderEdgeCall } from '@/lib/founder-session';",
    "export const a = payCall(ctx, 'payHalts.history', 'GET', { limit: 5 }, parseWith(historySchema));",
    "export const b = payCall(ctx, 'recipients.list', 'GET', {}, readRows, 'identity');",
    "export const c = founderEdgeCall(config, 'identity', 'recipients.add', 'POST', input, undefined, signIn);",
  ]);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });

  const sites = findSites(repo).filter((s) => s.shape !== 'keyed-schema');
  const of = (shape, path) => sites.find((s) => s.shape === shape && s.path === path);
  for (const s of sites) assert.equal(s.problem, undefined, `${s.shape} ${s.path}: ${s.problem}`);
  assert.deepEqual(
    sites.map((s) => [s.shape, s.module, s.path, s.kind]).sort(),
    [
      ['founderEdgeCall', 'identity', 'recipients.add', 'mutation'],
      ['payCall', 'identity', 'recipients.list', 'query'],
      ['payCall', 'pay', 'payHalts.history', 'query'],
      ['useBankRead', 'bank', 'cards.list', 'query'],
    ].sort(),
  );
  assert.match(text(of('useBankRead', 'cards.list').schema.p, of('useBankRead', 'cards.list').schema.node), /^z\.array/);

  const moved = (s, name, takesNone) => {
    const changes = new Changes();
    rewriteSite(changes, s, name, '@intafaced/contracts/x', takesNone);
    const f = changes.of(s.file);
    return { code: applyEdits(load(s.file).src, f.edits), imports: [...f.imports] };
  };
  const card = moved(of('useBankRead', 'cards.list'), 'BANK_CARDS_LIST');
  assert.match(card.code, /= \(\) => useBankRecord\(BANK_CARDS_LIST, \{ limit: 5 \}, open\);$/m);
  assert.deepEqual(
    card.imports.map(([spec, names]) => [spec, [...names]]),
    [
      ['./components', ['useBankRecord']],
      ['@intafaced/contracts/x', ['BANK_CARDS_LIST']],
    ],
  );
  assert.match(
    moved(of('payCall', 'payHalts.history'), 'PAY_HALTS_HISTORY').code,
    /= payRecordCall\(ctx, PAY_HALTS_HISTORY, \{ limit: 5 \}\);$/m,
  );
  assert.match(
    moved(of('payCall', 'recipients.list'), 'IDENTITY_RECIPIENTS_LIST', true).code,
    /= payRecordRead\(ctx, IDENTITY_RECIPIENTS_LIST, undefined, readRows\);$/m,
  );
  assert.match(
    moved(of('founderEdgeCall', 'recipients.add'), 'IDENTITY_RECIPIENTS_ADD').code,
    /= founderEdgeRecordCall\(config, IDENTITY_RECIPIENTS_ADD, input, undefined, signIn\);$/m,
  );
});
