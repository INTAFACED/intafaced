// The Volt recipe's codemod (volt-recipe.mjs): what it moves onto the kit, and what it leaves for judgement.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSync } from 'oxc-parser';
import { readdirSync, readFileSync } from 'node:fs';
import { CLASSES, GONE, ONE_RULE, classesIn, classesTestsFind, rank, recipe, WHOLE, WHOLE_UNSPACED } from './volt-recipe.mjs';

test('moves the old Button, its variants and loading, and the three classes onto the kit', () => {
  const { text, left } = recipe(
    [
      "import { Button } from '@intafaced/ui';",
      "import { FlowTemplate } from '@intafaced/ui/lit/templates';",
      'export const Room = () => (',
      '  <FlowTemplate>',
      '    <label className="field"><span>Name</span><input /></label>',
      '    <a className="text-link" href="/x">x</a><span className="sr-only">y</span>',
      '    <Button type="submit" variant="primary" loading={busy} disabled={busy || !ok}>Send</Button>',
      '    <Button variant="ghost" onClick={() => go(a > b)}>Back</Button>',
      '    <Button type="button">Add</Button>',
      '  </FlowTemplate>',
      ');',
      '',
    ].join('\n'),
  );
  assert.deepEqual(left, []);
  assert.match(text, /^import \{ Button \} from '@intafaced\/ui\/lit';$/m);
  assert.doesNotMatch(text, /from '@intafaced\/ui';/);
  assert.match(text, /<label className="lt-field">/);
  assert.match(text, /<a className="lt-link" href="\/x">/);
  assert.match(text, /<span className="lt-sr">/);
  assert.match(text, /<Button type="submit" tone="primary" aria-busy=\{busy \|\| undefined\} disabled=\{busy \|\| !ok\}>/);
  // An arrow and a `>` inside an expression do not end the tag.
  assert.match(text, /<Button tone="quiet" onClick=\{\(\) => go\(a > b\)\}>Back/);
  // The old Button's default variant was primary.
  assert.match(text, /<Button tone="primary" type="button">Add/);
});

test('leaves, by line, every finding that needs judgement and changes no Button it cannot move whole', () => {
  const source = [
    "import { Button, Card } from '@intafaced/ui';",
    "import { Tabs } from '@intafaced/ui/tabs';",
    'export const a = <Button variant="buy">Buy</Button>;',
    'export const b = <p className="money-check">x</p>;',
    'export const c = <p className={cls}>y</p>;',
    '',
  ].join('\n');
  const { text, left } = recipe(source);
  assert.equal(text, source);
  assert.deepEqual(left, [
    '1: imports Button, Card from @intafaced/ui (Card: no recipe)',
    "2: imports '@intafaced/ui/tabs'",
    '4: className "money-check" (money-check has no recipe)',
    '5: className={…}, computed, needs judgement',
  ]);
});

test('refuses a Button prop with no twin in the kit, and a loading the caller does not also disable on', () => {
  const { text, left } = recipe(
    [
      "import { Button } from '@intafaced/ui';",
      'export const a = <Button size={32} variant="primary">a</Button>;',
      'export const b = <Button variant="buy">b</Button>;',
      'export const c = <Button loading={busy}>c</Button>;',
      '',
    ].join('\n'),
  );
  assert.deepEqual(left, [
    "2: <Button> with size, which the kit's Button has no twin for",
    '3: <Button> variant="buy", which the kit has no tone for',
    '4: <Button> loading={busy} without a disabled that names it',
  ]);
  assert.match(text, /<Button size=\{32\} variant="primary">a/);
  // One Button that cannot move keeps the old import, so no Button is left typed against the wrong kit.
  assert.match(text, /^import \{ Button \} from '@intafaced\/ui';$/m);
  assert.match(text, /<Button loading=\{busy\}>c/);
});

