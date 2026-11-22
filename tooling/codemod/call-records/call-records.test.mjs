// The call-records codemod's own pieces, on small inputs (the codemod itself is proven by its runs: run.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  answerChecks,
  Changes,
  checkedCall,
  importedFrom,
  importsFile,
  portInFlight,
  pruneImports,
  pruneReExports,
  pruneSchemas,
  recordName,
  rewriteSite,
} from './index.mjs';
import { applyEdits, freeNames, load, resolveRelative, text } from './ast.mjs';
import { findSites } from './sites.mjs';
import { closureOf } from './closure.mjs';
import { CALL_METHOD, callMethodFor, doublesIn } from './doubles.mjs';
import { armsOf, callsOf } from './door.mjs';
import { canon, doorTree, treeOf } from './door-check.mjs';
import { samplesFor } from './samples.mjs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

/** The zod the records use: the one @intafaced/contracts resolves. */
const contractsZod = () =>
  import(pathToFileURL(createRequire(new URL('../../../packages/contracts/package.json', import.meta.url)).resolve('zod')).href);

test('a record is named by its module and path, a leading segment that repeats the module dropped', () => {
  assert.equal(recordName('bank', 'deposits.addresses.list'), 'BANK_DEPOSITS_ADDRESSES_LIST');
  assert.equal(recordName('notify', 'notify.unreadCount'), 'NOTIFY_UNREAD_COUNT');
  assert.equal(recordName('notify', 'statusPage.templates.define'), 'NOTIFY_STATUS_PAGE_TEMPLATES_DEFINE');
});

