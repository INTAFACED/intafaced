// The four repeat rules on planted files: each fires on its weed and names the fix, and stays quiet on the clean form.
// Each planted weed is a copy of one on main (named beside it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { namesClass } from './repeat-rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const skip = !existsSync(OXLINT) && 'no node_modules';

/** Each planted file's findings of `rule`, as unix-format lines. */
function findings(rule, files) {
  const config = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'garden-repeat-'));
  try {
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify({ ...config, jsPlugins: config.jsPlugins.map((p) => join(ROOT, p)) }));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', '.oxlintrc.json', '--format', 'unix', ...Object.keys(files)], { cwd: dir, encoding: 'utf8' });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => l.includes(`garden(${rule})`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const at = (out, file, line) => out.find((l) => l.startsWith(`${file}:${line}:`));
const lines = (...l) => l.join('\n') + '\n';

test('namesClass: a class anywhere in a CSS selector, never an id, an attribute value, a string or another engine', () => {
  for (const s of [
    '.st-row',
    'section.pp-secret',
    'tbody tr td .font-mono',
    '[data-series="X"] .st-value-text',
    ':scope > .empty-state',
    'li:not(.x)',
    '[data-code], .service-off',
    'nav >> .adm-nav',
  ])
    assert.ok(namesClass(s), s);
  for (const s of [
    '#trade\\.validation_failed',
    '[title="a.b"]',
    'text=Paid 1.5 USDT',
    'button:has-text("v1.2")',
    'tbody tr',
    '[data-testid="money-total"] [role="img"]',
    'xpath=//a[@class="x"]',
    'data-testid=pp.x',
  ])
    assert.ok(!namesClass(s), s);
});

test(
  'no-class-selector: a journey that finds an element by its class fires and names the fix; a role, a test id and an app file do not',
  skip,
  () => {
    const J = 'apps/customer/tests/real-app/J-x-01.pw.mjs';
    const HELPER = 'apps/customer/tests/real-app/desk.mjs';
    const out = findings('no-class-selector', {
      [J]: lines(
        "test('J-x-01 #3', async ({ page }) => {",
        // J-charts-desk-03.pw.mjs:234 on main.
        "  await expect(quietLegend.locator('.st-row').first()).toBeVisible();",
        // J-ops-console-01.pw.mjs:58 on main.
        '  await expect(page.locator(`.adm-session > span[title="${id}"]`)).toHaveText(name);',
        "  const n = await page.evaluate(() => document.querySelectorAll('li.row').length);",
        "  await page.getByRole('row', { name: 'BTC', exact: true }).click();",
        "  await page.getByTestId('pc-legend').locator('b').click();",
        "  await expect(page.locator('#trade\\\\.validation_failed')).toBeVisible();",
        '  await page.locator(\'[data-testid="money-row"]\').first().click();',
        '});',
      ),
      // merchant.mjs:346 on main.
      [HELPER]: "export const off = (head) => head.locator('.pfo-action-off');\n",
      'apps/customer/src/screens/x.ts': "export const el = () => document.querySelector('.st-row');\n",
    });
    assert.equal(out.length, 4, out.join('\n'));
    for (const [f, n] of [
      [J, 2],
      [J, 3],
      [J, 4],
      [HELPER, 1],
    ])
      assert.ok(at(out, f, n), `${f}:${n}\n${out.join('\n')}`);
    assert.ok(at(out, J, 2).includes("`locator('.st-row')`") && at(out, J, 2).includes('getByTestId'), out.join('\n'));
  },
);

test(
  'switch-needs-default: string cases with no default fire and name the never arm; a default, a checked return and a test do not',
  skip,
  () => {
    const S = 'services/svc-x/src/a.ts';
    const out = findings('switch-needs-default', {
      [S]: lines(
        // svc-p2p/src/pricing.ts:87 on main: a new rounding mode would do nothing.
        "export function round(units: bigint, rounding: 'ceil' | 'floor'): bigint {",
        '  switch (rounding) {',
        "    case 'ceil': units += 1n; break;",
        "    case 'floor': break;",
        '  }',
        '  return units;',
        '}',
        // svc-identity/src/router.ts:227 on main: a switch that falls through to code after it.
        'export function toTrpc(err: { code: string }): string {',
        '  switch (err.code) {',
        "    case 'a.not_found': return 'NOT_FOUND';",
        '  }',
        "  return 'INTERNAL';",
        '}',
        // Clean: a never arm.
        "export function f(s: 'a' | 'b'): number {",
        '  switch (s) {',
        "    case 'a': return 1;",
        "    case 'b': return 2;",
        '    default: { const unhandled: never = s; throw new Error(String(unhandled)); }',
        '  }',
        '}',
        // Clean: ends a function declared to return a value, every arm returns: TypeScript checks it.
        "export function g(s: 'a' | 'b'): Promise<unknown> {",
        '  switch (s) {',
        "    case 'a':",
        "    case 'b': return Promise.resolve(1);",
        '  }',
        '}',
        "export async function h(s: 'a' | 'b'): Promise<number> {",
        "  switch (s) { case 'a': return 1; case 'b': { return 2; } }",
        '}',
        // Clean: numeric cases are not a state.
        'export function k(n: number): void { switch (n) { case 1: break; } }',
      ),
      // Fires, though it ends the function: an async Promise<void> may return nothing, so TypeScript does not check it.
      'services/svc-x/src/b.ts': lines(
        "export async function v(s: 'a' | 'b'): Promise<void> {",
        "  switch (s) { case 'a': return; case 'b': return; }",
        '}',
      ),
      'services/svc-x/src/a.test.ts': "switch (x) { case 'a': break; }\n",
      'apps/customer/src/a.ts': "switch (x) { case 'a': break; }\n",
    });
    assert.equal(out.length, 3, out.join('\n'));
    assert.ok(at(out, S, 2)?.includes('const unhandled: never = rounding'), out.join('\n'));
    assert.ok(at(out, S, 9)?.includes('`switch (err.code)`'), out.join('\n'));
    assert.ok(at(out, 'services/svc-x/src/b.ts', 2), out.join('\n'));
  },
);

