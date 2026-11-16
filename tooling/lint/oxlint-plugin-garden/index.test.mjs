// The garden rules on planted files: each fires on its weed, names its fix, and stays quiet on the clean form.
// Runs with every other tooling test (tooling/scripts/tooling-tests.mjs). The root config is read as it is, so a rule
// switched off or a broken plugin shows here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OXLINT = join(ROOT, 'node_modules', '.bin', 'oxlint');
const CONFIG = JSON.parse(readFileSync(join(ROOT, '.oxlintrc.json'), 'utf8'));

/** Lint planted files with the root config (its plugin path made absolute); returns oxlint's unix-format lines. */
function lint(files) {
  const dir = mkdtempSync(join(tmpdir(), 'garden-'));
  try {
    const config = { ...CONFIG, jsPlugins: CONFIG.jsPlugins.map((p) => join(ROOT, p)) };
    writeFileSync(join(dir, '.oxlintrc.json'), JSON.stringify(config));
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    let out = '';
    try {
      out = execFileSync(OXLINT, ['-c', join(dir, '.oxlintrc.json'), '--format', 'unix', ...Object.keys(files)], {
        cwd: dir,
        encoding: 'utf8',
      });
    } catch (e) {
      out = String(e.stdout ?? '');
    }
    return out.split('\n').filter((l) => /:\d+:\d+:/.test(l));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const has = (out, file, rule) => out.some((l) => l.startsWith(`${file}:`) && l.includes(rule));

test('oxlint is installed', { skip: !existsSync(OXLINT) && 'no node_modules' }, () => assert.ok(existsSync(OXLINT)));

test('the six garden rules fire on their weeds and name the fix', { skip: !existsSync(OXLINT) && 'no node_modules' }, () => {
  const out = lint({
    'cast.ts': 'export const n = ("1" as unknown as number) + 1;\n',
    'reasonless.ts': '// eslint-disable-next-line no-console\nconsole.log(1);\n',
    'src/wait.test.ts': 'export async function t() {\n  await new Promise((r) => setTimeout(r, 50));\n}\n',
    'page.pw.mjs': 'export async function t(page) {\n  await page.waitForTimeout(500);\n}\n',
    'any.ts': 'export const f = (x: any) => x;\n',
  });
  assert.ok(has(out, 'cast.ts', 'garden(no-double-cast)'), out.join('\n'));
  assert.ok(
    out.some((l) => l.includes('no-double-cast') && l.includes('type guard')),
    'the cast message names the fix',
  );
  assert.ok(has(out, 'reasonless.ts', 'garden(require-suppression-reason)'), out.join('\n'));
  assert.ok(has(out, 'src/wait.test.ts', 'garden(no-real-clock-wait-in-tests)'), out.join('\n'));
  assert.ok(
    out.some((l) => l.includes('no-real-clock-wait-in-tests') && l.includes('useFakeTimers')),
    'the wait message names the fix',
  );
  assert.ok(has(out, 'page.pw.mjs', 'garden(no-wait-for-timeout)'), out.join('\n'));
  assert.ok(has(out, 'any.ts', 'no-explicit-any'), out.join('\n'));
});

test('the clean forms pass', { skip: !existsSync(OXLINT) && 'no node_modules' }, () => {
  const out = lint({
    'reasoned.ts': '// eslint-disable-next-line no-console -- the CLI prints its table\nconsole.log(1);\n',
    'one-cast.ts': 'export const n = Number("1" as string) + 1;\n',
    'src/fake.test.ts': 'export function t(vi) {\n  vi.useFakeTimers();\n}\n',
    'imports.ts': "import { isRecord } from '@intafaced/contracts/guards';\nexport const ok = isRecord({});\n",
    'prod-wait.ts': 'export const later = () => new Promise((r) => setTimeout(r, 50));\n',
  });
  const garden = out.filter((l) => l.includes('garden('));
  assert.deepEqual(garden, [], garden.join('\n'));
});

test(
  'no-local-helper is on now that the shared isRecord and sleep exist in @intafaced/contracts',
  { skip: !existsSync(OXLINT) && 'no node_modules' },
  () => {
    const out = lint({
      'helper.ts':
        'export function isRecord(v: unknown): v is Record<string, unknown> {\n  return typeof v === "object" && v !== null;\n}\n',
      'nap.ts': 'const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));\nexport const nap = () => sleep(5);\n',
    });
    assert.ok(has(out, 'helper.ts', 'garden(no-local-helper)'), out.join('\n'));
    assert.ok(has(out, 'nap.ts', 'garden(no-local-helper)'), out.join('\n'));
  },
);

// ---------------------------------------------------------------------------------------------------------------------
// The rules that replaced source-reading unit tests, and the two money rules. Each case below is the deleted test's own
// planted case, so the rule is shown to catch what the test caught.
import { cataloguePromises, handSchemaProblem, portalWords, promiseScope, screenLiterals } from './copy-rules.js';

const skip = { skip: !existsSync(OXLINT) && 'no node_modules' };

test('no-promise-copy: the Trade lane bans its promise words on code lines, not in comments', skip, () => {
  const out = lint({
    'apps/customer/src/screens/trade/x/copy.ts': "export const a = { title: 'Coming soon' };\n",
    'apps/admin/src/lib/trade-ops/y.ts': "export const b = 'Check back later';\n",
    'apps/customer/src/features/trade/z.tsx': "// this lands soon\nexport const c = 'Trade now';\n",
    'apps/customer/src/screens/trade/x/copy.test.ts': "export const d = 'not yet';\n",
  });
  assert.ok(has(out, 'apps/customer/src/screens/trade/x/copy.ts', 'garden(no-promise-copy)'), out.join('\n'));
  assert.ok(has(out, 'apps/admin/src/lib/trade-ops/y.ts', 'garden(no-promise-copy)'), out.join('\n'));
  assert.ok(!has(out, 'apps/customer/src/features/trade/z.tsx', 'garden(no-promise-copy)'), out.join('\n'));
  assert.ok(!has(out, 'apps/customer/src/screens/trade/x/copy.test.ts', 'garden(no-promise-copy)'), out.join('\n'));
});

test('no-promise-copy: the copy catalogues outside the Trade and merchant lanes, with the stated facts cut out', skip, () => {
  const out = lint({
    'apps/customer/src/features/cards/cards-copy.ts': "export const a = { blockNone: 'No card issuer is connected yet.' };\n",
    'apps/customer/src/data/refusals.ts': "export const r = { x: 'That balance is locked for now.' };\n",
    'apps/customer/src/features/cards/Room.tsx': "export const a = 'Coming soon';\n",
    'apps/customer/src/features/pay/portal/x-copy.ts': "export const a = { b: 'Coming soon' };\n",
    'apps/customer/src/features/more/ok-copy.ts': "export const a = { b: 'Not chosen yet' };\n",
  });
  assert.ok(has(out, 'apps/customer/src/features/cards/cards-copy.ts', 'garden(no-promise-copy)'), out.join('\n'));
  assert.ok(has(out, 'apps/customer/src/data/refusals.ts', 'garden(no-promise-copy)'), out.join('\n'));
  assert.ok(!has(out, 'apps/customer/src/features/cards/Room.tsx', 'garden(no-promise-copy)'), 'not a copy file');
  assert.ok(!has(out, 'apps/customer/src/features/pay/portal/x-copy.ts', 'garden(no-promise-copy)'), 'the portal has its own rule');
  assert.ok(!has(out, 'apps/customer/src/features/more/ok-copy.ts', 'garden(no-promise-copy)'), 'a stated fact');
  assert.equal(promiseScope('apps/customer/src/app/feature-registry.ts'), 'catalogue');
  assert.equal(promiseScope('apps/customer/src/features/pay/merchant-rooms/copy.ts'), null);
  assert.equal(promiseScope('apps/admin/src/app/(console)/trade-ops/page.tsx'), 'trade');
});

test('no-promise-copy: every promise the deleted copy-promises test planted is caught', () => {
  for (const bad of [
    "  body: 'Sale subscriptions cannot be read yet, so nothing is counted.',",
    "  body: 'Bill pay isn’t connected yet',",
    "  body: 'Coming soon',",
    "  body: 'These are the steps you will see once it is.',",
    "  body: 'That balance is locked for now.',",
    "  appNoneTitle: 'There is no store app yet',",
    "  blockNone: 'No card issuer is connected yet, so cards cannot be ordered.',",
    "  workerRegisterReason: 'The pool doesn’t let customers register a worker yet.',",
    "  assessmentReason: 'Academy has no assessment service yet.',",
    "  pendingBody: 'Deposits on their way will show here once custody is connected.',",
    "  addReason: 'Nothing is charged and no rate is shown until one is.',",
    "  inactive: 'Payout is unavailable until an eligible live rail is connected.',",
    "  blockNone: 'Todavía no hay un emisor de tarjetas conectado.',",
    "  fReason: 'Enviar dinero fuera de INTAFACED aún no está conectado.',",
    "  warning2: 'El mínimo se mostrará aquí hasta entonces.',",
    "  blockNone: 'Aucun émetteur n’est connecté pour le moment : pas encore disponible.',",
    "  addressBlocked: 'Une adresse ne peut être affichée qu’une fois la conservation connectée. D’ici là, rien.',",
  ])
    assert.notEqual(cataloguePromises(bad).length, 0, bad);
  // The allowed phrase is cut out of the line, so a second promise beside it still fails.
  assert.equal(cataloguePromises("  a: 'Not chosen yet. Bill pay isn’t connected yet.',").length, 1);
  assert.deepEqual(cataloguePromises("  a: 'Not chosen yet',"), []);
  assert.deepEqual(cataloguePromises("  empty: 'No trades yet',"), []);
});

test('pay-portal-copy: engineer words in a portal catalogue fire, placeholders do not', skip, () => {
  const out = lint({
    'apps/customer/src/features/pay/portal/money/copy.ts':
      "const en = {\n  a: 'Loaded from the backend',\n  b: 'You have {n} payouts',\n  c: 'Invitations are on the way',\n};\nexport const m = en;\n",
  });
  const hits = out.filter((l) => l.includes('garden(pay-portal-copy)'));
  assert.equal(hits.length, 2, out.join('\n'));
  assert.ok(hits.some((l) => l.includes(':2:')) && hits.some((l) => l.includes(':4:')), hits.join('\n'));
  for (const promise of [
    'Not connected yet',
    'Not available yet',
    'Invitations are on the way',
    'We’ll try again soon',
    'You’ll be able to see it here',
    'Check back later.',
    'INTAFACED has not set limits for your account yet.',
    'Your checkout isn’t set up yet',
    'Your account has no tier yet.',
    'No pricing has been set for your account yet.',
    'INTAFACED has not published any tiers to compare with yet.',
  ])
    assert.notDeepEqual(portalWords(promise), [], promise);
  for (const ok of ['Not paid out yet', 'No refunds yet', 'No limits are set on your account.', 'Your payments are in the list'])
    assert.deepEqual(portalWords(ok), [], ok);
});

test('no-hand-schema: the deleted test’s cases', skip, () => {
  const screen = `import { z } from 'zod';\nconst s = z.object({ a: z.string() });\nexport const read = (api) => api.query('x', 'y', undefined, s);\n`;
  const f = 'apps/customer/src/features/x/api.ts';
  assert.notEqual(handSchemaProblem(f, screen), null);
  assert.notEqual(
    handSchemaProblem('apps/customer/src/features/x/schemas.ts', `import { z } from 'zod';\nexport const a = z.object({});\n`),
    null,
  );
  assert.equal(handSchemaProblem(f, `import { rankStateSchema } from '@intafaced/contracts/identity';\n${screen}`), null);
  assert.equal(handSchemaProblem(f, `// hand-declared-ok: svc-x has no schema in packages/contracts\n${screen}`), null);
  assert.notEqual(handSchemaProblem(f, `// hand-declared-ok:\n${screen}`), null);
  assert.equal(
    handSchemaProblem(
      'apps/customer/src/features/x/draft.ts',
      `import { z } from 'zod';\nexport const draft = z.object({ note: z.string() });\n`,
    ),
    null,
  );
  assert.equal(handSchemaProblem('apps/customer/src/features/x/api.test.ts', screen), null);
  assert.equal(handSchemaProblem('apps/admin/src/api.ts', screen), null);
  assert.equal(handSchemaProblem(f, `// z.object({}) in a comment only\nexport const a = 1;\n`), null);
  const out = lint({ [f]: screen });
  assert.ok(
    out.some((l) => l.startsWith(`${f}:2:`) && l.includes('garden(no-hand-schema)') && l.includes('@intafaced/contracts')),
    out.join('\n'),
  );
});

test('no-screen-literal: the deleted test’s cases', skip, () => {
  const file = 'apps/customer/src/screens/x/Room.tsx';
  const lit = (text, path = file) => screenLiterals(path, text).map(([line, value]) => `${line}: ${value}`);
  assert.deepEqual(lit(`export const A = () => <p>Send money now</p>;\n`), ['1: Send money now']);
  assert.deepEqual(lit(`export const A = () => <p>{'Send money'}</p>;\n`), ['1: Send money']);
  assert.deepEqual(lit(`export const A = () => <input aria-label="Amount to send" />;\n`), ['1: Amount to send']);
  assert.deepEqual(lit(`export const A = () => <input aria-label={'Amount to send'} />;\n`), ['1: Amount to send']);
  assert.deepEqual(lit(`export const A = () => (\n  <p>\n    Send money to a friend\n  </p>\n);\n`), ['3: Send money to a friend']);
  assert.deepEqual(lit(`export const A = () => (\n  <div>\n    <Text k="a" />\n    <b>Hello there</b>\n  </div>\n);\n`), [
    '4: Hello there',
  ]);
  assert.deepEqual(lit(`export const A = () => <p>{t('send')} · <Text k="x" /> — 12 / 40</p>;\n`), []);
  assert.deepEqual(lit(`export const A = () => <input lang="en" className="field" aria-label={t('amount')} />;\n`), []);
  assert.deepEqual(lit(`// literal-text-ok: stock symbols are not sentences\nexport const A = () => <p>Send money now</p>;\n`), []);
  assert.notDeepEqual(lit(`// literal-text-ok:\nexport const A = () => <p>Send money now</p>;\n`), []);
  const code = `import { useState } from 'react';\nexport default function Room() {\n  const [n, setN] = useState(0);\n  const more = n > 3 && n < 9;\n  const go = (a: number) => a < n;\n  return (\n    <button type="button" onClick={() => setN(n + 1)} className="field">\n      {t('go')}\n    </button>\n  );\n}\n`;
  assert.deepEqual(lit(code), []);
  const ternary = [
    'export const A = () => (',
    '  <div>',
    '    {view ? (',
    '      <p className="a">',
    "        {t('one')}",
    '      </p>',
    '    ) : failed ? (',
    '      <b />',
    '    ) : isLedgerTab(tab) ? (',
    '      <i />',
    '    ) : null}',
    '    {emptyState ??',
    "      t('none')}",
    '    {market && market.strike && market.optionType',
    "      ? t('a')",
    "      : t('b')}",
    '  </div>',
    ');',
    '',
  ].join('\n');
  assert.deepEqual(lit(ternary), []);
  assert.deepEqual(lit('export const A = () => <i aria-label={`${label} ${parent.id}`} />;\n'), []);
  const long = `export const A = () => <p>${'word '.repeat(40_000)}</p>;\nconst x = <b title="${'a'.repeat(50_000)}`;
  const started = Date.now();
  lit(long);
  assert.ok(Date.now() - started < 1500);
  assert.deepEqual(lit(`const A = () => <p>Send money now</p>;\n`, 'apps/customer/src/screens/x/Room.test.tsx'), []);
  assert.deepEqual(lit(`const A = () => <p>Send money now</p>;\n`, 'apps/customer/src/features/x/Room.tsx'), []);
  assert.deepEqual(lit(`export const a = 'Send money now';\n`, 'apps/customer/src/screens/x/model.ts'), []);
  // Through the linter, on the line the words are on even after a multi-line comment.
  const out = lint({ [file]: `/*\n a note\n*/\nexport const A = () => <p>Send money now</p>;\n` });
  assert.ok(
    out.some((l) => l.startsWith(`${file}:4:`) && l.includes('garden(no-screen-literal)')),
    out.join('\n'),
  );
});

test('own-gap-wording: "not connected" about our own gap fires in the shell copy files; a reasoned suppression holds it', skip, () => {
  const out = lint({
    'apps/customer/src/features/public/x-copy.ts':
      "const en = {\n  partner: 'Partner intake is not connected',\n  ok: 'Email is switched off in this build',\n};\nexport default en;\n",
    'apps/customer/src/features/protocol/copy.ts':
      "const en = {\n  // oxlint-disable-next-line garden/own-gap-wording -- known line, its owner rewords it\n  chip: 'This chain is not connected here',\n};\nexport default en;\n",
    'apps/customer/src/features/cards/copy.ts': "const en = {\n  a: 'The issuer is not connected',\n};\nexport default en;\n",
  });
  assert.ok(
    out.some((l) => l.startsWith('apps/customer/src/features/public/x-copy.ts:2:') && l.includes('garden(own-gap-wording)')),
    out.join('\n'),
  );
  assert.ok(!has(out, 'apps/customer/src/features/protocol/copy.ts', 'garden(own-gap-wording)'), out.join('\n'));
  assert.ok(!has(out, 'apps/customer/src/features/cards/copy.ts', 'garden(own-gap-wording)'), 'outside the shell folders');
});

test('no-number-money: a money field accepted as a number and converted fires; a refusal does not', skip, () => {
  const out = lint({
    // The shape the CI review failed three heads in a row on (services/svc-trade/src/signals/signal-desk.ts).
    'services/svc-x/src/desk.ts':
      "export function read(body: any) {\n  const amount = typeof body.amount === 'number' ? String(body.amount) : body.amount;\n  return amount;\n}\n",
    'services/svc-x/src/if.ts':
      "export function read(body: any) {\n  let p = body.price;\n  if (typeof body?.price === 'number') {\n    p = body.price.toFixed(2);\n  }\n  return p;\n}\n",
    'services/svc-x/src/refuse.ts':
      "export function read(input: any) {\n  if (typeof input.amount === 'number' || typeof input.amount === 'bigint') {\n    throw new Error('The amount must be a decimal string, not a number');\n  }\n  return input.amount;\n}\n",
    'services/svc-x/src/count.ts': "export const n = (b: any) => (typeof b.count === 'number' ? String(b.count) : '0');\n",
    'services/svc-x/src/desk.test.ts': "export const t = (b: any) => (typeof b.amount === 'number' ? String(b.amount) : b.amount);\n",
  });
  assert.ok(has(out, 'services/svc-x/src/desk.ts', 'garden(no-number-money)'), out.join('\n'));
  assert.ok(
    out.some((l) => l.includes('no-number-money') && l.includes('decimal-string schema')),
    'the message names the fix',
  );
  assert.ok(has(out, 'services/svc-x/src/if.ts', 'garden(no-number-money)'), out.join('\n'));
  assert.ok(!has(out, 'services/svc-x/src/refuse.ts', 'garden(no-number-money)'), out.join('\n'));
  assert.ok(!has(out, 'services/svc-x/src/count.ts', 'garden(no-number-money)'), 'not a money word');
  assert.ok(!has(out, 'services/svc-x/src/desk.test.ts', 'garden(no-number-money)'), 'tests are not judged');
});

// What apps/customer/src/{data,screens/trade/desk,screens/trade/options}/money-paths.test.ts judge, held at the moment of
// writing, and the customer app beyond.
test('no-number-money: the customer app never makes money a float, and chartValue() is the one way onto a chart', skip, () => {
  const C = 'apps/customer/src/';
  const out = lint({
    // #8644's two cases: the chart's float sent as an order's amount, and a money value made a float in shared/.
    [`${C}screens/trade/desk/Ticket.tsx`]:
      "import { chartValue } from '../../../shared/chart-value';\nexport const intent = (a: string) => ({ kind: 'place_order', amount: String(chartValue(a)) });\n",
    [`${C}shared/send.ts`]: 'export function amountToSend(amount: string): number {\n  return Number(amount);\n}\n',
    [`${C}features/x/body.ts`]: 'export const body = (a: string) => JSON.stringify({ amount: chartValue(a) });\n',
    [`${C}features/x/label.ts`]: 'export const label = (p: string) => `${chartValue(p)} USD`;\n',
    [`${C}features/x/held.ts`]: 'export function f(p: string) {\n  const y = chartValue(p) * 2;\n  return y.toFixed(2);\n}\n',
    [`${C}features/x/names.ts`]:
      'export const a = (o: { price: string }) => parseFloat(o.price);\nexport const b = (amount: string) => +amount;\nexport const c = (t: string) => Number(t.trim()) + Number.parseFloat(feeTotal);\n',
    [`${C}features/x/parts.ts`]:
      'export const a = (o: { priceUsd: string }) => Number(o.priceUsd);\nexport const b = (amount_in: string) => Number(amount_in);\nexport const c = (bar: { c: string }) => Number(bar.c);\nexport const d = (prices: string[]) => prices.map(Number);\n',
    [`${C}features/x/venue.ts`]:
      'export const a = (o: { px: string; markPx: string }) => Number(o.px) + Number(o.markPx);\nexport const b = (prices: string[]) => prices.map((p) => Number(p));\nexport const c = (amount: string) => parseInt(amount, 10);\n',
    [`${C}features/x/callbacks.ts`]: [
      'export const a = (amounts: string[]) => amounts.map((p) => {\n  return Number(p);\n});',
      'export const b = (amounts: string[]) => amounts.map(function (p) {\n  return Number(p);\n});',
      'export const c = (amounts: string[]) => amounts.reduce((s, x) => s + Number(x), 0);',
      'export const d = (amounts: string[]) => Array.from(amounts, Number);',
      'export const e = (amounts: string[]) => amounts.map(Number.parseFloat);',
      'export const f = (amount: string) => Number(String(amount));',
      'export const g = (ids: string[], amounts: string[]) => ids.map((p) => Number(p)).concat(amounts.length);',
      '',
    ].join('\n'),
    [`${C}features/x/alias.ts`]:
      "import { chartValue as cv } from '../../shared/chart-value';\nexport const s = (a: string) => String(cv(a));\n",
    [`${C}features/x/space.ts`]:
      "import * as ns from '../../shared/chart-value';\nexport const s = (a: string) => String(ns.chartValue(a));\n",
    [`${C}features/x/shown.tsx`]:
      'import { chartValue } from \'../../shared/chart-value\';\nexport const P = ({ a }: { a: string }) => <span title="x">{chartValue(a)}</span>;\nexport const L = ({ a }: { a: string }) => <Line price={chartValue(a)} />;\n',
    [`${C}features/x/book.ts`]: [
      'export const a = (bids: [string, string][]) => bids.map(([p, s]) => Number(p) * Number(s));',
      'export function b(amounts: string[]) {\n  let t = 0;\n  for (const p of amounts) t += Number(p);\n  return t;\n}',
      'export const c = (p: string) => Number(p);',
      '',
    ].join('\n'),
    [`${C}features/x/counts.ts`]:
      'export const a = (o: { widthPx: string; lastSeenAt: string; totalPages: string; pageSize: string }) =>\n  Number(o.widthPx) + Number(o.lastSeenAt) + Number(o.totalPages) + Number(o.pageSize);\n',
    [`${C}features/x/rates.ts`]:
      'export const a = (feeBps: string) => Number(feeBps);\nexport const b = (m: { open: boolean }) => Number(m.open);\nexport const c = (ids: string[]) => ids.map(Number);\nexport const d = (ids: string[]) => ids.map((id) => Number(id));\nexport const e = (page: string) => parseInt(page, 10);\n',
    [`${C}data/poll.spec.ts`]: 'export const ms = (s: string) => Number(s);\n',
    // The folders the scanner tests judged: every float conversion, whatever it is called.
    [`${C}data/poll.ts`]: 'export const ms = (s: string) => Number(s);\n',
    [`${C}data/deep/fixed.ts`]: 'export const f = (n: number) => n.toFixed(2);\n',
    [`${C}screens/trade/desk/Book.tsx`]: 'export const n = (s: string) => +s;\n',
    [`${C}screens/trade/options/Chain.tsx`]:
      'export const n = (s: string) => new Number(s);\nexport const chartValue = (v: string) => Number(v);\n',
    // Quiet: the exit itself, chart math on its result, names that are not money, the scanners' own exemptions, prose.
    [`${C}shared/chart-value.ts`]: 'export function chartValue(value: string): number {\n  return Number(value);\n}\n',
    [`${C}screens/trade/chart/depth.ts`]:
      "import { chartValue } from '../../../shared/chart-value';\nexport const d = (h: { y(p: number): number }, price: string) => {\n  const y = h.y(chartValue(price));\n  return `M ${y.toFixed(1)}`;\n};\n",
    [`${C}features/x/plain.ts`]:
      'export const m = (minutes: string) => Number(minutes.trim()) * 60;\nexport const ok = (ms: number) => Number.isFinite(ms);\n',
    [`${C}data/sparkline.ts`]: 'export const y = (s: string) => Number(s);\n',
    [`${C}data/__fixtures__/book.ts`]: 'export const y = (s: string) => Number(s);\n',
    [`${C}screens/trade/desk/chart/axis.ts`]: 'export const y = (s: string) => Number(s);\n',
    [`${C}data/prose.ts`]:
      "// never parseFloat(x) or Number(x)\nexport const s = 'Number(x) .toFixed(2)';\nexport const t = (a: number, b: number) => a + b;\n",
    [`${C}data/poll.test.ts`]: 'export const ms = (amount: string) => Number(amount);\n',
    'services/svc-x/src/rate.ts': 'export const r = (amount: string) => Number(amount);\n',
  });
  const fires = (file, n = 1) =>
    assert.equal(
      out.filter((l) => l.startsWith(`${file}:`) && l.includes('garden(no-number-money)')).length,
      n,
      `${file}\n${out.join('\n')}`,
    );
  fires(`${C}screens/trade/desk/Ticket.tsx`);
  assert.ok(
    out.some((l) => l.startsWith(`${C}screens/trade/desk/Ticket.tsx:`) && l.includes('send or show the decimal string it was made from')),
    'the chart case names the fix',
  );
  fires(`${C}shared/send.ts`);
  assert.ok(
    out.some((l) => l.startsWith(`${C}shared/send.ts:`) && l.includes('`amount` is money') && l.includes('parseAmount/formatAmount')),
    'the float case names the fix',
  );
  fires(`${C}features/x/body.ts`);
  fires(`${C}features/x/label.ts`);
  fires(`${C}features/x/held.ts`);
  fires(`${C}features/x/names.ts`, 3);
  fires(`${C}features/x/parts.ts`, 4);
  fires(`${C}features/x/venue.ts`, 4);
  fires(`${C}features/x/callbacks.ts`, 6);
  fires(`${C}features/x/alias.ts`);
  fires(`${C}features/x/space.ts`);
  fires(`${C}features/x/shown.tsx`);
  fires(`${C}features/x/book.ts`, 3);
  fires(`${C}features/x/counts.ts`, 0);
  fires(`${C}features/x/rates.ts`, 0);
  fires(`${C}data/poll.spec.ts`);
  fires(`${C}data/poll.ts`);
  fires(`${C}data/deep/fixed.ts`);
  fires(`${C}screens/trade/desk/Book.tsx`);
  fires(`${C}screens/trade/options/Chain.tsx`, 2);
  for (const quiet of [
    'shared/chart-value.ts',
    'screens/trade/chart/depth.ts',
    'features/x/plain.ts',
    'data/sparkline.ts',
    'data/__fixtures__/book.ts',
    'screens/trade/desk/chart/axis.ts',
    'data/prose.ts',
    'data/poll.test.ts',
  ])
    fires(`${C}${quiet}`, 0);
  fires('services/svc-x/src/rate.ts', 0);
});

test('no-random-request-key: a random key fires directly, in a template and through a const; a held key does not', skip, () => {
  const out = lint({
    // The shape the CI review failed (apps/customer/src/screens/trade/copybots/WebhooksRoom.tsx).
    'apps/customer/src/screens/x/Hooks.tsx':
      'export const create = (api, symbol) => api.mutate({ clientRequestId: `wh-${symbol}-${crypto.randomUUID()}` });\n',
    'services/svc-x/src/a.ts':
      "import { randomUUID } from 'node:crypto';\nexport const send = (bus) => bus.publish({ idempotencyKey: randomUUID() });\n",
    'services/svc-x/src/b.ts':
      'export const send = (bus) => {\n  const key = `k-${Date.now()}`;\n  return bus.publish({ idempotencyKey: key });\n};\n',
    'apps/customer/src/screens/x/Held.tsx':
      "import { useRef } from 'react';\nexport function A(api, held) {\n  const requestKey = useRef(crypto.randomUUID());\n  const clientRequestId = held.current ?? `s:${crypto.randomUUID()}`;\n  return api.mutate({ clientRequestId, other: requestKey.current });\n}\n",
    'services/svc-x/src/c.ts': 'export const send = (bus, d) => bus.publish({ idempotencyKey: `p2p.dispute:${d.id}` });\n',
  });
  assert.ok(has(out, 'apps/customer/src/screens/x/Hooks.tsx', 'garden(no-random-request-key)'), out.join('\n'));
  assert.ok(
    out.some((l) => l.includes('no-random-request-key') && l.includes('business key')),
    'the message names the fix',
  );
  assert.ok(has(out, 'services/svc-x/src/a.ts', 'garden(no-random-request-key)'), out.join('\n'));
  assert.ok(has(out, 'services/svc-x/src/b.ts', 'garden(no-random-request-key)'), out.join('\n'));
  assert.ok(!has(out, 'apps/customer/src/screens/x/Held.tsx', 'garden(no-random-request-key)'), out.join('\n'));
  assert.ok(!has(out, 'services/svc-x/src/c.ts', 'garden(no-random-request-key)'), out.join('\n'));
});

// The regex duplicate ratchet's own self-test cases (tooling/ci/boundary-scan.mjs), on the rules that replaced it.
import { duplicateHits } from './duplicate-rules.js';

test('the four duplicate kinds count what the regex ratchet counted', () => {
  const n = (path, text) => Object.fromEntries(Object.entries(duplicateHits(path, text)).map(([k, v]) => [k, v.length]));
  assert.deepEqual(n('services/svc-x/src/a.ts', 'const SCALE = 10n ** 18n; a * b / SCALE'), { 'no-local-scale': 1 });
  assert.deepEqual(n('packages/ledger-client/src/money.ts', 'const SCALE = 10n ** 18n;'), {}, 'ledger-client owns the scale');
  assert.deepEqual(n('services/svc-x/src/a.ts', 'const x = r.result?.data; const y = result.data;'), { 'no-hand-trpc-unwrap': 2 });
  assert.deepEqual(n('services/svc-x/src/a.ts', "s.padEnd(18, '0')"), { 'no-hand-decimal-parse': 1 });
  assert.deepEqual(n('services/svc-x/src/a.ts', 'await fetch(url);'), { 'no-fetch-without-timeout': 1 });
  assert.deepEqual(n('services/svc-x/src/a.ts', 'await fetch(url, { signal: AbortSignal.timeout(5000) });'), {});
  assert.deepEqual(n('apps/customer/src/a.ts', 'const SCALE = 10n ** 18n;'), {}, 'apps were never counted');
  assert.deepEqual(n('services/svc-x/src/a.test.ts', 'await fetch(url);'), {}, 'nor tests');
  assert.deepEqual(n('services/svc-x/src/a.ts', '// 10n ** 18n in a comment\nconst a = 1;'), {});
});

test('the duplicate rules report through the linter, on the line', { skip: !existsSync(OXLINT) && 'no node_modules' }, () => {
  const out = lint({
    'services/svc-x/src/a.ts': 'export const a = 1;\nexport const SCALE = 10n ** 18n;\nexport const g = () => fetch("x");\n',
  });
  assert.ok(
    out.some((l) => l.startsWith('services/svc-x/src/a.ts:2:') && l.includes('garden(no-local-scale)')),
    out.join('\n'),
  );
  assert.ok(
    out.some((l) => l.startsWith('services/svc-x/src/a.ts:3:') && l.includes('garden(no-fetch-without-timeout)')),
    out.join('\n'),
  );
});

test('no-effect-in-product: an effect in a room, screen or the shell fires; the data layer, shared hooks and tests do not', skip, () => {
  const effect = "import { useEffect } from 'react';\nexport function R() {\n  useEffect(() => {}, []);\n  return null;\n}\n";
  const out = lint({
    'apps/customer/src/features/money/Room.tsx': effect,
    'apps/customer/src/screens/home/index.tsx': effect.replace(/useEffect/g, 'useLayoutEffect'),
    'apps/customer/src/app/Shell.tsx':
      "import React from 'react';\nexport function S() {\n  React.useEffect(() => {}, []);\n  return null;\n}\n",
    'apps/customer/src/shared/resource.ts': effect,
    'apps/customer/src/data/hooks.ts': effect,
    'apps/customer/src/features/money/Room.test.tsx': effect,
    'apps/admin/src/components/desk.tsx': effect,
  });
  for (const f of [
    'apps/customer/src/features/money/Room.tsx',
    'apps/customer/src/screens/home/index.tsx',
    'apps/customer/src/app/Shell.tsx',
  ])
    assert.ok(has(out, f, 'garden(no-effect-in-product)'), `${f}\n${out.join('\n')}`);
  assert.ok(
    out.some((l) => l.includes('no-effect-in-product') && l.includes('src/shared/resource.ts')),
    'the message names the fix',
  );
  for (const f of [
    'apps/customer/src/shared/resource.ts',
    'apps/customer/src/data/hooks.ts',
    'apps/customer/src/features/money/Room.test.tsx',
    'apps/admin/src/components/desk.tsx',
  ])
    assert.ok(!has(out, f, 'garden(no-effect-in-product)'), `${f}\n${out.join('\n')}`);
});

test('no-hand-answer-reader: a reader of a founderCall answer checked by hand fires; parseWith and a schema reader do not', skip, () => {
  const head = "import { founderCall, parseWith } from '@/lib/desk/founder-call';\nimport { s } from '@intafaced/contracts/x';\n";
  const call = (parse) => `export const go = (ctx) => founderCall(ctx, 'pay', 'a.b', 'GET', {}, ${parse});\n`;
  const out = lint({
    'apps/admin/src/lib/a/inline.ts': head + call("(raw) => (typeof raw === 'object' && raw ? raw : null)"),
    'apps/admin/src/lib/a/local.ts':
      head +
      "function readAnswer(raw: unknown) {\n  return raw && typeof (raw as { id?: unknown }).id === 'string' ? raw : null;\n}\n" +
      call('readAnswer'),
    'apps/admin/src/lib/a/schema.ts': head + call('parseWith(s)'),
    'apps/admin/src/lib/a/schema-reader.ts':
      head +
      'const readAnswer = (raw: unknown) => {\n  const p = s.safeParse(raw);\n  return p.success ? p.data : null;\n};\n' +
      call('readAnswer'),
    'apps/admin/src/lib/a/imported.ts': head + "import { readX } from './model';\n" + call('readX'),
    'apps/admin/src/lib/a/wrapper.ts': head + "import { readX } from './model';\n" + call('(raw) => readX(raw, 2)'),
    'apps/admin/src/lib/a/form.ts': "export function readForm(raw: unknown) {\n  return typeof raw === 'string' ? raw : null;\n}\n",
  });
  assert.ok(has(out, 'apps/admin/src/lib/a/inline.ts', 'garden(no-hand-answer-reader)'), out.join('\n'));
  assert.ok(
    out.some((l) => l.startsWith('apps/admin/src/lib/a/local.ts:3:') && l.includes('no-hand-answer-reader') && l.includes('parseWith')),
    out.join('\n'),
  );
  for (const f of ['schema.ts', 'schema-reader.ts', 'imported.ts', 'wrapper.ts', 'form.ts'])
    assert.ok(!has(out, `apps/admin/src/lib/a/${f}`, 'garden(no-hand-answer-reader)'), `${f}\n${out.join('\n')}`);
});
