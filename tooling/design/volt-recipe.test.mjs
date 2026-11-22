// The Volt recipe's codemod (volt-recipe.mjs): what it moves onto the kit, and what it leaves for judgement.
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
    '<Button variant="buy">Buy</Button>',
    '<p className="money-check">x</p>',
    '<p className={cls}>y</p>',
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
      '<Button size={32} variant="primary">a</Button>',
      '<Button variant="buy">b</Button>',
      '<Button loading={busy}>c</Button>',
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
