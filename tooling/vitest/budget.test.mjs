// Every package whose tests run on vitest takes the one shared budget (tooling/vitest/budget.mjs), so a new package or a
// new config can't fall back to vitest's 5 s / 10 s defaults and go red on a loaded runner (#7659, #8213, #8217, #8218,
// #8309, #8605). It reads each package's `test` script and its vitest config as text; it runs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AREAS = ['apps', 'packages', 'services', 'tooling'];
const CONFIGS = ['vitest.config.ts', 'vitest.config.mts', 'vitest.config.mjs', 'vitest.config.js'];
// Named, with the reason; nothing else is let off.
const NOT_YET = {
  // Its vitest reads vite.config.ts, the app's build config (no vitest.config of its own); giving it one would drop the
  // build's plugins from its tests, so its budget is its own change.
  'apps/customer': 'vitest reads the build config vite.config.ts',
};

/** Each package (`<area>/<name>`) whose `test` script runs vitest. */
export function vitestPackages(root = ROOT) {
  const found = [];
  for (const area of AREAS) {
    const dir = join(root, area);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pj = join(dir, name, 'package.json');
      if (!existsSync(pj)) continue;
      const script = JSON.parse(readFileSync(pj, 'utf8')).scripts?.test ?? '';
      if (/\bvitest\b/u.test(script)) found.push(`${area}/${name}`);
    }
  }
  return found.sort();
}

/** Why this package's vitest runs without the shared budget, or null when it takes it. */
export function missingBudget(pkg, root = ROOT) {
  const file = CONFIGS.map((c) => join(root, pkg, c)).find((p) => existsSync(p));
  if (!file) return 'no vitest config, so vitest runs on its 5 s / 10 s defaults';
  const text = readFileSync(file, 'utf8');
  if (!/from ['"][./]*(?:tooling\/)?vitest\/budget\.mjs['"]/u.test(text))
    return `${file.slice(root.length + 1)} does not import tooling/vitest/budget.mjs`;
  if (!/\.\.\.TEST_BUDGET\b/u.test(text)) return `${file.slice(root.length + 1)} does not spread TEST_BUDGET into test`;
  return null;
}

test('every package whose tests run on vitest takes the shared budget', () => {
  const pkgs = vitestPackages();
  assert.ok(pkgs.length > 40, `found only ${pkgs.length} vitest packages: the walk is broken`);
  const missing = pkgs
    .filter((p) => !(p in NOT_YET))
    .map((p) => [p, missingBudget(p)])
    .filter(([, why]) => why);
  assert.deepEqual(
    missing.map(([p, why]) => `${p}: ${why}`),
    [],
    "add `import { TEST_BUDGET } from '<relative path>/tooling/vitest/budget.mjs'` and `test: { ...TEST_BUDGET, ... }` to its vitest config",
  );
});

test('a let-off names a package that still runs vitest', () => {
  const pkgs = new Set(vitestPackages());
  for (const p of Object.keys(NOT_YET)) assert.ok(pkgs.has(p), `${p} is let off but no longer runs vitest: drop it from NOT_YET`);
});
