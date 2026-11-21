// The call-records codemod's own pieces, on small inputs (the codemod itself is proven by its runs: run.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { answerChecks, pruneImports, recordName } from './index.mjs';
import { freeNames, load } from './ast.mjs';
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

test('the report sorts each hand reason into the kind one script change or one decision closes', async () => {
  const { reasonOf } = await import('./report.mjs');
  assert.equal(reasonOf('founderEdgeCall has no record form yet'), 'no record form: founderEdgeCall');
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

test("a guard behind the service's own function or const options is copied whole onto its record; one that checks more keeps its call, named", async () => {
  const { procedures, chainOf } = await import('./router.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'call-records-guards-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(dir, 'src'));
  writeFileSync(
    join(dir, 'src/procedures.ts'),
    [
      "import { scopedProcedure } from '@intafaced/contracts';",
      "export function executeProcedure() { return scopedProcedure('agents:execute', { module: 'agents', person: true, ownSession: 'agents.execute_person_only' }); }",
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, 'src/router.ts'),
    [
      "import { scopedProcedure, TRPCError } from '@intafaced/contracts';",
      "import { executeProcedure } from './procedures.js';",
      "const guards = { module: 'core-ops' as const, plane: 'fiat' as const };",
      "const opsScope = 'admin:compliance' as const;",
      'export function createSvcRouter(deps) {',
      "  const operator = (scope: 'admin:read' | 'admin:write') => scopedProcedure(scope, { module: 'agents', person: true, ownSession: 'agents.fleet_person_only' });",
      "  const readProcedure = () => scopedProcedure('agents:read', { module: 'agents' });",
      '  const reader = scopedProcedure(opsScope, guards);',
      "  const either = (flag) => { if (flag) return scopedProcedure('admin:write'); return scopedProcedure('admin:read'); };",
      "  const opsProcedure = scopedProcedure('campaigns:ops', guards).use(({ next }) => next());",
      '  return router({',
      "    desk: operator('admin:read').output(o).query(h),",
      '    run: executeProcedure().output(o).mutation(h),',
      '    signer: readProcedure().output(o).query(h),',
      '    inbox: reader.output(o).query(h),',
      "    status: scopedProcedure('admin:read', guards).output(o).query(h),",
      '    pick: either(true).output(o).query(h),',
      '    ops: opsProcedure.output(o).query(h),',
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
    ops: "guard opsProcedure kept by hand: it adds svc-campaigns' ops second-factor check (requireOpsMfa); no record field says that",
  });
  const { reasonOf } = await import('./report.mjs');
  assert.equal(reasonOf(access.ops), 'guard kept by hand (named, with its reason)');
});