// The real failure (EarnPoolActions.tsx, 521 lines written as 832): a `//` comment inside a Button's attribute held an
// apostrophe and backticks, the old scanner took them for a string and ran past the tag's end, and the next Button's
// text was written twice.
test('a quote or backtick in a comment or in JSX text never moves a tag end or duplicates code', () => {
  const source = [
    "import { Button } from '@intafaced/ui';",
    'export const Room = () => (',
    '  <div>',
    '    <Button',
    '      onClick={() => {',
    "        // The id is checked for every write (`check`); a term is this review's own promise.",
    '        go();',
    '      }}',
    '    >',
    '      Deposit',
    '    </Button>',
    "    <p>Don't stop: `x`</p>",
    '    <Button variant="secondary" onClick={back}>',
    '      Back',
    '    </Button>',
    '    <a className="text-link" href="/x">x</a>',
    '  </div>',
    ');',
    '',
  ].join('\n');
  const { text, left } = recipe(source);
  assert.deepEqual(left, []);
  assert.deepEqual(parseSync('room.tsx', text).errors, []);
  assert.equal(text.split('\n').length, source.split('\n').length);
  assert.equal(text.match(/<Button\b/g).length, 2);
  assert.equal(text.match(/Deposit/g).length, 1);
  assert.match(text, /^ {4}<Button tone="primary"$/m);
  assert.match(text, /<Button tone="secondary" onClick=\{back\}>/);
  assert.match(text, /<a className="lt-link" href="\/x">/);
  assert.match(text, /^import \{ Button \} from '@intafaced\/ui\/lit';$/m);
  // A class written only inside a comment or a string is not a JSX attribute and is never touched.
  const quiet = 'export const s = \'className="field"\';\n// className="sr-only"\n';
  assert.equal(recipe(quiet).text, quiet);
});

test('refuses a room that does not parse, and names where', () => {
  assert.throws(() => recipe("import { Button } from '@intafaced/ui';\nexport const a = <Button>;\n"), /does not parse at line 2/);
});

test("moves Badge onto the kit's Tag and a StatusTag that names its words onto StatusChip, renaming both ends of each tag", () => {
  const { text, left, changed } = recipe(
    [
      "import { Badge, Button, StatusTag } from '@intafaced/ui';",
      'export const Room = () => (',
      '  <div>',
      '    <Badge tone="lime" data-testid="tag">Live</Badge>',
      '    <Badge>Plain</Badge>',
      '    <StatusTag status="filled" label={t("Filled")} />',
      '    <StatusTag status="pending" label={t("Waiting")}></StatusTag>',
      '    <Button variant="secondary">Back</Button>',
      '  </div>',
      ');',
      '',
    ].join('\n'),
  );
  assert.deepEqual(left, []);
  assert.equal(changed, 6);
  assert.match(text, /^import \{ Tag, Button, StatusChip \} from '@intafaced\/ui\/lit';$/m);
  assert.match(text, /<Tag tone="accent" data-testid="tag">Live<\/Tag>/);
  // The old Badge's default tone was neutral.
  assert.match(text, /<Tag tone="neutral">Plain<\/Tag>/);
  assert.match(text, /<StatusChip status="done" label=\{t\("Filled"\)\} \/>/);
  assert.match(text, /<StatusChip status="pending" label=\{t\("Waiting"\)\}><\/StatusChip>/);
  assert.match(text, /<Button tone="secondary">Back<\/Button>/);
});

test('leaves a part whose tag cannot move whole, and says why for the parts the kit has no twin for', () => {
  const source = [
    "import { Badge, StatusTag } from '@intafaced/ui';",
    "import { StateBlock } from '@intafaced/ui';",
    "import { DataTable, SubNav } from '@intafaced/ui';",
    'export const a = <Badge tone="warn">x</Badge>;',
    'export const b = <Badge variant="outline">x</Badge>;',
    'export const c = <StatusTag status="pending" />;',
    'export const d = <StatusTag status="working" label="w" />;',
    'export const e = <Badge {...props}>x</Badge>;',
    'export const f = <StatusTag status="failed" label="f" data-testid="x" />;',
    'export const g = <StateBlock kind="empty" title="t" />;',
    '',
  ].join('\n');
  const { text, left } = recipe(source);
  assert.equal(text, source);
  assert.deepEqual(left, [
    "2: imports StateBlock from @intafaced/ui (StateBlock: the kit's EmptyState draws its title as text, not the heading StateBlock draws, and loading, error and refused take other props (Skeleton, RefusalBox))",
    "3: imports DataTable, SubNav from @intafaced/ui (DataTable: it takes its rows as children; the kit's Table takes rows and columns as data; SubNav: it marks the current item by its id; the kit's Tabs marks it by its href)",
    '4: <Badge> tone="warn", which the kit\'s Tag has no tone for',
    "5: <Badge> with variant, which the kit's Tag has no twin for",
    '8: <Badge {...}>, a spread, needs judgement',
    "6: <StatusTag> without a label: the kit's StatusChip says other words",
    "7: <StatusTag> status working, which the kit's StatusChip has no twin for",
    "9: <StatusTag> with data-testid, which the kit's StatusChip has no twin for",
  ]);
});

