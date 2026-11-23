// node --test tooling/codemod/no-stale-read/rewrite.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rewrite } from './rewrite.mjs';

const one = (body) => rewrite(`test('x', async ({ page }) => {\n${body}\n});\n`);

test('a one-shot read in an assertion becomes a retried read judged by the same matcher', () => {
  const { out, done, left } = one(`  expect(ungroup(await panel.innerText())).toMatch(/Fee/);`);
  assert.match(out, /^ {2}await expect\.poll\(async \(\) => ungroup\(await panel\.innerText\(\)\)\)\.toMatch\(\/Fee\/\);$/mu);
  assert.equal(done.length, 1);
  assert.equal(left.length, 0);
});

test("expect's message is kept as the poll's message", () => {
  const { out } = one(`  expect(await row.getAttribute('data-status'), 'the lists were read').toBe('ready');`);
  assert.match(
    out,
    /await expect\.poll\(async \(\) => await row\.getAttribute\('data-status'\), 'the lists were read'\)\.toBe\('ready'\);/u,
  );
});

test('an object value is wrapped so the arrow returns it', () => {
  const { out } = one(`  expect({ a: await x.innerText() }).toEqual({ a: '1' });`);
  assert.match(out, /expect\.poll\(async \(\) => \(\{ a: await x\.innerText\(\) \}\)\)/u);
});

test('a read inside a function the assertion already retries (toPass) is not this shape', () => {
  const { done, left } = one(`  await expect(async () => { const t = await x.innerText(); expect(t).toBe('1'); }).toPass();`);
  assert.equal(done.length + left.length, 0);
});

for (const [why, body] of [
  ['inside toPass', `  await expect(async () => {\n    expect(await a.innerText()).toBe(v);\n  }).toPass();`],
  ['negated', `  expect(await panel.innerText()).not.toMatch(/Fee/);`],
  ['soft', `  expect.soft(await panel.innerText()).toBe('a');`],
  ['not a statement', `  const ok = expect(await panel.innerText()).toBe('a');`],
  ['options argument', `  expect(await panel.innerText(), opts).toBe('a');`],
  ['matcher awaits', `  expect(await a.innerText()).toBe(await b.innerText());`],
  ['awaits other work', `  expect(await f(await a.innerText())).toBe(1);`],
  ['assigns', `  expect((t = await a.innerText())).toBe('1');`],
  ['shared regex', `  expect(RE.exec(await a.innerText())[1]).toBe('1');`],
  ['equals a before snapshot', `  expect(await a.innerText()).toBe(shownBefore);`],
  ['equals an earlier screen read', `  const shown = await a.innerText();\n  expect(await a.innerText()).toEqual(shown);`],
  ['says it stayed', `  expect(await a.innerText(), 'the refused save changed nothing').toBe('x');`],
]) {
  test(`left as it is: ${why}`, () => {
    const src = `test('x', async ({ page }) => {\n${body}\n});\n`;
    const { out, done, left } = rewrite(src);
    assert.equal(out, src);
    assert.equal(done.length, 0);
    assert.equal(left.length, 1);
  });
}
