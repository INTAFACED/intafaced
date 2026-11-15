// World: restart
import { test, expect } from './journey.mjs';
import { api, journeyState, restartWithSetting } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { userIdOf } from './copy.mjs';

// J-algo-dev-12, in the running app (docs/roadmap/journeys.json): a founder sets plan quotas and sandbox limits with a
// reason, and reads what developers see. One test per step, titled "J-algo-dev-12 #<n>", run in order. The founder is the
// stack's LOCAL TEST founder A (admin.mjs) on the console's quant desk, /more-ops/quant, whose plan limits desk writes to
// svc-quant (`ops.quota.*`, `ops.sandbox.corpus`). The plan is this run's own TEST profile, so nothing here changes the
// TEST default plan every other journey's developer runs under; the developer is put on it in #2. Step #2 restarts
// svc-quant once with the default plan blank, to show an account with no plan, and puts it back before the step ends.
// No money moves: svc-quant holds no ledger grant, and every run here is paper.
const J = 'J-algo-dev-12';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });
test.use({ actionTimeout: 15_000 });

const SOURCE = 'console.log("TEST limits check")';

const body200 = (res) => {
  expect(res.status, JSON.stringify(res.body).slice(0, 600)).toBe(200);
  return res.body;
};

function state() {
  const s = run.read();
  if (!s.dev || !s.plan) throw new Error(`${J} #1 made no developer or plan, so this step has nothing to act on`);
  return s;
}

/** Founder A on the quant desk, with this run's plan read. */
async function limitsDesk(browser, plan) {
  const page = await (await browser.newContext()).newPage();
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/more-ops/quant`);
  await expect(page.getByRole('heading', { name: 'Quant desk' })).toBeVisible();
  const desk = page.getByTestId('quant-limits-desk');
  await expect(desk.getByRole('heading', { name: 'Plan quotas and sandbox limits' })).toBeVisible();
  await desk.getByLabel('Plan', { exact: true }).fill(plan);
  await desk.getByRole('button', { name: 'Read plan' }).click();
  await expect(desk.getByTestId('limits-quota')).toBeVisible();
  return { page, desk };
}

const quotaRow = (desk, resource) => desk.getByTestId('limits-quota').locator(`tr[data-resource="${resource}"]`);
const sandboxRow = (desk, limit) => desk.getByTestId('limits-sandbox').locator(`tr[data-limit="${limit}"]`);
const outcome = (desk) => desk.getByTestId('limits-desk-outcome');

/** Saves one quota limit from the desk's form; `reason` may be blank. */
async function saveQuota(desk, resource, limit, reason) {
  await desk.locator('#quota-resource').selectOption(resource);
  await desk.locator('#quota-limit').fill(limit);
  await desk.locator('#quota-reason').fill(reason);
  await desk.getByRole('button', { name: 'Save quota limit' }).click();
}

/** Saves one sandbox limit from the desk's form; a blank value is "not set". */
async function saveSandbox(desk, limit, value, reason) {
  await desk.locator('#sandbox-limit').selectOption(limit);
  await desk.locator('#sandbox-value').fill(value);
  await desk.locator('#sandbox-reason').fill(reason);
  await desk.getByRole('button', { name: 'Save sandbox limit' }).click();
}

/** The developer presses Run in the sandbox room with a one-line strategy. */
async function sandboxRun(page, source = SOURCE) {
  await page.goto('/quant/sandbox');
  await page.getByLabel('Simulated starting cash').fill('1000');
  await page.getByLabel('Strategy source').fill(source);
  await page.getByRole('button', { name: 'Review simulation' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Run simulation' }).click();
}

const usageOf = async (who) => body200(await (await api(who)).get('/api/quant/trpc/quota.get')).result.data;
const limitsOf = async (who) => body200(await (await api(who)).get('/api/quant/trpc/limits.get')).result.data;

test(`${J} #1 opens quota settings and saves a limit with no reason: a typed refusal and no change`, async ({ page, browser }) => {
  test.setTimeout(180_000);
  const dev = await signUp(page, 'ad12');
  await verify(page, dev);
  const plan = `TEST ${J} ${Date.now().toString(36)}`;
  run.reset({ dev, devId: await userIdOf(dev), plan });

  const { desk } = await limitsDesk(browser, plan);
  // A plan nobody has set yet: every quota and sandbox limit reads "not set".
  await expect(quotaRow(desk, 'runs')).toHaveAttribute('data-limit', '');
  await expect(quotaRow(desk, 'runs')).toContainText('not set');

  await saveQuota(desk, 'runs', '5', '');
  await expect(outcome(desk)).toHaveAttribute('data-code', 'quant.quota_reason_unset');
  await expect(outcome(desk)).toHaveAttribute('role', 'alert');
  await expect(outcome(desk)).toContainText('a quota change needs a reason');
  // No change: the desk re-read the plan after the refusal, and the limit is still not set.
  await expect(quotaRow(desk, 'runs')).toHaveAttribute('data-limit', '');
  await expect(quotaRow(desk, 'runs')).toContainText('not set');
  // The same press with a reason that is only spaces is refused the same way.
  await saveQuota(desk, 'runs', '5', '   ');
  await expect(outcome(desk)).toHaveAttribute('data-code', 'quant.quota_reason_unset');
  await expect(quotaRow(desk, 'runs')).toHaveAttribute('data-limit', '');
});

