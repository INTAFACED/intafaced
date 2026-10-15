import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  actualCheckoutSha,
  classifyFailure,
  collectEvidence,
  parseFailureSignatures,
  parseInheritedDeclarations,
} from './merge-evidence.mjs';
import { GitHubRefusalError } from './gate-gh.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const REPO = 'owner/repo';
const ui = readFileSync(new URL('./fixtures/merge-gate/evidence-ui.log', import.meta.url), 'utf8');
const other = readFileSync(new URL('./fixtures/merge-gate/evidence-ui-other-defect.log', import.meta.url), 'utf8');
const money = readFileSync(new URL('./fixtures/merge-gate/evidence-money.log', import.meta.url), 'utf8');
const declaration = { owner: '@frontend', evidence: 'https://github.com/owner/repo/issues/123' };
// Explicit repository-manifest fixture: this suite also runs in tooling-only copies.
const workspaceRoots = new Map([
  ['@intafaced/ui', 'packages/ui'],
  ['@intafaced/ledger-client', 'packages/ledger-client'],
  ['@intafaced/i18n', 'packages/i18n'],
]);
const declarations = 'Inherited-Failure: CI/Tests (full) | owner=@frontend | evidence=https://github.com/owner/repo/issues/123';
const check = { workflow: 'CI', name: 'Tests (full)', bucket: 'fail', link: `https://github.com/${REPO}/actions/runs/200/job/201` };
const job = (id, conclusion = 'failure') => ({
  databaseId: id,
  name: check.name,
  status: 'completed',
  conclusion,
  steps: [
    { name: 'Run pnpm test --continue', status: 'completed', conclusion },
    { name: 'Every infrastructure-backed suite actually ran', status: 'completed', conclusion: 'success' },
  ],
});
const checkout = (sha, log = '') =>
  `Tests (full)\tCheckout repository\t2026-10-15T00:00:00.000Z [command]/usr/bin/git log -1 --format=%H\nTests (full)\tCheckout repository\t2026-10-15T00:00:00.001Z ${sha}\n${log}`;
const pure = (overrides = {}) =>
  classifyFailure({ check, headJob: job(201), baseJob: job(101), headLog: ui, baseLog: ui, declaration, workspaceRoots, ...overrides });

function fixture({
  headLog = ui,
  baseLog = ui,
  baseConclusion = 'failure',
  baseSha = BASE,
  headSha = HEAD,
  files = ['packages/ui/src/card.ts'],
  headWorkflow = 'CI',
  baseWorkflowId = 9,
  unfinished = false,
  runs = true,
  headJob = job(201),
  fakeCheckoutSha = headSha,
} = {}) {
  const calls = [];
  const run = (id, sha, jobs, workflowName = 'CI', workflowDatabaseId = 9) => ({
    databaseId: id,
    headSha: sha,
    workflowName,
    workflowDatabaseId,
    status: 'completed',
    conclusion: 'failure',
    jobs,
  });
  const headRun = run(200, headSha, [headJob], headWorkflow);
  const baseRun = run(100, baseSha, [job(101, baseConclusion)], 'CI', baseWorkflowId);
  if (unfinished) baseRun.jobs.push({ ...job(102), status: 'in_progress' });
  const gh = (args) => {
    calls.push(args);
    let data;
    if (args[0] === 'run' && args[1] === 'list') data = runs ? [baseRun] : [];
    else if (args.includes('--log'))
      return { status: 0, stdout: args[3] === '201' ? checkout(fakeCheckoutSha, headLog) : checkout(BASE, baseLog), stderr: '' };
    else if (args[2] === '200') data = headRun;
    else if (args[2] === '100') data = baseRun;
    else throw new Error(`unexpected gh ${args.join(' ')}`);
    return { status: 0, stdout: JSON.stringify(data), stderr: '' };
  };
  return { calls, gh, headRun, options: { gh, repo: REPO, head: HEAD, base: BASE, checks: [check], files, declarations, workspaceRoots } };
}

