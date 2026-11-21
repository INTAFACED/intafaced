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
