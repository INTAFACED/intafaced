import { test, expect } from './journey.mjs';
import { OWN_AGENT, UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { api } from './stack.mjs';

// J-agents-05, in the running app (docs/roadmap/journeys.json): approve, edit or reject what my agent wants to do. One
// test per step, titled "J-agents-05 #<n>", run in order on one verified TEST account with an agent of its own that has a
// tool needing approval and the standing rule "ask before sending a comment". The gated tool runs exactly once after
// approval, never before, and every decision is recorded. The push notice shows its vendor text (vendor.push); the
// automatic reviewer waits on the owner's model choice (owner.decision).
// #1 and #2 are built (AG-guardrails-02, AG-guardrails-01): the agent's Rules page, the managed baseline (a labelled TEST
// value on the stack), the consent card for each kind of tool and the Permissions page, with every answer read back
// from svc-agents. #3 is built (AG-approvals-01): a held call reads waiting for approval on Live runs and is a row of the
// Approvals inbox, and the tool has not run. The rest fail at their first missing part, quickly (UNBUILT): there is no
// notice, no approve, edit or reject (the inbox shows them off), no expiry, and no automatic reviewer (AG-approvals-01, -02).
const J = 'J-agents-05';
const agents = agentsRun(J);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const rules = (page) => main(page).getByRole('form', { name: 'Rules' });
const tryTool = (page) => main(page).getByRole('region', { name: 'Try a tool' });
const consentCard = (page) => page.getByRole('dialog', { name: /^Allow this agent to use/ });
const requests = (page) => tableIn(main(page), 'Approval requests');
const inbox = (page) => tableIn(main(page), 'Approvals');

/** One of the person's own agent's service reads through Edge, on a sign-in of its own: the answer's data. */
async function ownRead(procedure, input) {
  const query = `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await (await api(agents.account())).get(`/api/agents/trpc/own.${procedure}${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
/** One session's action log, as svc-agents keeps it for the person. */
async function ownSessionLog(sessionId) {
  const query = `?input=${encodeURIComponent(JSON.stringify({ sessionId, limit: 500 }))}`;
  const res = await (await api(agents.account())).get(`/api/agents/trpc/session.log${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
/** The journey's own agent, as svc-agents holds it. */
async function ownAgent() {
  const [agent] = (await ownRead('list', { limit: 50 })).filter((row) => row.name === OWN_AGENT);
  expect(agent, 'the journey made its own agent').toBeTruthy();
  return agent;
}

/** Picks a tool on the Test page, fills its declared input fields, and presses "Run a test". */
async function runTest(page, tool, fields = {}) {
  await tryTool(page).getByRole('combobox', { name: 'Tool' }).selectOption({ label: tool });
  for (const [field, value] of Object.entries(fields)) {
    await tryTool(page)
      .getByRole('textbox', { name: new RegExp(`^${field}`) })
      .fill(value);
  }
  await tryTool(page).getByRole('button', { name: 'Run a test' }).click();
}

async function saveRule(page, action, when) {
  await rules(page).getByRole('combobox', { name: 'Action' }).selectOption({ label: action });
  await rules(page).getByRole('combobox', { name: 'When' }).selectOption({ label: when });
  await rules(page).getByRole('button', { name: 'Save rule' }).click();
}

const COMMENT = { ticketId: 'TEST-ticket', body: 'TEST comment' };
const RUN_COMMENT = { ticketId: 'TEST-ticket', body: 'TEST comment, run' };

async function openInbox(page) {
  await signIn(page, agents.account());
  await page.goto('/agents/approvals');
  await expect(main(page).getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible(UNBUILT);
}

test(`${J} starts: a verified TEST account with an agent of its own that has a tool needing approval`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag05', '10');
  await signIn(page, agents.account());
  await createOwnAgent(page);
  // The service starter carries the help search; the comment tool, a live write, is added on the Build page.
  const builder = main(page).getByRole('form', { name: 'Agent builder' });
  await builder.getByRole('button', { name: 'Add a tool' }).click();
  await page
    .getByRole('dialog', { name: 'Add a tool' })
    .getByRole('option', { name: /support\.ticket\.comment/ })
    .click();
  await builder.getByRole('button', { name: 'Save draft' }).click();
  await expect(builder.getByRole('status')).toHaveText('Draft saved.');
  expect((await ownAgent()).tools).toEqual(expect.arrayContaining(['support.kb.search', 'support.ticket.comment']));
  // A session opens only once the person has set the agent's caps (J-agents-02): the journey sets them here.
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Limits', exact: true }).click();
  const limits = main(page).getByRole('form', { name: 'Spending limits' });
  await limits.getByRole('textbox', { name: /^Per call/ }).fill('0.012');
  await limits.getByRole('textbox', { name: /^Per session/ }).fill('0.02');
  await limits.getByRole('textbox', { name: /^Per month/ }).fill('5');
  await limits.getByRole('button', { name: 'Save limits' }).click();
  await expect(limits.getByRole('status')).toHaveText('Limits saved.');
});

test(`${J} #1 writes "ask before sending a comment", then a rule that acts without asking on a live-write tool: the first saves, the second and any loosening are refused`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await ownAgent();
  // Before any rule, the agent's comment is not held for the person: once the person allows actions in their name, the
  // call goes straight on to the comment's door (not built: it refuses and sends nothing) and no approval request exists.
  await openOwnAgent(page, agents, 'Test');
  await runTest(page, 'Send a comment', COMMENT);
  await expect(consentCard(page)).toBeVisible();
  await expect(consentCard(page)).toHaveAccessibleName('Allow this agent to use actions in your name?');
  await consentCard(page).getByRole('button', { name: 'Allow' }).click();
  await expect(tryTool(page).getByRole('status')).toHaveText('Allowed: actions in your name. Run the test again.');
  await tryTool(page).getByRole('button', { name: 'Run a test' }).click();
  await expect(tryTool(page).getByRole('alert').locator('code')).toHaveText('agents.tool_not_wired');
  expect(await ownRead('approvals', { id: agent.id, limit: 50 })).toEqual([]);

  // The first rule saves.
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Rules', exact: true }).click();
  await saveRule(page, 'Send a comment', 'Ask me before acting');
  await expect(rules(page).getByRole('status')).toHaveText('Rule saved.');
  await expect(rules(page).getByRole('list', { name: 'Your rules' }).getByRole('listitem')).toHaveText(['Ask before sending a comment']);
  const [saved] = await ownRead('rules.list', { id: agent.id });
  expect(saved).toMatchObject({ tool: 'support.ticket.comment', choice: 'ask_before' });

  // A rule that lets the live-write comment act without asking is refused at save.
  await saveRule(page, 'Send a comment', 'Act without asking');
  await expect(rules(page).getByRole('alert')).toContainText('A rule cannot let a live-write tool act without asking.');
  await expect(rules(page).getByRole('alert').locator('code')).toHaveText('agents.rule_invalid');
  // A rule looser than the baseline (the TEST baseline lets own data act only on request) is refused at save.
  await saveRule(page, 'Search help articles', 'Act without asking');
  await expect(rules(page).getByRole('alert')).toContainText('A rule cannot loosen the baseline.');
  await expect(rules(page).getByRole('alert').locator('code')).toHaveText('agents.baseline_loosen_refused');
  // Neither refused rule was stored: svc-agents holds the one saved rule, and the page read again shows only it.
  expect(await ownRead('rules.list', { id: agent.id })).toEqual([saved]);
  await page.reload();
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Rules', exact: true }).click();
  await expect(rules(page).getByRole('list', { name: 'Your rules' }).getByRole('listitem')).toHaveText(['Ask before sending a comment']);

  // When the agent tries the comment now, the saved rule turns it into an approval request and the tool does not run.
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Test', exact: true }).click();
  await runTest(page, 'Send a comment', COMMENT);
  await expect(tryTool(page).getByRole('status')).toHaveText('Waiting for your approval: sending a comment. The tool has not run.');
  await expect(tryTool(page).getByRole('alert')).toHaveCount(0);
  const row = requests(page).getByRole('row').filter({ hasText: 'Send a comment' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Waiting for approval');
  await expect(row).toContainText('body: TEST comment');
  const held = await ownRead('approvals', { id: agent.id, limit: 50 });
  expect(held).toHaveLength(1);
  expect(held[0]).toMatchObject({ tool: 'support.ticket.comment', status: 'waiting', ruleId: saved.id, input: COMMENT });
});

test(`${J} #2 uses a connector class for the first time: the consent card appears and the call is refused until granted; revoking withdraws it`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await ownAgent();
  // The help search reads the person's own data: a class this agent has not used, so nothing is granted for it yet.
  expect((await ownRead('consents.list', { id: agent.id })).map((row) => row.dataClass)).not.toContain('own_data');
  await openOwnAgent(page, agents, 'Test');
  await runTest(page, 'Search help articles', { kbQuery: 'account', limit: '5' });
  const consent = consentCard(page);
  await expect(consent).toBeVisible();
  await expect(consent).toHaveAccessibleName('Allow this agent to use your own data?');
  await expect(main(page).getByRole('alert')).toContainText('Refused until you allow it.');
  await expect(main(page).getByRole('alert').locator('code')).toHaveText('agents.consent_required');
  // Refused: the tool did not run, and asking again without allowing is refused again.
  await consent.getByRole('button', { name: 'Not now' }).click();
  await expect(tryTool(page).getByRole('region', { name: 'Tool answer' })).toHaveCount(0);
  await tryTool(page).getByRole('button', { name: 'Run a test' }).click();
  await expect(consentCard(page)).toBeVisible();
  await consentCard(page).getByRole('button', { name: 'Allow' }).click();
  await expect(tryTool(page).getByRole('status')).toHaveText('Allowed: your own data. Run the test again.');
  expect(await ownRead('consents.list', { id: agent.id })).toEqual(
    expect.arrayContaining([expect.objectContaining({ dataClass: 'own_data', state: 'granted', revokedAt: null })]),
  );
  // Granted: the same call now runs, and the help search answers.
  await tryTool(page).getByRole('button', { name: 'Run a test' }).click();
  const answer = tryTool(page).getByRole('region', { name: 'Tool answer' });
  await expect(answer).toContainText('Ran Search help articles.');
  await expect(answer.getByTestId('tool-answer')).toContainText('"tool": "support.kb.search"');
  await expect(answer.getByTestId('tool-answer')).toContainText('"status": "ok"');
  await expect(answer.getByTestId('tool-answer')).toContainText('"articleKey": "kb-');
  await expect(consentCard(page)).toHaveCount(0);

  // Revoking withdraws it: the Permissions page says so, svc-agents holds it withdrawn, and the next call is refused again.
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Permissions', exact: true }).click();
  await expect(main(page).getByTestId('acts-as-you')).toContainText('This agent acts as you, with your own access and no more.');
  const ownData = main(page)
    .getByRole('list', { name: 'Kinds of tools this agent uses' })
    .getByRole('listitem')
    .filter({ hasText: 'your own data' });
  await expect(ownData).toContainText('Allowed');
  await ownData.getByRole('button', { name: 'Revoke' }).click();
  await expect(main(page).getByRole('status')).toContainText('Withdrawn');
  await expect(ownData).toContainText('Withdrawn');
  expect(await ownRead('consents.list', { id: agent.id })).toEqual(
    expect.arrayContaining([expect.objectContaining({ dataClass: 'own_data', state: 'withdrawn' })]),
  );
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Test', exact: true }).click();
  await runTest(page, 'Search help articles', { kbQuery: 'account', limit: '5' });
  await expect(consentCard(page)).toBeVisible();
  await expect(main(page).getByRole('alert').locator('code')).toHaveText('agents.consent_required');
  await expect(tryTool(page).getByRole('region', { name: 'Tool answer' })).toHaveCount(0);
});

test(`${J} #3 runs the agent to the gated tool: the tool has not run, the run reads waiting for approval and a request row exists`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const agent = await ownAgent();
  const before = await ownRead('approvals', { id: agent.id, limit: 50 });
  // The agent runs to its comment tool; the rule "ask before sending a comment" (#1) holds the call for the person.
  await openOwnAgent(page, agents, 'Test');
  await runTest(page, 'Send a comment', RUN_COMMENT);
  await expect(tryTool(page).getByRole('status')).toHaveText('Waiting for your approval: sending a comment. The tool has not run.');
  const held = await ownRead('approvals', { id: agent.id, limit: 50 });
  expect(held).toHaveLength(before.length + 1);
  const request = held[0];
  expect(request).toMatchObject({ tool: 'support.ticket.comment', status: 'waiting', input: RUN_COMMENT });

  // The tool has not run: the session's own log holds no call of the comment tool, and svc-agents lists the run as this
  // held call, with no action of its own and nothing billed.
  const log = await ownSessionLog(request.sessionId);
  expect(log.filter((action) => action.tool === 'support.ticket.comment')).toEqual([]);
  const [newest] = await ownRead('runs', { id: agent.id, limit: 50 });
  expect(newest).toMatchObject({ status: 'waiting', tool: 'support.ticket.comment', requestId: request.id, sequence: null });
  expect(Number(newest.cost)).toBe(0);

  // The run reads waiting for approval on the agent's Live runs.
  await page.getByRole('group', { name: 'Agent pages' }).getByRole('button', { name: 'Runs', exact: true }).click();
  const run = tableIn(main(page), 'Live runs').getByRole('row').nth(1);
  await expect(run).toContainText('Waiting for approval');
  await expect(run).toContainText('Send a comment: the tool has not run.');

  // A request row exists in the Approvals inbox: one row for each request svc-agents holds, this one among them.
  await openInbox(page);
  const rows = inbox(page).getByRole('row').filter({ hasText: 'Send a comment' });
  await expect(rows).toHaveCount(held.length);
  const row = inbox(page).locator(`[data-request-id="${request.id}"]`);
  await expect(row).toContainText(OWN_AGENT);
  await expect(row).toContainText('body: TEST comment, run');
  await expect(row).toContainText('Waiting for approval');
  expect(await ownRead('inbox', { limit: 100 })).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: request.id, agentId: agent.id, agentName: OWN_AGENT, status: 'waiting' })]),
  );
});

