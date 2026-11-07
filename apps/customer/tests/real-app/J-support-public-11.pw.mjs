// World: restart
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { signUp } from './desk.mjs';
import { asDesk, deskPeople, ensureDeskGroup } from './help-centre.mjs';
import { staffSignIn } from './staff.mjs';
import { api, ORIGIN, restartWith } from './stack.mjs';

// J-support-public-11, in the running app (docs/roadmap/journeys.json): a support agent runs a team case. Tests titled
// "J-support-public-11 #<n>" prove a whole step. Independent tests (OWNER 212), written from the step's words only.
//
// The people: the stack's TEST support staff member (staff.mjs, staffSignIn) is the agent working in the founder console;
// founder B is the second agent and founder A the lead (help-centre.mjs appoints both). The TEST staff member is appointed
// an agent by the lead and put in this journey's desk group, so it may work the requests (an agent sees only its groups).
// TEST customers send the requests through their own support API and read the answers in the customer app.
//
// A step whose part is missing fails at it quickly (UNBUILT). A refusal is matched by its typed code, and the record is
// read again after it to show nothing changed. A clause that needs an owner value blank restarts svc-support with that
// TEST value switched off (stack.mjs restartWith) and puts it back after.
const J = 'J-support-public-11';
const RUN = Date.now().toString(36);
const UNBUILT = { timeout: 5_000 };
// A one-pixel PNG, a file the stack's TEST scanner calls clean.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
/** TEST attachment limits (LOCAL TEST values, not owner decisions), set by the lead only when the stack has none. */
const TEST_LIMITS = { maxBytes: 1_048_576, allowedTypes: ['image/png', 'text/plain'], maxCount: 5 };

test.describe.configure({ mode: 'default' });

let customer;
let other;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await browser.newPage();
  customer = await signUp(page, 'sq11');
  await page.close();
  const second = await browser.newPage();
  other = await signUp(second, 'sq11c');
  await second.close();
  await desk('agent', 'query', 'staffList', undefined);
});

const query = (procedure, input) => `/api/support/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;

/** A desk call that must succeed; its data. */
async function desk(who, kind, procedure, input) {
  const res = await asDesk(who, kind, procedure, input);
  if (res.json?.result?.data === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return res.json.result.data;
}

/** A desk call that must be refused: its typed code (svc-support's error message is the code itself). */
async function refusedWith(who, kind, procedure, input) {
  const res = await asDesk(who, kind, procedure, input);
  expect(res.json?.result?.data, `${procedure} must be refused: ${res.text.slice(0, 300)}`).toBeUndefined();
  return res.json?.error?.message;
}

/** A customer's own support call through Edge; the response as it came back. */
async function asCustomer(who, kind, procedure, input) {
  const client = await api(who);
  return kind === 'query' ? client.get(query(procedure, input)) : client.post(`/api/support/trpc/${procedure}`, input);
}

/** The customer sends one request through its own support API; returns the stored ticket. */
async function request(subject, who = customer) {
  const res = await asCustomer(who, 'mutation', 'create', {
    category: 'account',
    subject,
    body: `TEST ${J} request: ${subject}`,
    clientRequestId: `${J}:${RUN}:${subject}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  const ticket = res.body.result.data;
  await inGroup(ticket);
  return ticket;
}

/** This journey's desk group, holding founder B and the TEST staff member (once appointed), with the request in it. */
async function inGroup(ticket) {
  const { agent } = await deskPeople();
  let group = await ensureDeskGroup(`TEST ${J} agents`);
  for (const member of [agent, staff.userId].filter(Boolean))
    if (!group.memberIds.includes(member)) {
      await desk('lead', 'mutation', 'groupsAddMember', { groupId: group.id, userId: member });
      group = await ensureDeskGroup(`TEST ${J} agents`);
    }
  await desk('lead', 'mutation', 'ticketSetGroup', { ticketId: ticket.id, groupId: group.id });
}

