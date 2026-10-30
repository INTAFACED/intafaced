import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, expect } from '@playwright/test';
import { agentsRun, openFounderDesk, openNavigatorSession, tableIn } from './agents.mjs';
import { api, ROOT } from './stack.mjs';

// J-agents-15, in the founder console (docs/roadmap/journeys.json): find out why an agent action failed for a customer.
// One test per step, titled "J-agents-15 #<n>", run in order. The customer is a TEST account who, in their own signed-in
// session, opens a Navigator session, runs one engine call and asks for a task the agent may not run, which svc-agents
// refuses and logs. The operator is the stack's LOCAL TEST founder on the agents log desk (/more-ops/agents/log),
// searching by the customer's handle. Every log read needs a reason from the owner's list and writes one audit row,
// which svc-agents re-reads and the desk shows; no prompt text is listed.
// The owner's values are LOCAL TEST values on this stack (tooling/profiles/test-owner-values/agents.json); a step that
// proves a blank value restarts svc-agents with it blank (LOCAL_STACK_AGENTS_*=off) and restores it in `finally`.
const J = 'J-agents-15';
const agents = agentsRun(J);
const PROMPT = 'TEST: why was my agent request refused?';
const REFUSED_TASK = 'support.reply';

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const desk = (page) => main(page).getByRole('form', { name: 'Search the agent log' });
const rows = (page) => tableIn(main(page), 'Agent actions for this customer');
const actionRow = (page, id) => rows(page).locator(`tr[data-action-id="${id}"]`);
const transcriptProblem = (page) => main(page).getByTestId('transcript-problem');
/** The desk's count, re-read from svc-agents on each read, of this customer's log reads so far, this one included. */
const readsSoFar = (n) => `Reads of this customer’s agent log so far: ${n}, this one included`;
/** The LOCAL TEST retention, as the stack publishes it to svc-agents. */
const RETENTION_DAYS = Number(
  JSON.parse(readFileSync(path.join(ROOT, 'tooling/profiles/test-owner-values/agents.json'), 'utf8')).values
    .AGENTS_TRANSCRIPT_RETENTION_DAYS.value,
);

/** Opens the log desk and searches the customer's handle, with the first of the owner's reasons when `reason` is set. */
async function search(page, reason) {
  await openFounderDesk(page, '/more-ops/agents/log', 'Agent action log');
  await desk(page)
    .getByRole('textbox', { name: /^Customer reference/ })
    .fill(agents.account().handle);
  if (reason) await desk(page).getByRole('combobox', { name: 'Reason' }).selectOption({ index: 1 });
  await desk(page).getByRole('button', { name: 'Search' }).click();
}

/**
 * Restarts svc-agents with one owner value blank (`off`) or back on its LOCAL TEST value. The restart runs without
 * blocking this process, so the console's kept-alive connections close while it runs and the next request opens a new one.
 */
async function ownerValue(variable, on) {
  const env = { ...process.env };
  if (on) delete env[variable];
  else env[variable] = 'off';
  await promisify(execFile)(process.execPath, [path.join(ROOT, 'tooling/scripts/local-test-stack.mjs'), 'restart', 'agents'], {
    cwd: ROOT,
    env,
    timeout: 120_000,
  });
}

/** One engine call in the customer's own session, through their own signed-in API door. */
async function ownRun(sessionId, requestId, task) {
  const door = await api(agents.account());
  return door.post('/api/agents/trpc/run.complete', { sessionId, requestId, task, messages: [{ role: 'user', content: PROMPT }] });
}

test(`${J} starts: a TEST customer who tried to open a Navigator session, and the founder console`, async ({ page }) => {
  test.setTimeout(240_000);
  // svc-agents starts on every LOCAL TEST owner value (reasons and retention), whatever an earlier run left blank.
  await ownerValue('LOCAL_STACK_AGENTS_LOG_READ_REASONS', true);
  await agents.start(page, 'ag15', '10');
  // The customer opens a Navigator session and runs it once, in their own session, confirming the spend ceiling.
  const sessionId = await openNavigatorSession(page, agents);
  const workspace = main(page).getByRole('region', { name: 'Session workspace' });
  await workspace.getByRole('textbox', { name: /^Ask the agent/ }).fill(PROMPT);
  const answered = page.waitForResponse((res) => res.url().endsWith('/api/agents/trpc/run.complete'));
  await workspace.getByRole('button', { name: 'Run' }).click();
  await page
    .getByRole('dialog', { name: 'Confirm the spend ceiling' })
    .getByRole('button', { name: /^Run up to/ })
    .click();
  const ran = await answered;
  expect(ran.status()).toBe(200);
  const run = (await ran.json()).result.data;
  expect([run.action.kind, run.action.status]).toEqual(['completion', 'executed']);
  // Then asks for a task this agent may not run: svc-agents refuses it and logs the refusal. This is the failed action.
  const refused = await ownRun(sessionId, `${sessionId}:not-allowed`, REFUSED_TASK);
  expect(refused.status).toBe(403);
  expect(refused.body.error.message).toBe('agents.refused.task_not_allowed');
  agents.run.write({ sessionId, ranActionId: run.action.id, task: run.action.task });
});

