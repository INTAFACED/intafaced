import { test, expect } from './journey.mjs';
import { OWN_AGENT, UNBUILT, agentsRun, createOwnAgent, openOwnAgent, tableIn } from './agents.mjs';
import { signIn } from './desk.mjs';
import { api, journeyState, tool } from './stack.mjs';

// J-agents-05, in the running app (docs/roadmap/journeys.json): approve, edit or reject what my agent wants to do. One
// test per step, titled "J-agents-05 #<n>", run in order on one verified TEST account with an agent of its own that has a
// tool needing approval and the standing rule "ask before sending a comment". The gated tool runs exactly once after
// approval, never before, and every decision is recorded. The push notice shows its vendor text (vendor.push); the
// automatic reviewer waits on the owner's model choice (owner.decision).
// #1 and #2 are built (AG-guardrails-02, AG-guardrails-01): the agent's Rules page, the managed baseline (a labelled TEST
// value on the stack), the consent card for each kind of tool and the Permissions page, with every answer read back
// from svc-agents. #3 is built (AG-approvals-01): a held call reads waiting for approval on Live runs and is a row of the
// Approvals inbox, and the tool has not run. #5 and #6 are built (AG-approvals-01): edit, approve and reject in the inbox,
// with the comment sent once to the person's own support request (svc-support), a wait after which a request expires
// (a short TEST wait on a restart), and identity unavailable to svc-agents on a restart (LOCAL_STACK_AGENTS_IDENTITY=off).
// #4 is built (AG-approvals-01): svc-agents publishes each held call once (agents.approval.requested) and svc-notify
// writes one inbox row naming the action and linking to the Approvals inbox, which says phone notices are off
// (vendor.push). #7 fails at its first missing part, quickly (UNBUILT): there is no automatic reviewer (AG-approvals-02).
const J = 'J-agents-05';
const agents = agentsRun(J);
/** The run's own state file (the one agentsRun keeps): the support request the comments go to. */
const state = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

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
/** The person's own support request, which the start opened: the comment the agent runs to (#3) goes there. */
function ticketId() {
  const { ticketId: id } = state.read();
  if (!id) throw new Error(`${J} opened no support request, so this step has nowhere to comment`);
  return id;
}
const runComment = () => ({ ticketId: ticketId(), body: 'TEST comment, run' });

/** A call of the person's own agent's service through Edge, as the person: status and body, refusals included. */
async function ownCall(procedure, input) {
  const res = await (await api(agents.account())).post(`/api/agents/trpc/own.${procedure}`, input);
  return { status: res.status, body: res.body };
}
/** The comments svc-support holds on the person's request, as the person reads them. */
async function ticketComments() {
  const query = `?input=${encodeURIComponent(JSON.stringify({ ticketId: ticketId(), limit: 200 }))}`;
  const res = await (await api(agents.account())).get(`/api/support/trpc/listComments${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}
/** The agent's comment call, made as the agent would make it, on a request id the step knows. */
async function agentComment(requestId, body) {
  const agent = await ownAgent();
  const opened = await ownCall('session.open', { id: agent.id });
  expect(opened.status, JSON.stringify(opened.body).slice(0, 300)).toBe(200);
  const call = {
    id: agent.id,
    sessionId: opened.body.result.data.sessionId,
    requestId,
    tool: 'support.ticket.comment',
    input: { ticketId: ticketId(), body },
  };
  return { call, answer: await ownCall('tool.try', call) };
}
/** Restarts svc-agents with one TEST switch set, then as it was (restartWith sets only `off`; the wait needs `short`). */
function restartAgents(envKey, value) {
  const before = process.env[envKey];
  if (value === undefined) delete process.env[envKey];
  else process.env[envKey] = value;
  try {
    tool('local-test-stack.mjs', 'restart', 'agents');
  } finally {
    if (before === undefined) delete process.env[envKey];
    else process.env[envKey] = before;
  }
}

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
  // The person's own support request, which the agent's comment goes to once it is approved.
  const opened = await (
    await api(agents.account())
  ).post('/api/support/trpc/create', {
    category: 'account',
    subject: `TEST ${J} request`,
    body: `TEST ${J} request the agent comments on`,
    clientRequestId: `${J}:${process.env.JOURNEY_RUN_ID ?? 'local'}:ticket`,
  });
  expect(opened.status, JSON.stringify(opened.body).slice(0, 300)).toBe(200);
  state.write({ ticketId: opened.body.result.data.id });
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
  await runTest(page, 'Send a comment', runComment());
  await expect(tryTool(page).getByRole('status')).toHaveText('Waiting for your approval: sending a comment. The tool has not run.');
  const held = await ownRead('approvals', { id: agent.id, limit: 50 });
  expect(held).toHaveLength(before.length + 1);
  const request = held[0];
  expect(request).toMatchObject({ tool: 'support.ticket.comment', status: 'waiting', input: runComment() });

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
  // Every comment the account's agent holds (#3's among them, as #3 counts them) is one notice: the notice is built, so
  // svc-agents publishes each held call and svc-notify writes its row, with a real wait.
  const held = (await ownRead('inbox', { limit: 100 })).filter((row) => row.tool === 'support.ticket.comment' && row.status === 'waiting');
  const [request] = held.filter((row) => row.input.body === 'TEST comment, run');
  expect(request, "#3's held comment").toBeDefined();
  await page.getByRole('button', { name: /^Notifications/ }).click();
  const notices = page.getByRole('dialog', { name: /Notifications/ }).getByRole('link', { name: /wants to send a comment/ });
  await expect(notices).toHaveCount(held.length, { timeout: 20_000 });
  for (const notice of await notices.all()) await expect(notice).toHaveAttribute('href', '/agents/approvals');

  // Exactly one row per held request, read back from the notify service, and #3's push delivery refused for the unset
  // push vendor (the stack wires none), which the push channel names as vendor.push.
  const notifyRead = async (procedure, input) => {
    const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
    const res = await (await api(agents.account())).get(`/api/notify/trpc/${procedure}${query}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return res.body.result.data;
  };
  const rows = (await notifyRead('notify.list', { limit: 100 })).items.filter(({ kind }) => kind === 'agents.approval.requested');
  for (const { id } of held)
    expect(
      rows.filter(({ params }) => params.requestId === id),
      `the notice of request ${id}`,
    ).toHaveLength(1);
  const [ofRequest] = rows.filter(({ params }) => params.requestId === request.id);
  expect(ofRequest).toMatchObject({ href: '/agents/approvals', params: { tool: 'support.ticket.comment' } });
  const push = (await notifyRead('notify.deliveries', { notificationId: ofRequest.id })).filter((row) => row.channel === 'push');
  expect(push.map(({ status, refusalCode }) => ({ status, refusalCode }))).toEqual([
    { status: 'refused', refusalCode: 'channel.not_configured' },
  ]);
  const pushCell = (await notifyRead('notify.categoryPrefs')).find((cell) => cell.channel === 'push');
  expect(pushCell).toMatchObject({ configured: false, notConnected: 'vendor.push' });

  // The notice opens the Approvals inbox, which says phone notices are off and names the vendor.
  await notices.first().click();
  await expect(page).toHaveURL(/\/agents\/approvals/);
  await expect(main(page).getByRole('note').filter({ hasText: 'vendor.push' })).toBeVisible();
});