test(`${J} #2 sets limits for runs, files and collaborators with a reason: the profile saves; an account without a profile sees "quota profile not set"`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  const { dev, devId, plan } = state();
  const { desk } = await limitsDesk(browser, plan);
  // Runs, files (saved strategies, the developer's source files) and collaborators, each with its reason.
  for (const [resource, limit] of [
    ['runs', '5'],
    ['strategies', '3'],
    ['collaborators', '2'],
  ]) {
    await saveQuota(desk, resource, limit, `TEST ${J} plan: ${resource}`);
    await expect(outcome(desk)).toContainText('Done: the quota limit is saved');
    await expect(quotaRow(desk, resource)).toHaveAttribute('data-limit', limit);
  }
  // The rest of what one sandbox run counts against, so the developer's runs in #4 and #5 are decided by this plan.
  for (const [resource, limit] of [
    ['concurrent_runs', '2'],
    ['storage', '10000000'],
  ]) {
    await saveQuota(desk, resource, limit, `TEST ${J} plan: ${resource}`);
    await expect(quotaRow(desk, resource)).toHaveAttribute('data-limit', limit);
  }
  // The profile saved: a fresh read shows it as stored.
  await desk.getByRole('button', { name: 'Read plan' }).click();
  for (const [resource, limit] of [
    ['runs', '5'],
    ['strategies', '3'],
    ['collaborators', '2'],
  ])
    await expect(quotaRow(desk, resource)).toHaveAttribute('data-limit', limit);

  // The developer is put on the plan, and sees its limits as their own.
  await desk.locator('#assign-account').fill(devId);
  await desk.locator('#assign-reason').fill(`TEST ${J} developer on the plan`);
  await desk.getByRole('button', { name: 'Assign plan' }).click();
  await expect(outcome(desk)).toContainText('Done: the account is on the plan');
  const usage = await usageOf(dev);
  expect(usage.profile).toBe(plan);
  expect(usage.source).toBe('assigned');
  expect(usage.resources.find((r) => r.resource === 'runs')?.limit).toBe('5');
  expect(usage.resources.find((r) => r.resource === 'strategies')?.limit).toBe('3');
  expect(usage.resources.find((r) => r.resource === 'collaborators')?.limit).toBe('2');

  // An account without a profile: with the owner's default plan blank (svc-quant restarted so, then put back), a
  // developer never put on a plan reads that no plan applies, and every limit "not set".
  const other = await signUp(page, 'ad12n');
  await verify(page, other);
  restartWithSetting('quant', 'LOCAL_STACK_QUANT_DEFAULT_QUOTA_PROFILE', 'off');
  try {
    await signIn(page, other);
    await page.goto('/quant/strategies');
    const panel = page.getByTestId('quant-usage');
    await expect(panel.getByTestId('quant-usage-plan')).toHaveAttribute('data-profile', '');
    await expect(panel.getByTestId('quant-usage-plan')).toHaveText(
      'No plan applies to this account: the default plan is not set, so a new strategy or run is refused.',
    );
    for (const row of await panel.locator('tr[data-resource]').all()) await expect(row).toContainText('not set');
    const none = await usageOf(other);
    expect(none.profile).toBeNull();
    expect(none.resources.every((r) => r.limit === null)).toBe(true);
    // Its run is refused by name: no quota profile is set.
    const refused = await (
      await api(other)
    ).post('/api/quant/trpc/sandbox.run', {
      language: 'javascript',
      source: SOURCE,
      cash: '1000',
      environment: 'paper',
      presentedAs: 'paper',
      idempotencyKey: `${J}:no-plan:${Date.now()}`,
    });
    expect(refused.status, 'a refusal, not a run').not.toBe(200);
    expect(JSON.stringify(refused.body)).toContain('quant.quota_profile_unset');
    // The developer on the plan still has theirs.
    expect((await usageOf(dev)).profile).toBe(plan);
  } finally {
    restartWithSetting('quant', 'LOCAL_STACK_QUANT_DEFAULT_QUOTA_PROFILE', null);
  }
  expect((await usageOf(other)).profile).not.toBeNull();
});