test(`${J} #4 gets the notice and opens the Approvals inbox: the notice names the action and links to the inbox; the push notice shows the vendor text`, async ({
  page,
}) => {
  await signIn(page, agents.account());
  await page.goto('/home');
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const notice = page.getByRole('dialog', { name: /Notifications/ }).getByRole('link', { name: /wants to send a comment/ });
  await expect(notice).toBeVisible(UNBUILT);
  await notice.click();
  await expect(page).toHaveURL(/\/agents\/approvals/);
  await expect(main(page).getByRole('note').filter({ hasText: 'vendor.push' })).toBeVisible();
});

test(`${J} #5 edits the payload then approves: a new request for the new payload, the old approval does not carry over; approve runs once, a repeat returns the first result`, async ({
  page,
}) => {
  await openInbox(page);
  const request = inbox(page).getByRole('row').filter({ hasText: 'Send a comment' }).first();
  await request.getByRole('button', { name: 'Edit' }).click(UNBUILT);
  await page
    .getByRole('dialog', { name: 'Edit the request' })
    .getByRole('textbox', { name: /^Comment/ })
    .fill('TEST comment, edited');
  await page.getByRole('dialog', { name: 'Edit the request' }).getByRole('button', { name: 'Save as a new request' }).click();
  await expect(inbox(page).getByRole('row').filter({ hasText: 'Replaced by your edit' })).toHaveCount(1);
  const edited = inbox(page).getByRole('row').filter({ hasText: 'TEST comment, edited' });
  await edited.getByRole('button', { name: 'Approve' }).click();
  await expect(edited).toContainText('Approved · ran once');
  await edited.getByRole('button', { name: 'Approve again' }).click();
  await expect(main(page).getByRole('status')).toContainText('Already approved: the first result is shown.');
});