test(`${J} #5 edits the payload then approves: a new request for the new payload, the old approval does not carry over; approve runs once, a repeat returns the first result`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openInbox(page);
  // The comment the agent ran to in #3, still waiting: the person edits its text.
  const [original] = (await ownRead('inbox', { limit: 100 })).filter((row) => row.input.body === 'TEST comment, run');
  expect(original).toMatchObject({ status: 'waiting', input: runComment() });
  const row = inbox(page).locator(`[data-request-id="${original.id}"]`);
  await row.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit the request' });
  await dialog.getByRole('textbox', { name: /^Comment/ }).fill('TEST comment, edited');
  await dialog.getByRole('button', { name: 'Save as a new request' }).click();
  await expect(main(page).getByRole('status')).toContainText('Saved as a new request.');

  // A new request exists for the new payload; the old one reads replaced and is no longer approvable.
  await expect(inbox(page).getByRole('row').filter({ hasText: 'Replaced by your edit' })).toHaveCount(1);
  await expect(row).toContainText('Replaced by your edit');
  await expect(row.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  const [edited] = (await ownRead('inbox', { limit: 100 })).filter((r) => r.input.body === 'TEST comment, edited');
  expect(edited).toMatchObject({
    status: 'waiting',
    tool: 'support.ticket.comment',
    input: { ticketId: ticketId(), body: 'TEST comment, edited' },
  });
  expect(edited.id).not.toBe(original.id);
  expect((await ownRead('inbox', { limit: 100 })).find((r) => r.id === original.id)).toMatchObject({
    status: 'replaced',
    replacedBy: edited.id,
    refusalCode: 'agents.approval.replaced',
  });
  const editedRow = inbox(page).locator(`[data-request-id="${edited.id}"]`);
  await expect(editedRow).toContainText('body: TEST comment, edited');
  await expect(editedRow).toContainText('Waiting for approval');
  // The old approval does not carry over: approving the replaced request is refused, and nothing was sent.
  const old = await ownCall('approval.approve', { requestId: original.id });
  expect(old.status).toBe(403);
  expect(JSON.stringify(old.body)).toContain('agents.approval.replaced');
  expect(await ticketComments()).toEqual([]);

  // Approving runs the tool once: one comment on the person's request with the edited text, one call in the session log.
  await editedRow.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(main(page).getByRole('status')).toHaveText('Approved: the tool ran once.');
  await expect(editedRow).toContainText('Approved · ran once');
  const comments = await ticketComments();
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({ ticketId: ticketId(), body: 'TEST comment, edited', authorRole: 'user' });
  const approved = (await ownRead('inbox', { limit: 100 })).find((r) => r.id === edited.id);
  expect(approved).toMatchObject({ status: 'approved', result: { commentId: comments[0].id, commented: 'yes' } });
  const ran = (await ownSessionLog(edited.sessionId)).filter((a) => a.tool === 'support.ticket.comment');
  expect(ran).toHaveLength(1);

  // A repeated approve returns the first result: the same comment, and the tool does not run again.
  await editedRow.getByRole('button', { name: 'Approve again' }).click();
  await expect(main(page).getByRole('status')).toHaveText('Already approved: the first result is shown.');
  await expect(main(page).getByTestId('first-result')).toContainText(comments[0].id);
  const repeat = await ownCall('approval.approve', { requestId: edited.id });
  expect(repeat.status).toBe(200);
  expect(repeat.body.result.data).toMatchObject({ repeated: true, request: { result: approved.result } });
  expect(await ticketComments()).toHaveLength(1);
  expect((await ownSessionLog(edited.sessionId)).filter((a) => a.tool === 'support.ticket.comment')).toHaveLength(1);
});

