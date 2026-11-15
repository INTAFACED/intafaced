// World: none
import { test, expect } from './journey.mjs';
import { agentsRun, openFounderDesk, openNavigatorSession, tableIn } from './agents.mjs';
import { api } from './stack.mjs';

// J-agents-16, in the founder console (docs/roadmap/journeys.json): get alerted when agents fail, refuse or cost too
// much. One test per step, titled "J-agents-16 #<n>", run in order by the stack's LOCAL TEST founder on the agents alert
// desk (/more-ops/agents/alerts). The start makes a fresh TEST customer whose Navigator session asks for a task the
// agent may not run, so svc-agents records one refused action now: the refusal-rate rule's window is breached.
// Delivery: while alert notifications are on, svc-agents hands each alert to notifications (svc-notify). #3 takes them
// down on the desk, fires a new alert, sees it kept with delivery pending, and brings them back. The managed baseline is the stack's LOCAL TEST AGENTS_POLICY_BASELINE (own data: act when asked).
const J = 'J-agents-16';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const newRule = (page) => main(page).getByRole('form', { name: 'New alert rule' });
const rules = (page) => tableIn(main(page), 'Alert rules');
const alerts = (page) => tableIn(main(page), 'Alerts');
const evaluation = (page) => tableIn(main(page), 'Last evaluation');
const openAlerts = (page) => openFounderDesk(page, '/more-ops/agents/alerts', 'Agent alerts');
const rowOf = (table, name) => table.getByRole('row').filter({ has: table.page().getByRole('cell', { name, exact: true }) });

/** The two rule names this run stores, kept in the run file so a later step looks for the same rules. */
function names() {
  const { rule, quiet } = agents.run.read();
  if (!rule || !quiet) throw new Error(`${J} start named no rules, so this step has no rule to look for`);
  return { rule, quiet };
}

/** Fills and saves the new-rule form; a blank `threshold` leaves the field empty. */
async function saveRule(page, { name, threshold, agentId = '' }) {
  const form = newRule(page);
  await form.getByRole('textbox', { name: /^Rule name/ }).fill(name);
  await form.getByRole('combobox', { name: 'Measure' }).selectOption({ label: 'Refusal rate' });
  await form.getByRole('textbox', { name: /^Threshold/ }).fill(threshold);
  await form.getByRole('textbox', { name: /^Window/ }).fill('60');
  await form.getByRole('textbox', { name: /^Agent id/ }).fill(agentId);
  await form.getByRole('button', { name: 'Save rule' }).click();
}

