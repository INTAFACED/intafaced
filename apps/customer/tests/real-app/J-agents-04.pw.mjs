import { test, expect } from '@playwright/test';
import { UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';

// J-agents-04, in the running app (docs/roadmap/journeys.json): test my agent before release without spending real
// money. One test per step, titled "J-agents-04 #<n>", run in order on one verified TEST account with a draft agent of
// its own. A test session holds no reservation and never calls the ledger; every test reply and log row reads TEST.
// Every step is written; none is built yet, so each fails at its first missing part, quickly (UNBUILT):
// - the person cannot create an agent yet (no builder at /agents/new), so there is no Test panel, dry run or
//   Evaluations page (AG-testing-01, -02, AG-spend-04).
const J = 'J-agents-04';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const testPanel = (page) => main(page).getByRole('region', { name: 'Test' });
const evals = (page) => main(page).getByRole('region', { name: 'Evaluations' });

test(`${J} starts: a verified TEST account with a draft agent of its own`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag04', '10');
  await signIn(page, agents.account());
  await createOwnAgent(page);
});

test(`${J} #1 opens the Test panel and runs a test: mode test, billing 0, no reservation or usage row, every reply and log row labelled TEST`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Test');
  await testPanel(page)
    .getByRole('textbox', { name: /^Ask the agent/ })
    .fill('TEST question');
  await testPanel(page).getByRole('button', { name: 'Run a test' }).click();
  const run = tableIn(testPanel(page), 'Test runs').getByRole('row').nth(1);
  await expect(run).toContainText('TEST');
  await expect(run.getByTestId('run-cost')).toHaveText('0 USDT');
  await expect(testPanel(page).getByRole('region', { name: 'Reply' })).toContainText('TEST');
  await expect(testPanel(page)).toContainText('Test runs use the test engine and are never billed.');
});

test(`${J} #2 tests a tool that would move value: the run reports what it would do and no ledger call is made`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Test');
  await testPanel(page).getByRole('combobox', { name: 'Tool' }).selectOption({ label: 'trade.order.place' }, UNBUILT);
  await testPanel(page).getByRole('button', { name: 'Run a test' }).click();
  await expect(testPanel(page).getByRole('region', { name: 'Would do' })).toContainText('Would place');
  await expect(testPanel(page)).toContainText('Nothing was sent to the ledger.');
});

test(`${J} #3 submits a dry run of one tool call: the checks it passed and the would-be effect; no ledger entry, intent or reservation`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Test');
  await testPanel(page).getByRole('button', { name: 'Dry run one call' }).click(UNBUILT);
  const dry = testPanel(page).getByRole('region', { name: 'Dry run' });
  await expect(dry.getByRole('list', { name: 'Checks passed' }).getByRole('listitem').first()).toBeVisible();
  await expect(dry.getByRole('term').filter({ hasText: 'Would-be effect' })).toBeVisible();
  await expect(dry).toContainText('No entry, intent or reservation was made.');
});

test(`${J} #4 looks at the lists: live and test runs listed separately; test runs left out of live analytics by default`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Runs');
  await expect(main(page).getByRole('tab', { name: 'Live runs' })).toBeVisible(UNBUILT);
  await expect(main(page).getByRole('tab', { name: 'Test runs' })).toBeVisible();
  await openOwnAgent(page, agents, 'Analytics');
  await expect(main(page).getByRole('checkbox', { name: 'Include test runs' })).not.toBeChecked();
});

test(`${J} #5 opens Evaluations with no test set: a visible warning that the agent has no test set`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Evaluations');
  await expect(evals(page).getByRole('alert')).toHaveText('This agent has no test set yet.', UNBUILT);
});

test(`${J} #6 adds cases, repeats and a blank pass threshold, then starts: refused naming the threshold; with it set, results labelled TEST and pass equals the comparison`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Evaluations');
  await evals(page).getByRole('button', { name: 'Add a case' }).click(UNBUILT);
  await evals(page)
    .getByRole('textbox', { name: /^Case 1 input/ })
    .fill('TEST case');
  await evals(page)
    .getByRole('textbox', { name: /^Case 1 expected/ })
    .fill('TEST answer');
  await evals(page)
    .getByRole('textbox', { name: /^Repeats/ })
    .fill('2');
  await evals(page).getByRole('button', { name: 'Start evaluation' }).click();
  await expect(evals(page).getByRole('alert')).toContainText('Set a pass threshold first.');
  await evals(page)
    .getByRole('textbox', { name: /^Pass threshold/ })
    .fill('50');
  await evals(page).getByRole('button', { name: 'Start evaluation' }).click();
  const results = tableIn(evals(page), 'Evaluation results');
  await expect(results.getByRole('row')).toHaveCount(3);
  await expect(results).toContainText('TEST');
  const score = Number((await evals(page).getByTestId('eval-score').innerText()).replace(/[^\d.]/g, ''));
  await expect(evals(page).getByTestId('eval-verdict')).toHaveText(score >= 50 ? 'Pass' : 'Fail');
});

test(`${J} #7 starts the same evaluation again with the same request id: one evaluation run exists`, async ({ page }) => {
  await openOwnAgent(page, agents, 'Evaluations');
  await evals(page).getByRole('button', { name: 'Send again' }).click(UNBUILT);
  await expect(tableIn(evals(page), 'Evaluation runs').getByRole('row')).toHaveCount(2);
});