test('a service whose Rust port is in flight is refused, by name, before anything is read; one not started or switched is not', () => {
  const root = mkdtempSync(join(tmpdir(), 'call-records-port-'));
  for (const d of ['crates/svc-agents', 'services/svc-agents', 'services/svc-bank', 'crates/svc-academy'])
    mkdirSync(join(root, d), { recursive: true });
  assert.match(portInFlight('svc-agents', root) ?? '', /svc-agents's Rust port is in flight/);
  assert.equal(portInFlight('svc-bank', root), null, 'no crate yet: its port has not started');
  assert.equal(portInFlight('svc-academy', root), null, 'switched: its TypeScript is gone, the door path (--from-rev) runs');
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

test('a re-export no other file imports once the run is written is dropped; one still imported stays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const file = join(dir, 'service.ts');
  writeFileSync(
    file,
    ["import { CAP, LIMIT } from '@intafaced/contracts/x';", 'export const use = () => CAP + LIMIT;', 'export { CAP, LIMIT };', ''].join(
      '\n',
    ),
  );
  pruneReExports(file, new Set(['CAP', 'LIMIT']), (name) => (name === 'LIMIT' ? ['other.ts'] : []));
  const out = readFileSync(file, 'utf8');
  assert.match(out, /export \{ LIMIT \};/);
  assert.doesNotMatch(out, /export \{[^}]*CAP/);
  pruneReExports(file, new Set(['LIMIT']), () => []);
  assert.doesNotMatch(readFileSync(file, 'utf8'), /export \{/);
});

test("an importer counts only when its import resolves to the file: another folder's schemas.ts is not it", () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  mkdirSync(join(dir, 'portal'));
  writeFileSync(join(dir, 'schemas.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'portal/schemas.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'service.ts'), 'export const a = 1;\n');
  writeFileSync(join(dir, 'portal/api.ts'), "import * as p from './schemas';\nexport const x = p.a;\n");
  writeFileSync(join(dir, 'router.ts'), "import { a } from './service.js';\nexport const y = a;\n");
  // Its own `a`, beside another name it imports from the file: not an importer of `a`.
  writeFileSync(join(dir, 'portal/own.ts'), "import { b } from '../schemas';\nexport const a = b;\n");
  assert.equal(importsFile(join(dir, 'portal/api.ts'), join(dir, 'schemas.ts'), 'schemas', 'a'), false);
  assert.equal(importsFile(join(dir, 'portal/api.ts'), join(dir, 'portal/schemas.ts'), 'schemas', 'a'), true);
  assert.equal(importsFile(join(dir, 'portal/api.ts'), join(dir, 'portal/schemas.ts'), 'schemas', 'z'), false);
  assert.equal(importsFile(join(dir, 'router.ts'), join(dir, 'service.ts'), 'service', 'a'), true);
  assert.equal(importsFile(join(dir, 'portal/own.ts'), join(dir, 'schemas.ts'), 'schemas', 'a'), false);
  assert.equal(importsFile(join(dir, 'portal/own.ts'), join(dir, 'schemas.ts'), 'schemas', 'b'), true);
});

test('a namespace import names each member it reads, so a schema whose last `s.x` reader moved is seen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  writeFileSync(join(dir, 'schemas.ts'), 'export const a = 1;\nexport const b = 2;\n');
  const file = join(dir, 'api.ts');
  writeFileSync(file, "import * as s from './schemas';\nexport const f = () => s.a + s.b;\n");
  const before = importedFrom(file);
  writeFileSync(file, "import * as s from './schemas';\nexport const f = () => s.a;\n");
  const after = importedFrom(file);
  assert.equal(before.get('s.b'), join(dir, 'schemas.ts'));
  assert.ok(after.has('s') && after.has('s.a') && !after.has('s.b'));
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

test('a useApi mock with only mutate (or only query) gets a call to it, and the other kind is refused as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const file = join(dir, 'b.test.tsx');
  writeFileSync(
    file,
    [
      "vi.mock('../session/session', () => ({ useApi: () => ({ mutate: async () => 1 }) }));",
      "vi.mock('./reads', () => ({ useApi: () => ({ query: async () => 2 }) }));",
      'const hook = { mutate: () => 3 };',
      '',
    ].join('\n'),
  );
  assert.equal(doublesIn(file).out.length, 2, "an object with mutate that isn't a useApi mock is left");
  // Such a test reaches its component by `await import('./Room')`, with no extension, a .tsx file.
  writeFileSync(join(dir, 'Room.tsx'), 'export const Room = 1;\n');
  assert.equal(resolveRelative(file, './Room'), join(dir, 'Room.tsx'));
  const strip = (m) =>
    m
      .replace(/^call\(\s*this:[^\n]*\n/, 'call(\n')
      .replace(/: \{ kind[^}]*\}/, '')
      .replace(/\?: unknown/g, '')
      .replace(/,$/, '');
  const sent = [];
  const writes = new Function('m', `return { mutate: (...a) => (m.push(a), 'm'), ${strip(callMethodFor(['mutate']))} };`)(sent);
  const record = { kind: 'mutation', module: 'quant', path: 'preview.act', output: 'schema' };
  assert.equal(writes.call(record, { room: 'editor' }), 'm');
  assert.deepEqual(sent, [['quant', 'preview.act', { room: 'editor' }, 'schema', undefined]]);
  assert.throws(() => writes.call({ ...record, kind: 'query' }), /no query/);
  const reads = new Function(`return { query: () => 'q', ${strip(callMethodFor(['query']))} };`)();
  assert.equal(reads.call({ ...record, kind: 'query' }), 'q');
  assert.throws(() => reads.call(record), /no mutate/);
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

test('the report sorts each hand reason into the kind one script change or one decision closes', async () => {
  const { reasonOf } = await import('./report.mjs');
  assert.equal(
    reasonOf('its own schema checks the answer, mine() builds the schema (a.ts:3): move it'),
    "schema built by the caller's own function",
  );
  assert.equal(
    reasonOf('its own schema checks the answer, .refine() (a.ts:3): move it'),
    'caller schema checks the answer (.refine and the like)',
  );
  assert.equal(reasonOf('identity.x: no accepted input found; write its samples by hand'), 'no sample inputs');
  assert.equal(
    reasonOf('helper amountString clashes with another amountString in this record file: a rerun places it'),
    'helper name clash (a rerun places it)',
  );
  assert.equal(reasonOf('something new'), 'other');
});

test('the router reader follows a builder member, an imported builder and both branches of a switch, and names a path two branches define', async () => {
  const { procedures } = await import('./router.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-svc-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src/parts.ts'),
    [
      'export function partRoutes() { return { customer: { one: p.input(a).query(h) } }; }',
      'export function liveRouter() { return router({ shared: p.query(h), live: p.query(h) }); }',
      'export function standIn() { return router({ shared: p.query(h2) }); }',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'src/router.ts'),
    [
      "import { partRoutes, liveRouter, standIn } from './parts.js';",
      'export function createSvcRouter(flag: boolean) {',
      '  const part = partRoutes();',
      '  return router({ ...part.customer, flagged: flag ? liveRouter() : standIn() });',
      '}',
      '',
    ].join('\n'),
  );
  const { procedures: found, unread } = procedures(dir);
  assert.deepEqual([...found.keys()].sort(), ['flagged.live', 'one']);
  assert.deepEqual(
    unread.map((u) => `${u.path}: ${u.why}`),
    ['flagged.shared: two procedures under one path (a switch router)'],
  );
});

test('an ops-desk read beside readOf is a site the codemod moves to ...readOf(RECORD)', async () => {
  const { deskReadSite } = await import('./sites.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const file = join(dir, 'catalog.ts');
  writeFileSync(
    file,
    [
      'export const readOf = (r: { module: string; path: string }) => ({ module: r.module, procedure: r.path });',
      "export const a = { id: 'bank.health', module: 'bank', procedure: 'health', shape: 'record' };",
      "export const b = { id: 'x', procedure: 'health' };",
      '',
    ].join('\n'),
  );
  const found = deskReadSite(load(file));
  assert.deepEqual(
    found.map((s) => `${s.module} ${s.path} ${s.kind}`),
    ['bank health query'],
  );
  // `module` and `procedure` with no `readOf` and no `ReadSpec` in reach: not a desk read.
  const bare = join(dir, 'bare.ts');
  writeFileSync(bare, "export const d = { module: 'bank', procedure: 'health' };\n");
  assert.deepEqual(deskReadSite(load(bare)), []);
  // `ReadSpec` imported, `readOf` not: a desk read that imports `readOf` from the same place.
  const typed = join(dir, 'typed.ts');
  writeFileSync(
    typed,
    "import type { ReadSpec } from '@/lib/ops-desk';\nexport const e: ReadSpec = { module: 'bank', procedure: 'health' };\n",
  );
  assert.deepEqual(
    deskReadSite(load(typed)).map((s) => s.helperFrom),
    ['@/lib/ops-desk'],
  );
  // An operator tool beside `toolOf`: its kind is its own, and `edgeModule` and `kind` are what the record replaces.
  const tools = join(dir, 'tools.ts');
  writeFileSync(
    tools,
    [
      'export const toolOf = (r: { module: string; path: string; kind: string }) => ({ edgeModule: r.module, procedure: r.path, kind: r.kind });',
      "export const t = { id: 'pay.set', edgeModule: 'pay', procedure: 'merchantState.set', kind: 'mutation', scope: 'admin:write' };",
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    deskReadSite(load(tools)).map((s) => `${s.module} ${s.path} ${s.kind} ${s.helper} ${s.drop.map((d) => d.key.name).join('+')}`),
    ['pay merchantState.set mutation toolOf edgeModule+kind'],
  );
});

test('a table its own founderCall sends by `spec.procedure` is a site, the whole table or none of it', async () => {
  const { opsEntrySites } = await import('./sites.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const write = (name, lines) => {
    const file = join(dir, name);
    writeFileSync(file, [...lines, ''].join('\n'));
    return load(file);
  };
  const head = [
    "import { founderCall } from '@/lib/desk';",
    "const OPS = { hide: { procedure: 'ops.hide' }, show: { procedure: 'ops.show' } } as const;",
  ];
  const send =
    "export const act = (ctx: never, op: 'hide' | 'show', i: unknown) => { const spec = OPS[op]; return founderCall(ctx, 'quant', spec.procedure, 'POST', i, (r) => r); };";
  assert.deepEqual(
    opsEntrySites(write('sent.ts', [...head, send])).map((s) => `${s.module} ${s.path} ${s.kind} ${s.problem ?? 'ok'}`),
    ['quant ops.hide mutation ok', 'quant ops.show mutation ok'],
  );
  // Read anywhere else, the entry's name must stay: the table stays as it is, named.
  const leaked = opsEntrySites(write('leaked.ts', [...head, send, 'export const name = OPS.hide.procedure;']));
  assert.ok(leaked.every((s) => /read by more than its founderCall/.test(s.problem)));
  const whole = opsEntrySites(write('whole.ts', [...head, send, 'export const all = OPS;']));
  assert.ok(whole.every((s) => /passed on whole/.test(s.problem)));
  // Its keys alone read no entry: still the shape.
  const keys = opsEntrySites(write('keys.ts', [...head, send, 'export const has = (o: string) => Object.hasOwn(OPS, o);']));
  assert.deepEqual(
    keys.map((s) => s.problem ?? 'ok'),
    ['ok', 'ok'],
  );
  // No call in the file sends the table: not this shape (the rule's plain `procedure:` finding).
  assert.deepEqual(opsEntrySites(write('unsent.ts', head)), []);
});

test('a call naming one of two paths by `? :` is a site per branch, its input written out or none', async () => {
  const { findSites } = await import('./sites.mjs');
  const repo = mkdtempSync(join(tmpdir(), 'call-records-repo-'));
  mkdirSync(join(repo, 'apps/customer/src'), { recursive: true });
  writeFileSync(
    join(repo, 'apps/customer/src/holds.ts'),
    [
      "export const a = (api: any, ok: boolean, id: string) => api.mutate('bank', ok ? 'holds.accept' : 'holds.deny', { id }, s);",
      "export const b = (api: any, reg: boolean, body: object) => api.mutate('identity', reg ? 'auth.register' : 'auth.login', body, s);",
      '',
    ].join('\n'),
  );
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  const found = findSites(repo).map((s) => `${s.path} ${s.branch} ${s.problem ? 'stays' : 'moves'}`);
  assert.deepEqual(found, [
    'holds.accept consequent moves',
    'holds.deny alternate moves',
    'auth.register consequent stays',
    'auth.login alternate stays',
  ]);
});

test("a guard behind the service's own function or const options is copied whole onto its record; one that checks more names its check, or keeps its call, named", async () => {
  const { procedures, chainOf } = await import('./router.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-guards-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src/procedures.ts'),
    [
      "import { scopedProcedure } from '@intafaced/contracts';",
      "export function executeProcedure() { return scopedProcedure('agents:execute', { module: 'agents', person: true, ownSession: 'agents.execute_person_only' }); }",
      'export function requireOpsMfa(ctx) {}',
      "export const opsProcedure = scopedProcedure('campaigns:ops', { module: 'campaigns' }).use(({ ctx, next }) => {\n  requireOpsMfa(ctx);\n  return next();\n});",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'src/router.ts'),
    [
      "import { scopedProcedure, TRPCError } from '@intafaced/contracts';",
      "import { executeProcedure, opsProcedure as sharedOps } from './procedures.js';",
      "const guards = { module: 'core-ops' as const, plane: 'fiat' as const };",
      "const opsScope = 'admin:compliance' as const;",
      'export function createSvcRouter(deps) {',
      "  const operator = (scope: 'admin:read' | 'admin:write') => scopedProcedure(scope, { module: 'agents', person: true, ownSession: 'agents.fleet_person_only' });",
      "  const readProcedure = () => scopedProcedure('agents:read', { module: 'agents' });",
      '  const reader = scopedProcedure(opsScope, guards);',
      "  const either = (flag) => { if (flag) return scopedProcedure('admin:write'); return scopedProcedure('admin:read'); };",
      '  const requireMfa = (ctx) => {};',
      "  const opsProcedure = scopedProcedure('campaigns:ops', guards).use(({ ctx, next }) => { requireMfa(ctx); return next(); });",
      "  const auditedOps = scopedProcedure('campaigns:ops', guards).use(({ ctx, next }) => { requireMfa(ctx); requireMfa(ctx); return next(); });",
      '  const jobProcedure = publicProcedure.use(({ ctx, next }) => { requireMfa(ctx); return next(); });',
      '  const merchantApi = async () => {};',
      "  const merchantApiProcedure = (scope: 'p2p:read' | 'p2p:write') => scopedProcedure(scope, { module: 'p2p', check: merchantApi });",
      '  return router({',
      "    desk: operator('admin:read').output(o).query(h),",
      '    run: executeProcedure().output(o).mutation(h),',
      '    signer: readProcedure().output(o).query(h),',
      '    inbox: reader.output(o).query(h),',
      "    status: scopedProcedure('admin:read', guards).output(o).query(h),",
      '    pick: either(true).output(o).query(h),',
      '    ops: opsProcedure.output(o).query(h),',
      '    shared: sharedOps.output(o).query(h),',
      '    audited: auditedOps.output(o).query(h),',
      '    job: jobProcedure.output(o).mutation(h),',
      "    dispute: merchantApiProcedure('p2p:write').output(o).mutation(h),",
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  const { procedures: found } = procedures(dir);
  const access = Object.fromEntries(
    [...found].map(([path, proc]) => [path, chainOf(proc)]).map(([path, c]) => [path, c.guard?.text ?? c.problems.join('; ')]),
  );
  assert.deepEqual(access, {
    desk: "{ caller: 'scope', scope: 'admin:read', module: 'agents', person: true, ownSession: 'agents.fleet_person_only' }",
    run: "{ caller: 'scope', scope: 'agents:execute', module: 'agents', person: true, ownSession: 'agents.execute_person_only' }",
    signer: "{ caller: 'scope', scope: 'agents:read', module: 'agents' }",
    inbox: "{ caller: 'scope', scope: 'admin:compliance', module: 'core-ops', plane: 'fiat' }",
    status: "{ caller: 'scope', scope: 'admin:read', module: 'core-ops', plane: 'fiat' }",
    // Two returns may be two guards: neither is copied.
    pick: 'guard either() is a function with more than its returned guard: not one a record names',
    // A scope guard and one check of the service's own: the record names the check, in this file or shared from another.
    ops: "{ caller: 'scope', scope: 'campaigns:ops', module: 'core-ops', plane: 'fiat', check: 'requireMfa' }",
    shared: "{ caller: 'scope', scope: 'campaigns:ops', module: 'campaigns', check: 'requireOpsMfa' }",
    // One statement more is not one check: it stays.
    audited: 'guard use() chained: not one a record names',
    job: "guard jobProcedure kept by hand: it is a job twin's signed-service check (requireBankJobService, requireTokenJobService) with its own refusal message, not serviceProcedureFor's",
    // The service's own check is named on the record, which mounts it from the service's parts.
    dispute: "{ caller: 'scope', scope: 'p2p:write', module: 'p2p', check: 'merchantApi' }",
  });
  const { reasonOf } = await import('./report.mjs');
  assert.equal(reasonOf(access.job), 'guard kept by hand (named, with its reason)');
  assert.equal(reasonOf(access.audited), 'guard chained with .use()');
});

test("a record naming its service's own check mounts with the router file's parts, else with its refusal reader and the check's export", async () => {
  const { partsFor } = await import('./guard-check.mjs');
  const guard = {
    text: "{ caller: 'scope', scope: 'campaigns:ops', check: 'requireOpsMfa' }",
    check: { name: 'requireOpsMfa', file: '/s/kit.ts', exported: true },
  };
  const reader = { name: 'refusalOf', file: '/s/kit.ts', exported: true };
  const declared = { name: 'p2pParts', file: '/s/router.ts', parts: true };
  assert.equal(
    partsFor([declared], '/s/router.ts', guard, () => reader),
    declared,
  );
  assert.deepEqual(
    partsFor([], '/s/tasks.ts', guard, () => reader),
    {
      name: '{ refusalOf: refusalOf, checks: { requireOpsMfa } }',
      file: '/s/tasks.ts',
      imports: [
        { file: '/s/kit.ts', name: 'refusalOf' },
        { file: '/s/kit.ts', name: 'requireOpsMfa' },
      ],
    },
  );
  // A check another file can't import, or no refusal reader: the call stays.
  assert.equal(
    partsFor([], '/s/tasks.ts', { ...guard, check: { ...guard.check, exported: false } }, () => reader),
    undefined,
  );
  assert.equal(
    partsFor([], '/s/tasks.ts', guard, () => undefined),
    undefined,
  );
});

test('portable: a refused z.unknown() is followed from the record to its source and becomes jsonValueSchema', async () => {
  const { plan, parseWhy } = await import('./portable.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-portable-'));
  writeFileSync(
    join(dir, 'views.ts'),
    [
      "import { z } from 'zod';",
      'const shape = { id: z.string(), filter: z.unknown() };',
      'export const viewSchema = z.object(shape).strict();',
      'export const listSchema = z.object({ views: z.array(viewSchema), sort: z.unknown().nullable().optional(), n: z.number().refine((x) => x > 0) });',
      '',
    ].join('\n'),
  );
  const record = join(dir, 'views-procedures.ts');
  writeFileSync(
    record,
    [
      "import { listSchema } from './views.js';",
      "export const R = defineProcedure({ name: 'x.views', input: NO_INPUT, output: listSchema });",
      '',
    ].join('\n'),
  );
  const why =
    'x.views.output cannot be exported without losing meaning: x.views.output.views[].filter (z.unknown (no shape: accepts anything)); ' +
    'x.views.output.sort (z.unknown (no shape: accepts anything)); x.views.output.n (.refine/.superRefine (a TypeScript predicate the export drops))';
  assert.equal(parseWhy(why).findings.length, 3);
  const { edits, left } = plan({ views: why }, [record]);
  const f = edits.get(join(dir, 'views.ts'));
  assert.deepEqual([...f.edits.values()].map((e) => e.text).sort(), ['jsonValueSchema', 'jsonValueSchema']);
  // An answer's refinement with no words to quote stays, named.
  assert.deepEqual(
    left.map((l) => l.at),
    ['x.views.output.n'],
  );
});

test('portable: a leading lookahead that bars one character of the class after it has the same strings without it', async () => {
  const { withoutLeadingLookahead } = await import('./portable.mjs');
  const before = '^(?!-)[a-z0-9-]+(\\.[a-z0-9-]+)+$';
  const after = withoutLeadingLookahead(before);
  assert.equal(after, '^[a-z0-9][a-z0-9-]*(\\.[a-z0-9-]+)+$');
  const a = new RegExp(before);
  const b = new RegExp(after);
  // Every string of up to 5 characters over the class, the dot and one outside character: both say the same.
  const chars = ['a', '0', '-', '.', 'Z'];
  const all = [''];
  for (let n = 0; n < 5; n++)
    for (const s of all.splice(0))
      for (const c of chars) {
        all.push(s + c);
        all.push(s);
      }
  for (const s of new Set(all)) assert.equal(b.test(s), a.test(s), s);
  // Followed from a record to the regex where it is written, through a named schema.
  const { plan } = await import('./portable.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-portable-'));
  writeFileSync(
    join(dir, 'channels.ts'),
    [
      "import { z } from 'zod';",
      `const domain = z.string().regex(/${before}/, 'a domain');`,
      'export const channelsSchema = z.object({ domains: z.array(domain) });',
      '',
    ].join('\n'),
  );
  const record = join(dir, 'channels-procedures.ts');
  writeFileSync(
    record,
    [
      "import { channelsSchema } from './channels.js';",
      "export const R = defineProcedure({ name: 'x.ch', output: channelsSchema });",
      '',
    ].join('\n'),
  );
  const why = `x.ch.output cannot be exported without losing meaning: x.ch.output.domains[] (regex /${before}/ uses lookaround or backreferences (not in Rust regex))`;
  const { edits } = plan({ ch: why }, [record]);
  assert.deepEqual(
    [...edits.get(join(dir, 'channels.ts')).edits.values()].map((e) => e.text),
    [`/${after}/`],
  );
  // A lookahead it has no plain form for stays.
  assert.equal(withoutLeadingLookahead('^(?=a)[a-z]+$'), undefined);
});

test('portable: an answer refinement with a message is named in the record, once for every place one schema sits', async () => {
  const { plan } = await import('./portable.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-portable-'));
  writeFileSync(
    join(dir, 'caps.ts'),
    [
      "import { z } from 'zod';",
      "export const viewCapSchema = z.object({ cap: z.number().nullable() }).strict().refine((v) => v.cap !== 0, { message: 'a cap is never zero' });",
      'export const listSchema = z.object({ personalCap: viewCapSchema, sharedCap: viewCapSchema });',
      '',
    ].join('\n'),
  );
  const record = join(dir, 'caps-procedures.ts');
  writeFileSync(
    record,
    [
      "import { listSchema } from './caps.js';",
      "export const R = defineProcedure({ name: 'x.caps', input: NO_INPUT, output: listSchema, samples: [] });",
      '',
    ].join('\n'),
  );
  const refine = '(.refine/.superRefine (a TypeScript predicate the export drops))';
  const why = `x.caps.output cannot be exported without losing meaning: x.caps.output.personalCap ${refine}; x.caps.output.sharedCap ${refine}`;
  const { edits, left } = plan({ caps: why }, [record]);
  assert.deepEqual(left, []);
  assert.deepEqual(
    [...edits.get(record).edits.values()].map((e) => e.text),
    [', outputChecks: { view_cap_holds: { at: ["output.personalCap", "output.sharedCap"], says: "a cap is never zero" } }'],
  );
});

test("portable: a service's wire replay samples a JSON-value schema as main's z.unknown(), once, in either sampler", async () => {
  const { withReplayJson } = await import('./portable.mjs');
  for (const head of [
    'function sample(schema: Schema | undefined, defs: Record<string, Schema>, depth = 0): Json {',
    'function sample(schema: unknown, depth = 0): unknown {',
  ]) {
    const src = ['const x = 1;', head, '  return null;', '}', ''].join('\n');
    const once = withReplayJson(src);
    assert.ok(once.includes(`${head}\n  if (acceptsAnyJson(schema)) return null;\n  return null;`));
    assert.ok(once.includes('function acceptsAnyJson(schema: unknown): boolean'));
    assert.equal(withReplayJson(once), once);
  }
  // A replay that reads the service's schemas through another sampler is refused; one that reads none is left as it is.
  assert.equal(withReplayJson("const s = readFileSync('svc.schema.json');\n"), undefined);
  assert.equal(withReplayJson('const y = 2;\n'), 'const y = 2;\n');
});

test("a door's match arms: a pattern over lines, each arm to the next, a literal that is no call skipped", () => {
  const lines = [
    '    match path {',
    '        "a.one" => one()?,',
    '        "b.two"',
    '        | "b.three" => {',
    '            two()?',
    '        }',
    '        "not.a.call" => other(),',
    '        _ => rest(),',
    '    }',
  ];
  const arms = armsOf('src/slices/x.rs', lines, new Map([['a.one'], ['b.two'], ['b.three']]));
  assert.deepEqual(
    arms.map((a) => [a.call, a.from, a.to]),
    [
      ['a.one', 1, 2],
      ['b.two', 2, 6],
      ['b.three', 2, 6],
    ],
  );
});

test("a door's calls.rs rows read as kind, scope (null when public) and guarded; a row it can't read stops it", () => {
  const dir = mkdtempSync(join(tmpdir(), 'door-'));
  mkdirSync(join(dir, 'src/door'), { recursive: true });
  const row = (path, kind, access, guarded) =>
    `Call { path: "${path}", kind: Kind::${kind}, access: Access::${access}, guarded: ${guarded}, }`;
  writeFileSync(
    join(dir, 'src/door/calls.rs'),
    [row('a', 'Query', 'Public', 'false'), row('b', 'Mutation', 'Scope("x:write")', 'true')].join('\n'),
  );
  assert.deepEqual(Object.fromEntries(callsOf(dir)), {
    a: { kind: 'query', scope: null, guarded: false },
    b: { kind: 'mutation', scope: 'x:write', guarded: true },
  });
  writeFileSync(join(dir, 'src/door/calls.rs'), 'Call { path: "c", kind: Kind::Query, access: Access::Operator, guarded: true, }');
  assert.throws(() => callsOf(dir), /can't read/);
});

test("a record's input is held to the door's tree: the same zod parts match, one changed bound does not", async () => {
  const { z } = await contractsZod();
  const nodes = [
    { t: 'object', shape: [['slug', 1]], catchall: 'strict' },
    { t: 'string', checks: [{ k: 'min_length', n: 1 }] },
  ];
  assert.equal(canon(treeOf(z.strictObject({ slug: z.string().min(1) }))), canon(doorTree(nodes, 0)));
  assert.notEqual(canon(treeOf(z.strictObject({ slug: z.string().min(2) }))), canon(doorTree(nodes, 0)));
});

test("a door record's accepted sample is the door's own accepted request, and none is guessed without one", async () => {
  const { z } = await contractsZod();
  const record = { name: 'X', path: 'p', input: z.object({ from: z.string() }) };
  assert.match(samplesFor(record, new Map([['p', { from: '2026-01-01' }]])), /verdict: 'accept', input: \{"from":"2026-01-01"\}/);
  assert.throws(() => samplesFor(record, new Map()), /the door lets through/);
  assert.match(samplesFor(record), /verdict: 'accept'/);
});

test('a schema const the moved call left unread goes, and the one it read after it; one still read or impure stays, and an export no file imports loses its export', () => {
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  const file = join(dir, 'prune-schemas-fixture.ts');
  writeFileSync(
    file,
    [
      "import { z } from 'zod';",
      'const inner = z.object({ id: z.string() });',
      'const left = z.array(inner).nullable();',
      'const read = z.string();',
      'export const shared = z.number();',
      'const impure = makeSchema();',
      'export const use = () => read.parse("x") + shared.parse(1);',
      '',
    ].join('\n'),
  );
  pruneSchemas(file);
  const out = readFileSync(file, 'utf8');
  assert.doesNotMatch(out, /const (inner|left) =/);
  assert.match(out, /const read = z\.string\(\);/);
  assert.match(out, /^const shared = z\.number\(\);$/m);
  assert.match(out, /const impure = makeSchema\(\);/);
});

test('a name a service file re-exports is followed to where it is declared, renamed or not, and a renamed declaration is named', () => {
  const repo = mkdtempSync(join(tmpdir(), 'call-records-reexport-'));
  const put = (path, lines) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), `${lines.join('\n')}\n`);
  };
  put('packages/contracts/src/wire.ts', ['export const quantAccountField = { accountId: z.string().optional() };']);
  put('svc/core.ts', [
    "import { z } from 'zod';",
    "import { quantAccountField as accountField } from '@intafaced/contracts/wire';",
    'const keyField = { key: z.string() };',
    'const local = { n: z.number() };',
    'export { accountField, keyField };',
    'export { local as renamed };',
    "export { keyField as passed } from './more.js';",
  ]);
  put('svc/more.ts', ["import { z } from 'zod';", 'export const keyField = { more: z.string() };']);
  put('svc/router.ts', [
    "import { z } from 'zod';",
    "import { accountField, keyField, renamed, passed } from './core.js';",
    'const a = z.object({ ...accountField });',
    'const b = z.object({ ...keyField });',
    'const c = z.object({ ...renamed });',
    'const d = z.object({ ...passed });',
  ]);
  const p = load(join(repo, 'svc/router.ts'));
  const root = (i) => ({ p, node: p.program.body[2 + i].declarations[0].init, where: 'r' });
  const a = closureOf(repo, [root(0)]);
  assert.deepEqual(
    [...a.fromContracts].map(([n, c]) => [n, c.imported]),
    [['accountField', 'quantAccountField']],
  );
  assert.deepEqual(a.problems, []);
  const b = closureOf(repo, [root(1)]);
  assert.deepEqual(
    b.moved.map((m) => m.name),
    ['keyField'],
  );
  assert.deepEqual(b.problems, []);
  assert.deepEqual(closureOf(repo, [root(2)]).problems, ['r: local is re-exported as renamed']);
  assert.deepEqual(closureOf(repo, [root(3)]).problems, ['r: keyField is imported as passed']);
});

test("portable: a door answer's Date becomes its ISO string; a mounted service's stays named", async () => {
  const { plan } = await import('./portable.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-'));
  writeFileSync(
    join(dir, 'grants.ts'),
    [
      "import { z } from 'zod';",
      'export const grantSchema = z.object({ grantedAt: z.coerce.date(), revokedAt: z.date().nullable() });',
      '',
    ].join('\n'),
  );
  const record = join(dir, 'grants-procedures.ts');
  writeFileSync(
    record,
    [
      "import { grantSchema } from './grants.js';",
      "export const R = defineProcedure({ name: 'x.grant', input: NO_INPUT, output: grantSchema, samples: [] });",
      '',
    ].join('\n'),
  );
  const date = '(Date object (not JSON))';
  const why = `x.grant.output cannot be exported without losing meaning: x.grant.output.grantedAt ${date}; x.grant.output.revokedAt ${date}`;
  const door = plan({ grant: why }, [record], { door: true });
  assert.deepEqual(door.left, []);
  assert.deepEqual(
    [...door.edits.get(join(dir, 'grants.ts')).edits.values()].map((e) => e.text),
    ['z.iso.datetime({ offset: true })', 'z.iso.datetime({ offset: true })'],
  );
  const input = plan(
    { grant: 'x.grant.input cannot be exported without losing meaning: input.scene (z.unknown (no shape: accepts anything))' },
    [record],
    { door: true },
  );
  assert.deepEqual(
    input.left.map((l) => l.at),
    ['input.scene'],
  );
  const mounted = plan({ grant: why }, [record]);
  assert.equal(mounted.edits.size, 0);
  assert.deepEqual(
    mounted.left.map((l) => l.at),
    ['x.grant.output.grantedAt', 'x.grant.output.revokedAt'],
  );
});