test(`${J} #3 leaves a sandbox limit (wall-clock, memory, output) unset: the strategy start names the unset limit before it runs`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const { dev, plan } = state();
  const { desk } = await limitsDesk(browser, plan);
  await saveSandbox(desk, 'wall_clock_ms', '5000', `TEST ${J} wall-clock`);
  await expect(outcome(desk)).toContainText('Done: the sandbox limit is saved');
  await saveSandbox(desk, 'output_bytes', '200000', `TEST ${J} output`);
  await expect(sandboxRow(desk, 'wall_clock_ms')).toHaveAttribute('data-value', '5000');
  await expect(sandboxRow(desk, 'output_bytes')).toHaveAttribute('data-value', '200000');
  // Memory is left unset.
  await expect(sandboxRow(desk, 'memory_bytes')).toHaveAttribute('data-value', '');
  await expect(sandboxRow(desk, 'memory_bytes')).toContainText('not set');

  const before = (await usageOf(dev)).resources.find((r) => r.resource === 'runs')?.used;
  await signIn(page, dev);
  await sandboxRun(page);
  await expect(page.getByTestId('failure')).toContainText(
    'Nothing ran: the memory per run (bytes of text held) limit of your plan is not set, so no run starts.',
  );
  await expect(page.getByText('Paper — not live performance', { exact: true })).toHaveCount(0);
  // Before it runs: the service names the limit, and no run was recorded.
  const refused = await (
    await api(dev)
  ).post('/api/quant/trpc/sandbox.run', {
    language: 'javascript',
    source: SOURCE,
    cash: '1000',
    environment: 'paper',
    presentedAs: 'paper',
    idempotencyKey: `${J}:unset:${Date.now()}`,
  });
  expect(refused.status, 'a refusal, not a run').not.toBe(200);
  expect(JSON.stringify(refused.body)).toContain(
    'quant.sandbox_limit_unset — memory_bytes: the limit for memory per run in bytes is not set',
  );
  expect((await usageOf(dev)).resources.find((r) => r.resource === 'runs')?.used).toBe(before);
});

