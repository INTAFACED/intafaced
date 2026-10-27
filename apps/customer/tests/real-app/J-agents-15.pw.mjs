import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { UNBUILT, agentsRun, openFounderDesk, openNavigatorSession, tableIn } from './agents.mjs';

// J-agents-15, in the founder console (docs/roadmap/journeys.json): find out why an agent action failed for a customer.
// One test per step, titled "J-agents-15 #<n>", run in order. The customer is a TEST account whose Navigator session
// the start tries to open (today refused); the operator is the stack's LOCAL TEST founder, who is the stack's support
// operator too, on the agents log desk (/more-ops/agents/log), searching by the customer's handle. Every log read needs
// a reason from the owner's list and writes one audit row; no prompt text is shown.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - /more-ops/agents/log does not exist: there is no operator action log, reason gate, filters, export or transcript
//   read (AG-audit-01, AG-audit-02).
// - #5 needs the owner's transcript retention value, which the stack leaves blank (#4 is that refusal); it stays red on
//   this stack until a TEST retention value is published.
const J = 'J-agents-15';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const desk = (page) => page.getByRole('main').getByRole('form', { name: 'Search the agent log' });
const rows = (page) => tableIn(page.getByRole('main'), 'Agent actions for this customer');

/** Opens the log desk and searches the customer's handle, with `reason` chosen when one is given. */
async function search(page, reason) {
  await openFounderDesk(page, '/more-ops/agents/log', 'Agent action log');
  await desk(page)
    .getByRole('textbox', { name: /^Customer reference/ })
    .fill(agents.account().handle);
  if (reason) await desk(page).getByRole('combobox', { name: 'Reason' }).selectOption({ index: 1 });
  await desk(page).getByRole('button', { name: 'Search' }).click();
}

test(`${J} starts: a TEST customer who tried to open a Navigator session, and the founder console`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag15', '10');
  // On today's stack the open is refused for a standard account; that refusal is the customer's failed action.
  await openNavigatorSession(page, agents).catch(() => {});
});

test(`${J} #1 searches the operator action log without a reason: a refusal that a reason is required and no rows`, async ({ page }) => {
  await search(page, false);
  await expect(desk(page).getByRole('alert')).toContainText('A reason is required', UNBUILT);
  await expect(rows(page)).toHaveCount(0);
});

test(`${J} #2 enters a reason and searches: rows with refusal code and tool, no prompt text; exactly one log-read audit row`, async ({
  page,
}) => {
  await search(page, true);
  await expect(rows(page).getByRole('row').nth(1)).toBeVisible(UNBUILT);
  for (const column of ['Time', 'Tool', 'Outcome', 'Refusal code'])
    await expect(rows(page).getByRole('columnheader', { name: column })).toBeVisible();
  await expect(rows(page).getByRole('columnheader', { name: 'Prompt' })).toHaveCount(0);
  await expect(page.getByRole('main').getByTestId('log-read-audit')).toHaveText('1 audit row written for this read');
});

test(`${J} #3 filters by outcome and tool: matching rows; the export applies the same filter`, async ({ page }) => {
  await search(page, true);
  await page.getByRole('main').getByRole('combobox', { name: 'Outcome' }).selectOption({ label: 'Refused' }, UNBUILT);
  const tool = page.getByRole('main').getByRole('combobox', { name: 'Tool' });
  await tool.selectOption({ index: 1 });
  const chosen = await tool.inputValue();
  await expect(rows(page).getByTestId('action-outcome')).not.toHaveCount(0);
  await expect(
    rows(page)
      .getByTestId('action-outcome')
      .filter({ hasNotText: /^Refused$/ }),
  ).toHaveCount(0);
  await expect(rows(page).getByTestId('action-tool').filter({ hasNotText: chosen })).toHaveCount(0);
  const shown = await rows(page).getByTestId('action-outcome').count();
  // The export holds the same rows: one line each, every one refused and for the chosen tool.
  const download = page.waitForEvent('download');
  await page
    .getByRole('main')
    .getByRole('button', { name: /^Export/ })
    .click();
  const lines = readFileSync(await (await download).path(), 'utf8')
    .trim()
    .split('\n')
    .slice(1);
  expect(lines).toHaveLength(shown);
  for (const line of lines) {
    expect(line).toContain('Refused');
    expect(line).toContain(chosen);
  }
});

test(`${J} #4 opens a transcript with retention unset: the typed refusal and no text row`, async ({ page }) => {
  await search(page, true);
  await rows(page).getByRole('row').nth(1).getByRole('button', { name: 'Open transcript' }).click(UNBUILT);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('agents.retention.unset');
  await expect(page.getByRole('main').getByRole('region', { name: 'Transcript' })).toHaveCount(0);
});

test(`${J} #5 opens a transcript after the owner sets retention: text whose digest equals the action row's; the read needs a reason and writes one audit row`, async ({
  page,
}) => {
  await search(page, true);
  const row = rows(page).getByRole('row').nth(1);
  const digest = await row.getByTestId('action-digest').innerText(UNBUILT);
  await row.getByRole('button', { name: 'Open transcript' }).click();
  const transcript = page.getByRole('main').getByRole('region', { name: 'Transcript' });
  await expect(transcript.getByTestId('transcript-digest')).toHaveText(digest);
  await expect(page.getByRole('main').getByTestId('transcript-read-audit')).toHaveText('1 audit row written for this read');
});
