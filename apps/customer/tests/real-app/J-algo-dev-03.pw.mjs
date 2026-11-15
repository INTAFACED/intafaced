// World: book
import { test, expect } from './journey.mjs';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { tapeWindow } from './tape.mjs';
import { userIdOf } from './copy.mjs';

// J-algo-dev-03, in the running app (docs/roadmap/journeys.json): keep strategies organised and stay inside the plan
// limits. One test per step, titled "J-algo-dev-03 #<n>", run in order on one TEST developer who starts signed in,
// verified and with no strategy. Every strategy in Algo dev is simulated; nothing here moves money. Steps whose slice
// is not built yet (AL-live-01's paper runs for #6, RC-algo-dev-05 for #8) check their step's text with a short wait,
// so they fail fast and name what is missing.
const J = 'J-algo-dev-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

function developer() {
  const who = run.read().account;
  if (!who) throw new Error(`${J} #1 made no account, so this step has no one to act as`);
  return who;
}

/** Saves a new signal-rules strategy on 1 minute bars of BTC/USDT at version 1. Every figure is a TEST simulation input. */
async function saveSignalStrategy(page, name) {
  await page.goto('/quant/studio');
  const fresh = page.getByRole('button', { name: 'Start a new strategy' });
  if (await fresh.isVisible()) await fresh.click();
  await page.getByLabel('Strategy name').fill(name);
  await page.getByLabel('Simulated starting cash').fill('1000');
  await page.getByLabel('Block 1 symbol').fill('BTC/USDT');
  await page.getByLabel('Block 1 quantity').fill('0.01');
  await page.getByLabel('Max drawdown (service unit unspecified)').fill('100');
  await page.getByLabel('Max notional (service unit unspecified)').fill('500');
  await page.getByLabel('Kill threshold (service unit unspecified)').fill('50');
  await page.getByLabel('How the strategy trades').selectOption('signal');
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Symbol').fill('BTC/USDT');
  await builder.getByLabel('Bar size').selectOption('1m');
  await builder.getByLabel('Fast average (bars)').fill('1');
  await builder.getByLabel('Slow average (bars)').fill('2');
  await builder.getByRole('combobox', { name: /^Size each entry by/ }).selectOption('quantity');
  await builder.getByLabel('Size', { exact: true }).fill('0.01');
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText('Saved as version 1.');
}

/** The saved list's row for a strategy, found by its id so a rename does not lose it. */
function rowOf(page, id) {
  return page.getByTestId('quant-strategies').locator(`[data-testid="quant-strategy-row"][data-id="${id}"]`);
}

const FIRST = 'TEST trend strategy';
const RENAMED = 'TEST momentum strategy';
const FOLDER = 'TEST momentum';

