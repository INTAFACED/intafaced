// test-shards: the packing, the split into pieces, the coverage check on planted faults, and the real workspace's shards.
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHARD_COUNT } from './ci-affected.mjs';
import { SPLIT, coverage, plan, shardList, testPackages } from './test-shards.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

const pk = [
  { name: 'a', weight: 50 },
  { name: 'b', weight: 30 },
  { name: 'c', weight: 30 },
  { name: 'd', weight: 10 },
  { name: 'e', weight: 5 },
];

test('plan: every package once, deterministic, balanced', () => {
  const shards = plan(pk, 3);
  const all = shards.flatMap((s) => s.names).sort();
  assert.ok(JSON.stringify(all) === '["a","b","c","d","e"]', 'every package is in exactly one shard');
  assert.ok(JSON.stringify(plan(pk, 3)) === JSON.stringify(shards), 'the plan is deterministic');
  assert.ok(Math.max(...shards.map((s) => s.weight)) <= 50, 'no shard is heavier than the heaviest package here');
  assert.ok(plan(pk, 8).flatMap((s) => s.names).length === 5, 'more shards than packages still covers each once');
  assert.ok(
    plan([], 4).every((s) => s.names.length === 0),
    'an empty set gives empty shards',
  );
});

test('shardList: pieces after the whole packages, each piece alone in its shard', () => {
  const sp = shardList(pk, 4, { a: 2 });
  assert.ok(
    JSON.stringify(sp.map((s) => [s.names, s.piece])) ===
      JSON.stringify([
        [['b', 'd'], null],
        [['c', 'e'], null],
        [['a'], '1/2'],
        [['a'], '2/2'],
      ]),
    'a split package runs as its pieces, after the whole packages',
  );
  assert.ok(coverage(sp, pk).length === 0, 'the split covers every package once');
  let threw = false;
  try {
    shardList(pk, 2, { a: 2 });
  } catch {
    threw = true;
  }
  assert.ok(threw, 'too few shards for the pieces is refused, not an empty filter list');
});

test('coverage: planted faults are each named', () => {
  const sp = shardList(pk, 4, { a: 2 });
  const names = (list) => list.map((s) => ({ ...s, names: [...s.names] }));
  const has = (list, text) => coverage(list, pk).some((p) => p.includes(text));
  const dropped = names(sp);
  dropped[0].names = ['b'];
  assert.ok(has(dropped, 'd is in no shard'), 'a dropped package fails');
  const twice = names(sp);
  twice[1].names.push('b');
  assert.ok(has(twice, 'b runs more than once'), 'a package in two shards fails');
  const lostPiece = names(sp).slice(0, 3);
  assert.ok(has(lostPiece, 'a runs pieces 1/2, not 1/2, 2/2'), 'a lost piece fails');
  const wholeAndPiece = names(sp);
  wholeAndPiece[0].names.push('a');
  assert.ok(has(wholeAndPiece, 'a runs more than once'), 'a split package also run whole fails');
  const empty = [...names(sp), { names: [], piece: null }];
  assert.ok(has(empty, 'has no package'), 'an empty shard fails');
});

test('the real workspace: shards are disjoint and together equal the set `pnpm test` runs', () => {
  const real = testPackages(ROOT);
  assert.ok(real.length > 0, 'the workspace has test packages');
  for (const name of Object.keys(SPLIT))
    assert.ok(
      real.some((p) => p.name === name),
      `${name} is in SPLIT but has no test script; take it out of SPLIT`,
    );
  const realShards = shardList(real, SHARD_COUNT);
  assert.ok(realShards.length === SHARD_COUNT, 'one shard per matrix entry');
  const problems = coverage(realShards, real);
  assert.ok(problems.length === 0, `the real shards: ${problems.join('; ')}`);
});
