import { test, expect } from './journey.mjs';
import { OWN_AGENT, UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { api, toUnits } from './stack.mjs';

// J-agents-04, in the running app (docs/roadmap/journeys.json): test my agent before release without spending real
// money. One test per step, titled "J-agents-04 #<n>", run in order on one verified TEST account with a draft agent of
// its own. A test session holds no reservation and never calls the ledger; every test reply and log row reads TEST.
// #5 to #7 are built (AG-testing-02): the agent's Evaluations page, its test set and evaluation runs on the test engine
// (no model, never billed, no ledger call), each result labelled TEST, every answer read back from svc-agents.
// #3 and #4 are built (AG-spend-04, AG-testing-01): a dry run of one tool call on the Test page reports every check a
// real call meets and the would-be effect, and makes no ledger entry, intent or reservation (read back from the ledger
// and svc-agents); it is a test run, listed apart from live runs on Runs and left out of live analytics by default.
// #1 and #2 fail at their first missing part, quickly (UNBUILT): there is no test-engine run in the Test panel and no
// test of a tool that would move value (AG-testing-01).
const J = 'J-agents-04';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const testPanel = (page) => main(page).getByRole('region', { name: 'Test' });
const evals = (page) => main(page).getByRole('region', { name: 'Evaluations' });
const startForm = (page) => evals(page).getByRole('form', { name: 'Start an evaluation' });
const pages = (page) => page.getByRole('group', { name: 'Agent pages' });

/** The checks a real call of one of the agent's tools meets, in order, as the dry run words them. */
const CHECKS = {
  tool_declared: 'The agent carries this tool',
  input_declared: 'Every input is one the tool declares',
  moves_no_value: 'The tool moves no value',
  consent: 'You allowed this kind of tool',
  baseline: 'The platform’s baseline covers this kind of tool',
  rule: 'Your rules let the call go ahead',
  caps_set: 'Your spending caps for this agent are set',
  door_wired: 'The tool’s connection is built',
};
/** The one call #3 dry runs: the help search the service starter carries, with its two declared inputs. */
const CALL = { tool: 'support.kb.search', words: 'Search help articles', input: { kbQuery: 'TEST question', limit: '5' } };

/** One of the person's own agent's service reads through Edge, on a sign-in of its own: the answer's data. */
async function ownRead(procedure, input) {
  const query = `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await (await api(agents.account())).get(`/api/agents/trpc/own.${procedure}${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
/** The journey's own agent, as svc-agents holds it. */
async function ownAgent() {
  const [agent] = (await ownRead('list', { limit: 50 })).filter((row) => row.name === OWN_AGENT);
  expect(agent, 'the journey made its own agent').toBeTruthy();
  return agent;
}
/** The journey's own agent's test set and evaluation runs, as svc-agents holds them. */
async function evalsRead() {
  return ownRead('evals.get', { id: (await ownAgent()).id, limit: 50 });
}
/** The person's ledger lines (every asset, newest first) and balances, as the ledger answers them through Edge. */
async function ledgerNow() {
  const me = await api(agents.account());
  const { status, body } = await me.get('/api/v1/ledger?limit=200');
  expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return { entries: body.entries, balances: await me.balances() };
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
  // The agent as a real call of its help search needs it: the person's caps for it (Limits), and their consent to its
  // own-data tools, given on the consent card the first real call of one asks for (Test, "Try a tool").
  await openOwnAgent(page, agents, 'Limits');
  const limits = main(page).getByRole('form', { name: 'Spending limits' });
  await expect(limits).toBeVisible();
  await limits.getByRole('textbox', { name: /^Per call/ }).fill('0.5');
  await limits.getByRole('textbox', { name: /^Per session/ }).fill('1');
  await limits.getByRole('textbox', { name: /^Per month/ }).fill('5');
  await limits.getByRole('button', { name: 'Save limits' }).click();
  await expect(limits.getByRole('status')).toHaveText('Limits saved.');
  await pages(page).getByRole('button', { name: 'Test', exact: true }).click();
  const tryTool = main(page).getByRole('region', { name: 'Try a tool' });
  await tryTool.getByRole('combobox', { name: 'Tool' }).selectOption({ label: CALL.words });
  await tryTool.getByRole('button', { name: 'Run a test' }).click();
  const card = page.getByRole('dialog', { name: /^Allow this agent to use/ });
  await card.getByRole('button', { name: 'Allow' }).click();
  await expect(tryTool.getByRole('status')).toHaveText('Allowed: your own data. Run the test again.');

  const agent = await ownAgent();
  const before = {
    ledger: await ledgerNow(),
    holds: await ownRead('holds', { id: agent.id }),
    tests: await ownRead('testRuns', { id: agent.id, limit: 50 }),
  };

  await testPanel(page).getByRole('combobox', { name: 'Tool' }).selectOption({ label: CALL.words }, UNBUILT);
  for (const [field, value] of Object.entries(CALL.input))
    await testPanel(page)
      .getByRole('textbox', { name: new RegExp(`^${field}`) })
      .fill(value);
  await testPanel(page).getByRole('button', { name: 'Dry run one call' }).click();
  const dry = testPanel(page).getByRole('region', { name: 'Dry run' });

  // The checks it passed: every check a real call of the help search meets, in order, each passed, none failed.
  await expect(dry.getByRole('list', { name: 'Checks passed' }).getByRole('listitem')).toHaveText(Object.values(CHECKS));
  await expect(dry.getByRole('list', { name: 'Checks not passed' })).toHaveCount(0);
  // The would-be effect: the one read it would run, with its input, and that it moves nothing; never billed.
  await expect(dry.getByRole('term').filter({ hasText: 'Would-be effect' })).toBeVisible();
  await expect(dry.getByTestId('dry-effect')).toHaveText(
    `Would run “${CALL.words}” once in a session of this agent, with kbQuery: TEST question; limit: 5: it reads support data and moves no value.`,
  );
  await expect(dry.getByTestId('dry-cost')).toHaveText('0 USDT');
  await expect(dry).toContainText('No entry, intent or reservation was made.');

  // svc-agents holds the dry run as one new test run: those checks, all passed, that effect, labelled TEST, cost 0.
  const tests = await ownRead('testRuns', { id: agent.id, limit: 50 });
  expect(tests).toHaveLength(before.tests.length + 1);
  expect(tests[0]).toMatchObject({
    kind: 'dry_run',
    tool: CALL.tool,
    input: CALL.input,
    cost: '0',
    label: 'TEST',
    effect: { kind: 'run', tool: CALL.tool, module: 'support', dataClass: 'own_data', input: CALL.input },
  });
  expect(tests[0].checks).toEqual(Object.keys(CHECKS).map((check) => ({ check, passed: true, code: null })));

  // No ledger entry, intent or reservation exists: the ledger lines and balances are exactly as before, and svc-agents
  // holds no reservation and no intent for this agent, and no more sessions than before.
  expect(await ledgerNow()).toEqual(before.ledger);
  expect(await ownRead('holds', { id: agent.id })).toEqual({ ...before.holds, reservations: 0, intents: 0 });
});

test(`${J} #4 looks at the lists: live and test runs listed separately; test runs left out of live analytics by default`, async ({
  page,
}) => {
  // One live run of the agent, on its Limits page's session: an engine run, billed as any live run is.
  await openOwnAgent(page, agents, 'Limits');
  const session = main(page).getByRole('region', { name: 'Session' });
  await session.getByRole('button', { name: 'Open a session' }).click();
  await session.getByRole('textbox', { name: /^Ask the agent/ }).fill('TEST question');
  await session.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(session.getByRole('region', { name: 'Reply' })).toBeVisible();
  const agent = await ownAgent();
  const live = await ownRead('runs', { id: agent.id, limit: 50 });
  const tests = await ownRead('testRuns', { id: agent.id, limit: 50 });
  expect(live.filter((run) => run.status === 'executed').length, 'a live run was made').toBeGreaterThan(0);
  expect(tests.length, '#3 made a test run').toBeGreaterThan(0);

  // Two lists, each its own tab. Live runs: exactly the service's live runs, none labelled TEST.
  await pages(page).getByRole('button', { name: 'Runs', exact: true }).click();
  const liveTab = main(page).getByRole('tab', { name: 'Live runs' });
  const testTab = main(page).getByRole('tab', { name: 'Test runs' });
  await expect(liveTab).toBeVisible(UNBUILT);
  await expect(testTab).toBeVisible();
  await expect(liveTab).toHaveAttribute('aria-selected', 'true');
  const liveTable = tableIn(main(page), 'Runs');
  await expect(liveTable.getByRole('row')).toHaveCount(1 + live.length);
  await expect(liveTable.getByTestId('run-cost')).toHaveText(live.map((run) => `${run.cost} ${run.assetId}`));
  await expect(liveTable).not.toContainText('TEST');
  await expect(tableIn(main(page), 'Test runs')).toHaveCount(0);

  // Test runs: exactly the service's test runs, each a dry run labelled TEST at 0, and the live list is not among them.
  await testTab.click();
  await expect(testTab).toHaveAttribute('aria-selected', 'true');
  const testTable = tableIn(main(page), 'Test runs');
  await expect(testTable.getByRole('row')).toHaveCount(1 + tests.length);
  await expect(testTable.getByTestId('test-run-label')).toHaveText(tests.map(() => 'TEST'));
  await expect(testTable.getByTestId('test-run-cost')).toHaveText(tests.map((run) => `0 ${run.assetId}`));
  await expect(testTable).toContainText('Dry run');
  await expect(tableIn(main(page), 'Runs')).toHaveCount(0);

  // Live analytics, by default: "Include test runs" is off and the figures are the live runs alone.
  await openOwnAgent(page, agents, 'Analytics');
  const include = main(page).getByRole('checkbox', { name: 'Include test runs' });
  await expect(include).not.toBeChecked();
  const byDefault = await ownRead('analytics', { id: agent.id });
  expect(byDefault).toMatchObject({ includeTest: false, runs: live.length, liveRuns: live.length, testRuns: null });
  expect(toUnits(byDefault.cost)).toBe(live.reduce((sum, run) => sum + toUnits(run.cost), 0n));
  const figure = (id) => main(page).getByTestId(`analytics-${id}`);
  await expect(figure('runs')).toHaveText(String(live.length));
  await expect(figure('test-runs')).toHaveText('—');
  await expect(figure('cost')).toHaveText(`${byDefault.cost} ${byDefault.assetId}`);

  // Included on request: the runs grow by exactly the test runs, and what was spent does not move.
  await include.check();
  await expect(figure('runs')).toHaveText(String(live.length + tests.length));
  await expect(figure('test-runs')).toHaveText(String(tests.length));
  await expect(figure('cost')).toHaveText(`${byDefault.cost} ${byDefault.assetId}`);
  expect(await ownRead('analytics', { id: agent.id, includeTest: true })).toEqual({
    ...byDefault,
    includeTest: true,
    runs: live.length + tests.length,
    testRuns: tests.length,
  });
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