test(
  'no-journey-sql-read: a journey reading a service table fires and names the route; a write, a fragment and a service do not',
  skip,
  () => {
    const J = 'apps/customer/tests/real-app/J-x-01.pw.mjs';
    const out = findings('no-journey-sql-read', {
      [J]: lines(
        "test('J-x-01 #2', async () => {",
        // J-academy-18.pw.mjs:318 on main.
        '  await academyDb((sql) => sql`SELECT id, course_id FROM academy.discussion_posts WHERE author_id = ${id}`);',
        // J-campaigns-15.pw.mjs:289 on main, over two lines.
        '  const [row] = await sql`',
        '    SELECT id, state FROM campaigns.campaigns WHERE name = ${NAME}`;',
        '  await sql`WITH x AS (SELECT 1) SELECT * FROM x JOIN trade.orders o ON true`;',
        '  await sql`UPDATE campaigns.campaigns SET state = ${s} WHERE id = ${id}`;',
        '  await sql`SELECT 1`;',
        '  const where = sql`AND id = ${id}`;',
        '  // oxlint-disable-next-line garden/no-journey-sql-read -- a removed row: no route lists what is gone',
        '  await sql`SELECT count(*) FROM academy.posts WHERE id = ${id}`;',
        '});',
      ),
      'services/svc-x/src/a.ts': 'export const q = (sql) => sql`SELECT id FROM x.orders`;\n',
    });
    assert.equal(out.length, 3, out.join('\n'));
    for (const n of [2, 3, 5]) assert.ok(at(out, J, n), `${n}\n${out.join('\n')}`);
    assert.ok(at(out, J, 2).includes('its own route'), out.join('\n'));
  },
);

test(
  'no-hand-row: a typed query and the hand row type it names fire, by kind; a parsed query, a schema type and a CSV row do not',
  skip,
  () => {
    const S = 'services/svc-x/src/store.ts';
    const out = findings('no-hand-row', {
      [S]: lines(
        "import { z } from 'zod';",
        // svc-ops/src/incidents/store.ts:48 on main.
        'type IncidentRow = { id: string; state: string };',
        'interface OverrideRow { id: string }',
        'export async function read(sql, tx, id) {',
        '  const a = await sql<IncidentRow[]>`SELECT id, state FROM ops.incidents WHERE id = ${id}`;',
        '  const b = await tx.unsafe<OverrideRow[]>(`SELECT id FROM ops.overrides`);',
        '  const c = (await sql`SELECT n FROM ops.counts`) as ReadonlyArray<{ n: number }>;',
        '  const d = Order.array().parse(await sql`SELECT id FROM ops.orders`);',
        '  return [a, b, c, d];',
        '}',
        'const Order = z.object({ id: z.string() });',
        'type OrderRow = z.infer<typeof Order>;',
        // A CSV line no query is typed with (svc-academy/src/curriculum/bulk-grade-file.ts:16 on main).
        'export type BulkGradeRow = { line: number; score: string };',
      ),
      'services/svc-x/src/store.test.ts': 'type TRow = { id: string };\nexport const t = (sql) => sql<TRow[]>`SELECT 1`;\n',
      'apps/admin/src/a.ts': 'type TRow = { id: string };\nexport const t = (sql) => sql<TRow[]>`SELECT 1`;\n',
    });
    const kinds = (k) => out.filter((l) => l.includes(`[${k}]`)).map((l) => Number(l.split(':')[1]));
    assert.deepEqual(kinds('sql-generic').sort(), [5, 6, 7], out.join('\n'));
    assert.deepEqual(kinds('row-type').sort(), [2, 3], out.join('\n'));
    assert.ok(at(out, S, 2).includes('`IncidentRow`') && at(out, S, 2).includes('.array().parse('), out.join('\n'));
    assert.equal(out.length, 5, out.join('\n'));
  },
);