test('strict parser records complete error, assertion diff, location, and task', () => {
  const parsed = parseFailureSignatures(ui);
  assert.equal(parsed.readable, true);
  assert.equal(parsed.failures[0].task, '@intafaced/ui#test');
  assert.match(parsed.failures[0].signature, /expected 'Save'/);
  assert.match(parsed.failures[0].signature, /42:17/);
  assert.match(parsed.failures[0].signature, /\\n- Send/);
});

test('introduced failure: exact-base passing job blocks', () => {
  const result = pure({ baseJob: job(101, 'success') });
  assert.equal(result.classification, 'introduced');
  assert.equal(result.allowed, false);
});

test('inherited identical full failure requires unique owner and evidence', () => {
  assert.equal(pure().allowed, true);
  assert.equal(pure().classification, 'inherited');
  assert.equal(pure({ declaration: undefined }).allowed, false);
  assert.equal(parseInheritedDeclarations(declarations).get('CI/Tests (full)').owner, '@frontend');
  assert.equal(parseInheritedDeclarations(`${declarations}\n${declarations}`).get('CI/Tests (full)'), null);
  assert.equal(parseInheritedDeclarations(declarations.replace('https://', 'http://')).size, 0);
  assert.equal(parseInheritedDeclarations(`\`\`\`text\n${declarations}\n\`\`\``).size, 0);
});

test('two defects with same exact test name are introduced, never excused', () => {
  const result = pure({ headLog: other });
  assert.equal(result.classification, 'introduced');
  assert.equal(result.allowed, false);
  assert.equal(parseFailureSignatures(ui).failures[0].name, parseFailureSignatures(other).failures[0].name);
});

test('assertion diff changes alone block even when error first line and name match', () => {
  assert.equal(pure({ headLog: ui.replace('- Send', '- Submit') }).classification, 'introduced');
});

test('missing signature, location, task attribution and extra unhandled errors block unknown', () => {
  for (const headLog of [
    ui.replace(/AssertionError:.*\n/, ''),
    ui.replace(/ ❯.*\n/, ''),
    ui.replace('##[group]@intafaced/ui:test', ''),
    `${ui}\nUnhandled Rejection: oops`,
    ui.replace('@intafaced/ui#test', '@intafaced/ui#test, @intafaced/i18n#test'),
  ]) {
    assert.equal(pure({ headLog }).classification, 'unknown');
    assert.equal(pure({ headLog }).allowed, false);
  }
});

test('money invariant identical at base is blocked on unrelated UI PR', () => {
  const result = pure({ headLog: money, baseLog: money });
  assert.equal(result.classification, 'unknown');
  assert.equal(result.allowed, false);
  assert.match(result.reason, /protected/);
});

test('doctrine/security and task with unknown provenance never get inherited allowance', () => {
  for (const name of ['Doctrine gates', 'Security audit', 'Tests (money)'])
    assert.equal(pure({ check: { ...check, name } }).allowed, false);
  assert.equal(
    pure({ headLog: ui.replaceAll('@intafaced/ui', 'unknown'), baseLog: ui.replaceAll('@intafaced/ui', 'unknown') }).allowed,
    false,
  );
  assert.equal(
    pure({ headLog: ui.replaceAll('@intafaced/ui', '@intafaced/invented'), baseLog: ui.replaceAll('@intafaced/ui', '@intafaced/invented') })
      .allowed,
    false,
  );
  assert.equal(
    pure({
      headLog: ui.replaceAll('src/card.test.ts', 'packages/i18n/src/card.test.ts'),
      baseLog: ui.replaceAll('src/card.test.ts', 'packages/i18n/src/card.test.ts'),
    }).allowed,
    false,
  );
});

test('environmental startup failure is identified but blocks until tests actually run', () => {
  const result = pure({ headJob: { ...job(201, 'startup_failure'), steps: [] }, baseJob: undefined });
  assert.equal(result.classification, 'environmental');
  assert.equal(result.allowed, false);
});

test('infrastructure invariant failure cannot be excused by matching test signatures', () => {
  const withInvariant = (id) => ({ ...job(id), steps: job(id).steps.map((s) => ({ ...s, conclusion: 'failure' })) });
  assert.equal(pure({ headJob: withInvariant(201), baseJob: withInvariant(101) }).allowed, false);
  assert.equal(pure({ headJob: { ...job(201), steps: [job(201).steps[0]] } }).allowed, false);
});