test(`${J} #6 rejects another request and lets a third expire: the step ends with a typed refusal; an expired request or a down identity service fails closed`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const sent = (await ticketComments()).length;
  // Another request: the agent's comment, held by the rule. The person rejects it in the inbox.
  const rejected = await agentComment(`${J}:reject`, 'TEST comment, to reject');
  expect(rejected.answer.status, JSON.stringify(rejected.answer.body).slice(0, 300)).toBe(200);
  const toReject = rejected.answer.body.result.data.request;
  await openInbox(page);
  const rejectRow = inbox(page).locator(`[data-request-id="${toReject.id}"]`);
  await rejectRow.getByRole('button', { name: 'Reject' }).click();
  await expect(main(page).getByRole('status')).toContainText('Rejected.');
  await expect(rejectRow).toContainText('Rejected');
  await expect(rejectRow.locator('code')).toHaveText('agents.approval.rejected');
  // The step ends with a typed refusal the run can read: the agent's same call now answers with it, and nothing ran.
  const readBack = await ownCall('tool.try', rejected.call);
  expect(readBack.status).toBe(403);
  expect(JSON.stringify(readBack.body)).toContain('agents.approval.rejected');

  // A third request, held under a short TEST wait, expires: it reads expired with its code, and approving it fails closed.
  restartAgents('LOCAL_STACK_AGENTS_APPROVAL_TTL', 'short');
  let toExpire;
  try {
    const expiring = await agentComment(`${J}:expire`, 'TEST comment, to expire');
    expect(expiring.answer.status, JSON.stringify(expiring.answer.body).slice(0, 300)).toBe(200);
    toExpire = { ...expiring, request: expiring.answer.body.result.data.request };
  } finally {
    restartAgents('LOCAL_STACK_AGENTS_APPROVAL_TTL', undefined);
  }
  await expect
    .poll(async () => (await ownRead('inbox', { limit: 100 })).find((r) => r.id === toExpire.request.id)?.status, { timeout: 120_000 })
    .toBe('expired');
  await page.reload();
  const expiredRow = inbox(page).locator(`[data-request-id="${toExpire.request.id}"]`);
  await expect(expiredRow).toContainText('Expired');
  await expect(expiredRow.locator('code')).toHaveText('agents.approval.expired');
  await expect(expiredRow.getByRole('button', { name: /^Approve/ })).toHaveCount(0);
  const lateApprove = await ownCall('approval.approve', { requestId: toExpire.request.id });
  expect(lateApprove.status).toBe(403);
  expect(JSON.stringify(lateApprove.body)).toContain('agents.approval.expired');
  const lateRead = await ownCall('tool.try', toExpire.call);
  expect(lateRead.status).toBe(403);
  expect(JSON.stringify(lateRead.body)).toContain('agents.approval.expired');

  // With identity unavailable to svc-agents, approving a waiting request fails closed: refused, still waiting, not run.
  const waiting = await agentComment(`${J}:identity`, 'TEST comment, identity down');
  expect(waiting.answer.status, JSON.stringify(waiting.answer.body).slice(0, 300)).toBe(200);
  const held = waiting.answer.body.result.data.request;
  restartAgents('LOCAL_STACK_AGENTS_IDENTITY', 'off');
  try {
    await page.reload();
    const heldRow = inbox(page).locator(`[data-request-id="${held.id}"]`);
    await heldRow.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(main(page).getByRole('alert').locator('code')).toHaveText('agents.identity.owner_unread');
    await expect(heldRow).toContainText('Waiting for approval');
    expect((await ownRead('inbox', { limit: 100 })).find((r) => r.id === held.id)).toMatchObject({ status: 'waiting', ranAt: null });
  } finally {
    restartAgents('LOCAL_STACK_AGENTS_IDENTITY', undefined);
  }
  // Nothing of #6 reached the person's request, and no comment call of these requests ran.
  expect(await ticketComments()).toHaveLength(sent);
  for (const sessionId of new Set([toReject.sessionId, toExpire.request.sessionId, held.sessionId])) {
    expect((await ownSessionLog(sessionId)).filter((a) => a.tool === 'support.ticket.comment')).toEqual([]);
  }
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
