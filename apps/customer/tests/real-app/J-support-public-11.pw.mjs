// World: none
import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { signUp } from './desk.mjs';
import { asDesk, deskPeople, ensureDeskGroup } from './help-centre.mjs';
import { staffSignIn } from './staff.mjs';
import { api } from './stack.mjs';

// J-support-public-11, in the running app (docs/roadmap/journeys.json): a support agent runs a team case. Tests titled
// "J-support-public-11 #<n>" prove a whole step. Independent tests (OWNER 212), written from the step's words only.
//
// The people: the stack's TEST support staff member (staff.mjs, staffSignIn) is the agent working in the founder console;
// founder B is the second agent and founder A the lead (help-centre.mjs appoints both). The TEST staff member is appointed
// an agent by the lead and put in this journey's desk group, so it may work the requests (an agent sees only its groups).
// A TEST customer sends the requests through its own support API.
//
// This file holds the steps already built (#6); the other steps' tests wait in the unbuilt-steps draft PR. A refusal is
// matched by its typed code, and the record is read again after it to show nothing changed.
const J = 'J-support-public-11';
const RUN = Date.now().toString(36);
// A one-pixel PNG, a file the stack's TEST scanner calls clean.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
/** TEST attachment limits (LOCAL TEST values, not owner decisions), set by the lead only when the stack has none. */
const TEST_LIMITS = { maxBytes: 1_048_576, allowedTypes: ['image/png', 'text/plain'], maxCount: 5 };

test.describe.configure({ mode: 'default' });

let customer;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const page = await browser.newPage();
  customer = await signUp(page, 'sq11');
  await page.close();
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
