// A journey reads the answer to a page it navigates to only through `responseAfterNavigation`
// (apps/customer/tests/real-app/navigation.mjs). A `waitForResponse` set up before a `goto` or `reload` and awaited after it
// can be answered by a request the old page made just before the navigation, and the navigation then drops that answer's
// body, or the test reads the old page's answer as the new one's. Failures it prevents, one class (project-state #2065,
// class B): J-home-ia-06 #1 (#7452, red in 8 journeys runs from 9 to 10 Nov), J-charts-desk-09 #1 (#7919), J-wallet-04 #4
// (#7457). Run: node tooling/scripts/journey-navigation.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'apps/customer/tests/real-app');
const HELPER = 'navigation.mjs';

/**
 * Each place in `src` where a `waitForResponse` promise is kept (`const x = page.waitForResponse(...)`) and a `goto(` or
 * `reload(` runs before `x` is awaited or handed to `Promise.all`: `{ line, name }`, 1-based. A wait awaited where it is made,
 * or handed on before any navigation, is fine.
 */
export function waitsBeforeNavigation(src) {
  const lines = src.split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?!await\b)[\w$.]*\.waitForResponse\(/.exec(lines[i]);
    if (!m) continue;
    const name = m[1];
    const used = new RegExp(`(await\\s+\\(?\\s*${name}\\b|\\b${name}\\s*[,\\]]|\\[\\s*${name}\\b|\\b${name}\\.then\\()`);
    for (let j = i + 1; j < lines.length; j += 1) {
      if (used.test(lines[j])) break;
      if (/\.(goto|reload)\(/.test(lines[j])) {
        found.push({ line: i + 1, name });
        break;
      }
      // A function's end ends the search: the wait is out of scope.
      if (/^}/.test(lines[j])) break;
    }
  }
  return found;
}

// The rule on its own words.
assert.deepEqual(
  waitsBeforeNavigation(
    ['  const feed = page.waitForResponse((r) => r.url().includes("x"));', "  await page.goto('/notice');", '  await feed;'].join('\n'),
  ),
  [{ line: 1, name: 'feed' }],
  'a wait made before a goto and awaited after it is found',
);
assert.deepEqual(
  waitsBeforeNavigation(
    ['  const r = page.waitForResponse(m);', '  await page.reload();', '  const body = await (await r).json();'].join('\n'),
  ),
  [{ line: 1, name: 'r' }],
  'a reload is a navigation too',
);
assert.deepEqual(
  waitsBeforeNavigation(
    ['  const r = page.waitForResponse(m);', "  await page.getByRole('button').click();", '  await r;', "  await page.goto('/x');"].join(
      '\n',
    ),
  ),
  [],
  'a wait awaited before the navigation is fine',
);
assert.deepEqual(
  waitsBeforeNavigation(['  const r = await page.waitForResponse(m);', "  await page.goto('/x');"].join('\n')),
  [],
  'an awaited wait is fine',
);
assert.deepEqual(
  waitsBeforeNavigation(
    ['  const r = page.waitForResponse(m);', '  const [a] = await Promise.all([r, other]);', "  await page.goto('/x');"].join('\n'),
  ),
  [],
  'a wait handed to Promise.all before the navigation is fine',
);

// Every journey file and helper keeps to it; the helper itself is where the pattern is made safe.
const offenders = [];
for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs') && f !== HELPER)) {
  for (const hit of waitsBeforeNavigation(fs.readFileSync(path.join(DIR, file), 'utf8')))
    offenders.push(`apps/customer/tests/real-app/${file}:${hit.line} (${hit.name})`);
}
assert.deepEqual(
  offenders,
  [],
  `a response wait set up before a goto or reload, which the old page can answer; read it with responseAfterNavigation (${HELPER}) instead:\n${offenders.join('\n')}`,
);
console.log('journey-navigation: no response wait is set up before a navigation outside navigation.mjs');