test('leaves a part used other than as a tag, or whose twin is already a name in the file', () => {
  const used = ["import { Badge } from '@intafaced/ui';", 'export const parts = { Badge };', 'export const a = <Badge>x</Badge>;', ''].join(
    '\n',
  );
  assert.deepEqual(recipe(used).left, ['2: Badge is used other than as a tag, needs judgement']);
  assert.equal(recipe(used).text, used);
  const taken = ["import { Badge } from '@intafaced/ui';", "import { Tag } from './tag';", 'export const a = <Badge>x</Badge>;', ''].join(
    '\n',
  );
  assert.deepEqual(recipe(taken).left, ['1: <Badge>: Tag is already a name in this file']);
  assert.equal(recipe(taken).text, taken);
});

test('moves a className whose every class has a kit twin, once each, and leaves one with any other class whole', () => {
  const { text, left } = recipe(
    [
      'export const a = <div className="stack form-stack">x</div>;',
      'export const b = <p className="muted numeric">1</p>;',
      'export const c = <div className="failure"><a className="button button--primary" href="/x">Go</a></div>;',
      'export const d = <p className="muted pay-total">2</p>;',
      '',
    ].join('\n'),
  );
  assert.match(text, /<div className="lt-stack">x/);
  assert.match(text, /<p className="lt-muted lt-num">1/);
  assert.match(text, /<div className="lt-refusal"><a className="lt-button lt-button-primary" href="\/x">/);
  assert.match(text, /<p className="muted pay-total">2/);
  assert.deepEqual(left, ['4: className "muted pay-total" (pay-total has no recipe)']);
});

test('leaves a class on words with a typed arrow, which the kit draws instead', () => {
  const source = [
    'export const a = <a className="text-link" href="/x">Open →</a>;',
    'export const b = <a className="text-link" href="/y">{t(\'Back\')} {\'↗\'}</a>;',
    'export const c = <a className="text-link" href="/z">{t(\'Open\')}</a>;',
    "export const d = <a className=\"text-link\" href=\"/w\">{t('More')} {open ? '↓' : '→'}</a>;",
    '',
  ].join('\n');
  const { text, left } = recipe(source);
  assert.deepEqual(left, [
    '1: className "text-link" on words with a typed arrow, which the kit draws (lt-arrow)',
    '2: className "text-link" on words with a typed arrow, which the kit draws (lt-arrow)',
    '4: className "text-link" on words with a typed arrow, which the kit draws (lt-arrow)',
  ]);
  assert.match(text, /<a className="lt-link" href="\/z">/);
});

test("every class the map moves to is the kit's own", () => {
  const css = readFileSync(new URL('../../packages/ui/src/lit/templates/templates.css', import.meta.url), 'utf8');
  const missing = [...new Set(Object.values(CLASSES).flatMap((v) => v.split(' ')))].filter(
    (kit) => !new RegExp(`\\.${kit}[\\s,{:]`).test(css),
  );
  assert.deepEqual(missing, []);
});

test('the second map: moves a class whose one rule is the kit class, and drops a class no stylesheet names', () => {
  const { text, left, changed } = recipe(
    [
      'export const a = <div className="more-grid">x</div>;',
      'export const b = <span className="pp-sr">y</span>;',
      'export const c = <form className="form-stack pp-form" onSubmit={send}>z</form>;',
      'export const d = <ul className="pp-table" data-testid="rows">w</ul>;',
      'export const e = <p className="mkt-muted pp-count">v</p>;',
      '',
    ].join('\n'),
  );
  assert.deepEqual(left, []);
  assert.equal(changed, 5);
  assert.match(text, /<div className="lt-stack">x/);
  assert.match(text, /<span className="lt-sr">y/);
  assert.match(text, /<form className="lt-stack" onSubmit=\{send\}>z/);
  // A className with nothing left goes with its one space; the test id beside it stays.
  assert.match(text, /<ul data-testid="rows">w/);
  assert.match(text, /<p className="lt-muted">v/);
});

