import { test, expect } from '@playwright/test';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signIn, signUp } from './desk.mjs';
import { asDesk, deskPeople } from './help-centre.mjs';
import { api, tool } from './stack.mjs';

// J-support-public-10, in the running app (docs/roadmap/journeys.json): work the support queue and answer customers. Tests
// titled "J-support-public-10 #<n>" prove a whole step. The agent works in the founder console (apps/admin) as the stack's
// founder A, the support lead; founder B is a second agent (help-centre.mjs appoints both). A TEST customer sends the
// requests through its own support API, and reads the answers in the customer app.
// A step whose part is missing fails at it quickly (UNBUILT).
// #7's "public reply only" is proved against the status reason and the escalation summary: the desk has no internal notes
// yet (SP-tickets-05), so a note the signature must stay off does not exist to check.
// A refusal is matched by its one typed code, and the record is read again after it to show nothing changed.
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

/** A desk call that must be refused: its one typed code (svc-support's error message is the code itself). */
async function refusedWith(who, kind, procedure, input) {
  const res = await asDesk(who, kind, procedure, input);
  expect(res.json?.result?.data, `${procedure} must be refused: ${res.text.slice(0, 300)}`).toBeUndefined();
  return res.json?.error?.message;
}

/** The request's trail as svc-support keeps it. */
const trail = (ticketId) => desk('lead', 'query', 'events', { ticketId, limit: 500 });

/** The queue row of the request with this subject. */
const rowOf = (queue, subject) => queue.getByRole('row').filter({ hasText: subject });

/** Opens a request from the queue in its workspace. */
async function openRequest(page, queue, ticket) {
  await rowOf(queue, ticket.subject).getByRole('button', { name: 'Open' }).click();
  // Exact: "Ticket history", "Ticket actions" and "Files on this ticket" are regions inside it.
  const workspace = page.getByRole('region', { name: 'Ticket', exact: true });
  await expect(workspace).toBeVisible();
  await cardRead(workspace);
  return workspace;
}

/**
 * Waits until the customer card has answered: its read writes a trail row of its own (grounding_read), so a step that
 * compares the trail before and after a refusal starts from a trail the card no longer adds to.
 */
async function cardRead(workspace) {
  const card = workspace.getByRole('region', { name: 'Customer' });
  await expect(card.getByTestId('customer-account-state')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Read again' })).toBeEnabled();
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
  await page.getByRole('button', { name: 'Claim the next request' }).click();
  await expect(page).toHaveURL(new RegExp(`^${ADMIN}/(admin/)?support/[0-9a-f-]{36}$`));
  const ticketId = page.url().split('/').pop();
  const { lead } = await deskPeople();
  // The workspace open at that address is the claimed request, held by this agent.
  const claimed = await desk('lead', 'query', 'get', { ticketId });
  expect(claimed.assigneeId).toBe(lead);
  const workspace = page.getByRole('region', { name: 'Ticket', exact: true });
  await expect(workspace).toContainText(claimed.subject);
  await expect(workspace.getByTestId('ticket-holder')).toHaveAttribute('data-user-id', lead);
  await cardRead(workspace);

  // The second agent's claim of it is refused by its code; it stays with the first and the trail gains nothing.
  const before = await trail(ticketId);
  expect(await refusedWith('agent', 'mutation', 'claim', { ticketId })).toBe('support.claim.already_claimed');
  expect((await desk('lead', 'query', 'get', { ticketId })).assigneeId).toBe(lead);
  expect(await trail(ticketId)).toEqual(before);
});

