// garden/no-call-by-name on planted files: each shape of a call named by strings fires in the customer and admin apps and
// names the record; the record call, a variable dialog field, a dotted key holding words, a test file and a service do not.
// The count command reads the same findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countOf } from '../count-rule.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';
const RULE = 'garden/no-call-by-name';

/** oxlint's JSON diagnostics over planted files, linted with the root config. */
function lint(files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-call-by-name-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'json', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return JSON.parse(out).diagnostics ?? [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const CUSTOMER = 'apps/customer/src/features/money/NewRoom.tsx';
const ADMIN = 'apps/admin/src/lib/desk/new-desk.ts';

test('every shape of a call named by strings fires, in both apps, and names the record', skip, () => {
  const diagnostics = lint({
    [CUSTOMER]: [
      "const a = api.query('bank', 'cards.list', { limit: 50 }, cardsSchema);",
      'const b = api.mutate<X>(',
      "  'bank',",
      "  'cards.freeze', {}, s);",
      "const c = api.mutate('agents', procedure, { id }, z.array(schema));",
      "const d = useBankRead('cards.list', { limit });",
      "open({ title, procedure: 'cards.freeze' });",
      "const reads = { 'cards.list': cardsSchema, 'fees.schedule.get': z.object({ a: z.string() }) };",
    ].join('\n'),
    [ADMIN]: [
      "const e = await founderCall(ctx, 'support', 'listQueue', 'GET', {}, read);",
      "const f = await founderEdgeCall(config, 'ops', procedure, 'POST', {});",
      "const g = await payCall(ctx, 'founderAdmin.registries.save', 'POST', change, parse);",
    ].join('\n'),
  });
  const { total, files } = countOf(diagnostics, RULE);
  assert.deepEqual(files, { [CUSTOMER]: 7, [ADMIN]: 3 });
  assert.equal(total, 10);
  for (const d of diagnostics.filter((x) => x.code === 'garden(no-call-by-name)')) assert.match(d.message, /api\.call\(<RECORD>, input\)/u);
});

test('the record call and look-alikes stay quiet; tests and services are out of scope', skip, () => {
  const clean = [
    'const a = api.call(BANK_TRANSFERS_QUOTE, input);',
    'const b = useBankCall(RECORD, {});',
    'open(bankAction(RECORD, spec));',
    'open({ title, procedure: tool.procedure });',
    "const none = { toolId, procedure: '', edgePath: null };",
    "const copy = { 'menu.title': 'Cards', 'cards.list': 3 };",
    "const rows = await query('select 1', 'x');",
    "const c = founderCall(ctx, module, procedure, 'GET', {}, read);",
  ].join('\n');
  const named = "const a = api.query('bank', 'cards.list', {}, s);";
  const diagnostics = lint({
    [CUSTOMER]: clean,
    'apps/customer/src/features/money/NewRoom.test.tsx': named,
    'apps/customer/tests/real-app/J-x.pw.mjs': named,
    'services/svc-bank/src/client.ts': named,
    'packages/sdk/src/client.ts': named,
  });
  assert.deepEqual(countOf(diagnostics, RULE), { total: 0, files: {} });
});

// project-state#3841: a helper given the call's name hid each of its callers. BankAccountRoom's `useAccountRead('onboarding', …)`
// (a template sender) and BusinessTeamRoom's `useBank('businessTeam.roles', …)` and `change.run('businessTeam.approve', …)`
// each counted only at the helper's sender.
test("each caller that hands a helper the call's name by a string is a finding, the helper's own file or another", skip, () => {
  const ROOM = 'apps/customer/src/features/money/bank-account/AccountRoom.tsx';
  const BANNER = 'apps/customer/src/features/money/bank-overview/Banner.tsx';
  const diagnostics = lint({
    [ROOM]: [
      'export function useAccountRead(procedure: string, schema: S, version: number) {',
      "  return api.query('bank', `bankAccount.${procedure}`, {}, schema);",
      '}',
      'function useBank(procedure: string, input: unknown, schema: S, base: string, rev = 0) {',
      "  return useResource(() => api.query('bank', procedure, input, schema), base);",
      '}',
      'function useOverview(name: string) { return useBank(name, {}, s, "-"); }',
      'function useChange(after: () => void) {',
      '  async function run(procedure: string, body: unknown, schema: S) {',
      "    return api.mutate('bank', procedure, body, schema);",
      '  }',
      '  return { run, busy };',
      '}',
      "const a = useAccountRead('onboarding', s, 0);",
      "const b = useBank('businessTeam.roles', input, s, key, rev);",
      "const c = useOverview('businessTeam.overview');",
      "function One() { const change = useChange(() => {}); change.run('businessTeam.approve', {}, s); }",
      "function Two() { const change = useChange(() => {}); void change.run('businessTeam.reject', {}, s); }",
      // Not by a string: nothing more to count.
      'const d = useBank(name, input, s, key);',
      "const e = useChange(() => {}).busy; const f = other.run('businessTeam.approve');",
    ].join('\n'),
    [BANNER]: [
      "import { useAccountRead } from '../bank-account/AccountRoom';",
      "const read = useAccountRead('onboarding', s, 0);",
      // A helper of the same name declared twice in one file is not followed.
      'function run(x: string) { return 1; }',
    ].join('\n'),
  });
  const helper = diagnostics.filter((d) => d.message.startsWith("a helper given the call's name"));
  assert.deepEqual(
    helper.map((d) => `${d.filename} ${/`([^`]+)`/u.exec(d.message)[1]}`).sort(),
    [`${BANNER} useAccountRead`, `${ROOM} run`, `${ROOM} run`, `${ROOM} useAccountRead`, `${ROOM} useBank`, `${ROOM} useOverview`].sort(),
  );
  // The senders still count once each, beside their callers.
  assert.deepEqual(countOf(diagnostics, RULE), { total: 9, files: { [ROOM]: 8, [BANNER]: 1 } });
  for (const d of helper) assert.match(d.message, /api\.call\(<RECORD>, input\)/u);
});

test('a name bound more than once in a file, or a helper that never sends its parameter, is not followed', skip, () => {
  const diagnostics = lint({
    [CUSTOMER]: [
      "function useBank(procedure: string) { return api.query('bank', procedure, {}, s); }",
      'function Other() { const useBank = (x: string) => x; }',
      "const a = useBank('cards.list');",
      'function label(procedure: string) { return t(procedure); }',
      "const b = label('cards.list');",
    ].join('\n'),
  });
  assert.equal(diagnostics.filter((d) => d.message.startsWith("a helper given the call's name")).length, 0);
});