test('leaves a dropped class alone on its line, or beside a class with no recipe', () => {
  const source = [
    'export const a = (',
    '  <ul',
    '    className="pp-table"',
    '    data-testid="rows"',
    '  />',
    ');',
    'export const b = <p className="pp-form pay-total">x</p>;',
    '',
  ].join('\n');
  const { text, left } = recipe(source);
  assert.equal(text, source);
  assert.deepEqual(left, [
    '3: className "pp-table" (no stylesheet names it: delete the attribute and its line)',
    '7: className "pp-form pay-total" (pay-total has no recipe)',
  ]);
});

test('leaves a class a test or a journey finds an element by', () => {
  const source = [
    'export const a = <div className="more-grid">x</div>;',
    'export const b = <span className="pp-sr">y</span>;',
    'export const c = <form className="form-stack pp-form">z</form>;',
    '',
  ].join('\n');
  const found = new Set(classesIn("await page.locator('.more-grid > a').click(); expect(el.querySelector('form.pp-form')).toBeNull();"));
  const { text, left } = recipe(source, { found });
  assert.deepEqual(left, [
    '1: className "more-grid" (a test finds an element by more-grid, needs judgement)',
    '3: className "form-stack pp-form" (a test finds an element by pp-form, needs judgement)',
  ]);
  assert.match(text, /<div className="more-grid">x/);
  assert.match(text, /<span className="lt-sr">y/);
  assert.match(text, /<form className="form-stack pp-form">z/);
});

test('reads the classes a test selects by, and not a property access or a selector that takes either name', () => {
  const names = classesIn(
    [
      'page.locator(\'.pp-detail-head [data-testid="pp-chip"]\');',
      'cell.locator(\'[data-study="rsi-1"] .st-row-formula\');',
      "el.querySelector('tr.pe-row > td');",
      'expect(error.stack).toBeDefined(); list.actions.push(1);',
      "dialog.locator(':is(.form-stack, .lt-stack) > button');",
      "page.locator(':is(.form-stack, .other) > button');",
    ].join('\n'),
  );
  for (const name of ['pp-detail-head', 'st-row-formula', 'pe-row', 'other']) assert.ok(names.includes(name), name);
  for (const name of ['stack', 'actions']) assert.ok(!names.includes(name), name);
  // Named with its kit twin in one :is(), the old class is free to move; named with anything else, it is held.
  assert.equal(new Set(names).has('form-stack'), true);
  assert.deepEqual(classesIn("dialog.locator(':is(.form-stack, .lt-stack) > button');"), []);
  // Over the app's own tests: a class the journeys find by is held, on the real files.
  const found = classesTestsFind();
  for (const name of ['pp-detail-head', 'dk-kv-row', 'p2p-order-identity']) assert.ok(found.has(name), name);
});