test('a customer call whose own schema only refuses an answer moves through callAs, keeping that schema; one that transforms it stays', () => {
  const repo = mkdtempSync(join(tmpdir(), 'call-records-checked-'));
  const file = join(repo, 'apps/customer/src/features/more/Agents.tsx');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      "import { useApi } from '../session';",
      'const mine = z.object({ id: z.string() }).refine((r) => r.id === me);',
      "export const a = (api) => api.query('agents', 'agent.get', { id }, mine, { signal });",
      "export const b = (api) => api.mutate('agents', 'session.close', { id }, z.object({ ok: z.literal(true) }));",
      '',
    ].join('\n'),
  );
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  const [a, b] = findSites(repo).sort((x, y) => x.node.start - y.node.start);
  assert.equal(checkedCall(a, a.node.arguments[3], ['.refine() (Agents.tsx:2)']), true);
  assert.equal(checkedCall(a, a.node.arguments[3], ['.refine() (x:1)', '.transform() (x:2)']), false, 'a transform changes the answer');
  assert.equal(checkedCall({ ...a, file: join(repo, 'apps/admin/src/x.ts') }, a.node.arguments[3], ['.refine() (x:1)']), false);
  const changes = new Changes();
  rewriteSite(changes, { ...a, checked: 'mine' }, 'AGENTS_AGENT_GET', '@intafaced/contracts/agents-agent-procedures', false);
  rewriteSite(changes, b, 'AGENTS_SESSION_CLOSE', '@intafaced/contracts/agents-session-procedures', false);
  const f = changes.of(file);
  const out = applyEdits(load(file).src, f.edits);
  assert.match(
    out,
    /api => callAs\(api, AGENTS_AGENT_GET, \{ id \}, mine, \{ signal \}\)|\(api\) => callAs\(api, AGENTS_AGENT_GET, \{ id \}, mine, \{ signal \}\)/,
  );
  assert.match(out, /api\.call\(AGENTS_SESSION_CLOSE, \{ id \}\)/);
  assert.deepEqual([...(f.imports.get('../../shared/api') ?? [])], ['callAs']);
  assert.ok(!(f.schemas ?? new Map()).has('mine'), 'the checked schema is kept as written, not retyped');
});