test(`${J} #1 opens the strategy list: saved strategies with version and folder; an account with none sees an honest empty state`, async ({
  page,
}) => {
  const who = await signUp(page, 'jo');
  await verify(page, who);
  run.reset({ account: who });
  await signIn(page, developer());

  // No strategy yet: the list says so, with no sample row, and offers Studio.
  await page.goto('/quant/strategies');
  const room = page.getByTestId('quant-strategies');
  await expect(room).toContainText('Simulated only.');
  await expect(room.getByText('No strategy is saved on this account.')).toBeVisible();
  await expect(room.getByTestId('quant-strategy-row')).toHaveCount(0);
  await expect(room.getByRole('link', { name: 'Open Studio' })).toHaveAttribute('href', '/quant/studio');
  // The room is one of the Algo dev rooms.
  await expect(page.getByRole('navigation', { name: 'Algo dev rooms' }).getByRole('link', { name: 'Strategies' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // Saved in Studio, it is listed with its version and its folder (none yet).
  await saveSignalStrategy(page, FIRST);
  await page.goto('/quant/strategies');
  const row = room.getByTestId('quant-strategy-row');
  await expect(row).toHaveCount(1);
  await expect(row.getByTestId('quant-strategy-name')).toHaveText(FIRST);
  await expect(row).toHaveAttribute('data-version', '1');
  await expect(row).toContainText('Version 1');
  await expect(row).toContainText('No folder');
  run.write({ strategyId: await row.getAttribute('data-id') });
});

test(`${J} #2 renames a strategy and moves it to a folder: the head changes and no version is added`, async ({ page }) => {
  const { strategyId } = run.read();
  if (!strategyId) throw new Error(`${J} #1 listed no strategy, so this step has nothing to rename`);
  await signIn(page, developer());
  await page.goto('/quant/strategies');
  const row = rowOf(page, strategyId);
  await row.getByRole('button', { name: `Rename or move ${FIRST}` }).click();
  const form = row.getByTestId('quant-organise');
  await form.getByLabel('Strategy name').fill(RENAMED);
  await form.getByLabel('Folder (blank for none)').fill(FOLDER);
  await form.getByLabel('Description').fill('TEST two moving averages');
  await form.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByTestId('quant-strategies-note')).toHaveText('Saved. The name and folder changed; no new version was added.');

  // The head changed: new name, folder and description. The version did not.
  await expect(row.getByTestId('quant-strategy-name')).toHaveText(RENAMED);
  await expect(row).toHaveAttribute('data-folder', FOLDER);
  await expect(row).toHaveAttribute('data-version', '1');
  await expect(row).toContainText('TEST two moving averages');
  // It is filed: the folder filter shows it, and it survives a reload.
  await page.reload();
  await page
    .getByTestId('quant-strategies')
    .getByRole('combobox', { name: /^Folder/ })
    .selectOption({ label: FOLDER });
  await expect(page.getByTestId('quant-strategy-row')).toHaveCount(1);
  await expect(rowOf(page, strategyId).getByTestId('quant-strategy-name')).toHaveText(RENAMED);
  await expect(rowOf(page, strategyId)).toHaveAttribute('data-version', '1');
});

/** Opens the strategy in Studio, sets its slow average, writes a release note and saves the next version. */
async function saveVersion(page, name, slow, note, version) {
  await page.goto('/quant/studio');
  // Studio keeps the strategy it last saved open on this device; otherwise open it from the library.
  const open = page.getByRole('button', { name: `Open ${name}` });
  await expect(open.or(page.getByText('Open in the form'))).toBeVisible();
  if (await open.isVisible()) await open.click();
  await expect(page.getByLabel('How the strategy trades')).toHaveValue('signal');
  // The form may hold the name it was saved under; keep the strategy's current name.
  await page.getByLabel('Strategy name').fill(name);
  const builder = page.getByTestId('quant-signal-builder');
  await builder.getByLabel('Slow average (bars)').fill(slow);
  await page.getByLabel('Release note for this version (optional)').fill(note);
  await page.getByRole('button', { name: 'Save to library', exact: true }).click();
  await expect(page.getByTestId('quant-save-state')).toHaveText(`Saved as version ${version}.`);
}

test(`${J} #3 edits, saves and writes release notes on two versions, then compares them: both listed with notes and a diff; the code each past run used is shown`, async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const { strategyId } = run.read();
  if (!strategyId) throw new Error(`${J} #1 listed no strategy, so this step has no versions to compare`);
  await signIn(page, developer());

  // Version 2 with its note, then a backtest of it on the TEST tape, then version 3 with its note.
  await saveVersion(page, RENAMED, '3', 'TEST slower exit', 2);
  const window = await tapeWindow(60);
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: RENAMED });
  await expect(room.getByTestId('quant-backtest-rules')).toHaveText('Version 2: BTC/USDT, 1m bars.');
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill('5');
  await room.getByTestId('quant-backtest-run').click();
  const runId = await room.getByTestId('quant-bar-result').getAttribute('data-run-id', { timeout: 120_000 });
  await saveVersion(page, RENAMED, '4', 'TEST slowest exit', 3);

  // The strategy's page: every version with its note, newest first, and the first one without a note.
  await page.goto('/quant/strategies');
  await rowOf(page, strategyId).getByTestId('quant-strategy-name').click();
  const versions = page.getByTestId('quant-versions');
  await expect(versions).toHaveAttribute('data-strategy-id', strategyId);
  const rows = versions.getByTestId('quant-version-row');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveAttribute('data-version', '3');
  await expect(rows.nth(0).getByTestId('quant-version-note')).toHaveText('TEST slowest exit');
  await expect(rows.nth(1).getByTestId('quant-version-note')).toHaveText('TEST slower exit');
  await expect(rows.nth(2).getByTestId('quant-version-note')).toHaveText('No note');

  // Version 2 against version 3: the slow average is the changed line, removed and added.
  await versions.getByRole('checkbox', { name: 'Compare version 2' }).check();
  await versions.getByRole('checkbox', { name: 'Compare version 3' }).check();
  const diff = versions.getByTestId('quant-diff');
  await expect(diff).toHaveAttribute('data-from', '2');
  await expect(diff).toHaveAttribute('data-to', '3');
  const rules = diff.getByTestId('quant-diff-rules');
  await expect(rules.locator('[data-op="removed"]').filter({ hasText: '"slow": "3"' })).toHaveCount(1);
  await expect(rules.locator('[data-op="added"]').filter({ hasText: '"slow": "4"' })).toHaveCount(1);

  // The run ran version 2, and its code is that version's source, read only.
  const ran = versions.locator(`[data-testid="quant-strategy-run"][data-run-id="${runId}"]`);
  await expect(ran).toHaveAttribute('data-version', '2');
  await ran.getByRole('button', { name: 'Show the code (version 2)' }).click();
  const code = versions.getByTestId('quant-run-code');
  await expect(code).toHaveAttribute('data-version', '2');
  await expect(code.getByTestId('quant-version-source')).toContainText('BTC/USDT');
  await expect(code.locator('textarea, [contenteditable="true"]')).toHaveCount(0);
});