test('checkout must be actual full SHA emitted by checkout step, once', () => {
  assert.equal(actualCheckoutSha(checkout(HEAD)), HEAD);
  assert.equal(actualCheckoutSha(HEAD), null);
  assert.equal(actualCheckoutSha(checkout(HEAD).replaceAll('Checkout repository', 'Run tests')), null);
  assert.equal(actualCheckoutSha(checkout(HEAD) + checkout(HEAD)), null);
});

test('collector uses exact commits and head check run/job link, no historical window', async () => {
  const f = fixture();
  const result = await collectEvidence(f.options);
  assert.equal(result.pass, true);
  assert.equal(result.classifications[0].classification, 'inherited');
  assert.equal(result.classifications[0].headRunId, '200');
  assert.equal(result.classifications[0].baseRunId, '100');
  const list = f.calls.find((a) => a[1] === 'list');
  assert.equal(list[list.indexOf('--commit') + 1], BASE);
  assert.equal(
    f.calls.some((a) => a.includes('--branch')),
    false,
  );
});

test('collector classifies introduced with exact actual base passing evidence', async () => {
  const f = fixture({ baseConclusion: 'success', baseLog: '' });
  const result = await collectEvidence(f.options);
  assert.equal(result.classifications[0].classification, 'introduced');
  assert.equal(result.pass, false);
});

test('wrong SHA, synthetic merge checkout, missing exact base and unfinished jobs block unknown', async () => {
  for (const options of [
    { baseSha: 'c'.repeat(40) },
    { headSha: 'c'.repeat(40) },
    { fakeCheckoutSha: 'c'.repeat(40) },
    { runs: false },
    { unfinished: true },
    { headWorkflow: 'Spoof' },
    { baseWorkflowId: 10 },
  ]) {
    const f = fixture(options);
    const result = await collectEvidence(f.options);
    assert.equal(result.pass, false, JSON.stringify(options));
    assert.equal(result.classifications[0].classification, 'unknown', JSON.stringify(options));
  }
});

test('test selection changes and unknown job coverage block inherited excuse', async () => {
  const f = fixture({ files: ['.github/workflows/ci.yml'] });
  assert.equal((await collectEvidence(f.options)).pass, false);
  const result = pure({ coverageProblem: 'unknown scope' });
  assert.equal(result.classification, 'unknown');
});

test('foreign repository or mismatched job link cannot bind check to another run', async () => {
  for (const link of [
    'https://github.com/evil/repo/actions/runs/200/job/201',
    'https://github.com/owner/repo/actions/runs/200/job/999',
    'https://evil.test/owner/repo/actions/runs/200/job/201',
  ]) {
    const f = fixture();
    f.options.checks = [{ ...check, link }];
    assert.equal((await collectEvidence(f.options)).pass, false);
  }
});