/** The selector of every rule in the customer app's and the kit's stylesheets. */
function selectors() {
  const out = [];
  for (const dir of ['../../apps/customer/src/', '../../packages/ui/src/']) {
    const root = new URL(dir, import.meta.url).pathname;
    for (const f of readdirSync(root, { recursive: true }).filter((f) => f.endsWith('.css'))) {
      const css = readFileSync(`${root}${f}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{};]+)\{/g)) out.push(...m[1].split(',').map((s) => s.trim()));
    }
  }
  return out;
}
const naming = (selector, name) => new RegExp(`\\.${name}(?![\\w-])`).test(selector);
/** Whether the rule draws the class's own element and nothing else: its last part is the class alone (`.pp .pp-sr`). */
const onItself = (selector, name) => selector.split(/[\s>+~]+/).pop() === `.${name}` && selector.split(`.${name}`).length === 2;

test('no rule reaches another element through a class of the second map, and no stylesheet names a dropped class', () => {
  const all = selectors();
  const reaching = Object.keys(ONE_RULE).flatMap((name) =>
    all.filter((s) => naming(s, name) && !onItself(s, name)).map((s) => `${name}: ${s}`),
  );
  assert.deepEqual(reaching, []);
  const named = [...GONE].flatMap((name) => all.filter((s) => naming(s, name)).map((s) => `${name}: ${s}`));
  assert.deepEqual(named, []);
  // No class is in two tables, so one name has one outcome.
  assert.deepEqual(
    [...GONE].filter((name) => Object.hasOwn(CLASSES, name)),
    [],
  );
});

test('ranks the classes and parts left, commonest first', () => {
  const { classes, parts } = rank([
    '4: className "muted pay-total" (pay-total has no recipe)',
    '9: className "pay-total row" (pay-total row has no recipe)',
    '1: imports Card, Input from @intafaced/ui (Card: no recipe; Input: no recipe)',
    '2: imports Input from @intafaced/ui (Input: no recipe)',
    '5: className={…}, computed, needs judgement',
  ]);
  assert.deepEqual(classes, ['2 pay-total', '1 row']);
  assert.deepEqual(parts, ['2 Input', '1 Card']);
});

test('says why the commonest parts left have no twin', () => {
  const { left } = recipe('import { EmptyState, KeyValue, Table } from \'@intafaced/ui\';\nexport const a = <EmptyState title="t" />;\n');
  assert.equal(left.length, 1);
  assert.match(left[0], /^1: imports EmptyState, KeyValue, Table from @intafaced\/ui \(EmptyState: it takes its action as data/);
  assert.match(left[0], /KeyValue: it takes items/);
  assert.match(left[0], /Table: its columns are/);
});

test('a whole string of utilities moves to its one kit class, and only whole', () => {
  const { text, left } = recipe(
    'export const a = (\n  <div>\n    <p className="m-0 text-sm text-fg-2">x</p>\n    <div className="flex flex-col gap-2">y</div>\n    <p className="text-sm text-fg-2">z</p>\n    <div className="flex flex-col gap-2 p-3">w</div>\n  </div>\n);\n',
  );
  assert.match(text, /<p className="lt-hint">x/);
  assert.match(text, /<div className="lt-stack">y/);
  // Not in WHOLE as written: left whole, never half-moved.
  assert.match(text, /<p className="text-sm text-fg-2">z/);
  assert.match(text, /<div className="flex flex-col gap-2 p-3">w/);
  assert.equal(left.length, 2);
  // A utility a test finds an element by holds the whole string.
  const held = recipe('export const a = <div className="flex flex-col gap-2" />;\n', { found: new Set(['flex-col']) });
  assert.match(held.text, /flex flex-col gap-2/);
  assert.match(held.left[0], /a test finds an element by flex-col/);
  for (const kit of Object.values(WHOLE)) assert.match(kit, /^lt-[a-z-]+$/);
});

test('the third map: a row, a field row, a list and a mono face move whole; a hint string moves only where no margin is lost', () => {
  const { text, left } = recipe(
    [
      'export const a = <div className="flex flex-wrap items-center gap-2">a</div>;',
      'export const b = <div className="flex flex-wrap items-end gap-3">b</div>;',
      'export const c = <ul className="m-0 flex list-none flex-col gap-2 p-0">c</ul>;',
      'export const d = <span className="text-sm text-fg-2">d</span>;',
      'export const e = <p className="text-sm text-fg-2">e</p>;',
      'export const f = <span className="dk-tif-label">f</span>;',
      'export const g = <div className="vk-row">g</div>;',
      '',
    ].join('\n'),
  );
  assert.match(text, /<div className="lt-toolbar">a/);
  assert.match(text, /<div className="lt-field-row">b/);
  assert.match(text, /<ul className="lt-list">c/);
  assert.match(text, /<span className="lt-hint">d/);
  // A paragraph keeps the margin the kit's lt-hint sets to 0: left whole.
  assert.match(text, /<p className="text-sm text-fg-2">e/);
  assert.deepEqual(left, ['5: className "text-sm text-fg-2" (text-sm has no recipe)']);
  // A class whose twin is two kit classes takes both.
  assert.match(text, /<span className="lt-hint lt-nowrap">f/);
  assert.match(text, /<div className="lt-toolbar">g/);
  for (const kit of Object.values(WHOLE_UNSPACED)) assert.match(kit, /^lt-[a-z-]+$/);
});