/** The TEST support staff member, signed in to the console in `page`, appointed an agent of the desk the first time. */
const staff = { userId: null };
async function agentSignIn(page, browser) {
  const { userId } = await staffSignIn(page, browser, 'support');
  staff.userId = userId;
  const members = await desk('lead', 'query', 'staffList', undefined);
  if (!members.some((m) => m.userId === userId))
    await desk('lead', 'mutation', 'staffAppoint', { userId, role: 'agent', idempotencyKey: `journey:support-agent:${userId}` });
  return userId;
}

/** Opens a request's workspace in the console at its own address. */
async function openTicket(page, ticket) {
  await page.goto(`${ADMIN}/support/${ticket.id}`);
  const workspace = page.getByRole('region', { name: 'Ticket', exact: true });
  await expect(workspace).toBeVisible();
  return workspace;
}

/** The request's trail as svc-support keeps it. */
const trail = (ticketId) => desk('lead', 'query', 'events', { ticketId, limit: 500 });
const comments = (ticketId) => desk('lead', 'query', 'listComments', { ticketId, limit: 500 });
const files = (ticketId) => desk('lead', 'query', 'ticketAttachments', { ticketId, limit: 500 });

/** A customer page signed in to the customer app. */
async function customerPage(browser, who) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  return page;
}

/** Every customer read of a request (thread, events, the request itself) as text, each answering 200. */
async function customerReads(who, ticketId) {
  const out = [];
  for (const [procedure, input] of [
    ['listComments', { ticketId, limit: 500 }],
    ['events', { ticketId, limit: 500 }],
    ['get', { ticketId }],
  ]) {
    const res = await asCustomer(who, 'query', procedure, input);
    expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    out.push(JSON.stringify(res.body));
  }
  return out.join('\n');
}

/** Adds an internal note in the workspace through the composer's review step. */
async function writeNote(workspace, body) {
  const actions = workspace.page().getByRole('region', { name: 'Ticket actions' });
  await actions.getByLabel('Internal note (staff only)').check();
  await actions.getByLabel('Your internal note').fill(body);
  return actions;
}