test('green checks perform no baseline calls, mandatory failures are handled by caller', async () => {
  const gh = () => {
    throw new Error('unexpected call');
  };
  const result = await collectEvidence({
    gh,
    repo: REPO,
    head: HEAD,
    base: BASE,
    checks: [
      { ...check, bucket: 'pass' },
      { workflow: 'Gitleaks', name: 'Gitleaks', bucket: 'fail' },
    ],
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.classifications, []);
});

test('GitHub refusal escapes immediately without fallback or retry', async () => {
  let calls = 0;
  const f = fixture();
  f.options.gh = () => {
    calls++;
    throw new GitHubRefusalError('HTTP 403');
  };
  await assert.rejects(collectEvidence(f.options), GitHubRefusalError);
  assert.equal(calls, 1);
});

const sealLog = readFileSync(new URL('./fixtures/merge-gate/evidence-seal.log', import.meta.url), 'utf8');
function sealFixture({
  log = sealLog,
  sha = HEAD,
  additionalStep = false,
  additionalJob = false,
  differentRun = false,
  fullLog = ui,
  owner = declarations,
} = {}) {
  const f = fixture({ headLog: fullLog });
  const seal = {
    databaseId: 202,
    name: 'CI merge seal',
    status: 'completed',
    conclusion: 'failure',
    steps: [{ name: 'Require needed jobs', status: 'completed', conclusion: 'failure' }],
  };
  if (additionalStep) seal.steps.push({ name: 'Checkout', status: 'completed', conclusion: 'failure' });
  f.headRun.jobs.push(
    seal,
    ...['Affected shards', 'Doctrine gates', 'Format', 'Typecheck & build'].map((name, i) => ({
      databaseId: 210 + i,
      name,
      status: 'completed',
      conclusion: 'success',
      steps: [],
    })),
  );
  if (additionalJob) f.headRun.jobs.find((j) => j.name === 'Doctrine gates').conclusion = 'failure';
  const originalGh = f.gh;
  f.options.gh = (args) => {
    if (args.includes('--log') && args[3] === '202') return { status: 0, stdout: checkout(sha, log), stderr: '' };
    if (args[0] === 'run' && args[1] === 'view' && args[2] === '300')
      return { status: 0, stdout: JSON.stringify({ ...f.headRun, databaseId: 300 }), stderr: '' };
    return originalGh(args);
  };
  f.options.checks = [
    { ...check, name: 'CI merge seal', link: `https://github.com/${REPO}/actions/runs/${differentRun ? 300 : 200}/job/202` },
    check,
  ];
  f.options.declarations = owner;
  return f;
}

test('derived merge seal passes only for sole allowed inherited full test in same actual-head run', async () => {
  const f = sealFixture();
  const result = await collectEvidence(f.options);
  assert.equal(result.pass, true, result.reasons.join('; '));
  const seal = result.classifications.find((c) => c.check === 'CI/CI merge seal');
  assert.equal(seal.classification, 'inherited');
  assert.equal(seal.derived, true);
  assert.equal(seal.derivedFrom, 'CI/Tests (full)');
  assert.equal(seal.owner, declaration.owner);
  assert.equal(seal.evidence, declaration.evidence);
  assert.equal(seal.headRunId, '200');
  assert.equal(seal.baseRunId, '100');
  const renderedAnnotation = sealLog.replace('::error title=CI merge seal::', '##[error]');
  assert.equal((await collectEvidence(sealFixture({ log: renderedAnnotation }).options)).pass, true);
});

test('derived merge seal blocks extra failure reasons, error annotations, and errors', async () => {
  const extra = (text) => `CI merge seal\tRequire needed jobs\t2026-10-15T00:00:00.009Z ${text}\n`;
  for (const log of [
    sealLog + extra('  - format was failure (required)'),
    sealLog + extra('::error title=CI merge seal::format was failure (required)'),
    sealLog + extra('Error: failed to execute script'),
    sealLog.replace('tests-full was failure (full run required)', 'tests-full was skipped (full run required)'),
  ]) {
    const result = await collectEvidence(sealFixture({ log }).options);
    assert.equal(result.pass, false);
    assert.equal(result.classifications.find((c) => c.check === 'CI/CI merge seal').allowed, false);
  }
});

test('derived merge seal blocks other failed steps/jobs and mismatching head or run', async () => {
  for (const config of [{ additionalStep: true }, { additionalJob: true }, { sha: BASE }, { differentRun: true }]) {
    const result = await collectEvidence(sealFixture(config).options);
    assert.equal(result.pass, false, JSON.stringify(config));
    assert.equal(result.classifications.find((c) => c.check === 'CI/CI merge seal').allowed, false);
  }
});

test('derived merge seal never upgrades unknown, introduced, missing or ownerless upstream', async () => {
  for (const config of [{ fullLog: '' }, { fullLog: other }, { owner: '' }]) {
    const result = await collectEvidence(sealFixture(config).options);
    assert.equal(result.pass, false);
    assert.equal(result.classifications.find((c) => c.check === 'CI/CI merge seal').allowed, false);
  }
  const f = sealFixture();
  f.options.checks = [f.options.checks[0]];
  assert.equal((await collectEvidence(f.options)).pass, false);
});
