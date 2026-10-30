import { test, expect } from '@playwright/test';
import { journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-algo-dev-03, in the running app (docs/roadmap/journeys.json): keep strategies organised and stay inside the plan
// limits. One test per step, titled "J-algo-dev-03 #<n>", run in order on one TEST developer who starts signed in,
// verified and with no strategy. Every strategy in Algo dev is simulated; nothing here moves money. Steps whose slice
// is not built yet (AL-editor-01's versions view, AL-editor-03's template source, AL-limits-01, RC-algo-dev-05) check
// their step's text with a short wait, so they fail fast and name what is missing.
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

test(`${J} #3 edits, saves and writes release notes on two versions, then compares them: both listed with notes and a diff; the code each past run used is shown`, async ({
  page,
}) => {
  const { strategyId } = run.read();
  if (!strategyId) throw new Error(`${J} #1 listed no strategy, so this step has no versions to compare`);
  await signIn(page, developer());
  // The strategy's own page with its Versions tab (AL-editor-01): not built yet.
  await page.goto(`/quant/strategies/${strategyId}?tab=versions`);
  await expect(page.getByTestId('quant-versions'), 'the Versions tab of /quant/strategies/:id is not built (AL-editor-01)').toBeVisible(
    UNBUILT,
  );
});

test(`${J} #4 opens a built-in template version and its source: readable and not editable; with no template published the list says none is published`, async ({
  page,
}) => {
  await signIn(page, developer());
  await page.goto('/quant/studio');
  await expect(
    page.getByTestId('quant-template-source'),
    'the read-only source view of a template version is not built (AL-editor-03)',
  ).toBeVisible(UNBUILT);
});

test(`${J} #5 deletes a strategy then restores it from the recycle bin: it moves out with its versions and returns with the same versions`, async ({
  page,
}) => {
  const { strategyId } = run.read();
  if (!strategyId) throw new Error(`${J} #1 listed no strategy, so this step has nothing to delete`);
  await signIn(page, developer());
  await page.goto('/quant/strategies');
  const room = page.getByTestId('quant-strategies');
  await rowOf(page, strategyId)
    .getByRole('button', { name: `Delete ${RENAMED}` })
    .click();
  await expect(page.getByTestId('quant-strategies-note')).toHaveText(
    `${RENAMED} moved to the recycle bin with every version, up to version 1.`,
  );
  await expect(rowOf(page, strategyId)).toHaveCount(0);
  await expect(room.getByText('No strategy is saved on this account.')).toBeVisible();

  // In the recycle bin with its version and folder; the tab is in the address, so a reload keeps it.
  await room.getByRole('button', { name: 'Recycle bin' }).click();
  await expect(page).toHaveURL(/[?&]tab=bin\b/);
  await page.reload();
  const binned = room.locator(`[data-testid="quant-bin-row"][data-id="${strategyId}"]`);
  await expect(binned).toHaveAttribute('data-version', '1');
  await expect(binned).toContainText(RENAMED);
  await expect(binned).toContainText(FOLDER);

  // Restored, it is back in the list with the same version, name and folder, and the bin is empty.
  await binned.getByRole('button', { name: `Restore ${RENAMED}` }).click();
  await expect(page.getByTestId('quant-strategies-note')).toHaveText(`${RENAMED} is back with every version, up to version 1.`);
  await expect(room.getByText('The recycle bin is empty.')).toBeVisible();
  await room.getByRole('button', { name: 'Saved' }).click();
  const back = rowOf(page, strategyId);
  await expect(back.getByTestId('quant-strategy-name')).toHaveText(RENAMED);
  await expect(back).toHaveAttribute('data-version', '1');
  await expect(back).toHaveAttribute('data-folder', FOLDER);
});

test(`${J} #6 starts a fourth concurrent run when the plan allows three: a refusal naming the resource with its used and allowed counts; zero refuses every create; unset reads "not set"`, async ({
  page,
}) => {
  await signIn(page, developer());
  await page.goto('/quant/strategies');
  await expect(page.getByTestId('quant-usage'), 'plan quotas and their refusal are not built (AL-limits-01)').toBeVisible(UNBUILT);
});

test(`${J} #7 opens the usage view: counts for strategies, runs, storage and collaborators against the plan`, async ({ page }) => {
  await signIn(page, developer());
  await page.goto('/quant/strategies');
  const usage = page.getByTestId('quant-usage');
  await expect(usage, 'the Usage panel is not built (AL-limits-01)').toBeVisible(UNBUILT);
  for (const resource of ['strategies', 'runs', 'storage', 'collaborators']) {
    await expect(usage.locator(`[data-resource="${resource}"]`)).toHaveCount(1);
  }
});

test(`${J} #8 chooses a plan with more data freshness or execution priority: the plan page shows what each tier changes; with no tier published it says so`, async ({
  page,
}) => {
  await signIn(page, developer());
  await page.goto('/quant/strategies');
  await expect(page.getByTestId('quant-plan-tiers'), 'compute tiers are not built (RC-algo-dev-05)').toBeVisible(UNBUILT);
});
