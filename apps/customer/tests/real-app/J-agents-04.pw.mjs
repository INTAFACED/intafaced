import { test, expect } from './journey.mjs';
import { OWN_AGENT, UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { api } from './stack.mjs';

// J-agents-04, in the running app (docs/roadmap/journeys.json): test my agent before release without spending real
// money. One test per step, titled "J-agents-04 #<n>", run in order on one verified TEST account with a draft agent of
// its own. A test session holds no reservation and never calls the ledger; every test reply and log row reads TEST.
// #5 to #7 are built (AG-testing-02): the agent's Evaluations page, its test set and evaluation runs on the test engine
// (no model, never billed, no ledger call), each result labelled TEST, every answer read back from svc-agents.
// #1 to #4 fail at their first missing part, quickly (UNBUILT): there is no test run in the Test panel, dry run, or
// live and test run lists (AG-testing-01, AG-spend-04).
const J = 'J-agents-04';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const testPanel = (page) => main(page).getByRole('region', { name: 'Test' });
const evals = (page) => main(page).getByRole('region', { name: 'Evaluations' });
const startForm = (page) => evals(page).getByRole('form', { name: 'Start an evaluation' });

/** One of the person's own agent's service reads through Edge, on a sign-in of its own: the answer's data. */
async function ownRead(procedure, input) {
  const query = `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await (await api(agents.account())).get(`/api/agents/trpc/own.${procedure}${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
/** The journey's own agent's test set and evaluation runs, as svc-agents holds them. */
async function evalsRead() {
  const [agent] = (await ownRead('list', { limit: 50 })).filter((row) => row.name === OWN_AGENT);
  expect(agent, 'the journey made its own agent').toBeTruthy();
  return ownRead('evals.get', { id: agent.id, limit: 50 });
}

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
  // svc-agents holds no test set and no run for the agent yet.
  expect(await evalsRead()).toEqual({ testSet: [], latest: null, runs: [] });
  await openOwnAgent(page, agents, 'Evaluations');
  const warning = evals(page).getByRole('alert');
  await expect(warning).toBeVisible();
  await expect(warning).toHaveText('This agent has no test set yet.');
});

test(`${J} #6 adds cases, repeats and a blank pass threshold, then starts: refused naming the threshold and no run; with it set, cases times repeats results each labelled TEST, and pass or fail equals the comparison`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Evaluations');
  // Two cases: on the test engine (its reply is "TEST reply: " and the input) the first reply lacks its expected answer
  // and the second holds it, so the results carry both outcomes.
  const cases = [
    { input: 'TEST case', expected: 'TEST answer' },
    { input: 'Say TEST answer', expected: 'TEST answer' },
  ];
  const repeats = 2;
  for (const [i, { input, expected }] of cases.entries()) {
    await evals(page).getByRole('button', { name: 'Add a case' }).click();
    await evals(page)
      .getByRole('textbox', { name: new RegExp(`^Case ${i + 1} input`) })
      .fill(input);
    await evals(page)
      .getByRole('textbox', { name: new RegExp(`^Case ${i + 1} expected`) })
      .fill(expected);
  }
  await evals(page)
    .getByRole('textbox', { name: /^Repeats/ })
    .fill(String(repeats));
  await expect(evals(page).getByRole('textbox', { name: /^Pass threshold/ })).toHaveValue('');
  await evals(page).getByRole('button', { name: 'Start evaluation' }).click();

  // Refused, naming the threshold, and no run: none on the page, none in svc-agents, and no test set saved.
  const refusal = startForm(page).getByRole('alert');
  await expect(refusal).toContainText('Set a pass threshold first.');
  await expect(refusal.locator('code')).toHaveText('agents.eval.threshold_unset');
  await expect(tableIn(evals(page), 'Evaluation runs').getByRole('row')).toHaveCount(1);
  expect(await evalsRead()).toEqual({ testSet: [], latest: null, runs: [] });

  const threshold = 50;
  await evals(page)
    .getByRole('textbox', { name: /^Pass threshold/ })
    .fill(String(threshold));
  await evals(page).getByRole('button', { name: 'Start evaluation' }).click();

  // Cases times repeats results, on the page and in svc-agents, each labelled TEST.
  const total = cases.length * repeats;
  const results = tableIn(evals(page), 'Evaluation results');
  await expect(results.getByRole('row')).toHaveCount(1 + total);
  await expect(results.getByTestId('result-label')).toHaveText(Array(total).fill('TEST'));
  const { testSet, latest: run, runs } = await evalsRead();
  expect(testSet).toEqual(cases);
  expect(runs.map((r) => r.id)).toEqual([run.id]);
  expect(run.results).toHaveLength(total);
  expect(run.results.map((r) => r.label)).toEqual(Array(total).fill('TEST'));
  expect(run.results.map((r) => [r.caseIndex, r.repeat])).toEqual(
    cases.flatMap((_, i) => [...Array(repeats).keys()].map((k) => [i, k + 1])),
  );

  // Each result's pass or fail is its comparison: the reply contains the expected answer.
  const replies = await results.getByTestId('result-reply').allInnerTexts();
  const expecteds = await results.getByTestId('result-expected').allInnerTexts();
  const outcomes = replies.map((reply, i) => (reply.includes(expecteds[i]) ? 'Pass' : 'Fail'));
  await expect(results.getByTestId('result-outcome')).toHaveText(outcomes);
  expect(outcomes).toContain('Pass');
  expect(outcomes).toContain('Fail');
  for (const r of run.results) expect(r.passed).toBe(r.reply.includes(r.expected));

  // The evaluation's pass or fail is the comparison of the share that passed with the threshold.
  const passed = outcomes.filter((outcome) => outcome === 'Pass').length;
  const score = Number((await evals(page).getByTestId('eval-score').innerText()).replace(/[^\d.]/g, ''));
  expect(score).toBe((passed * 100) / total);
  const verdict = passed * 100 >= threshold * total ? 'Pass' : 'Fail';
  await expect(evals(page).getByTestId('eval-verdict')).toHaveText(verdict);
  expect(run).toMatchObject({ passed, total, threshold: String(threshold), verdict: verdict.toLowerCase() });
});

test(`${J} #7 starts the same evaluation again with the same request id: one evaluation run exists`, async ({ page }) => {
  const { latest: before } = await evalsRead();
  expect(before, '#6 made one evaluation run').toBeTruthy();
  await openOwnAgent(page, agents, 'Evaluations');
  await expect(tableIn(evals(page), 'Evaluation runs').getByRole('row')).toHaveCount(2);
  // The press sends the run's own request id and the same evaluation, and the service answers with that run.
  const sent = page.waitForRequest((request) => request.method() === 'POST' && request.url().includes('own.evals.start'));
  const answered = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('own.evals.start'));
  await evals(page).getByRole('button', { name: 'Send again' }).click();
  const body = JSON.stringify((await sent).postDataJSON());
  expect(body).toContain(JSON.stringify(before.requestId));
  expect(body).toContain(JSON.stringify(before.cases));
  const answer = await answered;
  expect(answer.status()).toBe(200);
  expect(JSON.stringify(await answer.json())).toContain(before.id);
  await expect(evals(page).getByRole('status')).toHaveText(
    `Sent again with request id ${before.requestId}: the service answered with the same run, so nothing ran twice.`,
  );
  await expect(tableIn(evals(page), 'Evaluation runs').getByRole('row')).toHaveCount(2);
  const { latest, runs } = await evalsRead();
  expect(runs.map((r) => r.id)).toEqual([before.id]);
  expect(latest).toEqual(before);
});