test(`${J} #5 the customer card shows the account state, never "active" when identity can't be read, and the related order or "none"`, async ({
  page,
}) => {
  const ticket = await request(`TEST card ${RUN}`);
  const queue = await openQueue(page);
  const workspace = await openRequest(page, queue, ticket);
  const card = workspace.getByRole('region', { name: 'Customer' });
  await expect(card).toBeVisible();
  // The state shown is the one svc-support reads from identity for this request's customer.
  const read = await desk('lead', 'query', 'accountState', { ticketId: ticket.id });
  expect(read.status, JSON.stringify(read)).toBe('read');
  expect(read.state.userId).toBe(ticket.userId);
  await expect(card.getByTestId('customer-account-state')).toHaveText(read.state.status);
  // The request names no order, so the related order is "none".
  await expect(card.getByTestId('customer-related-order')).toHaveText('none');

  // With identity unreachable the card says "unread", never "active".
  test.setTimeout(240_000);
  try {
    tool('local-test-stack.mjs', 'stop', 'identity');
    const dark = await desk('lead', 'query', 'accountState', { ticketId: ticket.id });
    expect(dark).toEqual({ status: 'unread', reason: 'plane_dark' });
    // The console checks its founder with svc-identity before it reads anything, so with identity down the console
    // itself refuses the read; the card shows that refusal's code, and "unread".
    const answer = page.waitForResponse((res) => res.url().includes('view=customer'));
    await card.getByRole('button', { name: 'Read again' }).click();
    const refused = await answer;
    // Edge answers 502 or 503 depending on how far its own identity call got; the console's code is the same either way.
    const body = await refused.json();
    expect(refused.ok(), JSON.stringify(body)).toBe(false);
    expect(body.code, JSON.stringify(body)).toBe('admin.upstream_refused');
    await expect(card.getByTestId('customer-account-state')).toHaveText('unread');
    await expect(card.getByTestId('customer-account-state')).toHaveAttribute('data-code', 'admin.upstream_refused');
  } finally {
    tool('local-test-stack.mjs', 'start', '--only', 'identity');
  }
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
  // Above the 90 s default: the step makes about 30 desk calls and a dozen console round trips, each of which may wait
  // the 15 s expect timeout on a cold stack. It ran in 12 to 35 s on the local stack.
  test.setTimeout(150_000);
  const ticket = await request(`TEST macro ${RUN}`);
  // A lead writes the macro (SP-desk-02). A placeholder outside the closed list, a taken or too-short shortcode and an
  // agent's write are each refused by their one code, and the desk's list is read again to show none of them was saved.
  const title = `TEST macro ${RUN}`;
  const shortcode = `t7${RUN}`;
  const body = 'TEST: about request {{ticket.id}}. Hi {{requester.name}}, thanks for writing.';
  const save = { title, shortcode, folder: 'TEST', body, expectedRevision: 0, reason: `TEST ${J} #7` };
  const macro = await desk('lead', 'mutation', 'macroSave', save);
  expect(macro).toMatchObject({ title, shortcode, folder: 'TEST', body, revision: 1 });
  const listed = async () => (await desk('lead', 'query', 'macros', undefined)).macros;
  const saved = await listed();
  const other = { ...save, title: `TEST other ${RUN}`, shortcode: `t7o${RUN}` };
  expect(await refusedWith('lead', 'mutation', 'macroSave', { ...other, body: 'Hi {{ticket.subject}}' })).toBe(
    'support.macro_placeholder_unknown',
  );
  expect(await refusedWith('lead', 'mutation', 'macroSave', { ...other, shortcode })).toBe('support.shortcode_taken');
  expect(await refusedWith('lead', 'mutation', 'macroSave', { ...other, shortcode: 'x' })).toBe('support.shortcode_too_short');
  expect(await refusedWith('agent', 'mutation', 'macroSave', { ...other, body: 'Hi' })).toBe('support.not_lead');
  expect(await listed()).toEqual(saved);
  expect(saved.filter((m) => m.shortcode === shortcode)).toEqual([macro]);

  const queue = await openQueue(page);
  const workspace = await openRequest(page, queue, ticket);
  await claim(workspace);
  const actions = page.getByRole('region', { name: 'Ticket actions' });

  // The agent (the console's founder, the lead) sets their own signature, read back from svc-support; it goes into the
  // public reply's draft as it is composed, so the agent sees exactly what the customer will get.
  const signature = `TEST signature ${RUN}`;
  await actions.getByLabel(/Your signature/).fill(signature);
  await actions.getByRole('button', { name: 'Review signature' }).click();
  await actions.getByRole('button', { name: 'Yes, save my signature' }).click();
  await expect(actions.getByTestId('signature-outcome')).toContainText('Done');
  expect((await desk('lead', 'query', 'signature', undefined)).signature).toBe(signature);
  const draft = actions.getByLabel('Your reply');
  await expect(draft).toHaveValue(`\n\n${signature}`);

  // Applying the macro substitutes this request's id; the requester's name, which the desk does not hold, stays as
  // written (never blank, never a stand-in) and is named. Nothing is written.
  const before = await trail(ticket.id);
  // The desk's read holds internal notes too (SP-tickets-05): the public replies are the operator's public rows.
  const deskComments = () => desk('lead', 'query', 'listComments', { ticketId: ticket.id, limit: 50 });
  const operatorComments = async () => (await deskComments()).filter((row) => row.authorRole === 'operator' && row.visibility === 'public');
  const asCustomer = async (procedure, input) => {
    const res = await (await api(customer)).get(`/api/support/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return res.body.result.data;
  };
  await actions.getByLabel('Macro').selectOption({ label: `TEST / ${title} (${shortcode})` });
  const filled = `TEST: about request ${ticket.id}. Hi {{requester.name}}, thanks for writing.`;
  await expect(draft).toHaveValue(`${filled}\n\n${signature}`);
  await expect(actions.getByTestId('reply-unfilled')).toContainText('{{requester.name}}');
  expect(await operatorComments()).toHaveLength(0);
  expect(await trail(ticket.id)).toEqual(before);

  // Send with the placeholder still in it: svc-support refuses by its code and nothing is sent.
  const refused = await sendReply(workspace);
  await expect(refused).toHaveAttribute('data-code', 'support.macro_placeholder_blank');
  expect(await operatorComments()).toHaveLength(0);
  expect(await trail(ticket.id)).toEqual(before);

  // The agent removes it; the draft they send is what the customer gets, signature included, once.
  const reply = `TEST: about request ${ticket.id}. Thanks for writing.\n\n${signature}`;
  await draft.fill(reply);
  await expect(actions.getByTestId('reply-unfilled')).toHaveCount(0);
  await expect(await sendReply(workspace)).toContainText('Done');
  expect((await operatorComments()).map((row) => row.body)).toEqual([reply]);
  const customerView = await asCustomer('listComments', { ticketId: ticket.id, limit: 50 });
  expect(customerView.filter((row) => row.authorRole === 'operator').map((row) => row.body)).toEqual([reply]);
  // The next reply's draft starts again from the signature.
  await expect(draft).toHaveValue(`\n\n${signature}`);

  // A status reason is stored as written, without the signature.
  const reason = `TEST ${J} #7 hold`;
  await actions.getByLabel('New status').selectOption('on_hold');
  await actions.getByLabel(/^Reason/).fill(reason);
  await actions.getByRole('button', { name: 'Review status change' }).click();
  await actions.getByRole('button', { name: 'Yes, set it to on_hold' }).click();
  await expect(actions.getByTestId('status-outcome')).toContainText('Done');
  const held = (await trail(ticket.id)).filter((row) => row.kind === 'status_changed' && row.toStatus === 'on_hold');
  expect(held.map((row) => row.note)).toEqual([reason]);
  expect(await operatorComments()).toHaveLength(1);

  // "Public reply only" is measured against an internal note (SP-tickets-05): its draft starts empty, with no
  // signature and no macro, and the note is stored exactly as written, kept from the customer, with the ticket unmoved.
  await actions.getByLabel('Internal note (staff only)').check();
  const noteDraft = actions.getByLabel('Your internal note');
  await expect(noteDraft).toHaveValue('');
  await expect(actions.getByLabel('Macro')).toHaveCount(0);
  await expect(actions.getByTestId('note-no-macro')).toBeVisible();
  const trailBeforeNote = await trail(ticket.id);
  const ticketBeforeNote = await desk('lead', 'query', 'get', { ticketId: ticket.id });
  const note = `TEST ${J} #7 note ${RUN}: the customer asked twice`;
  await noteDraft.fill(note);
  await actions.getByRole('button', { name: 'Review note' }).click();
  await actions.getByRole('button', { name: 'Yes, add the note' }).click();
  await expect(actions.getByTestId('note-outcome')).toContainText('Done');
  // The desk reads it back as internal, exactly as written: the signature is not on it.
  const notes = (await deskComments()).filter((row) => row.visibility === 'internal');
  expect(notes.map((row) => [row.body, row.authorRole])).toEqual([[note, 'operator']]);
  expect(notes[0].body.includes(signature)).toBe(false);
  await expect(workspace.locator('li[data-visibility="internal"]')).toHaveText(new RegExp(`Internal note.*Staff only.*${note}`));
  // The customer's own reads never carry it, and the note moved nothing: status, trail and ticket are as before.
  const customerAfter = await asCustomer('listComments', { ticketId: ticket.id, limit: 50 });
  expect(customerAfter.filter((row) => row.authorRole === 'operator').map((row) => row.body)).toEqual([reply]);
  expect(JSON.stringify(customerAfter)).not.toContain(note);
  expect(JSON.stringify(await asCustomer('events', { ticketId: ticket.id, limit: 500 }))).not.toContain(note);
  expect(JSON.stringify(await asCustomer('get', { ticketId: ticket.id }))).not.toContain(note);
  expect(await trail(ticket.id)).toEqual(trailBeforeNote);
  expect(await desk('lead', 'query', 'get', { ticketId: ticket.id })).toEqual(ticketBeforeNote);
  expect(ticketBeforeNote.status).toBe('on_hold');
  // The next note starts empty again; the public reply's draft still starts from the signature.
  await expect(noteDraft).toHaveValue('');
  await actions.getByLabel('Public reply (the customer sees it)').check();
  await expect(draft).toHaveValue(`\n\n${signature}`);
  // The same words noted again after the request is opened afresh are a second note, never a replay of the first:
  // a note adds no trail row, so its key counts the notes already on the request.
  await page.reload();
  await expect(workspace).toBeVisible();
  await cardRead(workspace);
  await actions.getByLabel('Internal note (staff only)').check();
  await noteDraft.fill(note);
  await actions.getByRole('button', { name: 'Review note' }).click();
  await actions.getByRole('button', { name: 'Yes, add the note' }).click();
  await expect(actions.getByTestId('note-outcome')).toContainText('Done');
  const twice = (await deskComments()).filter((row) => row.visibility === 'internal');
  expect(twice.map((row) => row.body)).toEqual([note, note]);
  expect(new Set(twice.map((row) => row.id)).size).toBe(2);
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
  const before = await trail(ticket.id);
  const outcome = await sendReply(workspace);
  await expect(outcome).toHaveAttribute('data-code', 'support.stale_ticket');
  // The refusal lists the new event: the other agent's status change.
  const change = before.at(-1);
  expect([change.kind, change.toStatus]).toEqual(['status_changed', 'on_hold']);
  await expect(outcome.getByTestId('reply-stale-rows')).toContainText(
    `#${change.sequence} status_changed from ${change.fromStatus} to on_hold`,
  );
  // Nothing was written: no reply, and the trail is as it was.
  const comments = await desk('lead', 'query', 'listComments', { ticketId: ticket.id, limit: 50 });
  expect(comments.some((row) => row.body.includes(`TEST stale reply ${RUN}`))).toBe(false);
  expect(await trail(ticket.id)).toEqual(before);
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
  const notes = async (ticketId, note) => (await trail(ticketId)).filter((e) => e.note === note);
  // Only the assignee may unclaim: the other agent is refused by its code, the request stays with the lead, the trail is as it was.
  const held = await trail(mineToDrop.id);
  expect(await refusedWith('agent', 'mutation', 'unclaim', { ticketId: mineToDrop.id, idempotencyKey: `${J}:${RUN}:not-held` })).toBe(
    'support.release.not_assignee',
  );
  expect(await assignee(mineToDrop.id)).toBe(lead);
  expect(await trail(mineToDrop.id)).toEqual(held);
  await workspace.getByRole('button', { name: 'Unclaim' }).click();
  await expect(page.getByTestId('owner-outcome')).toContainText('Done');
  await expect.poll(() => assignee(mineToDrop.id)).toBeNull();
  await expect(page.getByTestId('ticket-holder')).toHaveText('Nobody: it is in the queue.');
  // One audit row, in svc-support's trail and in the history shown.
  expect(await notes(mineToDrop.id, 'unclaim')).toHaveLength(1);
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
  await expect(page.getByTestId('owner-outcome')).toContainText('Done');
  await expect.poll(() => assignee(toReassign.id)).toBe(agent);
  // The new assignee shows, and one audit row names them.
  await expect(page.getByTestId('ticket-holder')).toHaveAttribute('data-user-id', agent);
  expect(await notes(toReassign.id, `assign:${agent}`)).toHaveLength(1);
  await expect(
    other
      .getByRole('region', { name: 'Ticket history' })
      .getByRole('row')
      .filter({ hasText: `assign:${agent}` }),
  ).toHaveCount(1);
  // Only a lead reassigns to someone else: the agent is refused by its code, and nothing changes.
  const given = await trail(toReassign.id);
  expect(
    await refusedWith('agent', 'mutation', 'assign', {
      ticketId: toReassign.id,
      assigneeId: lead,
      idempotencyKey: `${J}:${RUN}:not-lead`,
    }),
  ).toBe('support.not_lead');
  expect(await assignee(toReassign.id)).toBe(agent);
  expect(await trail(toReassign.id)).toEqual(given);
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