/** The customer attaches a file to the request, with TEST limits set by the lead only if the stack has none. */
async function attach(ticket, name) {
  const limits = (await asCustomer(customer, 'query', 'attachmentLimits', undefined)).body?.result?.data;
  if (!limits || limits.missing)
    await desk('lead', 'mutation', 'setAttachmentSettings', {
      ...TEST_LIMITS,
      expectedRevision: limits?.revision ?? 0,
      reason: `TEST ${J}`,
    });
  const res = await asCustomer(customer, 'mutation', 'attach', {
    ticketId: ticket.id,
    clientRequestId: `${J}:${RUN}:${name}`,
    contentType: 'image/png',
    bodyBase64: PNG.toString('base64'),
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
}

test(`${J} #1 an internal note that mentions a colleague alerts them once; the customer never sees it; a resolved request stays resolved`, async ({
  page,
  browser,
}) => {
  await agentSignIn(page, browser);
  const ticket = await request(`TEST note ${RUN}`);
  await desk('lead', 'mutation', 'comment', { ticketId: ticket.id, body: `TEST ${J} the team answers in public` });
  const workspace = await openTicket(page, ticket);
  const note = `TEST ${J} ${RUN} staff only, for founder B`;
  const actions = await writeNote(workspace, note);
  // The colleague is mentioned by name from the note.
  await actions.getByRole('button', { name: 'Mention a colleague' }).click(UNBUILT);
  await actions
    .getByRole('option', { name: /founder b|agent/i })
    .first()
    .click(UNBUILT);
  await actions.getByRole('button', { name: 'Review note' }).click();
  await actions.getByRole('button', { name: 'Yes, add the note' }).click();
  await expect(actions.getByTestId('note-outcome')).toContainText(/added/i);

  // The colleague (founder B) gets exactly one in-app alert for it.
  const colleague = await browser.newPage();
  await founderSignIn(colleague, 'b');
  await colleague.goto(`${ADMIN}/support`);
  const alerts = colleague.getByRole('region', { name: 'Alerts' });
  await expect(alerts).toBeVisible(UNBUILT);
  await expect(alerts.getByRole('listitem').filter({ hasText: ticket.subject })).toHaveCount(1);
  await colleague.reload();
  await expect(colleague.getByRole('region', { name: 'Alerts' }).getByRole('listitem').filter({ hasText: ticket.subject })).toHaveCount(1);

  // The customer never sees the note: not in the list, not in the events, not in an export.
  const reads = await customerReads(customer, ticket.id);
  expect(reads).not.toContain(note);
  const exported = await asCustomer(customer, 'query', 'exportMine', { ticketId: ticket.id });
  expect(exported.status, `the customer's export: ${JSON.stringify(exported.body).slice(0, 300)}`).toBe(200);
  expect(JSON.stringify(exported.body)).not.toContain(note);
  const mine = await customerPage(browser, customer);
  await mine.goto(`/support/tickets/${ticket.id}`);
  await expect(mine.locator('main').getByText(`TEST ${J} the team answers in public`)).toBeVisible();
  await expect(mine.locator('main').getByText(note)).toHaveCount(0);
  expect(JSON.stringify(await comments(ticket.id))).toContain(note);

  // A note on a resolved request leaves it resolved.
  await desk('lead', 'mutation', 'setStatus', { ticketId: ticket.id, status: 'resolved', note: `TEST ${J} #1 resolved` });
  await desk('agent', 'mutation', 'addInternalNote', { ticketId: ticket.id, body: `${note} again`, clientRequestId: `${J}:${RUN}:note2` });
  expect((await desk('lead', 'query', 'get', { ticketId: ticket.id })).status).toBe('resolved');
});

test(`${J} #2 an account CC reads the public thread but not the notes; an email-only CC is stored with its delivery on vendor.email`, async ({
  page,
  browser,
}) => {
  await agentSignIn(page, browser);
  const ticket = await request(`TEST cc ${RUN}`);
  const reply = `TEST ${J} ${RUN} public answer for the CCs`;
  const note = `TEST ${J} ${RUN} note the CC must not read`;
  await desk('lead', 'mutation', 'comment', { ticketId: ticket.id, body: reply });
  await desk('lead', 'mutation', 'addInternalNote', { ticketId: ticket.id, body: note, clientRequestId: `${J}:${RUN}:ccnote` });
  const workspace = await openTicket(page, ticket);
  const ccs = workspace.getByRole('region', { name: 'CCs' });
  await expect(ccs).toBeVisible(UNBUILT);
  await ccs.getByLabel('CC an account').fill(other.email);
  await ccs.getByRole('button', { name: 'Add account CC' }).click();
  const address = `sq11-cc-${RUN}@local-test.invalid`;
  await ccs.getByLabel('CC an email address').fill(address);
  await ccs.getByRole('button', { name: 'Add email CC' }).click();

  // The account CC reads the public thread, never the notes.
  const reads = await customerReads(other, ticket.id);
  expect(reads).toContain(reply);
  expect(reads).not.toContain(note);
  const ccPage = await customerPage(browser, other);
  await ccPage.goto(`/support/tickets/${ticket.id}`);
  await expect(ccPage.locator('main').getByText(reply)).toBeVisible();
  await expect(ccPage.locator('main').getByText(note)).toHaveCount(0);

  // The email-only CC is stored, and its delivery row names vendor.email.
  await page.reload();
  const row = page.getByRole('region', { name: 'CCs' }).getByRole('row').filter({ hasText: address });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('vendor.email');
});

test(`${J} #3 alert preferences: in-app and audio alerts work; email or push with no sender stores the alert in app naming the vendor`, async ({
  page,
  browser,
}) => {
  await agentSignIn(page, browser);
  await page.goto(`${ADMIN}/support/settings`);
  const prefs = page.getByRole('region', { name: 'Alert preferences' });
  await expect(prefs).toBeVisible(UNBUILT);
  await prefs.getByLabel('In app').check();
  await prefs.getByLabel('Audio').check();
  await prefs.getByLabel('Email').check();
  await prefs.getByLabel('Push').check();
  await prefs.getByRole('button', { name: 'Save alert preferences' }).click();
  await expect(prefs.getByTestId('alert-prefs-outcome')).toContainText(/saved/i);

  // Something to be alerted about: a request assigned to this agent.
  const ticket = await request(`TEST alert ${RUN}`);
  await desk('lead', 'mutation', 'assign', { ticketId: ticket.id, assigneeId: staff.userId, idempotencyKey: `${J}:${RUN}:alert` });
  await page.goto(`${ADMIN}/support`);
  const alerts = page.getByRole('region', { name: 'Alerts' });
  const card = alerts.getByRole('listitem').filter({ hasText: ticket.subject });
  // In app: the alert is listed. Audio: the alert sound is played.
  await expect(card).toHaveCount(1);
  await expect(page.getByTestId('alert-audio')).toHaveAttribute('data-played', 'true');
  // Email and push have no sender on this stack: the alert is kept in app and its card names each missing vendor.
  await expect(card).toContainText('vendor.email');
  await expect(card).toContainText('vendor.push');
});

test(`${J} #4 a request created on behalf of a customer shows as opened by the team, the audit names agent and reason, an unknown requester is refused`, async ({
  page,
  browser,
}) => {
  await agentSignIn(page, browser);
  await page.goto(`${ADMIN}/support`);
  const form = page.getByRole('region', { name: 'New request for a customer' });
  await expect(form).toBeVisible(UNBUILT);
  const subject = `TEST on behalf ${RUN}`;
  const reason = `TEST ${J} the customer phoned in`;
  await form.getByLabel('Customer (email or handle)').fill(customer.email);
  await form.getByLabel('Subject').fill(subject);
  await form.getByLabel('Message').fill(`TEST ${J} what the customer told us`);
  await form.getByLabel('Reason').fill(reason);
  await form.getByRole('button', { name: 'Create the request' }).click();
  await expect(form.getByTestId('on-behalf-outcome')).toContainText(/created/i);

  // The customer sees it in My requests, marked as opened by the team.
  const mine = await customerPage(browser, customer);
  await mine.goto('/support/tickets');
  const row = mine.locator('main').getByRole('listitem').filter({ hasText: subject });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Opened by the team');
  const list = (await asCustomer(customer, 'query', 'listMine', { limit: 200 })).body.result.data;
  const made = list.find((t) => t.subject === subject);
  expect(made, 'the request is in the customer’s own list').toBeTruthy();

  // The audit row names the agent and the reason.
  const rows = await trail(made.id);
  const created = rows.find((r) => r.kind === 'created');
  expect(created?.actorId).toBe(staff.userId);
  expect(created?.note ?? '').toContain(reason);

  // An unknown requester is refused, and no request is made.
  await form.getByLabel('Customer (email or handle)').fill(`nobody-${RUN}@local-test.invalid`);
  await form.getByLabel('Subject').fill(`${subject} unknown`);
  await form.getByRole('button', { name: 'Create the request' }).click();
  await expect(form.getByTestId('on-behalf-outcome')).toHaveAttribute('data-code', /^support\./);
  const queue = await desk('lead', 'query', 'listAll', { limit: 500 });
  expect(JSON.stringify(queue)).not.toContain(`${subject} unknown`);
});

test(`${J} #5 a child request and a side conversation: both tickets show the link with their own trails; an email side conversation shows vendor.email`, async ({
  page,
  browser,
}) => {
  await agentSignIn(page, browser);
  const parent = await request(`TEST parent ${RUN}`);
  const workspace = await openTicket(page, parent);
  const linked = workspace.getByRole('region', { name: 'Linked requests' });
  await expect(linked).toBeVisible(UNBUILT);
  await linked.getByRole('button', { name: 'Open a child request' }).click();
  await linked.getByLabel('Subject').fill(`TEST child ${RUN}`);
  await linked.getByRole('button', { name: 'Create the child request' }).click();
  const childLink = linked.getByRole('link', { name: /TEST child/ });
  await expect(childLink).toBeVisible();
  const childId = (await childLink.getAttribute('href')).split('/').pop();

  // The child shows its parent, and each keeps its own trail.
  await page.goto(`${ADMIN}/support/${childId}`);
  await expect(page.getByRole('region', { name: 'Linked requests' }).getByRole('link', { name: new RegExp(parent.subject) })).toBeVisible();
  const parentTrail = await trail(parent.id);
  const childTrail = await trail(childId);
  expect(childTrail.every((r) => r.ticketId === childId)).toBe(true);
  expect(parentTrail.every((r) => r.ticketId === parent.id)).toBe(true);
  expect(childTrail.length).toBeGreaterThan(0);

  // A side conversation by email: the thread is stored and the send names vendor.email.
  await openTicket(page, parent);
  const side = page.getByRole('region', { name: 'Side conversations' });
  await side.getByLabel('To (email address)').fill(`sq11-side-${RUN}@local-test.invalid`);
  const words = `TEST ${J} ${RUN} side conversation`;
  await side.getByLabel('Message').fill(words);
  await side.getByRole('button', { name: 'Send by email' }).click();
  await expect(side.getByTestId('side-send-outcome')).toContainText('vendor.email');
  await page.reload();
  await expect(page.getByRole('region', { name: 'Side conversations' }).getByText(words)).toBeVisible();
});

test(`${J} #6 merging two open duplicates: the survivor holds every message and file, the source closes with a link, both trails have a merge row; a resolved source is refused; a replay changes nothing`, async ({
  page,
  browser,
}) => {
  await agentSignIn(page, browser);
  const survivor = await request(`TEST dup survivor ${RUN}`);
  const source = await request(`TEST dup source ${RUN}`);
  const said = `TEST ${J} ${RUN} more words on the duplicate`;
  const more = await asCustomer(customer, 'mutation', 'comment', { ticketId: source.id, body: said, clientRequestId: `${J}:${RUN}:dupc` });
  expect(more.status, JSON.stringify(more.body).slice(0, 300)).toBe(200);
  await attach(source, 'dupfile');
  const sourceComments = await comments(source.id);
  const sourceFiles = await files(source.id);
  expect(sourceFiles.length, 'the source has a file to move').toBeGreaterThan(0);
  const survivorCommentsBefore = (await comments(survivor.id)).length;
  const survivorFilesBefore = (await files(survivor.id)).length;

  // The agent merges the source into the survivor in the console.
  const workspace = await openTicket(page, source);
  const merge = workspace.getByRole('region', { name: 'Merge a duplicate' });
  await merge.getByLabel('The request that stays (full ticket id)').fill(survivor.id);
  await merge.getByLabel('Reason (required, kept in the log of both requests)').fill(`TEST ${J} same question twice`);
  await merge.getByRole('button', { name: 'See what would move' }).click();
  await expect(merge.getByTestId('merge-preview')).toBeVisible();
  await merge.getByRole('button', { name: 'Review the merge' }).click();
  await merge.getByRole('button', { name: 'Yes, merge them' }).click();
  await expect(page.getByTestId('merge-done')).toContainText(survivor.id.slice(0, 8));

  // The survivor holds every message and file the source had.
  const after = await comments(survivor.id);
  for (const c of sourceComments) expect(after.map((x) => x.body)).toContain(c.body);
  expect(after.length).toBeGreaterThanOrEqual(survivorCommentsBefore + sourceComments.length);
  const survivorFiles = await files(survivor.id);
  expect(survivorFiles.length).toBe(survivorFilesBefore + sourceFiles.length);
  // The source is closed with a link to the survivor.
  const closed = await desk('lead', 'query', 'get', { ticketId: source.id });
  expect(closed.status).toBe('closed');
  expect(closed.mergedInto).toBe(survivor.id);
  // Both trails have a merge row.
  const mergedRows = async (id) => (await trail(id)).filter((r) => r.kind === 'merged');
  expect(await mergedRows(source.id)).toHaveLength(1);
  expect(await mergedRows(survivor.id)).toHaveLength(1);

  // Replaying the same merge changes nothing.
  const replay = await desk('agent', 'mutation', 'mergeTickets', {
    sourceId: source.id,
    survivorId: survivor.id,
    reason: `TEST ${J} replay`,
  });
  expect(replay.survivorId).toBe(survivor.id);
  expect((await comments(survivor.id)).length).toBe(after.length);
  expect((await files(survivor.id)).length).toBe(survivorFiles.length);
  expect(await mergedRows(source.id)).toHaveLength(1);
  expect(await mergedRows(survivor.id)).toHaveLength(1);

  // A resolved source is refused, and nothing moves.
  const keep = await request(`TEST dup keep ${RUN}`);
  const resolved = await request(`TEST dup resolved ${RUN}`);
  await desk('lead', 'mutation', 'setStatus', { ticketId: resolved.id, status: 'resolved', note: `TEST ${J} #6 resolved` });
  const resolvedComments = (await comments(resolved.id)).length;
  expect(
    await refusedWith('agent', 'mutation', 'mergeTickets', { sourceId: resolved.id, survivorId: keep.id, reason: `TEST ${J} refused` }),
  ).toBe('support.merge_not_allowed');
  expect((await comments(resolved.id)).length).toBe(resolvedComments);
  expect((await desk('lead', 'query', 'get', { ticketId: resolved.id })).mergedInto ?? null).toBeNull();
  expect((await trail(keep.id)).filter((r) => r.kind === 'merged')).toHaveLength(0);
  const resolvedPage = await openTicket(page, resolved);
  await expect(resolvedPage.getByTestId('merge-not-mergeable')).toContainText('resolved');
});

test(`${J} #7 bulk-assigning three requests, one closed: two change, one refused with its reason, three audit rows; a blank bulk cap refuses`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const a = await request(`TEST bulk a ${RUN}`);
  const b = await request(`TEST bulk b ${RUN}`);
  const c = await request(`TEST bulk closed ${RUN}`);
  await desk('lead', 'mutation', 'setStatus', { ticketId: c.id, status: 'closed', note: `TEST ${J} #7 closed` });
  const { agent } = await deskPeople();
  const before = Object.fromEntries(await Promise.all([a, b, c].map(async (t) => [t.id, (await trail(t.id)).length])));
  const policy = await desk('agent', 'query', 'bulkPolicy', undefined);
  expect(policy.cap, 'the stack sets a TEST bulk cap so a bulk change can run').not.toBeNull();
  const result = await desk('agent', 'mutation', 'bulkUpdate', {
    batchKey: `${J}:${RUN}:assign`,
    ticketIds: [a.id, b.id, c.id],
    change: { kind: 'assign', assigneeId: agent },
    reason: `TEST ${J} bulk assign`,
  });
  const by = Object.fromEntries(result.results.map((r) => [r.ticketId, r]));
  expect(by[a.id].outcome).toBe('changed');
  expect(by[b.id].outcome).toBe('changed');
  expect(by[c.id].outcome).toBe('refused');
  expect(by[c.id].code).toMatch(/^support\./);
  expect((await desk('lead', 'query', 'get', { ticketId: a.id })).assigneeId).toBe(agent);
  expect((await desk('lead', 'query', 'get', { ticketId: b.id })).assigneeId).toBe(agent);
  expect((await desk('lead', 'query', 'get', { ticketId: c.id })).assigneeId ?? null).not.toBe(agent);
  // Three audit rows: one on each request's trail.
  for (const t of [a, b, c]) expect((await trail(t.id)).length, t.subject).toBe(before[t.id] + 1);

  // With the bulk cap blank, the action refuses and nothing changes.
  restartWith('support', 'LOCAL_STACK_SUPPORT_BULK_CAP', false);
  try {
    const d = await request(`TEST bulk blank ${RUN}`);
    const blank = await desk('agent', 'query', 'bulkPolicy', undefined);
    expect(blank).toEqual({ cap: null, missing: 'support.bulk_cap' });
    const dTrail = (await trail(d.id)).length;
    expect(
      await refusedWith('agent', 'mutation', 'bulkUpdate', {
        batchKey: `${J}:${RUN}:blank`,
        ticketIds: [d.id],
        change: { kind: 'assign', assigneeId: agent },
      }),
    ).toBe('support.bulk_cap_unset');
    expect((await desk('lead', 'query', 'get', { ticketId: d.id })).assigneeId ?? null).toBeNull();
    expect((await trail(d.id)).length).toBe(dTrail);
    const page = await browser.newPage();
    await founderSignIn(page, 'b');
    await page.goto(`${ADMIN}/support`);
    await expect(page.getByTestId('bulk-cap-unset')).toBeVisible();
    await page.close();
  } finally {
    restartWith('support', 'LOCAL_STACK_SUPPORT_BULK_CAP', true);
  }
});

test(`${J} #8 a complaint on a request has an acknowledgement, investigation notes and needs a final written decision before it closes`, async ({
  page,
  browser,
}) => {
  await agentSignIn(page, browser);
  const ticket = await request(`TEST complaint ${RUN}`);
  const workspace = await openTicket(page, ticket);
  await workspace.getByRole('button', { name: 'Open a complaint' }).click(UNBUILT);
  const complaint = page.getByRole('region', { name: 'Complaint' });
  await expect(complaint).toBeVisible();
  // The acknowledgement is part of the record.
  await expect(complaint.getByTestId('complaint-acknowledgement')).not.toBeEmpty();
  // Investigation notes are kept on it.
  const finding = `TEST ${J} ${RUN} what we looked at`;
  await complaint.getByLabel('Investigation note').fill(finding);
  await complaint.getByRole('button', { name: 'Add investigation note' }).click();
  await expect(complaint.getByText(finding)).toBeVisible();
  // It cannot close without a final written decision.
  await complaint.getByRole('button', { name: 'Close the complaint' }).click();
  await expect(complaint.getByTestId('complaint-outcome')).toHaveAttribute('data-code', /^support\./);
  await page.reload();
  await expect(page.getByRole('region', { name: 'Complaint' }).getByTestId('complaint-status')).not.toContainText(/closed/i);
  // With the decision written, it closes.
  const decision = `TEST ${J} ${RUN} our final decision`;
  await page.getByRole('region', { name: 'Complaint' }).getByLabel('Final written decision').fill(decision);
  await page.getByRole('region', { name: 'Complaint' }).getByRole('button', { name: 'Close the complaint' }).click();
  await page.reload();
  const done = page.getByRole('region', { name: 'Complaint' });
  await expect(done.getByTestId('complaint-status')).toContainText(/closed/i);
  await expect(done.getByText(decision)).toBeVisible();
  await expect(done.getByText(finding)).toBeVisible();
});

test(`${J} #9 archiving: with retention unset the page says so and nothing is archived; set, a closed request past it is archived once, left out of default lists and found by an agent's search`, async ({
  page,
  browser,
}) => {
  await agentSignIn(page, browser);
  test.setTimeout(240_000);
  const old = await request(`TEST old closed ${RUN}`);
  await desk('lead', 'mutation', 'setStatus', { ticketId: old.id, status: 'closed', note: `TEST ${J} #9 closed` });
  // Retention unset: the page says so, and a run archives nothing.
  await page.goto(`${ADMIN}/support/settings`);
  const archiving = page.getByRole('region', { name: 'Archiving' });
  await expect(archiving).toBeVisible(UNBUILT);
  await expect(archiving).toContainText('Retention is not set');
  expect((await desk('lead', 'query', 'get', { ticketId: old.id })).archivedAt ?? null).toBeNull();

  // Retention set (the stack's TEST value; the closed request is past it): archived once.
  restartWith('support', 'LOCAL_STACK_SUPPORT_RETENTION', true);
  await page.goto(`${ADMIN}/support/settings`);
  const set = page.getByRole('region', { name: 'Archiving' });
  await expect(set).not.toContainText('Retention is not set');
  await set.getByRole('button', { name: 'Archive now' }).click();
  await set.getByRole('button', { name: 'Archive now' }).click();
  const archived = await desk('lead', 'query', 'get', { ticketId: old.id });
  expect(archived.archivedAt).toBeTruthy();
  expect((await trail(old.id)).filter((r) => r.kind === 'archived')).toHaveLength(1);
  // Default lists omit it; an agent's search finds it.
  expect(JSON.stringify(await desk('agent', 'query', 'listAll', { limit: 500 }))).not.toContain(old.id);
  await page.goto(`${ADMIN}/support`);
  await expect(page.getByText(old.subject)).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search requests' }).fill(old.subject);
  await page.getByRole('searchbox', { name: 'Search requests' }).press('Enter');
  await expect(page.getByRole('row').filter({ hasText: old.subject })).toHaveCount(1);
});

test(`${J} #10 a removed request comes back inside the recovery window with its audit rows; with the window blank removal is refused`, async ({
  page,
  browser,
}) => {
  await agentSignIn(page, browser);
  test.setTimeout(240_000);
  const ticket = await request(`TEST remove ${RUN}`);
  await desk('lead', 'mutation', 'comment', { ticketId: ticket.id, body: `TEST ${J} answered before removal` });
  const rowsBefore = await trail(ticket.id);
  const workspace = await openTicket(page, ticket);
  await workspace.getByRole('button', { name: 'Remove this request' }).click(UNBUILT);
  await workspace.getByRole('button', { name: 'Yes, remove it' }).click();
  await expect(page.getByTestId('remove-outcome')).toContainText(/removed/i);
  // Recovered inside the window, with every earlier audit row intact.
  await page.goto(`${ADMIN}/support?view=removed`);
  const removed = page.getByRole('region', { name: 'Removed requests' });
  await removed.getByRole('row').filter({ hasText: ticket.subject }).getByRole('button', { name: 'Recover' }).click();
  await expect(page.getByTestId('recover-outcome')).toContainText(/recovered/i);
  const back = await desk('lead', 'query', 'get', { ticketId: ticket.id });
  expect(back.id).toBe(ticket.id);
  const rowsAfter = await trail(ticket.id);
  for (const r of rowsBefore) expect(rowsAfter.find((x) => x.id === r.id)).toEqual(r);

  // With the window blank, the removal is refused and the request stays.
  restartWith('support', 'LOCAL_STACK_SUPPORT_RECOVERY_WINDOW', false);
  try {
    const kept = await openTicket(page, ticket);
    await kept.getByRole('button', { name: 'Remove this request' }).click();
    await kept.getByRole('button', { name: 'Yes, remove it' }).click();
    await expect(page.getByTestId('remove-outcome')).toHaveAttribute('data-code', /^support\./);
    expect((await desk('lead', 'query', 'get', { ticketId: ticket.id })).id).toBe(ticket.id);
  } finally {
    restartWith('support', 'LOCAL_STACK_SUPPORT_RECOVERY_WINDOW', true);
  }
});

test(`${J} #11 after a sender is blocked, their next request lands in spam and not in the queue`, async ({ page, browser }) => {
  await agentSignIn(page, browser);
  const sender = await (async () => {
    const p = await browser.newPage();
    const who = await signUp(p, 'sq11s');
    await p.close();
    return who;
  })();
  const first = await request(`TEST spam first ${RUN}`, sender);
  const workspace = await openTicket(page, first);
  await workspace.getByRole('button', { name: 'Block this sender' }).click(UNBUILT);
  await workspace.getByRole('button', { name: 'Yes, block them' }).click();
  await expect(page.getByTestId('block-outcome')).toContainText(/blocked/i);

  const res = await asCustomer(sender, 'mutation', 'create', {
    category: 'account',
    subject: `TEST spam next ${RUN}`,
    body: `TEST ${J} after the block`,
    clientRequestId: `${J}:${RUN}:spam-next`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  const next = res.body.result.data;
  // Not in the queue.
  const queue = await desk('lead', 'query', 'listQueue', { limit: 500 });
  expect(JSON.stringify(queue)).not.toContain(next.id);
  await page.goto(`${ADMIN}/support`);
  await expect(page.getByRole('region', { name: 'Support queue' }).getByRole('row').filter({ hasText: next.subject })).toHaveCount(0);
  // In spam.
  await page.goto(`${ADMIN}/support?view=spam`);
  await expect(page.getByRole('region', { name: 'Spam' }).getByRole('row').filter({ hasText: next.subject })).toHaveCount(1);
});
