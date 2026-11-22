// The Volt recipe's codemod (volt-recipe.mjs): what it moves onto the kit, and what it leaves for judgement.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSync } from 'oxc-parser';
import { readFileSync } from 'node:fs';
import { CLASSES, recipe } from './volt-recipe.mjs';

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

test("every class the map moves to is the kit's own", () => {
  const css = readFileSync(new URL('../../packages/ui/src/lit/templates/templates.css', import.meta.url), 'utf8');
  const missing = [...new Set(Object.values(CLASSES))].filter((kit) => !new RegExp(`\\.${kit}[\\s,{:]`).test(css));
  assert.deepEqual(missing, []);
});