test(`${J} #4 opens the developer limits page: every limit with its current value as the developer will hit it`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const { dev, plan } = state();
  const { desk } = await limitsDesk(browser, plan);
  await saveSandbox(desk, 'memory_bytes', '1000000', `TEST ${J} memory`);
  await expect(sandboxRow(desk, 'memory_bytes')).toHaveAttribute('data-value', '1000000');

  await signIn(page, dev);
  await page.goto('/quant/strategies');
  await page.getByTestId('quant-usage-limits-link').click();
  await expect(page).toHaveURL(/\/quant\/limits$/);
  const limits = page.getByTestId('quant-limits');
  await expect(limits.getByTestId('quant-limits-plan')).toHaveText(`Plan: ${plan}`);
  const read = await limitsOf(dev);
  expect(read.profile).toBe(plan);
  const shown = [
    ['wall_clock_ms', 'Wall-clock time per run (milliseconds)', '5000'],
    ['memory_bytes', 'Memory per run (bytes of text held)', '1000000'],
    ['output_bytes', 'Log output per run (bytes)', '200000'],
    ['max_ops', 'Operations per run (every plan)', read.ceilings.maxOps],
    ['max_source', 'Source length (characters, every plan)', read.ceilings.maxSource],
  ];
  for (const [limit, label, value] of shown) {
    expect(value, `${limit} has a value on the stack`).toMatch(/^\d+$/);
    const row = limits.locator(`tr[data-limit="${limit}"]`);
    await expect(row).toHaveAttribute('data-value', value);
    await expect(row.getByRole('rowheader')).toHaveText(label);
    await expect(row.getByRole('cell')).toHaveText(value);
  }
  // The values on the page are the ones the sandbox applies: the plan's sandbox limits as svc-quant reads them.
  expect(read.sandbox).toEqual([
    { limit: 'wall_clock_ms', value: '5000' },
    { limit: 'memory_bytes', value: '1000000' },
    { limit: 'output_bytes', value: '200000' },
  ]);
  // The plan's quotas are on the same page, as the usage view counts them.
  const usage = page.getByTestId('quant-usage');
  await expect(usage.locator('tr[data-resource="runs"]')).toHaveAttribute('data-limit', '5');
  await expect(usage.locator('tr[data-resource="strategies"]')).toHaveAttribute('data-limit', '3');
  await expect(usage.locator('tr[data-resource="collaborators"]')).toHaveAttribute('data-limit', '2');

  // As the developer will hit them: with every limit set the run starts now, and a log over the output limit ends it by name.
  await sandboxRun(page);
  await expect(page.getByText('Paper — not live performance', { exact: true })).toBeVisible();
  const over = 'let s = "' + 'x'.repeat(4000) + '"\n' + Array.from({ length: 6 }, () => 's = s + s').join('\n') + '\nconsole.log(s)';
  const ended = await (
    await api(dev)
  ).post('/api/quant/trpc/sandbox.run', {
    language: 'javascript',
    source: over,
    cash: '1000',
    environment: 'paper',
    presentedAs: 'paper',
    idempotencyKey: `${J}:over:${Date.now()}`,
  });
  expect(JSON.stringify(ended.body)).toContain('quant.sandbox_output — output_bytes: the log reached the limit of 200000 bytes');
});

test(`${J} #5 runs the escape corpus against the sandbox: each case ends in a typed refusal, the host process survives and a second run on the account is unaffected`, async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const { dev, plan } = state();
  const { desk } = await limitsDesk(browser, plan);
  await desk.getByRole('button', { name: 'Run escape corpus' }).click();
  await expect(outcome(desk)).toContainText('Done: the escape corpus ran');
  const corpus = desk.getByTestId('limits-corpus');
  const rows = corpus.locator('tr[data-case]');
  const cases = await rows.evaluateAll((els) =>
    els.map((el) => ({ id: el.getAttribute('data-case'), code: el.getAttribute('data-code') })),
  );
  expect(cases.length).toBeGreaterThanOrEqual(15);
  // Each case ends in a typed refusal: a sandbox code, never an untyped failure and never a run.
  for (const c of cases) expect(c.code, c.id).toMatch(/^quant\.sandbox_(escape|syntax|memory|output|timeout)$/);
  const code = Object.fromEntries(cases.map((c) => [c.id, c.code]));
  expect(code['memory-bomb']).toBe('quant.sandbox_memory');
  expect(code['huge-output']).toBe('quant.sandbox_output');
  for (const id of ['network', 'filesystem', 'environment', 'host-global', 'dynamic-import', 'prototype-pollution', 'constructor-chain'])
    expect(code[id], id).toBe('quant.sandbox_escape');
  await expect(corpus.getByTestId('limits-corpus-summary')).toContainText(
    `${cases.length} of ${cases.length} cases ended in a typed refusal`,
  );
  await expect(corpus.getByTestId('limits-corpus-control')).toHaveAttribute('data-ok', 'true');

  // The host process survives: svc-quant still answers, and the desk reads the plan again after the corpus.
  await desk.getByRole('button', { name: 'Read plan' }).click();
  await expect(sandboxRow(desk, 'memory_bytes')).toHaveAttribute('data-value', '1000000');
  expect((await limitsOf(dev)).profile).toBe(plan);

  // A second run on the account is unaffected: the developer's own run starts, runs and logs.
  const second = body200(
    await (
      await api(dev)
    ).post('/api/quant/trpc/sandbox.run', {
      language: 'javascript',
      source: SOURCE,
      cash: '1000',
      environment: 'paper',
      presentedAs: 'paper',
      idempotencyKey: `${J}:second:${Date.now()}`,
    }),
  ).result.data;
  expect(second.ok).toBe(true);
  expect(second.logs).toEqual(['TEST limits check']);
  await signIn(page, dev);
  await sandboxRun(page);
  await expect(page.getByText('Paper — not live performance', { exact: true })).toBeVisible();
  await expect(page.getByText('TEST limits check').first()).toBeVisible();
});
