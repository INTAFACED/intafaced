import { test, expect } from './journey.mjs';
import { UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';

// J-agents-07, in the running app (docs/roadmap/journeys.json): schedule an agent, trigger it from an event and hand
// work to a specialist. One test per step, titled "J-agents-07 #<n>", run in order on one verified TEST account with a
// published agent of its own and a specialist agent. Every scheduled and child run is metered against the person's caps;
// a blank cap skips the occurrence with the reason shown. Run notices by email or SMS show their vendor notice.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the person cannot create or publish an agent yet (no builder at /agents/new), and there are no schedules, event
//   triggers or hand-offs to a specialist (AG-sessions-02, -03).
const J = 'J-agents-07';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const schedule = (page) => main(page).getByRole('form', { name: 'New schedule' });
const schedules = (page) => tableIn(main(page), 'Schedules');

test(`${J} starts: a verified TEST account with a published agent of its own and a specialist agent`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag07', '20');
  await signIn(page, agents.account());
  await createOwnAgent(page);
});

test(`${J} #1 creates a repeating schedule with the minimum interval left blank: a refusal naming the interval and no schedule`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Schedules');
  await schedule(page).getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Every hour' });
  await schedule(page).getByRole('button', { name: 'Create schedule' }).click();
  await expect(schedule(page).getByRole('alert')).toContainText('agents.schedule.min_interval_unset');
  await expect(schedules(page).getByRole('row')).toHaveCount(1);
});

test(`${J} #2 sets a cadence and a per-run cap: the schedule list with status and recent runs; two workers waking together make one run; a blank cap skips with the reason`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Schedules');
  await schedule(page).getByRole('combobox', { name: 'Repeat' }).selectOption({ label: 'Every hour' });
  await schedule(page)
    .getByRole('textbox', { name: /^Cap per run/ })
    .fill('0.1');
  await schedule(page).getByRole('button', { name: 'Create schedule' }).click();
  const row = schedules(page).getByRole('row').nth(1);
  await expect(row).toContainText('Active');
  await row.getByRole('button', { name: 'Recent runs' }).click();
  // One occurrence is one run, however many workers woke for it.
  await expect(
    tableIn(main(page), 'Occurrences').getByRole('row').filter({ hasText: 'Ran' }).first().getByTestId('runs-for-occurrence'),
  ).toHaveText('1 run');
  await expect(tableIn(main(page), 'Occurrences')).toContainText('Skipped: no cap per run');
});

test(`${J} #3 adds an event trigger and the same event id arrives twice: one run`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Triggers');
  const triggers = main(page).getByRole('form', { name: 'New trigger' });
  await triggers.getByRole('combobox', { name: 'When' }).selectOption({ label: 'An order of mine fills' });
  await triggers.getByRole('button', { name: 'Add trigger' }).click();
  const fired = tableIn(main(page), 'Trigger runs');
  await expect(fired.getByRole('row').filter({ hasText: 'Redelivered event ignored' })).toHaveCount(1);
  await expect(fired.getByRole('row').filter({ hasText: 'Ran' })).toHaveCount(1);
});

test(`${J} #4 cancels the schedule: no further occurrences`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Schedules');
  await schedules(page).getByRole('row').nth(1).getByRole('button', { name: 'Cancel' }).click(UNBUILT);
  await expect(schedules(page).getByRole('row').nth(1)).toContainText('Cancelled');
  await expect(schedules(page).getByRole('row').nth(1).getByTestId('next-occurrence')).toHaveText('None');
});

test(`${J} #5 lets a primary agent hand a task to a specialist: the specialist's run is a child with its own audit row; its cost counts on the caller's caps`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Runs');
  const parent = tableIn(main(page), 'Live runs').getByRole('row').filter({ hasText: 'Handed to' }).first();
  await parent.getByRole('button', { name: 'Open' }).click(UNBUILT);
  const child = tableIn(main(page), 'Child runs').getByRole('row').nth(1);
  await expect(child).toContainText('Market scanner');
  await expect(child.getByRole('link', { name: 'Audit row' })).toBeVisible();
  await expect(main(page).getByTestId('caps-used')).toContainText('including child runs');
});

test(`${J} #6 hands off in a loop and with the hop limit blank: a route-loop refusal and a hop-limit-unset refusal`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Runs');
  const refused = tableIn(main(page), 'Live runs').getByRole('row').filter({ hasText: 'Refused' });
  await expect(refused.filter({ hasText: 'agents.handoff.loop' })).toHaveCount(1, UNBUILT);
  await expect(refused.filter({ hasText: 'agents.handoff.hop_limit_unset' })).toHaveCount(1);
});

test(`${J} #7 stops the parent: the child stops at its next boundary`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Runs');
  const parent = tableIn(main(page), 'Live runs').getByRole('row').filter({ hasText: 'Handed to' }).first();
  await parent.getByRole('button', { name: 'Stop' }).click(UNBUILT);
  await parent.getByRole('button', { name: 'Open' }).click();
  await expect(tableIn(main(page), 'Child runs').getByRole('row').nth(1)).toContainText('Stopped at its next step');
});