/** A TEST starter template through the operator's publish door, as the founder console calls it. */
async function publishTemplate(input) {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  // The operator write scope, as svc-trade's admin doors take it; a plain founder session is an ordinary user.
  const res = await ctx.edge.mutate('quant', 'ops.template.publish', input, await founders.a.tradeOpsToken());
  if (!res.json?.result?.data?.version) throw new Error(`template publish refused: ${res.status} ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

const SOURCE_TEMPLATE = {
  id: 'test-source-view',
  name: 'TEST source view cross',
  description: 'Buys when a fast average crosses above a slow one and sells when it crosses back below.',
  rules: {
    symbol: 'BTC/USDT',
    barSize: '1h',
    signal: { kind: 'ma_cross', average: 'sma', fast: '', slow: '' },
    sizing: { kind: 'quantity', value: '' },
    exit: { stopLossPercent: '', takeProfitPercent: '' },
  },
  reason: 'LOCAL TEST journey template',
};

test(`${J} #4 opens a built-in template version and its source: readable and not editable; with no template published the list says none is published`, async ({
  page,
}) => {
  // Two TEST versions, one key each, so a second run replays them instead of stacking more.
  const first = await publishTemplate({
    ...SOURCE_TEMPLATE,
    releaseNote: 'LOCAL TEST first version.',
    idempotencyKey: 'journey:J-algo-dev-03:test-source-view:v1',
  });
  const second = await publishTemplate({
    ...SOURCE_TEMPLATE,
    rules: { ...SOURCE_TEMPLATE.rules, signal: { ...SOURCE_TEMPLATE.rules.signal, average: 'ema' } },
    releaseNote: 'LOCAL TEST uses an exponential average.',
    idempotencyKey: 'journey:J-algo-dev-03:test-source-view:v2',
  });
  expect(second.version).toBeGreaterThan(first.version);

  await signIn(page, developer());
  await page.goto('/quant/studio');
  const templates = page.getByTestId('quant-templates');
  const formName = await page.getByLabel('Strategy name').inputValue();
  await templates.getByRole('button', { name: `View the source of ${SOURCE_TEMPLATE.name}` }).click();
  const view = templates.getByTestId('quant-template-view');
  const source = view.getByTestId('quant-template-source');

  // The newest version opens first, readable: the generated source with every number a named blank, never a value.
  await expect(source).toHaveAttribute('data-version', String(second.version));
  await expect(view.getByTestId('quant-template-source-note')).toHaveText('LOCAL TEST uses an exponential average.');
  await expect(source).toContainText('const fast = ema(closes, /* signal.fast: blank, you set it after Use */);');
  await expect(source).toContainText('const slow = ema(closes, /* signal.slow: blank, you set it after Use */);');
  await expect(source).toContainText('oms.buy("BTC/USDT", size.quantity(/* sizing.value: blank, you set it after Use */));');
  await expect(source).toContainText('// Optional, blank in the template: exit.stopLossPercent, exit.takeProfitPercent.');
  expect(await source.innerText()).not.toMatch(/\(closes, \d/);

  // An older version reads with its own source.
  await view.getByLabel('Version to read').selectOption(String(first.version));
  await expect(source).toHaveAttribute('data-version', String(first.version));
  await expect(view.getByTestId('quant-template-source-note')).toHaveText('LOCAL TEST first version.');
  await expect(source).toContainText('const fast = sma(closes, /* signal.fast: blank, you set it after Use */);');

  // Not editable: no field in the view but the version picker, and typing into the source changes nothing.
  await expect(view.locator('input, textarea, [contenteditable]:not([contenteditable="false"])')).toHaveCount(0);
  expect(await source.evaluate((node) => [node.tagName, node.isContentEditable])).toEqual(['PRE', false]);
  const before = await source.innerText();
  await source.click();
  await page.keyboard.type('oms.buy("BTC/USDT", 1)');
  await expect(source).toHaveText(before);
  // Reading the source put nothing in the form.
  await expect(page.getByLabel('Strategy name')).toHaveValue(formName);
  await expect(page.getByTestId('quant-template-used')).toHaveCount(0);

  // With no template published, the list says so. The stack always holds this journey's TEST template, so the list's
  // reply is read again with no template in it, exactly as the service answers when nothing is published.
  await page.route('**/api/quant/trpc/template.list*', (route) =>
    route.fulfill({ json: { result: { data: { templates: [], nextCursor: null } } } }),
  );
  await page.reload();
  await expect(templates).toContainText('No template is published.');
});

