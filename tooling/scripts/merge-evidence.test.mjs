import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  actualCheckoutSha,
  TEST_JOB_POLICY,
  normalizeTestLog,
  parseTestExecution,
  classifyFailure,
  collectEvidence,
  opusPatchQuoted,
  parseFailureSignatures,
  parseInheritedDeclarations,
} from './merge-evidence.mjs';
import { GitHubRefusalError } from './gate-gh.mjs';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const MERGE = 'e'.repeat(40);
const REPO = 'owner/repo';
const ui = readFileSync(new URL('./fixtures/merge-gate/evidence-ui.log', import.meta.url), 'utf8');
const other = readFileSync(new URL('./fixtures/merge-gate/evidence-ui-other-defect.log', import.meta.url), 'utf8');
const money = readFileSync(new URL('./fixtures/merge-gate/evidence-money.log', import.meta.url), 'utf8');
const passedUi = ui
  .replace(/ FAIL [\s\S]*?(?=Test Files)/, '')
  .replaceAll('1 failed', '1 passed')
  .replace(/^Failed:.*$/m, '');
const backstopOutput =
  '\nTests (full)\tEvery infrastructure-backed suite actually ran\t2026-10-15T00:00:03Z   ✓ COMPLETE — every infrastructure-backed suite executed.\n';
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
  `Tests (full)\tCheckout repository\t2026-10-15T00:00:00.000Z [command]/usr/bin/git log -1 --format=%H\nTests (full)\tCheckout repository\t2026-10-15T00:00:00.001Z ${sha}\nTests (full)\tRun pnpm test --continue\t2026-10-15T00:00:00.002Z ##[group]Run pnpm test --continue\n${log}${backstopOutput}`;
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
  fakeCheckoutSha = MERGE,
} = {}) {
  const calls = [];
  const run = (id, sha, jobs, workflowName = 'CI', workflowDatabaseId = 9) => ({
    databaseId: id,
    headSha: sha,
    event: id === 200 ? 'pull_request' : 'push',
    workflowName,
    workflowDatabaseId,
    status: 'completed',
    conclusion: 'failure',
    jobs,
  });
  const headRun = run(200, headSha, [headJob], headWorkflow);
  const baseRun = run(100, baseSha, [job(101, baseConclusion)], 'CI', baseWorkflowId);
  if (unfinished) baseRun.jobs.push({ ...job(102), status: 'in_progress' });
  if (baseConclusion === 'success' && baseLog === ui) baseLog = passedUi;
  const gh = (args) => {
    calls.push(args);
    let data;
    if (args[0] === 'api' && args[1] === `repos/${REPO}/commits/${MERGE}`) data = { sha: MERGE, parents: [{ sha: BASE }, { sha: HEAD }] };
    else if (args[0] === 'run' && args[1] === 'list') data = runs ? [baseRun] : [];
    else if (args.includes('--log'))
      return { status: 0, stdout: args[3] === '201' ? checkout(fakeCheckoutSha, headLog) : checkout(BASE, baseLog), stderr: '' };
    else if (args[2] === '200') data = headRun;
    else if (args[2] === '100') data = baseRun;
    else throw new Error(`unexpected gh ${args.join(' ')}`);
    return { status: 0, stdout: JSON.stringify(data), stderr: '' };
  };
  return {
    calls,
    gh,
    headRun,
    baseRun,
    options: { gh, repo: REPO, head: HEAD, base: BASE, mergeSha: MERGE, checks: [check], files, declarations, workspaceRoots },
  };
}

test('strict parser records complete error, assertion diff, location, and task', () => {
  const parsed = parseFailureSignatures(ui);
  assert.equal(parsed.readable, true);
  assert.equal(parsed.failures[0].task, '@intafaced/ui#test');
  assert.match(parsed.failures[0].signature, /expected 'Save'/);
  assert.match(parsed.failures[0].signature, /42:17/);
  assert.match(parsed.failures[0].signature, /\\n- Send/);
});