test(`${J} #6 rejects another request and lets a third expire: the step ends with a typed refusal; an expired request or a down identity service fails closed`, async ({
  page,
}) => {
  await openInbox(page);
  const pending = inbox(page).getByRole('row').filter({ hasText: 'Waiting' });
  await pending.first().getByRole('button', { name: 'Reject' }).click(UNBUILT);
  await expect(inbox(page).getByRole('row').filter({ hasText: 'Rejected' }).first()).toContainText('agents.approval.rejected');
  await expect(inbox(page).getByRole('row').filter({ hasText: 'Expired' }).first()).toContainText('agents.approval.expired', {
    timeout: 120_000,
  });
});

test(`${J} #7 turns on the automatic reviewer for no-value tools: "proceed" runs a no-value call; a value tool always asks; with the model unset the owner-decision notice`, async ({
  page,
}) => {
  await openOwnAgent(page, agents, 'Rules');
  const reviewer = main(page).getByRole('switch', { name: 'Automatic reviewer for tools that move no value' });
  await expect(reviewer).toBeVisible(UNBUILT);
  // While the owner has not chosen the reviewer's model it stays off and says so; calls go to the person.
  await expect(reviewer).toBeDisabled();
  await expect(main(page).getByRole('note').filter({ hasText: 'owner.decision' })).toContainText('reviewer');
  await expect(main(page)).toContainText('Tools that can move value always ask you.');
});
