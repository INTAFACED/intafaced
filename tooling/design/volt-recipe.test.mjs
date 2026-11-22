// The Volt recipe's codemod (volt-recipe.mjs): what it moves onto the kit, and what it leaves for judgement.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSync } from 'oxc-parser';
import { recipe } from './volt-recipe.mjs';

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
    '1: imports Button, Card from @intafaced/ui (only Button has a recipe)',
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
    '3: <Button variant="buy">, which the kit has no tone for',
    '4: <Button loading={busy}> without a disabled that names it',
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