test('failed summary totals must account for every test and file with complete footers', () => {
  for (const headLog of [
    ui.replace('Tests  1 failed (1)', 'Tests  2 failed (2)'),
    ui.replace('Test Files  1 failed (1)', 'Test Files  2 failed (2)'),
    ui.replace('Tests  1 failed (1)', ''),
    ui.replace('Test Files  1 failed (1)', ''),
    ui.slice(0, ui.indexOf('Test Files')) + '\nFailed: @intafaced/ui#test',
    ui.replace('Tests  1 failed (1)', 'Tests  1 failed (2)'),
    ui.replace('Tests  1 failed (1)', 'Tests  1 failed (1)\nTests  1 failed (1)'),
  ]) {
    assert.equal(parseFailureSignatures(headLog).readable, false, headLog);
    assert.equal(pure({ headLog }).classification, 'unknown', headLog);
  }
});

test('accounts for repeated names and multiple files without collapsing failures', () => {
  const block = ui.slice(ui.indexOf(' FAIL '), ui.indexOf('Test Files'));
  const repeated = ui.replace('Test Files', `${block}Test Files`).replace('Tests  1 failed (1)', 'Tests  2 failed (2)');
  const sameFile = parseFailureSignatures(repeated);
  assert.equal(sameFile.readable, true, sameFile.issues.join('; '));
  assert.equal(sameFile.failures.length, 2);
  const multiFile = repeated
    .replace(block, block.replaceAll('src/card.test.ts', 'src/other.test.ts'))
    .replace('Test Files  1 failed (1)', 'Test Files  2 failed (2)');
  const parsed = parseFailureSignatures(multiFile);
  assert.equal(parsed.readable, true, parsed.issues.join('; '));
  assert.equal(new Set(parsed.failures.map((f) => f.file)).size, 2);
  assert.equal(parseFailureSignatures(multiFile.replace(block, '')).readable, false, 'omitted second FAIL cannot match the footer');
});

test('each failing task needs its own accounting, including prefixed task logs', () => {
  const combined =
    ui.replace('Failed:    @intafaced/ui#test', '') +
    ui
      .replaceAll('@intafaced/ui', '@intafaced/i18n')
      .replace('Failed:    @intafaced/i18n#test', 'Failed: @intafaced/ui#test, @intafaced/i18n#test');
  assert.equal(parseFailureSignatures(combined).readable, true);
  assert.equal(parseFailureSignatures(combined.replace('Tests  1 failed (1)', 'Tests  2 failed (2)')).readable, false);
  const prefixed = ui
    .split('\n')
    .map((line) => (line.startsWith('Failed:') || line.startsWith('##[') ? line : `@intafaced/ui:test: ${line}`))
    .join('\n');
  assert.equal(parseFailureSignatures(prefixed).readable, true);
});

