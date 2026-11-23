// No package's `test` script rebuilds its own `dist`. CI runs `turbo run test --concurrency=3`, so one package's tests
// run beside another's; a test script that ran `tsc` rewrote `dist/*.js` while the other package's vitest read it, and a
// half-written file loaded with no exports. Every file of the reading package then failed at import, and passed on the
// re-run of the same commit: svc-protocol (#9331), svc-notify (#9374) and svc-support (#9461) on @intafaced/contracts.
// A package whose tests need its own build says so in turbo.json (`"<pkg>#test": { "dependsOn": ["^build", "build"] }`),
// the one build every dependent's `^build` also waits for. It reads each package.json as text; it runs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AREAS = ['apps', 'packages', 'services', 'tooling'];
// The scripts a package manager runs as part of `test`.
const SCRIPTS = ['pretest', 'test'];

/** Why this script rebuilds the package's dist, or null when it does not. `build:jar` and `build-wrap.mjs` are not it. */
export function buildsDist(script) {
  if (/(?:^|[\s/&;|(])tsc(?:\.mjs)?(?=$|[\s&;|)])/u.test(script)) return 'runs tsc';
  if (/(?:^|[\s&;|(])(?:pnpm|npm|yarn|turbo)\s+(?:run\s+)?build(?![\w:-])/u.test(script)) return 'runs the build script';
  return null;
}

/** Each `<area>/<name>: <script> <why>` whose test scripts rebuild dist. */
export function rebuildingTests(root = ROOT) {
  const found = [];
  for (const area of AREAS) {
    const dir = join(root, area);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pj = join(dir, name, 'package.json');
      if (!existsSync(pj)) continue;
      const scripts = JSON.parse(readFileSync(pj, 'utf8')).scripts ?? {};
      for (const key of SCRIPTS) {
        const why = typeof scripts[key] === 'string' ? buildsDist(scripts[key]) : null;
        if (why) found.push(`${area}/${name}: ${key} ${why}`);
      }
    }
  }
  return found.sort();
}

test("no package's test script rebuilds its dist while other packages' tests read it", () => {
  assert.deepEqual(
    rebuildingTests(),
    [],
    'make the test script `vitest run` alone, and give the package `"<pkg>#test": { "dependsOn": ["^build", "build"] }` in turbo.json',
  );
});

test('the check refuses the scripts that raced, and passes the ones that do not build dist', () => {
  // The script @intafaced/contracts had when #9331 failed (f7e5a69228), and the other ways to say it.
  for (const script of [
    'tsc -p tsconfig.json && vitest run',
    'node ../../tooling/scripts/tsc.mjs -p tsconfig.json && vitest run',
    'pnpm build && vitest run',
    'pnpm run build && vitest run',
    'npm run build; vitest run',
  ])
    assert.ok(buildsDist(script), script);
  for (const script of [
    'vitest run',
    'pnpm --filter @intafaced/sbe-codec run build:jar && vitest run',
    'node ./scripts/build-wrap.mjs --check && node --test ./scripts/build-wrap.test.mjs',
    'node --test tsc.test.mjs',
  ])
    assert.equal(buildsDist(script), null, script);

  const root = mkdtempSync(join(tmpdir(), 'test-no-build-'));
  try {
    const plant = (name, scripts) => {
      mkdirSync(join(root, 'packages', name), { recursive: true });
      writeFileSync(join(root, 'packages', name, 'package.json'), JSON.stringify({ scripts }));
    };
    plant('raced', { test: 'tsc -p tsconfig.json && vitest run' });
    plant('pre', { pretest: 'pnpm build', test: 'vitest run' });
    plant('clean', { build: 'tsc -p tsconfig.json', test: 'vitest run' });
    assert.deepEqual(rebuildingTests(root), ['packages/pre: pretest runs the build script', 'packages/raced: test runs tsc']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
