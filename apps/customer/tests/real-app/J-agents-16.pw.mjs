import { test, expect } from '@playwright/test';
import { UNBUILT, openFounderDesk, tableIn } from './agents.mjs';
import { journeyState } from './stack.mjs';

// J-agents-16, in the founder console (docs/roadmap/journeys.json): get alerted when agents fail, refuse or cost too
// much. One test per step, titled "J-agents-16 #<n>", run in order by the stack's LOCAL TEST founder on the agents alert
// desk (/more-ops/agents/alerts). Rules are stored with their thresholds, one alert per breached window, and an
// override never loosens the managed baseline. Alert delivery by email or push shows its vendor notice; the alert row
// is kept either way (#3: the stack has no mail or push vendor, so delivery stays pending).
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /more-ops/agents/alerts does not exist: there are no alert rules, evaluator, alert rows or policy baseline
//   (AG-analytics-02, AG-guardrails-02).
const J = 'J-agents-16';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

/** The rule #1 names, kept in the run file so a step after a worker restart looks for the same rule. */
function rule() {
  const { rule: name } = run.read();
  if (!name) throw new Error(`${J} #1 named no rule, so this step has no rule to look for`);
  return name;
}

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const newRule = (page) => main(page).getByRole('form', { name: 'New alert rule' });
const rules = (page) => tableIn(main(page), 'Alert rules');
const alerts = (page) => tableIn(main(page), 'Alerts');
const openAlerts = (page) => openFounderDesk(page, '/more-ops/agents/alerts', 'Agent alerts');

test(`${J} #1 creates a refusal-rate rule with the threshold blank: refused by name and not stored; a threshold of 0 is stored as deliberate`, async ({
  page,
}) => {
  await openAlerts(page);
  await newRule(page)
    .getByRole('textbox', { name: /^Rule name/ })
    .fill(RULE);
  await newRule(page).getByRole('combobox', { name: 'Measure' }).selectOption({ label: 'Refusal rate' });
  await newRule(page).getByRole('button', { name: 'Save rule' }).click();
  await expect(newRule(page).getByRole('alert')).toContainText('Threshold');
  await expect(rules(page).getByRole('row').filter({ hasText: RULE })).toHaveCount(0);
  await newRule(page)
    .getByRole('textbox', { name: /^Threshold/ })
    .fill('0');
  await newRule(page).getByRole('button', { name: 'Save rule' }).click();
  await expect(rules(page).getByRole('row').filter({ hasText: RULE })).toContainText('0%');
});

test(`${J} #2 lets the evaluator run twice over a breached window: one alert row for that window; an empty window fires nothing and shows no zero rate`, async ({
  page,
}) => {
  await openAlerts(page);
  await main(page).getByRole('button', { name: 'Evaluate now' }).click(UNBUILT);
  await main(page).getByRole('button', { name: 'Evaluate now' }).click();
  const fired = alerts(page).getByRole('row').filter({ hasText: rule() });
  await expect(fired).not.toHaveCount(0);
  const windows = await fired.getByTestId('alert-window').allInnerTexts();
  expect(new Set(windows).size).toBe(windows.length);
  await expect(main(page).getByTestId('empty-window-rate')).toHaveText('No rows in this window');
});

test(`${J} #3 with notifications down: the alert row is still kept and shows delivery pending`, async ({ page }) => {
  await openAlerts(page);
  const row = alerts(page).getByRole('row').filter({ hasText: rule() }).first();
  await expect(row.getByTestId('alert-delivery')).toHaveText('Delivery pending', UNBUILT);
  await expect(main(page).getByRole('note').filter({ hasText: 'vendor.email' })).toBeVisible();
});

test(`${J} #4 opens the managed policy baseline and sets an environment override: the baseline is shown; a loosening override is refused`, async ({
  page,
}) => {
  await openAlerts(page);
  const baseline = main(page).getByRole('region', { name: 'Managed policy baseline' });
  await expect(baseline.getByRole('term').first()).toBeVisible(UNBUILT);
  const override = main(page).getByRole('form', { name: 'Environment override' });
  await override.getByRole('combobox', { name: 'Requirement' }).selectOption({ label: 'Ask before a live-write tool' });
  await override.getByRole('combobox', { name: 'Value' }).selectOption({ label: 'Off' });
  await override.getByRole('button', { name: 'Save override' }).click();
  await expect(override.getByRole('alert')).toContainText('An override cannot loosen the baseline.');
});

test(`${J} #5 checks a user rule that tries to loosen the baseline: the baseline wins and the rule is refused`, async ({ page }) => {
  await openAlerts(page);
  const check = main(page).getByRole('form', { name: 'Check a rule' });
  await check.getByRole('textbox', { name: /^Rule/ }).fill('Send comments without asking', UNBUILT);
  await check.getByRole('button', { name: 'Check' }).click();
  await expect(check.getByRole('status')).toHaveText('Refused: the baseline wins.');
});