test(`${J} #5 deletes a strategy then restores it from the recycle bin: it moves out with its versions and returns with the same versions`, async ({
  page,
}) => {
  const { strategyId } = run.read();
  if (!strategyId) throw new Error(`${J} #1 listed no strategy, so this step has nothing to delete`);
  await signIn(page, developer());
  await page.goto('/quant/strategies');
  const room = page.getByTestId('quant-strategies');
  // The versions it has now (#3 adds two), so the restore is checked against them.
  const version = await rowOf(page, strategyId).getAttribute('data-version');
  expect(version).toMatch(/^[1-9]\d*$/);
  await rowOf(page, strategyId)
    .getByRole('button', { name: `Delete ${RENAMED}` })
    .click();
  await expect(page.getByTestId('quant-strategies-note')).toHaveText(
    `${RENAMED} moved to the recycle bin with every version, up to version ${version}.`,
  );
  await expect(rowOf(page, strategyId)).toHaveCount(0);
  await expect(room.getByText('No strategy is saved on this account.')).toBeVisible();

  // In the recycle bin with its version and folder; the tab is in the address, so a reload keeps it.
  await room.getByRole('button', { name: 'Recycle bin' }).click();
  await expect(page).toHaveURL(/[?&]tab=bin\b/);
  await page.reload();
  const binned = room.locator(`[data-testid="quant-bin-row"][data-id="${strategyId}"]`);
  await expect(binned).toHaveAttribute('data-version', version ?? '');
  await expect(binned).toContainText(RENAMED);
  await expect(binned).toContainText(FOLDER);

  // Restored, it is back in the list with the same version, name and folder, and the bin is empty.
  await binned.getByRole('button', { name: `Restore ${RENAMED}` }).click();
  await expect(page.getByTestId('quant-strategies-note')).toHaveText(`${RENAMED} is back with every version, up to version ${version}.`);
  await expect(room.getByText('The recycle bin is empty.')).toBeVisible();
  await room.getByRole('button', { name: 'Saved' }).click();
  const back = rowOf(page, strategyId);
  await expect(back.getByTestId('quant-strategy-name')).toHaveText(RENAMED);
  await expect(back).toHaveAttribute('data-version', version ?? '');
  await expect(back).toHaveAttribute('data-folder', FOLDER);
});

/** The ids of the strategy's stored runs, as its page lists them: #3 ran one, so the list has loaded once a row shows. */
async function storedRuns(page, strategyId) {
  await page.goto(`/quant/strategies/${encodeURIComponent(strategyId)}`);
  const versions = page.getByTestId('quant-versions');
  await expect(versions).toHaveAttribute('data-strategy-id', strategyId);
  await expect(versions.getByTestId('quant-strategy-run').first(), `${J} #3 ran a backtest of this strategy`).toBeVisible();
  return versions.getByTestId('quant-strategy-run').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-run-id')));
}

