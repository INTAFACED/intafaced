/**
 * Shared path collision helpers for claim-check.mjs.
 * One algorithm — two call sites must not disagree about who owns a path.
 *
 * Paths are normalised (trailing slashes stripped) so `tooling/` and `tooling`
 * mean the same wall. Without that, claim-check reported ✓ clear for a directory
 * prefix with a trailing slash while open PRs already touched files under it —
 * the exact false-clear that lets two agents walk into the same tree unknowing.
 *
 * Self-test: node tooling/scripts/path-collide.mjs --self-test
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/** Strip trailing slashes so directory prefixes compare cleanly. */
export function normPath(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  // Collapse Windows separators, strip a single leading "./", collapse
  // internal // (tooling//ci must equal tooling/ci), then trailing slashes.
  let x = p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/');
  // Keep a lone "/" as root; otherwise drop trailing separators.
  return x.replace(/\/+$/, '') || '/';
}

/**
 * True when two paths are the same file/dir, or one is a strict ancestor of the other.
 * Order does not matter.
 */
export const touches = (a, b) => {
  const x = normPath(a);
  const y = normPath(b);
  if (typeof x !== 'string' || typeof y !== 'string') return false;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

export function filesCollide(filesA, filesB) {
  for (const a of filesA || []) {
    for (const b of filesB || []) {
      if (touches(a, b)) return true;
    }
  }
  return false;
}

function selfTest() {
  const fails = [];
  const assert = (c, m) => {
    if (!c) fails.push(m);
  };

  // THE REGRESSION: trailing slash on a wall prefix made claim-check lie "clear".
  assert(touches('tooling/', 'tooling/tracker/features.mjs') === true, 'tooling/ must touch child file');
  assert(touches('tooling', 'tooling/tracker/features.mjs') === true, 'tooling must touch child file');
  assert(touches('tooling/ci/', 'tooling/ci/gates.mjs') === true, 'tooling/ci/ must touch gates.mjs');
  assert(touches('tooling/ci', 'tooling/ci/gates.mjs') === true, 'tooling/ci must touch gates.mjs');

  // Exact match, either slash form.
  assert(touches('a/b', 'a/b') === true, 'exact match');
  assert(touches('a/b/', 'a/b') === true, 'exact match after norm');

  // Sibling dirs do not collide.
  assert(touches('tooling/ci', 'tooling/scripts') === false, 'sibling dirs');
  assert(touches('services/svc-bank', 'services/svc-pay') === false, 'sibling services');

  // Prefix that is only a string prefix of a sibling name must not collide
  // (startsWith(`${y}/`) requires the slash boundary).
  assert(touches('tooling/c', 'tooling/ci/gates.mjs') === false, 'string-prefix sibling not a wall');

  // filesCollide uses the same algorithm.
  assert(filesCollide(['tooling/'], ['tooling/tracker/features.mjs', 'docs/x.md']) === true, 'filesCollide trailing slash wall');
  assert(filesCollide(['docs/ops'], ['tooling/ci/gates.mjs']) === false, 'filesCollide disjoint');

  // normPath
  assert(normPath('tooling/') === 'tooling', 'normPath strips slash');
  assert(normPath('tooling//') === 'tooling', 'normPath strips many');
  assert(normPath('tooling') === 'tooling', 'normPath idempotent');
  assert(normPath('./tooling/ci/') === 'tooling/ci', 'normPath strips ./ and slash');
  assert(touches('./tooling', 'tooling/tracker/features.mjs') === true, './tooling must touch child');
  // Internal double-slash (paste / bad wall spelling) must not false-clear.
  assert(touches('tooling//ci', 'tooling/ci/gates.mjs') === true, 'internal // must collapse before touch');
  assert(normPath('tooling//ci//') === 'tooling/ci', 'normPath collapses internal and trailing //');

  if (fails.length) {
    console.error('path-collide --self-test FAIL:');
    for (const f of fails) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log('path-collide --self-test OK');
  console.log('  fixture trailing-slash wall prefix → touches (claim-check false-clear fix)');
  console.log('  fixture siblings / string-prefix → no touch');
  process.exit(0);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isDirectRun && process.argv.includes('--self-test')) selfTest();
