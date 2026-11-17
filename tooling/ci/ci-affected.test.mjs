import test from 'node:test';
import nodeAssert from 'node:assert/strict';
import {
  affectedFilters,
  buildFilters,
  classify,
  diffBase,
  mergeEdges,
  runsEverything,
  sealNeeded,
  shardMatrix,
  testedPackages,
} from './ci-affected.mjs';
import { detectedEdges } from './cross-package-reads.mjs';

const assert = (cond, msg) => nodeAssert.ok(cond, msg);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const none = { full: false, affected: false };

test('classify: each path lands in full, affected or neither', () => {
  const cases = [
    { files: ['services/svc-protocol/src/audit/pipeline.ts'], expected: { full: false, affected: true } },
    { files: ['services/svc-token/src/token-service.ts', 'apps/customer/src/x.tsx'], expected: { full: false, affected: true } },
    { files: ['packages/ledger-client/src/index.ts'], expected: { full: true, affected: false } },
    { files: ['packages/config/src/index.ts'], expected: { full: true, affected: false } },
    { files: ['packages/auth/src/index.ts'], expected: { full: true, affected: false } },
    { files: ['packages/contracts/src/x.ts'], expected: { full: true, affected: false } },
    { files: ['packages/events/src/catalog.ts'], expected: { full: true, affected: false } },
    { files: ['tooling/ci/gates.mjs'], expected: { full: true, affected: false } },
    { files: ['tooling/infra/postgres-init/01-service-schemas.sql'], expected: { full: true, affected: false } },
    { files: ['.github/workflows/ci.yml'], expected: { full: true, affected: false } },
    { files: ['pnpm-lock.yaml'], expected: { full: true, affected: false } },
    { files: ['turbo.json'], expected: { full: true, affected: false } },
    { files: ['tsconfig.base.json'], expected: { full: true, affected: false } },
    { files: ['AGENTS.md'], expected: { full: true, affected: false } },
    { files: ['CLAUDE.md'], expected: { full: true, affected: false } },
    { files: ['.cursor/rules/x.mdc'], expected: { full: true, affected: false } },
    { files: ['vendor/x/y.ts'], expected: { full: true, affected: false } },
    { files: ['services/svc-trade/CLAUDE.md'], expected: { full: true, affected: false } },
    { files: ['tooling/agent-protocol/AGENT_PROTOCOL.md'], expected: { full: true, affected: false } },
    { files: ['docs/agents/build-slice.md'], expected: { full: true, affected: false } },
    { files: ['docs/CODEOWNERS'], expected: { full: true, affected: false } },
    { files: ['.claude/agents/explore.md'], expected: { full: true, affected: false } },
    { files: ['services/svc-x/SKILL.md'], expected: { full: true, affected: false } },
    { files: ['.github/pull_request_template.md'], expected: { full: true, affected: false } },
    { files: ['docs/x.md'], expected: none },
    { files: ['services/svc-trade/README.md'], expected: none },
    { files: [], expected: none },
    { files: ['docs/x.md', 'services/svc-trade/src/a.ts'], expected: { full: false, affected: true } },
  ];
  for (const c of cases) {
    const got = classify(c.files);
    assert(same(got, c.expected), `classify(${JSON.stringify(c.files)}) => ${JSON.stringify(got)} expected ${JSON.stringify(c.expected)}`);
  }
  const forced = classify(['services/svc-protocol/x.ts'], { forceFull: true });
  assert(forced.full === true && forced.affected === false, 'forceFull must short-circuit to full');
});

test('filters: dependents of what changed, plus the readers of the changed package', () => {
  const edges = { 'apps/customer': ['services/svc-trade', 'services/svc-pay'], 'apps/admin': ['services/svc-bank'] };
  assert(
    same(affectedFilters(['services/svc-trade/src/a.ts'], edges), ['...[origin/main]', './apps/customer']),
    'a reader of svc-trade is selected when svc-trade changes',
  );
  assert(same(affectedFilters(['services/svc-ledger/src/a.ts'], edges), ['...[origin/main]']), 'unrelated change selects no reader');
  assert(
    same(affectedFilters(['services/svc-pay/a.ts', 'services/svc-bank/b.ts'], edges), [
      '...[origin/main]',
      './apps/customer',
      './apps/admin',
    ]),
    'every reader of every changed package is selected',
  );
  assert(!affectedFilters(['services/svc-trade-extra/a.ts'], edges).includes('./apps/customer'), 'a prefix sibling is not a match');
  assert(
    same(buildFilters(['services/svc-bank/b.ts'], edges), ['...[origin/main]', './apps/admin', './services/svc-bank']),
    'a selected reader builds every package it reads',
  );
  assert(same(buildFilters(['services/svc-ledger/src/a.ts'], edges), ['...[origin/main]']), 'no reader selected, nothing added');
});

