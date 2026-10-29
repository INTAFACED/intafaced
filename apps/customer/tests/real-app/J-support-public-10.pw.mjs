import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signIn, signUp } from './desk.mjs';
import { asDesk, deskPeople } from './help-centre.mjs';
import { api } from './stack.mjs';

// J-support-public-10, in the running app (docs/roadmap/journeys.json): work the support queue and answer customers. Tests
// titled "J-support-public-10 #<n>" prove a whole step. The agent works in the founder console (apps/admin) as the stack's
// founder A, the support lead; founder B is a second agent (help-centre.mjs appoints both). A TEST customer sends the
// requests through its own support API, and reads the answers in the customer app.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #4, #10: no "claim next", no workspace address per request, no unclaim or reassign in the console (SP-tickets-09).
// - #5: no customer card (SP-tickets-09). #7: no macros or signatures (SP-desk-02). #8: no stale-reply guard (SP-tickets-09).
// #2's blank view cap clause needs the cap blank; the stack sets owner values as TEST, so it is checked where the cap is unset.
const J = 'J-support-public-10';
const RUN = Date.now().toString(36);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });

let customer;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const page = await browser.newPage();
  customer = await signUp(page, 'sq10');
  await page.close();
  // Founder A is the desk's lead and founder B its agent before any step runs (help-centre.mjs appoints both on first use).
  await desk('agent', 'query', 'staffList', undefined);
});