test('suite load failures count as failed files rather than failed tests', () => {
  const suite = ui
    .replace(' FAIL src/card.test.ts > Card > renders label', ' FAIL src/card.test.ts [ src/card.test.ts ]')
    .replace('Tests  1 failed (1)', 'Tests  no tests');
  const parsed = parseFailureSignatures(suite);
  assert.equal(parsed.readable, true, parsed.issues.join('; '));
  assert.equal(parsed.failures[0].kind, 'suite');
  assert.equal(parseFailureSignatures(suite.replace('Tests  no tests', 'Tests  1 failed (1)')).readable, false);
  assert.equal(parseFailureSignatures(suite.replace(/AssertionError:.*\n/, '')).readable, false);
  assert.equal(parseFailureSignatures(suite.replace(/ ❯.*\n/, '')).readable, false);
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

test('money invariant already failing on main is no new failure; a new money workspace still blocks', () => {
  const same = pure({ headLog: money, baseLog: money });
  assert.equal(same.classification, 'inherited');
  assert.equal(same.allowed, true);
  assert.equal(same.noNewFailures, true);
  assert.match(same.reason, /no new failing workspaces/);
  const added = pure({ headLog: money, baseLog: ui });
  assert.equal(added.classification, 'introduced');
  assert.equal(added.allowed, false);
});

test('a protected full-suite failure matching main is excused only when the PR leaves that workspace untouched', () => {
  const elsewhere = pure({ headLog: money, baseLog: money, files: ['tooling/scripts/a.mjs'] });
  assert.equal(elsewhere.allowed, true);
  assert.equal(elsewhere.noNewFailures, true);
  const untouchedUi = pure({ headLog: money, baseLog: money, files: ['packages/ui/src/card.ts'] });
  assert.equal(untouchedUi.allowed, true);
  const touched = pure({ headLog: money, baseLog: money, files: ['packages/ledger-client/src/transfer.ts'] });
  assert.equal(touched.allowed, false);
  assert.equal(touched.noNewFailures, undefined);
  assert.match(touched.reason, /packages\/ledger-client/);
  assert.match(touched.reason, /changes a file in that workspace/);
});

test('collector excuses a matching protected failure only when that workspace is untouched', async () => {
  const i18n = passedUi.replaceAll('@intafaced/ui', '@intafaced/i18n');
  const log = `${passedUi}\n${money}\n${i18n}`;
  const seal = { workflow: 'CI', name: 'CI merge seal', bucket: 'fail', link: `https://github.com/${REPO}/actions/runs/200/job/301` };
  const clear = fixture({ headLog: log, baseLog: log, files: ['packages/ui/src/card.ts'] });
  clear.options.checks = [...clear.options.checks, seal];
  const allowed = await collectEvidence(clear.options);
  assert.equal(allowed.pass, true, allowed.reasons.join('; '));
  assert.ok(allowed.classifications.some((c) => c.check === 'CI/CI merge seal' && c.allowed));
  const edited = fixture({ headLog: log, baseLog: log, files: ['packages/ledger-client/src/transfer.ts'] });
  edited.options.checks = [...edited.options.checks, seal];
  const blocked = await collectEvidence(edited.options);
  assert.equal(blocked.pass, false);
  assert.match(blocked.reasons.join(' '), /packages\/ledger-client/);
  assert.ok(blocked.classifications.some((c) => c.check === 'CI/CI merge seal' && !c.allowed));
});

test('opus patch quote ignores stale hashes and refuses two claims of the current hash', () => {
  const current = 'ab'.repeat(32);
  const stale = 'cd'.repeat(32);
  assert.equal(opusPatchQuoted(`Patch-Hash: ${stale}\nPatch-Hash: ${current}`, current), true);
  assert.equal(opusPatchQuoted(`Patch-Hash: ${current}\nPatch-Hash: ${stale}`, current), true);
  assert.equal(opusPatchQuoted(`Patch-Hash: ${current}\nPatch-Hash: ${current}`, current), false);
  assert.equal(opusPatchQuoted(`Patch-Hash: ${stale}`, current), false);
  assert.equal(opusPatchQuoted(`\`\`\`\nPatch-Hash: ${current}\n\`\`\``, current), false);
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
  const f = fixture({ baseConclusion: 'success', baseLog: passedUi });
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

test('green checks require actual exact head and base coverage', async () => {
  const f = fixture({ headJob: job(201, 'success'), headLog: passedUi, baseConclusion: 'success', baseLog: passedUi });
  f.options.checks = [{ ...check, bucket: 'pass' }];
  const result = await collectEvidence(f.options);
  assert.equal(result.pass, true, result.reasons.join('; '));
  assert.equal(result.coverage.length, 1);
  assert.ok(f.calls.some((args) => args.includes('--commit') && args.includes(BASE)));
  for (const options of [{ fakeCheckoutSha: 'c'.repeat(40) }, { runs: false }]) {
    const missing = fixture({ headJob: job(201, 'success'), headLog: passedUi, baseConclusion: 'success', baseLog: passedUi, ...options });
    missing.options.checks = [{ ...check, bucket: 'pass' }];
    assert.equal((await collectEvidence(missing.options)).pass, false);
  }
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

test('matching signature multiplicity cannot excuse an added identical occurrence', () => {
  const block = ui.slice(ui.indexOf(' FAIL '), ui.indexOf('Test Files'));
  const repeated = ui.replace('Test Files', `${block}Test Files`).replace('Tests  1 failed (1)', 'Tests  2 failed (2)');
  const result = pure({ headLog: repeated });
  assert.equal(result.classification, 'introduced');
  assert.equal(result.allowed, false);
  assert.equal(result.failures.length, 1);
});

const exactLog = (sha, name, body = '') => {
  const policy = TEST_JOB_POLICY[name];
  return `${name}\tCheckout repository\t2026-10-15T00:00:00Z [command]/usr/bin/git log -1 --format=%H\n${name}\tCheckout repository\t2026-10-15T00:00:01Z ${sha}\n${name}\t${policy.step}\t2026-10-15T00:00:02Z ##[group]Run ${policy.command}\n${body}${backstopOutput}`;
};
function shardFixture({ baseName = 'Tests (pay-bank)', baseConclusion = 'failure', green = false, missing = false } = {}) {
  const name = 'Tests (pay-bank)';
  const log = money.replaceAll('@intafaced/ledger-client', '@intafaced/svc-bank');
  const passed = log
    .replace(/ FAIL [\s\S]*?(?=Test Files)/, '')
    .replaceAll('1 failed', '1 passed')
    .replace(/^Failed:.*$/m, '');
  const coveredJob = (id, jobName, conclusion) => ({
    ...job(id, conclusion),
    name: jobName,
    steps: [{ name: TEST_JOB_POLICY[jobName].step, status: 'completed', conclusion }, job(id).steps[1]],
  });
  const headRun = {
    databaseId: 200,
    headSha: HEAD,
    event: 'pull_request',
    workflowName: 'CI',
    workflowDatabaseId: 9,
    status: 'completed',
    jobs: [coveredJob(201, name, green ? 'success' : 'failure')],
  };
  const baseRun = { ...headRun, databaseId: 100, headSha: BASE, jobs: [coveredJob(101, baseName, baseConclusion)] };
  const gh = (args) => {
    let value;
    if (args.includes('--log'))
      return {
        status: 0,
        stderr: '',
        stdout:
          args[3] === '201'
            ? exactLog(MERGE, name, green ? passed : log)
            : exactLog(BASE, baseName, baseConclusion === 'success' ? passed : log),
      };
    if (args[0] === 'api' && args[1] === `repos/${REPO}/commits/${MERGE}`) value = { sha: MERGE, parents: [{ sha: BASE }, { sha: HEAD }] };
    else if (args[1] === 'list') value = missing ? [] : [baseRun];
    else value = args[2] === '200' ? headRun : baseRun;
    return { status: 0, stderr: '', stdout: JSON.stringify(value) };
  };
  return {
    headRun,
    baseRun,
    gh,
    options: {
      gh,
      repo: REPO,
      head: HEAD,
      base: BASE,
      mergeSha: MERGE,
      files: ['services/svc-bank/src/a.ts'],
      workspaceRoots: new Map([['@intafaced/svc-bank', 'services/svc-bank']]),
      checks: [{ ...check, name, bucket: green ? 'pass' : 'fail' }],
      declarations: `Inherited-Failure: CI/${name} | owner=@bank | evidence=https://github.com/owner/repo/issues/123`,
    },
  };
}
test('paired pay-bank base evidence classifies introduced, inherited protected, and missing unknown', async () => {
  for (const [options, classification] of [
    [{ baseConclusion: 'success' }, 'introduced'],
    [{}, 'inherited'],
    [{ missing: true }, 'unknown'],
  ]) {
    const result = await collectEvidence(shardFixture(options).options);
    assert.equal(result.classifications[0].classification, classification, result.reasons.join('; '));
    assert.equal(result.pass, false);
  }
});
test('a failed shard missing its exact-name base job blocks instead of substituting main full', async () => {
  const result = await collectEvidence(shardFixture({ baseName: 'Tests (full)' }).options);
  assert.equal(result.classifications[0].classification, 'unknown', result.reasons.join('; '));
  assert.equal(result.classifications[0].allowed, false);
  assert.equal(result.coverage.length, 0);
});
test('green shard requires exact base coverage and accepts completed full coverage at base', async () => {
  const result = await collectEvidence(shardFixture({ green: true, baseName: 'Tests (full)', baseConclusion: 'success' }).options);
  assert.equal(result.pass, true, result.reasons.join('; '));
  assert.equal(result.coverage.length, 1);
});
test('pnpm workspace streams use trusted paths and preserve complete signatures for shard diagnosis', () => {
  const stream = money
    .split('\n')
    .filter((l) => !l.startsWith('##[') && !l.startsWith('Failed:'))
    .map((l) => `packages/ledger-client test: ${l}`)
    .join('\n');
  const normalized = normalizeTestLog(stream, 'Tests (money)', workspaceRoots);
  const parsed = parseFailureSignatures(normalized);
  assert.equal(parsed.readable, true, parsed.issues.join('; '));
  assert.equal(parsed.failures[0].signature, parseFailureSignatures(money).failures[0].signature);
});
test('green statuses cannot replace the expected test command or successful infrastructure execution', async () => {
  const f = fixture({ headJob: job(201, 'success'), headLog: passedUi, baseConclusion: 'success', baseLog: passedUi });
  f.options.checks = [{ ...check, bucket: 'pass' }];
  f.headRun.jobs[0].steps[1].conclusion = 'failure';
  assert.equal((await collectEvidence(f.options)).pass, false);
  f.headRun.jobs[0].steps[1].conclusion = 'success';
  const original = f.options.gh;
  f.options.gh = (args) => {
    const result = original(args);
    return args.includes('--log')
      ? { ...result, stdout: result.stdout.replace('##[group]Run pnpm test --continue', '##[group]Run echo fake-pass') }
      : result;
  };
  assert.equal((await collectEvidence(f.options)).pass, false);
});

test('green job and backstop statuses cannot replace missing test execution output', async () => {
  const f = fixture({ headJob: job(201, 'success'), headLog: '', baseConclusion: 'success', baseLog: '' });
  f.options.checks = [{ ...check, bucket: 'pass' }];
  const result = await collectEvidence(f.options);
  assert.equal(result.pass, false);
  assert.match(result.reasons.join('; '), /execution|summary|output/);
});

test('trimmed real CI log preserves a deadlock signature through literal colour codes and refuses omitted tasks', () => {
  const real = readFileSync(new URL('./fixtures/merge-gate/real-ci-identity-deadlock.log', import.meta.url), 'utf8');
  assert.ok(real.includes('^[[41m'));
  const parsed = parseFailureSignatures(real);
  assert.equal(parsed.failures.length, 1, parsed.issues.join('; '));
  assert.equal(parsed.failures[0].task, '@intafaced/svc-identity#test');
  assert.match(parsed.failures[0].signature, /PostgresError: deadlock detected/);
  assert.match(parsed.failures[0].signature, /connection\.js:815:30/);
  assert.equal(parsed.readable, false, 'other original failed-task bodies were deliberately trimmed');
});

test('execution proof distinguishes actual tests from skipped, absent and conflicting green output', async () => {
  for (const [body, expected] of [
    [passedUi, true],
    [passedUi.replaceAll('1 passed', '1 skipped'), false],
    [passedUi.replaceAll('1 passed', '1 todo'), false],
    [ui, false],
    [passedUi.replaceAll('@intafaced/ui', '@intafaced/i18n'), false],
    [passedUi.replace('Tests  1 passed (1)', 'Tests  1 passed (2)'), false],
  ]) {
    const f = fixture({ headJob: job(201, 'success'), headLog: body, baseConclusion: 'success', baseLog: passedUi });
    f.options.checks = [{ ...check, bucket: 'pass' }];
    assert.equal((await collectEvidence(f.options)).pass, expected, body);
  }
});
test('backstop output must positively attest execution beyond a successful exit code', async () => {
  for (const replacement of ['', 'no infrastructure records found']) {
    const f = fixture({ headJob: job(201, 'success'), headLog: passedUi, baseConclusion: 'success', baseLog: passedUi });
    f.options.checks = [{ ...check, bucket: 'pass' }];
    const original = f.options.gh;
    f.options.gh = (args) => {
      const result = original(args);
      return args.includes('--log')
        ? { ...result, stdout: result.stdout.replace('✓ COMPLETE — every infrastructure-backed suite executed.', replacement) }
        : result;
    };
    assert.equal((await collectEvidence(f.options)).pass, false);
  }
});
test('protected skipped tests and unreported infrastructure suites cannot establish coverage', async () => {
  for (const suffix of ['', '\nTests (full)\tEvery infrastructure-backed suite actually ran\t · packages/ledger-client/src/db.test.ts']) {
    const body =
      passedUi
        .replaceAll('@intafaced/ui', '@intafaced/ledger-client')
        .replace('Tests  1 passed (1)', suffix ? 'Tests  1 passed (1)' : 'Tests  1 passed | 1 skipped (2)') + suffix;
    const f = fixture({
      headJob: job(201, 'success'),
      headLog: body,
      baseConclusion: 'success',
      baseLog: body,
      files: ['packages/ledger-client/src/a.ts'],
    });
    f.options.checks = [{ ...check, bucket: 'pass' }];
    assert.equal((await collectEvidence(f.options)).pass, false);
  }
});
test('Node reporters need complete internally consistent nonempty execution totals', () => {
  const body = '##[group]@intafaced/ui:test\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n##[endgroup]';
  assert.equal(parseTestExecution(body).tasks.get('@intafaced/ui#test').valid, true);
  for (const broken of [
    body.replace('# tests 2', '# tests 3'),
    body.replace('# todo 0', ''),
    body.replace('# pass 2', '# pass 0').replace('# tests 2', '# tests 0'),
  ])
    assert.equal(parseTestExecution(broken).tasks.get('@intafaced/ui#test').valid, false);
});

test('broad coverage denominator comes from trusted workspaces, never only emitted output', async () => {
  const f = fixture({
    headJob: job(201, 'success'),
    headLog: passedUi,
    baseConclusion: 'success',
    baseLog: passedUi,
    files: ['tooling/scripts/a.mjs'],
  });
  f.options.checks = [{ ...check, bucket: 'pass' }];
  f.options.workspaceRoots = new Map([
    ['@intafaced/ui', 'packages/ui'],
    ['@intafaced/svc-bank', 'services/svc-bank'],
  ]);
  const partial = await collectEvidence(f.options);
  assert.equal(partial.pass, false);
  assert.match(partial.reasons.join('; '), /svc-bank.*execution/);
  const original = f.options.gh;
  f.options.gh = (args) => {
    const result = original(args);
    return args.includes('--log')
      ? { ...result, stdout: result.stdout + passedUi.replaceAll('@intafaced/ui', '@intafaced/svc-bank') }
      : result;
  };
  assert.equal((await collectEvidence(f.options)).pass, true);
});

test('infra selection passes on the full suite when nothing new fails and the Opus patch hash is quoted', async () => {
  const hash = 'ab'.repeat(32);
  const all = ['@intafaced/ui', '@intafaced/ledger-client', '@intafaced/i18n']
    .map((name) => passedUi.replaceAll('@intafaced/ui', name))
    .join('\n');
  const f = fixture({
    headJob: job(201, 'success'),
    headLog: all,
    baseConclusion: 'success',
    baseLog: all,
    files: ['package.json'],
  });
  f.options.checks = [{ ...check, bucket: 'pass' }];
  const missing = await collectEvidence(f.options);
  assert.equal(missing.pass, false);
  assert.match(missing.reasons.join(' '), /canonical patch hash/);
  f.options.patchHash = hash;
  f.options.declarations = `${declarations}\nPatch-Hash: ${hash}`;
  const ok = await collectEvidence(f.options);
  assert.equal(ok.pass, true, ok.reasons.join('; '));
  f.options.declarations = `${declarations}\n\`\`\`\nPatch-Hash: ${hash}\n\`\`\``;
  const fenced = await collectEvidence(f.options);
  assert.equal(fenced.pass, false);
  assert.match(fenced.reasons.join(' '), /canonical patch hash/);
});

test('infra selection still refuses an affected-only shard', async () => {
  const f = shardFixture({ green: true, baseName: 'Tests (full)', baseConclusion: 'success' });
  f.options.files = ['package.json', ...f.options.files];
  f.options.patchHash = 'cd'.repeat(32);
  f.options.declarations += `\nPatch-Hash: ${f.options.patchHash}`;
  const result = await collectEvidence(f.options);
  assert.equal(result.pass, false);
  assert.match(result.reasons.join(' '), /affected-only/);
});

test('CI merge seal is excused only when Tests (full) has no new failures versus main', async () => {
  const seal = { workflow: 'CI', name: 'CI merge seal', bucket: 'fail', link: `https://github.com/${REPO}/actions/runs/200/job/301` };
  const f = fixture();
  f.options.checks = [...f.options.checks, seal];
  const allowed = await collectEvidence(f.options);
  assert.equal(allowed.pass, true, allowed.reasons.join('; '));
  assert.ok(allowed.classifications.some((c) => c.check === 'CI/CI merge seal' && c.allowed));
  const introduced = fixture({ baseConclusion: 'success', baseLog: passedUi });
  introduced.options.checks = [...introduced.options.checks, seal];
  const blocked = await collectEvidence(introduced.options);
  assert.equal(blocked.pass, false);
  assert.match(blocked.reasons.join(' '), /introduced|CI merge seal/);
});

test('changed workspaces may be covered by separate exact-commit shards, with no workspace omitted', async () => {
  const f = shardFixture({ green: true, baseName: 'Tests (full)', baseConclusion: 'success' });
  const bank = passedUi.replaceAll('@intafaced/ui', '@intafaced/svc-bank');
  const trade = passedUi.replaceAll('@intafaced/ui', '@intafaced/svc-trade');
  const tradeJob = {
    ...f.headRun.jobs[0],
    databaseId: 202,
    name: 'Tests (trade)',
    steps: [
      { name: TEST_JOB_POLICY['Tests (trade)'].step, status: 'completed', conclusion: 'success' },
      { name: 'Every infrastructure-backed suite actually ran', status: 'completed', conclusion: 'success' },
    ],
  };
  f.headRun.jobs.push(tradeJob);
  f.options.files.push('services/svc-trade/src/a.ts');
  f.options.workspaceRoots.set('@intafaced/svc-trade', 'services/svc-trade');
  f.options.checks.push({ ...check, name: 'Tests (trade)', bucket: 'pass', link: `https://github.com/${REPO}/actions/runs/200/job/202` });
  const original = f.options.gh;
  f.options.gh = (args) =>
    args.includes('--log')
      ? {
          status: 0,
          stderr: '',
          stdout:
            args[3] === '201'
              ? exactLog(MERGE, 'Tests (pay-bank)', bank)
              : args[3] === '202'
                ? exactLog(MERGE, 'Tests (trade)', trade.replaceAll('@intafaced/svc-trade:test: ', 'services/svc-trade test: '))
                : exactLog(BASE, 'Tests (full)', bank + trade),
        }
      : original(args);
  const result = await collectEvidence(f.options);
  assert.equal(result.pass, true, result.reasons.join('; '));
  f.options.checks.pop();
  const incomplete = await collectEvidence(f.options);
  assert.equal(incomplete.pass, false);
  assert.match(incomplete.reasons.join('; '), /svc-trade.*coverage/);
});

test('new or untested workspace roots cannot disappear from known-workspace coverage', async () => {
  for (const files of [['services/svc-new-money/src/a.ts'], ['packages/ui/src/card.ts', 'services/svc-new-money/src/a.ts']]) {
    const f = fixture({ headJob: job(201, 'success'), headLog: passedUi, baseConclusion: 'success', baseLog: passedUi, files });
    f.options.workspaceRoots = new Map([['@intafaced/ui', 'packages/ui']]);
    f.options.checks = [{ ...check, bucket: 'pass' }];
    const result = await collectEvidence(f.options);
    assert.equal(result.pass, false, files.join(','));
    assert.match(result.reasons.join('; '), /svc-new-money.*unknown.*coverage/);
  }
});

for (const side of ['head', 'base'])
  for (const failure of ['unhandled', 'step'])
    test(`green ${side} execution refuses ${failure} failure evidence`, async () => {
      const f = shardFixture({ green: true, baseName: 'Tests (full)', baseConclusion: 'success' });
      const target = side === 'head' ? f.headRun.jobs[0] : f.baseRun.jobs[0];
      if (failure === 'step') target.steps[0].conclusion = 'failure';
      const original = f.options.gh;
      f.options.gh = (args) => {
        const result = original(args);
        if (failure === 'unhandled' && args.includes('--log') && (args[3] === '201') === (side === 'head'))
          return {
            ...result,
            stdout: result.stdout.replace(
              '##[endgroup]',
              'Unhandled Errors\nUnhandled Error\nError: invariant crashed\nErrors  1 error\n##[endgroup]',
            ),
          };
        return result;
      };
      const result = await collectEvidence(f.options);
      assert.equal(result.pass, false, `${side} ${failure}`);
      assert.match(result.reasons.join('; '), /unhandled|error|test.*step/i);
    });

test('merge result is bound to target-main tip and PR head; raw head alone cannot prove integration', async () => {
  const f = fixture({ headJob: job(201, 'success'), headLog: passedUi, baseConclusion: 'success', baseLog: passedUi });
  f.options.checks = [{ ...check, bucket: 'pass' }];
  const good = await collectEvidence(f.options);
  assert.equal(good.pass, true, good.reasons.join('; '));
  assert.equal(good.coverage[0].head.testedSha, MERGE);
  assert.equal(good.coverage[0].base.sha, BASE);
  for (const parents of [
    [{ sha: 'c'.repeat(40) }, { sha: HEAD }],
    [{ sha: BASE }, { sha: 'd'.repeat(40) }],
    [{ sha: HEAD }, { sha: BASE }],
    [{ sha: BASE }],
  ]) {
    const original = f.gh;
    f.options.gh = (args) =>
      args[0] === 'api' ? { status: 0, stdout: JSON.stringify({ sha: MERGE, parents }), stderr: '' } : original(args);
    assert.equal((await collectEvidence(f.options)).pass, false, JSON.stringify(parents));
  }
  const raw = fixture({
    fakeCheckoutSha: HEAD,
    headJob: job(201, 'success'),
    headLog: passedUi,
    baseConclusion: 'success',
    baseLog: passedUi,
  });
  raw.options.checks = [{ ...check, bucket: 'pass' }];
  assert.equal((await collectEvidence(raw.options)).pass, false);
});