test('base and trigger: merge-base, run-everything events, edges', () => {
  const sha = 'a'.repeat(40);
  assert(diffBase(() => `${sha}\n`, 'origin/main') === sha, 'turbo compares against the merge-base, not the moving branch tip');
  assert(diffBase(() => 'not a sha', 'origin/main') === 'origin/main', 'an odd answer falls back to the branch tip');
  assert(runsEverything({ GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push' }), 'a push to main runs everything');
  assert(
    runsEverything({ GITHUB_REF: 'refs/heads/gh-readonly-queue/main/pr-1-' + 'a'.repeat(40), GITHUB_EVENT_NAME: 'merge_group' }),
    'a merge queue commit runs everything',
  );
  assert(!runsEverything({ GITHUB_REF: 'refs/pull/1/merge', GITHUB_EVENT_NAME: 'pull_request' }), 'a pull request runs what it changed');
  assert(!runsEverything({ GITHUB_REF: 'refs/heads/x', GITHUB_EVENT_NAME: 'push' }), 'a push elsewhere is not main');
  assert(
    diffBase(() => {
      throw new Error('no merge base');
    }, 'origin/main') === 'origin/main',
    'no merge base falls back to the branch tip',
  );
  assert(same(affectedFilters(['x'], {}, sha), [`...[${sha}]`]), 'the base reaches the filter');
  assert(
    same(Object.entries(mergeEdges({ 'apps/a': ['x', 'y'] }, { 'apps/a': ['y', 'z'], 'apps/b': ['x'] })).flat(2), [
      'apps/a',
      'x',
      'y',
      'z',
      'apps/b',
      'x',
    ]),
    'declared and detected edges merge without duplicates',
  );
  assert(detectedEdges()['apps/customer']?.includes('services/svc-trade'), 'a read the scan finds becomes an edge with no declaration');
});

test('seal: the required jobs a classification needs', () => {
  const ok = { changes: 'success', gates: 'success', format: 'success', build: 'success' };
  assert(sealNeeded(none, ok).length === 0, 'docs only needs no test job');
  assert(sealNeeded({ full: false, affected: true }, { ...ok, 'tests-full': 'success' }).length === 0, 'affected run green');
  assert(
    sealNeeded({ full: false, affected: true }, { ...ok, 'tests-full': 'skipped' }).length === 1,
    'skipped test job is a failure when tests were needed',
  );
  assert(sealNeeded({ full: true, affected: false }, { ...ok, 'tests-full': 'failure' }).length === 1, 'full run red');
  assert(sealNeeded({ full: true, affected: false }, { ...ok, build: 'failure', 'tests-full': 'success' }).length === 1, 'build red');
});

test('shards: how many test jobs a run takes', () => {
  assert(
    same(
      shardMatrix({ full: true }),
      Array.from({ length: 16 }, (_, i) => `${i + 1}/16`),
    ),
    'a full run is split sixteen ways',
  );
  assert(same(shardMatrix({ full: false, affected: true }), ['changed']), 'an affected run is one job');
  const sixteen = Array.from({ length: 16 }, (_, i) => `${i + 1}/16`);
  const narrow = ['@intafaced/customer', '@intafaced/mobile', '@intafaced/svc-edge', '@intafaced/ui'];
  assert(same(shardMatrix({ full: false, affected: true }, narrow), ['changed']), 'a narrow affected run stays one job');
  assert(
    same(shardMatrix({ full: false, affected: true }, [...narrow, '@intafaced/svc-trade']), sixteen),
    'an affected run that tests a SPLIT package takes the sixteen shards',
  );
  assert(same(shardMatrix({ full: false, affected: true }, null), sixteen), 'an unknown tested set takes the sixteen shards');
  assert(same(shardMatrix({ full: false, affected: false }, null), ['changed']), 'docs only stays as it was');
});

test('tested packages: what turbo says a filter tests', () => {
  const dry = JSON.stringify({
    tasks: [
      { task: 'test', package: '@intafaced/svc-trade', command: 'vitest run' },
      { task: 'build', package: '@intafaced/ledger-client', command: 'tsc' },
      { task: 'test', package: '@intafaced/config', command: '<NONEXISTENT>' },
      { task: 'test', package: '@intafaced/customer', command: 'vitest run' },
    ],
  });
  assert(
    same(
      testedPackages(['x'], () => dry),
      ['@intafaced/customer', '@intafaced/svc-trade'],
    ),
    'only packages with a test script count',
  );
  assert(
    testedPackages(['x'], () => {
      throw new Error('turbo failed');
    }) === null,
    'turbo failing is unknown, not narrow',
  );
  assert(same(testedPackages(['./services/svc-trade']), ['@intafaced/svc-trade']), 'the real turbo names what a filter tests');
});