/** The operator's quota door (AL-limits-01), as the founder console calls it, with the stack's TEST founder. */
async function quotaDoor() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const founders = await gates.approverSessions(ctx);
  const token = await founders.a.tradeOpsToken();
  const data = (res, what) => {
    const got = res.json?.result?.data;
    if (!got) throw new Error(`${what} refused: ${res.status} ${res.text.slice(0, 300)}`);
    return got;
  };
  return {
    async profile(profile) {
      return data(await ctx.edge.query('quant', 'ops.quota.profile', { profile }, token), 'ops.quota.profile');
    },
    /** Sets every limit of a TEST profile, one keyed write each, with a reason for the audit row. */
    async plan(profile, limits) {
      for (const [resource, limit] of Object.entries(limits)) {
        data(
          await ctx.edge.mutate(
            'quant',
            'ops.quota.set',
            {
              profile,
              resource,
              limit,
              reason: `LOCAL TEST ${J}`,
              idempotencyKey: `quant.quota:${profile}:${resource}:${limit ?? 'blank'}`,
            },
            token,
          ),
          'ops.quota.set',
        );
      }
    },
    async assign(accountId, profile) {
      data(
        await ctx.edge.mutate(
          'quant',
          'ops.quota.assign',
          { accountId, profile, reason: `LOCAL TEST ${J}`, idempotencyKey: `quant.quota.assign:${accountId}:${profile}` },
          token,
        ),
        'ops.quota.assign',
      );
    },
  };
}

/** A TEST profile's name for this run, so a second run of the journey starts from its own rows. */
const planName = (what) => `TEST ${what} ${process.env.JOURNEY_RUN_ID ?? 'local'}`.slice(0, 80);

/** Every limit roomy except those given: a step proves one limit and meets no other. */
const ROOMY = {
  strategies: '50',
  versions: '50',
  concurrent_runs: '10',
  paper_runs: '50',
  runs: '50',
  log_lines: '100000',
  storage: '100000000',
  collaborators: '5',
  notifications: '100',
};

test(`${J} #6 starts a fourth concurrent run when the plan allows three: a refusal naming the resource with its used and allowed counts; zero refuses every create; unset reads "not set"`, async ({
  page,
}) => {
  await signIn(page, developer());
  const { strategyId } = run.read();
  if (!strategyId) throw new Error(`${J} #1 listed no strategy, so this step has nothing to run`);
  // A concurrent run is a paper run that keeps going until it is stopped (AL-live-01); the one-shot runs finish at once.
  await page.goto(`/quant/strategies/${encodeURIComponent(strategyId)}`);
  await expect(
    page.getByRole('button', { name: 'Start a paper run' }),
    'paper runs that keep running are not built (AL-live-01)',
  ).toBeVisible(UNBUILT);
});

test(`${J} #7 opens the usage view: counts for strategies, runs, storage and collaborators against the plan`, async ({ page }) => {
  const { strategyId } = run.read();
  if (!strategyId) throw new Error(`${J} #1 listed no strategy, so this step has nothing to count`);
  await signIn(page, developer());

  // What the account holds, read from its own pages: the saved list and the strategy's runs.
  const ran = (await storedRuns(page, strategyId)).length;
  await page.goto('/quant/strategies');
  // The list has loaded once this journey's strategy is in it; then every saved row is counted.
  await expect(rowOf(page, strategyId)).toBeVisible();
  const saved = await page.getByTestId('quant-strategy-row').count();

  // The usage view names the plan that applies and counts each resource against that plan's stored limit.
  const usage = page.getByTestId('quant-usage');
  await expect(usage).toBeVisible();
  await expect(usage).toHaveAttribute('aria-label', 'Usage and plan limits');
  await expect(page.getByRole('heading', { name: 'Usage and plan limits' })).toBeVisible();
  const plan = usage.getByTestId('quant-usage-plan');
  const profile = await plan.getAttribute('data-profile');
  expect(profile, 'a plan applies to this account').toBeTruthy();
  await expect(plan).toContainText(`Plan: ${profile}`);
  const stored = Object.fromEntries((await (await quotaDoor()).profile(profile)).limits.map((row) => [row.resource, row.limit]));

  const row = (resource) => usage.locator(`[data-resource="${resource}"]`);
  const expected = { strategies: String(saved), runs: String(ran), collaborators: '0' };
  for (const [resource, label] of [
    ['strategies', 'Saved strategies'],
    ['runs', 'Stored runs'],
    ['storage', 'Source and result storage (bytes)'],
    ['collaborators', 'Collaborators per strategy'],
  ]) {
    await expect(row(resource)).toHaveCount(1);
    await expect(row(resource).getByRole('rowheader')).toHaveText(label);
    if (expected[resource]) await expect(row(resource)).toHaveAttribute('data-used', expected[resource]);
    // Against the plan: the limit shown is the one the plan stores, or "not set" when it is blank.
    const limit = stored[resource] ?? null;
    await expect(row(resource)).toHaveAttribute('data-limit', limit ?? '');
    await expect(row(resource).locator('td').nth(1)).toHaveText(limit ?? 'not set');
  }
  // Storage is the bytes of the stored source and results: a whole number above zero, since a strategy and a run are stored.
  expect(Number(await row('storage').getAttribute('data-used'))).toBeGreaterThan(0);
  await expect(row('storage').locator('td').first()).toHaveText(/^\d+$/);
});