test(`${J} #1 searches the operator action log without a reason: a refusal that a reason is required and no rows`, async ({ page }) => {
  await search(page, false);
  await expect(desk(page).getByRole('alert')).toContainText('A reason is required');
  // The refusal is svc-agents' own, by its typed code.
  await expect(desk(page).getByRole('alert')).toContainText('(agents.log_read_reason_required)');
  await expect(rows(page)).toHaveCount(0);
  await expect(main(page).getByTestId('log-read-audit')).toHaveCount(0);
  // Re-read with a reason: this customer's log has been read once, so the refused search wrote no audit row.
  await search(page, true);
  await expect(main(page).getByTestId('log-read-total')).toHaveText(readsSoFar(1));
});

test(`${J} #2 enters a reason and searches: rows with refusal code and tool, no prompt text; exactly one log-read audit row`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // With the owner's reason list blank there is no reason to enter: the search refuses by its code and shows no rows.
  try {
    await ownerValue('LOCAL_STACK_AGENTS_LOG_READ_REASONS', false);
    await search(page, false);
    await expect(desk(page).getByRole('combobox', { name: 'Reason' }).getByRole('option')).toHaveCount(1);
    await expect(desk(page).getByRole('alert')).toContainText('(agents.log_read_reason_unset)');
    await expect(rows(page)).toHaveCount(0);
    await expect(main(page).getByTestId('log-read-total')).toHaveCount(0);
  } finally {
    await ownerValue('LOCAL_STACK_AGENTS_LOG_READ_REASONS', true);
  }

  await search(page, true);
  await expect(main(page).getByTestId('log-read-audit')).toHaveText('1 audit row written for this read');
  // Exactly one more read of this customer's log than #1's: this search's own row, none for the refused one.
  await expect(main(page).getByTestId('log-read-total')).toHaveText(readsSoFar(2));
  await expect(desk(page).getByRole('alert')).toHaveCount(0);
  for (const column of ['Time', 'Tool', 'Outcome', 'Refusal code'])
    await expect(rows(page).getByRole('columnheader', { name: column })).toBeVisible();
  await expect(rows(page).getByRole('columnheader', { name: 'Prompt' })).toHaveCount(0);
  // The refused request is a row with its tool and its refusal code; the run is a row too.
  const refused = rows(page)
    .getByRole('row')
    .filter({ has: page.getByTestId('action-outcome').getByText('Refused', { exact: true }) });
  await expect(refused).toHaveCount(1);
  await expect(refused.getByTestId('action-tool')).toHaveText(REFUSED_TASK);
  await expect(refused.getByTestId('action-refusal')).toHaveText('agents.task_not_allowed');
  await expect(actionRow(page, agents.run.read().ranActionId).getByTestId('action-outcome')).toHaveText('Executed');
  // No prompt text anywhere on the desk.
  await expect(main(page)).not.toContainText(PROMPT);
});

test(`${J} #3 filters by outcome and tool: matching rows; the export applies the same filter`, async ({ page }) => {
  await search(page, true);
  await expect(main(page).getByTestId('log-read-audit')).toHaveText('1 audit row written for this read');
  const all = await rows(page).getByTestId('action-outcome').count();
  await main(page).getByRole('combobox', { name: 'Outcome' }).selectOption({ label: 'Refused' });
  await main(page).getByRole('combobox', { name: 'Tool' }).selectOption({ label: REFUSED_TASK });
  // The filtered rows: every one refused and for the chosen tool, fewer than the unfiltered read.
  await expect(rows(page).getByTestId('action-outcome')).toHaveCount(1);
  await expect(
    rows(page)
      .getByTestId('action-outcome')
      .filter({ hasNotText: /^Refused$/ }),
  ).toHaveCount(0);
  await expect(rows(page).getByTestId('action-tool').filter({ hasNotText: REFUSED_TASK })).toHaveCount(0);
  const shown = await rows(page).getByTestId('action-outcome').count();
  expect(shown).toBeLessThan(all);
  const shownIds = await rows(page)
    .locator('tr[data-action-id]')
    .evaluateAll((trs) => trs.map((tr) => tr.dataset.actionId));
  // The export holds the same rows: one line each, every one refused and for the chosen tool, and no prompt text.
  const download = page.waitForEvent('download');
  await main(page)
    .getByRole('button', { name: /^Export/ })
    .click();
  const file = readFileSync(await (await download).path(), 'utf8');
  const [header, ...lines] = file.trim().split('\n');
  expect(header).toBe('Time,Tool,Outcome,Refusal code,Input digest,Action id');
  expect(lines).toHaveLength(shown);
  for (const line of lines) {
    const [, lineTool, outcome] = line.split(',');
    expect([lineTool, outcome]).toEqual([REFUSED_TASK, 'Refused']);
  }
  // The same rows, each once: the export's action ids are the ids shown.
  expect(lines.map((line) => line.split(',').at(-1))).toEqual(shownIds);
  expect(file).not.toContain(PROMPT);
});