/** The customer sends one request through its own support API; returns the stored ticket. */
async function request(subject, category = 'account') {
  const res = await (
    await api(customer)
  ).post('/api/support/trpc/create', {
    category,
    subject,
    body: `TEST ${J} request: ${subject}`,
    clientRequestId: `${J}:${RUN}:${subject}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** A desk call that must succeed; its data. */
async function desk(who, kind, procedure, input) {
  const res = await asDesk(who, kind, procedure, input);
  if (res.json?.result?.data === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

/** Founder `key` signs in to the console and opens the support queue, which must list requests. */
async function openQueue(page, key = 'a') {
  await founderSignIn(page, key);
  await page.goto(`${ADMIN}/support`);
  await expect(page.getByRole('heading', { name: 'Support queue', level: 1 })).toBeVisible();
  const queue = page.getByRole('region', { name: 'Support queue' });
  await expect(queue, 'the desk lists the queue (founder console sign-in carries support:ops)').toBeVisible(UNBUILT);
  return queue;
}

/** The queue row of the request with this subject. */
const rowOf = (queue, subject) => queue.getByRole('row').filter({ hasText: subject });

/** Opens a request from the queue in its workspace. */
async function openRequest(page, queue, ticket) {
  await rowOf(queue, ticket.subject).getByRole('button', { name: 'Open' }).click();
  // Exact: "Ticket history", "Ticket actions" and "Files on this ticket" are regions inside it.
  const workspace = page.getByRole('region', { name: 'Ticket', exact: true });
  await expect(workspace).toBeVisible();
  return workspace;
}

/** Claims the open request with the console's two clicks. */
async function claim(workspace) {
  await workspace.getByRole('button', { name: 'Claim this ticket' }).click();
  await workspace.getByRole('button', { name: 'Yes, claim it' }).click();
  await expect(workspace.getByTestId('claim-reply')).toContainText(/claimed/i);
}

/** Sends the typed reply with its review step. */
async function sendReply(workspace, body) {
  const actions = workspace.page().getByRole('region', { name: 'Ticket actions' });
  if (body !== undefined) await actions.getByLabel('Your reply').fill(body);
  await actions.getByRole('button', { name: 'Review reply' }).click();
  await actions.getByRole('button', { name: 'Yes, send the reply' }).click();
  return actions.getByTestId('reply-outcome');
}

test(`${J} #1 /support lists unassigned open and pending requests by score, "not a promise", with no due time`, async ({ page }) => {
  const ticket = await request(`TEST queue ${RUN}`);
  const queue = await openQueue(page);
  await expect(rowOf(queue, ticket.subject)).toBeVisible();
  await expect(queue.getByRole('columnheader', { name: 'Score' })).toBeVisible();
  await expect(queue.getByRole('columnheader', { name: /due/i })).toHaveCount(0);
  await expect(page.getByTestId('queue-metrics')).toContainText('it is not a response-time promise');
  // Ranked by score, highest first.
  const scores = (await queue.getByRole('row').evaluateAll((rows) => rows.slice(1).map((row) => row.cells[4]?.textContent ?? ''))).map(
    Number,
  );
  expect(scores).toEqual([...scores].sort((a, b) => b - a));
  // Only unassigned open and pending requests.
  for (const status of await queue.getByRole('row').evaluateAll((rows) => rows.slice(1).map((row) => row.cells[3]?.textContent ?? '')))
    expect(['open', 'pending']).toContain(status);
});

test(`${J} #2 a filter by field saves as a view and is shared: list and count agree, a lead's shared view is read-only to others, a bad field is refused`, async ({
  page,
  browser,
}) => {
  await request(`TEST filter trading ${RUN}`, 'trading');
  await request(`TEST filter account ${RUN}`, 'account');
  const queue = await openQueue(page);
  const filters = page.getByRole('search', { name: 'Filter the queue' });
  await expect(filters).toBeVisible(UNBUILT);
  await filters.getByLabel('Field').selectOption('category');
  await filters.getByLabel('Value').fill('trading');
  await filters.getByRole('button', { name: 'Apply' }).click();
  const rows = queue.getByRole('row').filter({ hasNotText: 'Subject' });
  await expect(rows.filter({ hasText: `TEST filter trading ${RUN}` })).toHaveCount(1);
  await expect(rows.filter({ hasText: `TEST filter account ${RUN}` })).toHaveCount(0);
  await expect(page.getByTestId('queue-metrics')).toContainText(`${await rows.count()} shown`);

  // Saved and shared by the lead: another agent reads it but cannot change it.
  await filters.getByRole('button', { name: 'Save as view' }).click();
  await page.getByLabel('View name').fill(`TEST trading ${RUN}`);
  await page.getByRole('checkbox', { name: 'Share with the team' }).check();
  await page.getByRole('button', { name: 'Save view' }).click();
  const agent = await (await browser.newContext()).newPage();
  await openQueue(agent, 'b');
  const shared = agent.getByRole('link', { name: `TEST trading ${RUN}` });
  await shared.click();
  await expect(agent.getByRole('row').filter({ hasText: `TEST filter trading ${RUN}` })).toHaveCount(1);
  await expect(agent.getByRole('button', { name: 'Save view' })).toHaveCount(0);
  await agent.context().close();

  // A field the queue does not have is refused by name, and the list stays as it was.
  await page.goto(`${ADMIN}/support`);
  await expect(queue.getByRole('row').filter({ hasNotText: 'Subject' }).first()).toBeVisible();
  const before = await queue.getByRole('row').filter({ hasNotText: 'Subject' }).count();
  await page.goto(`${ADMIN}/support?filter=${encodeURIComponent('nosuchfield:x')}`);
  // Scoped to the page body: Next's route announcer is a second, empty alert outside it.
  await expect(page.getByRole('main').getByRole('alert')).toContainText('nosuchfield');
  await expect(queue.getByRole('row').filter({ hasNotText: 'Subject' })).toHaveCount(before);
});

test(`${J} #3 searching a word in a subject lists only requests this agent may see`, async ({ page }) => {
  const word = `zebra${RUN}`;
  const ticket = await request(`TEST ${word} search`);
  await request(`TEST other ${RUN}`);
  const queue = await openQueue(page);
  const box = page.getByRole('searchbox', { name: 'Search requests' });
  await expect(box).toBeVisible(UNBUILT);
  await box.fill(word);
  await box.press('Enter');
  const rows = queue.getByRole('row').filter({ hasNotText: 'Subject' });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(ticket.subject);
});

test(`${J} #4 claiming the next request opens its workspace at its own address; a second agent's claim of it is refused`, async ({
  page,
}) => {
  await request(`TEST claim next ${RUN}`);
  await openQueue(page);
  await page.getByRole('button', { name: 'Claim the next request' }).click(UNBUILT);
  await expect(page).toHaveURL(new RegExp(`^${ADMIN}/(admin/)?support/[0-9a-f-]{36}$`));
  const ticketId = page.url().split('/').pop();
  const { lead } = await deskPeople();
  expect((await desk('lead', 'query', 'get', { ticketId })).assigneeId).toBe(lead);

  // The second agent cannot take it over, and it stays with the first.
  const stolen = await asDesk('agent', 'mutation', 'claim', { ticketId });
  expect(stolen.status).not.toBe(200);
  expect((await desk('lead', 'query', 'get', { ticketId })).assigneeId).toBe(lead);
});

test(`${J} #5 the customer card shows the account state, never "active" when identity can't be read, and the related order or "none"`, async ({
  page,
}) => {
  const ticket = await request(`TEST card ${RUN}`);
  const queue = await openQueue(page);
  const workspace = await openRequest(page, queue, ticket);
  const card = workspace.getByRole('region', { name: 'Customer' });
  await expect(card).toBeVisible(UNBUILT);
  await expect(card.getByTestId('customer-account-state')).toHaveText(/^(active|restricted|frozen|closed|unread)$/i);
  await expect(card.getByTestId('customer-related-order')).toHaveText('none');
});

test(`${J} #6 priority, type and labels save with one audit row each; a label with a space is refused with a typed reason`, async ({
  page,
}) => {
  const ticket = await request(`TEST properties ${RUN}`);
  const queue = await openQueue(page);
  const workspace = await openRequest(page, queue, ticket);
  const props = page.getByRole('region', { name: 'Priority, type and labels' });
  const [priority] = await props.getByLabel('Priority').selectOption({ index: 1 });
  const [type] = await props.getByLabel('Type').selectOption({ index: 1 });
  await props.getByLabel(/^Labels/).fill(`test_${RUN} vip`);
  await props.getByRole('button', { name: 'Review changes' }).click();
  await props.getByRole('button', { name: 'Yes, save' }).click();
  await expect(props.getByTestId('prop-labels')).toHaveText(`test_${RUN}, vip`);
  const history = workspace.getByRole('region', { name: 'Ticket history' });
  for (const field of [/priority/i, /type/i, /labels/i]) await expect(history.getByRole('row').filter({ hasText: field })).toHaveCount(1);

  // One label holding a space is refused by its code, and nothing changes.
  const refused = await asDesk('lead', 'mutation', 'setProperties', {
    ticketId: ticket.id,
    labels: ['two words'],
    clientRequestId: `${J}:${RUN}:space-label`,
  });
  expect([refused.status, refused.json?.error?.message], refused.text.slice(0, 300)).toEqual([400, 'support.label_invalid']);
  // Labels are staff-only and kept beside the ticket, never on it (the owner reads the ticket), so the staff read is the one to check.
  const saved = await desk('lead', 'query', 'ticketProperties', { ticketId: ticket.id });
  expect(saved.labels).toEqual([`test_${RUN}`, 'vip']);
  expect(saved.priority).toBe(priority);
  expect(saved.ticketType).toBe(type);
  // The history, read again from the start, still holds one row per field: the refused call wrote none.
  await page.reload();
  const again = await openRequest(page, page.getByRole('region', { name: 'Support queue' }), ticket);
  const historyAgain = again.getByRole('region', { name: 'Ticket history' });
  for (const field of [/priority/i, /type/i, /labels/i])
    await expect(historyAgain.getByRole('row').filter({ hasText: field })).toHaveCount(1);
});

test(`${J} #7 a macro with a placeholder fills the reply draft, the signature goes on the public reply only, and nothing is sent until Send`, async ({
  page,
}) => {
  const ticket = await request(`TEST macro ${RUN}`);
  const queue = await openQueue(page);
  const workspace = await openRequest(page, queue, ticket);
  await claim(workspace);
  const actions = page.getByRole('region', { name: 'Ticket actions' });
  const macro = actions.getByLabel('Macro');
  await expect(macro).toBeVisible(UNBUILT);
  await macro.selectOption({ index: 1 });
  const draft = actions.getByLabel('Your reply');
  // The placeholder is filled with this request's own values, and the agent's signature closes the public reply.
  await expect(draft).not.toHaveValue(/\{\{.*\}\}/);
  await expect(draft).toHaveValue(new RegExp(customer.handle));
  await expect(actions.getByTestId('reply-signature')).toBeVisible();
  // Nothing has been sent yet.
  const comments = await (
    await api(customer)
  ).get(`/api/support/trpc/listComments?input=${encodeURIComponent(JSON.stringify({ ticketId: ticket.id, limit: 50 }))}`);
  expect(comments.body.result.data.filter((row) => row.authorRole !== 'customer')).toHaveLength(0);
});

test(`${J} #8 sending after another agent changed the status is refused as stale with the new events, and goes through after review`, async ({
  page,
}) => {
  const ticket = await request(`TEST stale ${RUN}`);
  const queue = await openQueue(page);
  const workspace = await openRequest(page, queue, ticket);
  await claim(workspace);
  await page.getByRole('region', { name: 'Ticket actions' }).getByLabel('Your reply').fill(`TEST stale reply ${RUN}`);
  // Meanwhile the other agent moves the request on.
  await desk('agent', 'mutation', 'setStatus', { ticketId: ticket.id, status: 'on_hold', note: `TEST ${J} #8` });
  const outcome = await sendReply(workspace);
  await expect(outcome).toContainText(/changed since you opened it/i, UNBUILT);
  await expect(outcome).toContainText('on_hold');
  const comments = await desk('lead', 'query', 'listComments', { ticketId: ticket.id, limit: 50 });
  expect(comments.some((row) => row.body.includes(`TEST stale reply ${RUN}`))).toBe(false);
  // After reading the new events the agent sends again, and it goes through once.
  await page.getByRole('button', { name: 'I have read the changes' }).click();
  await expect(await sendReply(workspace)).toContainText('Done');
  const after = await desk('lead', 'query', 'listComments', { ticketId: ticket.id, limit: 50 });
  expect(after.filter((row) => row.body.includes(`TEST stale reply ${RUN}`))).toHaveLength(1);
});

test(`${J} #9 the public reply moves the request to pending, waiting on the customer, and stamps the first reply once`, async ({
  page,
  browser,
}) => {
  const ticket = await request(`TEST reply ${RUN}`);
  const queue = await openQueue(page);
  const workspace = await openRequest(page, queue, ticket);
  await claim(workspace);
  await expect(await sendReply(workspace, `TEST first answer ${RUN}`)).toContainText('Done');
  const life = page.getByRole('region', { name: 'Waiting on' });
  await expect(life.getByTestId('life-waiting-on')).toHaveText('The customer');
  const first = await life.getByTestId('life-first-reply').innerText();
  expect(first).not.toBe('None yet');
  expect((await desk('lead', 'query', 'get', { ticketId: ticket.id })).status).toBe('pending');
  // A second reply leaves the first-reply time as it was.
  await expect(await sendReply(workspace, `TEST second answer ${RUN}`)).toContainText('Done');
  await expect(life.getByTestId('life-first-reply')).toHaveText(first);

  // The customer sees the reply and the new status on the request.
  const mine = await (await browser.newContext()).newPage();
  await signIn(mine, customer);
  await mine.goto(`/support/tickets/${ticket.id}`);
  await expect(mine.locator('main')).toContainText(`TEST first answer ${RUN}`);
  await expect(mine.locator('main')).toContainText(/Awaiting your reply/i);
  await mine.context().close();
});

test(`${J} #10 the assignee unclaims one request and a lead reassigns another, each with one audit row; nobody else may`, async ({
  page,
}) => {
  const mineToDrop = await request(`TEST unclaim ${RUN}`);
  const toReassign = await request(`TEST reassign ${RUN}`);
  const { lead, agent } = await deskPeople();
  const assignee = async (ticketId) => (await desk('lead', 'query', 'get', { ticketId })).assigneeId ?? null;
  const queue = await openQueue(page);
  const workspace = await openRequest(page, queue, mineToDrop);
  await claim(workspace);
  // Only the assignee may unclaim: the other agent is refused and the request stays with the lead.
  const notHeld = await asDesk('agent', 'mutation', 'unclaim', { ticketId: mineToDrop.id, idempotencyKey: `${J}:${RUN}:not-held` });
  expect(notHeld.status).not.toBe(200);
  expect(await assignee(mineToDrop.id)).toBe(lead);
  await workspace.getByRole('button', { name: 'Unclaim' }).click(UNBUILT);
  await expect.poll(() => assignee(mineToDrop.id)).toBeNull();
  await expect(
    workspace
      .getByRole('region', { name: 'Ticket history' })
      .getByRole('row')
      .filter({ hasText: /unclaim/i }),
  ).toHaveCount(1);

  // The lead gives another request to the second agent, who may not give it on to someone else.
  const other = await openRequest(page, queue, toReassign);
  await other.getByLabel('Assign to').selectOption(agent);
  await other.getByRole('button', { name: 'Reassign' }).click();
  await expect.poll(() => assignee(toReassign.id)).toBe(agent);
  await expect(
    other
      .getByRole('region', { name: 'Ticket history' })
      .getByRole('row')
      .filter({ hasText: /assign/i }),
  ).toHaveCount(1);
  const notLead = await asDesk('agent', 'mutation', 'assign', {
    ticketId: toReassign.id,
    assigneeId: lead,
    idempotencyKey: `${J}:${RUN}:not-lead`,
  });
  expect(notLead.status).not.toBe(200);
  expect(await assignee(toReassign.id)).toBe(agent);
});

test(`${J} #11 a general help request is resolved and reopens when the customer replies`, async ({ page }) => {
  const ticket = await request(`TEST resolve ${RUN}`, 'other');
  const queue = await openQueue(page);
  const workspace = await openRequest(page, queue, ticket);
  await claim(workspace);
  const actions = page.getByRole('region', { name: 'Ticket actions' });
  await actions.getByLabel('New status').selectOption('resolved');
  await actions.getByRole('button', { name: 'Review status change' }).click();
  await actions.getByRole('button', { name: 'Yes, set it to resolved' }).click();
  await expect(actions.getByTestId('status-outcome')).toContainText('Done');
  expect((await desk('lead', 'query', 'get', { ticketId: ticket.id })).status).toBe('resolved');

  // The customer answers, and the request is open again.
  const res = await (
    await api(customer)
  ).post('/api/support/trpc/comment', {
    ticketId: ticket.id,
    body: `TEST still stuck ${RUN}`,
    clientRequestId: `${J}:${RUN}:reopen`,
  });
  expect(res.status).toBe(200);
  expect((await desk('lead', 'query', 'get', { ticketId: ticket.id })).status).toBe('open');
});