test(`${J} starts: a TEST customer whose agent request was refused just now, and the founder console`, async ({ page }) => {
  test.setTimeout(180_000);
  await agents.start(page, 'ag16', '10');
  const sessionId = await openNavigatorSession(page, agents);
  const door = await api(agents.account());
  const refused = await door.post('/api/agents/trpc/run.complete', {
    sessionId,
    requestId: `${sessionId}:not-allowed`,
    task: 'support.reply',
    messages: [{ role: 'user', content: 'TEST: reply to my ticket' }],
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error.message).toBe('agents.refused.task_not_allowed');
  const tag = `${agents.account().handle}-${Date.now()}`;
  agents.run.write({
    rule: `TEST refusals ${tag}`,
    quiet: `TEST quiet ${tag}`,
    quietAgent: `TEST-no-actions-${tag}`,
    whileDown: `TEST while down ${tag}`,
  });
});

test(`${J} #1 creates a refusal-rate rule with the threshold blank: refused by name and not stored; a threshold of 0 is stored as deliberate`, async ({
  page,
}) => {
  const { rule } = names();
  await openAlerts(page);
  await saveRule(page, { name: rule, threshold: '' });
  await expect(newRule(page).getByRole('alert')).toContainText('Threshold is required');
  await expect(newRule(page).getByRole('alert')).toContainText('(agents.alert_threshold_required)');
  // Not stored: the desk re-read the rules from svc-agents after the refusal.
  await expect(main(page).getByRole('region', { name: 'Alert rules', exact: true })).toBeVisible();
  await expect(rowOf(rules(page), rule)).toHaveCount(0);
  await page.reload();
  await expect(rowOf(rules(page), rule)).toHaveCount(0);
  // 0 is a deliberate value: stored, and read back as 0%.
  await saveRule(page, { name: rule, threshold: '0' });
  await expect(newRule(page).getByRole('status')).toHaveText(`Rule stored: ${rule}.`);
  await page.reload();
  const stored = rowOf(rules(page), rule);
  await expect(stored).toHaveCount(1);
  await expect(stored.getByTestId('rule-threshold')).toHaveText('0%');
  await expect(stored).toContainText('Refusal rate');
});

test(`${J} #2 lets the evaluator run twice over a breached window: one alert row for that window; an empty window fires nothing and shows no zero rate`, async ({
  page,
}) => {
  const { rule, quiet } = names();
  const { quietAgent } = agents.run.read();
  await openAlerts(page);
  // A second rule over one agent id with no actions at all: its windows have no rows.
  await saveRule(page, { name: quiet, threshold: '0', agentId: quietAgent });
  await expect(newRule(page).getByRole('status')).toHaveText(`Rule stored: ${quiet}.`);
  const evaluate = main(page).getByRole('button', { name: 'Evaluate now' });
  await evaluate.click();
  await expect(rowOf(evaluation(page), rule)).toHaveCount(2);
  await expect(evaluate).toBeEnabled();
  await evaluate.click();
  await expect(evaluate).toBeEnabled();
  // The second run found the breached window's alert already kept and wrote none.
  const breached = rowOf(evaluation(page), rule).filter({
    has: page.getByTestId('window-result').getByText('Alert already kept for this window'),
  });
  await expect(breached).not.toHaveCount(0);
  await expect(rowOf(evaluation(page), rule).getByTestId('window-result').getByText('Alert written', { exact: true })).toHaveCount(0);
  // Exactly one alert row per window: the windows of this rule's alerts are all different, and there is one for each
  // breached window the evaluator reported.
  const fired = rowOf(alerts(page), rule);
  const windows = await fired.getByTestId('alert-window').allInnerTexts();
  expect(windows.length).toBe(await breached.count());
  expect(new Set(windows).size).toBe(windows.length);
  // Each alert keeps the threshold it was fired against: 0%.
  for (const row of await fired.all()) await expect(row.getByRole('cell').nth(4)).toHaveText('0%');
  // The empty windows: no rows, no rate, nothing fired, and no alert row.
  const empty = rowOf(evaluation(page), quiet);
  await expect(empty).toHaveCount(2);
  for (const row of await empty.all()) {
    await expect(row.getByTestId('window-rate')).toHaveText('No rows in this window');
    await expect(row.getByTestId('window-result')).toHaveText('Nothing fired');
    await expect(row).not.toContainText('0%');
  }
  await expect(rowOf(alerts(page), quiet)).toHaveCount(0);
});

test(`${J} #3 takes notifications down: the alert row is still kept and shows delivery pending`, async ({ page }) => {
  const { whileDown } = agents.run.read();
  if (!whileDown) throw new Error(`${J} start named no rule for #3`);
  await openAlerts(page);
  const switchboard = main(page).getByRole('region', { name: 'Alert notifications' });
  await expect(switchboard.getByTestId('notifications-state')).toHaveText('Notifications are on.');
  await switchboard.getByRole('button', { name: 'Take notifications down' }).click();
  try {
    await expect(switchboard.getByTestId('notifications-state')).toHaveText('Notifications are down.');
    // A new rule over the start's refusal fires while notifications are down.
    await saveRule(page, { name: whileDown, threshold: '0' });
    await expect(newRule(page).getByRole('status')).toHaveText(`Rule stored: ${whileDown}.`);
    await main(page).getByRole('button', { name: 'Evaluate now' }).click();
    // It fired (this click wrote it, or the service's own minute timer did just before): above the threshold, kept.
    await expect(
      rowOf(evaluation(page), whileDown).filter({
        has: page.getByTestId('window-result').getByText(/^Alert (written|already kept for this window)$/),
      }),
    ).not.toHaveCount(0);
    // The row is kept, read back from svc-agents, and shows delivery pending.
    await page.reload();
    const kept = rowOf(alerts(page), whileDown);
    await expect(kept).not.toHaveCount(0);
    for (const row of await kept.all()) await expect(row.getByTestId('alert-delivery')).toHaveText('Delivery pending');
    await expect(switchboard.getByTestId('notifications-state')).toHaveText('Notifications are down.');
  } finally {
    await switchboard.getByRole('button', { name: 'Bring notifications back' }).click();
    await expect(switchboard.getByTestId('notifications-state')).toHaveText('Notifications are on.');
  }
  // It was pending only because notifications were down: back on, the same row is handed over.
  const handed = rowOf(alerts(page), whileDown);
  await expect(handed).not.toHaveCount(0);
  for (const row of await handed.all()) await expect(row.getByTestId('alert-delivery')).toHaveText('Handed to notifications');
});

test(`${J} #4 opens the managed policy baseline and sets an environment override: the baseline is shown; a loosening override is refused`, async ({
  page,
}) => {
  await openAlerts(page);
  const baseline = main(page).getByRole('region', { name: 'Managed policy baseline' });
  const ownData = baseline.locator('[data-class="own_data"]');
  await expect(ownData.getByRole('term')).toHaveText('Own-data tools');
  await expect(ownData.getByTestId('baseline-choice')).toHaveText('Baseline: Act when asked');
  await expect(baseline.getByRole('term')).toHaveCount(4);
  const override = main(page).getByRole('form', { name: 'Environment override' });
  const before = await ownData.getByTestId('override-choice').innerText();
  await override.getByRole('combobox', { name: 'Requirement' }).selectOption({ label: 'Own-data tools' });
  await override.getByRole('combobox', { name: 'Value' }).selectOption({ label: 'Act without asking' });
  await override.getByRole('button', { name: 'Save override' }).click();
  await expect(override.getByRole('alert')).toHaveText('An override cannot loosen the baseline. (agents.baseline_loosen_refused)');
  // Nothing was stored: the override read back from svc-agents is what it was.
  await page.reload();
  await expect(ownData.getByTestId('override-choice')).toHaveText(before);
  await expect(ownData.getByTestId('effective-choice')).toHaveText('Applies: Act when asked');
  // An override no looser than the baseline is stored (the same choice, so no other journey's calls change).
  await override.getByRole('combobox', { name: 'Requirement' }).selectOption({ label: 'Own-data tools' });
  await override.getByRole('combobox', { name: 'Value' }).selectOption({ label: 'Act when asked' });
  await override.getByRole('button', { name: 'Save override' }).click();
  await expect(override.getByRole('status')).toHaveText('Override stored: Own-data tools, Act when asked.');
  await expect(ownData.getByTestId('override-choice')).toHaveText('Override: Act when asked');
});

test(`${J} #5 checks a user rule that tries to loosen the baseline: the baseline wins and the rule is refused`, async ({ page }) => {
  await openAlerts(page);
  const check = main(page).getByRole('form', { name: 'Check a rule' });
  await check.getByRole('combobox', { name: 'Tool class' }).selectOption({ label: 'Own-data tools' });
  await check.getByRole('combobox', { name: 'Rule' }).selectOption({ label: 'Act without asking' });
  await check.getByRole('button', { name: 'Check' }).click();
  await expect(check.getByRole('status')).toHaveText('Refused: the baseline wins.');
  // A rule within the baseline is allowed, so the refusal above is the baseline's and not every rule's.
  await check.getByRole('combobox', { name: 'Rule' }).selectOption({ label: 'Ask before acting' });
  await check.getByRole('button', { name: 'Check' }).click();
  await expect(check.getByRole('status')).toHaveText('Allowed: within the baseline (Act when asked).');
});