test(`${J} #4 opens a transcript with retention unset: the typed refusal and no text row`, async ({ page }) => {
  test.setTimeout(240_000);
  const { sessionId, ranActionId, task } = agents.run.read();
  let unkept;
  try {
    await ownerValue('LOCAL_STACK_AGENTS_TRANSCRIPT_RETENTION', false);
    await search(page, true);
    await actionRow(page, ranActionId).getByRole('button', { name: 'Open transcript' }).click();
    await expect(transcriptProblem(page)).toContainText('(agents.transcript_retention_unset)');
    await expect(main(page).getByRole('region', { name: 'Transcript' })).toHaveCount(0);
    // An engine call that runs while retention is unset keeps no text row.
    const again = await ownRun(sessionId, `${sessionId}:retention-unset`, task);
    expect(again.status).toBe(200);
    unkept = again.body.result.data.action.id;
  } finally {
    await ownerValue('LOCAL_STACK_AGENTS_TRANSCRIPT_RETENTION', true);
  }
  // With retention back on, that call still has no text, and the text kept before it was unset was purged with it
  // (unset retention keeps none): both transcripts are refused as not kept.
  await search(page, true);
  for (const actionId of [unkept, ranActionId]) {
    await actionRow(page, actionId).getByRole('button', { name: 'Open transcript' }).click();
    await expect(transcriptProblem(page)).toContainText('(agents.transcript_not_kept)');
    await expect(main(page).getByRole('region', { name: 'Transcript' })).toHaveCount(0);
  }
});

test(`${J} #5 opens a transcript after the owner sets retention: text whose digest equals the action row's; the read needs a reason and writes one audit row`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  // The owner sets retention (the LOCAL TEST value); the customer then runs their agent again, in their own session.
  await ownerValue('LOCAL_STACK_AGENTS_TRANSCRIPT_RETENTION', true);
  const { sessionId, task } = agents.run.read();
  const ran = await ownRun(sessionId, `${sessionId}:retention-set`, task);
  expect(ran.status).toBe(200);
  await search(page, true);
  const row = actionRow(page, ran.body.result.data.action.id);
  const digest = await row.getByTestId('action-digest').innerText();
  expect(digest).toMatch(/^[0-9a-f]{64}$/);
  const before = Number((await main(page).getByTestId('log-read-total').innerText()).match(/so far: (\d+),/)[1]);
  // Without a reason the transcript is not read.
  await desk(page).getByRole('combobox', { name: 'Reason' }).selectOption({ index: 0 });
  await row.getByRole('button', { name: 'Open transcript' }).click();
  await expect(transcriptProblem(page)).toContainText('(agents.log_read_reason_required)');
  await expect(main(page).getByRole('region', { name: 'Transcript' })).toHaveCount(0);
  // With one, the kept text: the customer's own prompt, whose digest (computed by svc-agents from the text) is the row's.
  await desk(page).getByRole('combobox', { name: 'Reason' }).selectOption({ index: 1 });
  await row.getByRole('button', { name: 'Open transcript' }).click();
  const transcript = main(page).getByRole('region', { name: 'Transcript' });
  await expect(transcript.getByTestId('transcript-digest')).toHaveText(digest);
  await expect(transcript.getByTestId('transcript-text')).toContainText(PROMPT);
  await expect(transcript.getByTestId('transcript-read-audit')).toHaveText('1 audit row written for this read');
  // Exactly one more read than the search before it: the transcript's own row, none for the refused open.
  await expect(transcript.getByTestId('transcript-read-total')).toHaveText(readsSoFar(before + 1));
  // Kept for the owner's retention, as svc-agents stored it.
  const storedAt = Date.parse(await transcript.getByTestId('transcript-stored-at').innerText());
  const keptUntil = Date.parse(await transcript.getByTestId('transcript-kept-until').innerText());
  expect(keptUntil - storedAt).toBe(RETENTION_DAYS * 86_400_000);
});