test(`${J} #8 chooses a plan with more data freshness or execution priority: the plan page shows what each tier changes; with no tier published it says so`, async ({
  page,
}) => {
  await signIn(page, developer());
  await page.goto('/quant/strategies');
  await expect(page.getByTestId('quant-plan-tiers'), 'compute tiers are not built (RC-algo-dev-05)').toBeVisible(UNBUILT);
});

/** Runs a bar backtest of the renamed strategy's newest version on the TEST tape, slipping by `slippage` basis points. */
async function startBacktest(page, slippage) {
  const window = await tapeWindow(60);
  await page.goto('/quant/backtest');
  const room = page.getByTestId('quant-bar-backtest');
  await room.getByRole('combobox', { name: /^Strategy/ }).selectOption({ label: RENAMED });
  await room.getByLabel('From (UTC)').fill(window.from);
  await room.getByLabel('To (UTC)').fill(window.to);
  await room.getByRole('combobox', { name: /^Fill a signal at/ }).selectOption('next_open');
  await room.getByRole('combobox', { name: /^Fee rate/ }).selectOption('taker');
  await room.getByLabel('Delay (bars)').fill('0');
  await room.getByLabel('Slippage (basis points)').fill(String(slippage));
  await room.getByTestId('quant-backtest-run').click();
  return room;
}

test(`${J} #9 starts a fourth run when the plan allows three stored runs: a refusal naming stored runs with 3 used of 3 allowed; the stored runs are unchanged`, async ({
  page,
}) => {
  test.setTimeout(10 * 60_000);
  const { strategyId } = run.read();
  if (!strategyId) throw new Error(`${J} #1 listed no strategy, so this step has nothing to run`);
  // The operator puts this developer on a TEST plan that allows three stored runs and is roomy for everything else.
  const profile = planName('three stored runs');
  const door = await quotaDoor();
  await door.plan(profile, { ...ROOMY, runs: '3' });
  await door.assign(await userIdOf(developer()), profile);
  await signIn(page, developer());

  // Up to three stored runs: this strategy's runs from earlier steps, then new backtests (each a new run key).
  let slippage = 6;
  for (let held = (await storedRuns(page, strategyId)).length; held < 3; held += 1, slippage += 1) {
    const room = await startBacktest(page, slippage);
    await expect(room.getByTestId('quant-bar-result')).toHaveAttribute('data-run-id', /\S/, { timeout: 120_000 });
  }
  const before = await storedRuns(page, strategyId);
  expect(before).toHaveLength(3);
  await page.goto('/quant/strategies');
  const runsRow = page.getByTestId('quant-usage').locator('[data-resource="runs"]');
  await expect(runsRow).toHaveAttribute('data-used', '3');
  await expect(runsRow).toHaveAttribute('data-limit', '3');

  // The fourth is refused by the plan, naming stored runs with 3 used of 3 allowed.
  const room = await startBacktest(page, slippage);
  const refusal = room.getByTestId('quant-quota-refusal');
  await expect(refusal).toHaveAttribute('data-resource', 'runs', { timeout: 120_000 });
  await expect(refusal).toHaveAttribute('data-kind', 'exceeded');
  await expect(refusal).toContainText('Your plan allows 3 stored runs: 3 used of 3 allowed. Nothing was added.');
  await expect(room.getByTestId('quant-bar-result')).toHaveCount(0);

  // The stored runs are unchanged: the same three, and the usage view still counts three.
  expect(await storedRuns(page, strategyId)).toEqual(before);
  await page.goto('/quant/strategies');
  await expect(runsRow).toHaveAttribute('data-used', '3');
});