test('a re-run whose records already exist (no record file changes) skips the file-list steps and still runs the rest', () => {
  // The failure it prevents: on 22 Nov 2026 a layer branch re-ran the identity run after main's (#9593) had written the
  // record; prettier was handed no paths and failed, and build, procedures:write and doubles were skipped.
  const root = mkdtempSync(join(tmpdir(), 'call-records-rerun-'));
  const dir = join(root, 'tooling/codemod/call-records');
  const bin = join(root, 'bin');
  const log = join(root, 'calls.log');
  for (const d of [dir, bin, join(root, 'node_modules/.bin'), join(root, 'packages/contracts/src')]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir, 'run.mjs'), readFileSync(new URL('./run.mjs', import.meta.url)));
  const stub = (body) =>
    `#!/usr/bin/env node\nconst { appendFileSync, writeFileSync } = process.getBuiltinModule('node:fs');\nconst a = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, process.getBuiltinModule('node:path').basename(process.argv[1]) + ' ' + a.join(' ') + '\\n');\n${body}\n`;
  const flagOut = (flag, json) => `const i = a.indexOf('${flag}'); if (i >= 0) writeFileSync(a[i + 1], '${json}');`;
  writeFileSync(join(dir, 'index.mjs'), stub(flagOut('--json', '{"records":[],"rewritten":1,"hand":[]}')));
  writeFileSync(join(dir, 'samples.mjs'), stub(flagOut('--unportable', '{}')));
  for (const f of ['portable.mjs', 'refusals.mjs', 'door-check.mjs', 'doubles.mjs']) writeFileSync(join(dir, f), stub(''));
  // Like the real prettier: no paths is an error.
  writeFileSync(
    join(root, 'node_modules/.bin/prettier'),
    stub("if (!a.some((x) => !x.startsWith('--') && x !== 'warn')) process.exit(2);"),
  );
  writeFileSync(join(bin, 'pnpm'), stub(''));
  for (const f of [join(root, 'node_modules/.bin/prettier'), join(bin, 'pnpm')]) execFileSync('chmod', ['+x', f]);
  writeFileSync(join(root, '.gitignore'), 'node_modules\nbin\ncalls.log\n');
  writeFileSync(join(root, 'packages/contracts/src/identity-procedures.ts'), 'export {};\n');
  const git = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'records already written');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  execFileSync('node', [join(dir, 'run.mjs'), '--module', 'identity', '--service', 'svc-identity', '--refusals', '--door', 'x'], {
    cwd: root,
    env,
    stdio: 'pipe',
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n');
  assert.ok(
    !calls.some((c) => /^(prettier|samples|portable|refusals|door-check)\.mjs? /.test(c) || c.startsWith('prettier ')),
    calls.join('\n'),
  );
  assert.ok(
    calls.some((c) => c.startsWith('pnpm procedures:write')),
    calls.join('\n'),
  );
  assert.ok(
    calls.some((c) => c.startsWith('doubles.mjs --write')),
    calls.join('\n'),
  );
});
