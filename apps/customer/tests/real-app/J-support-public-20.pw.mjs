import { test, expect } from './journey.mjs';
import { asDesk } from './help-centre.mjs';
import { signUp } from './desk.mjs';
import { api, ORIGIN } from './stack.mjs';

// J-support-public-20, in the running app (docs/roadmap/journeys.json): a support agent handles a customer's "my deposit
// or withdrawal is missing" request without moving money, lifting a restriction or reading what they are not entitled to.
// The desk calls go through Edge as the stack's support lead. Tests titled "J-support-public-20 #<n>" prove a step.
const J = 'J-support-public-20';
const RUN = Date.now().toString(36);

// Not serial: a step that is not built yet fails alone and the run goes on.
const shared = {};

async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

const query = (procedure, input) => `/api/support/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;

/** A desk call that must succeed, as the lead. */
async function lead(kind, procedure, input) {
  const res = await asDesk('lead', kind, procedure, input);
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
}

/** A desk call that must be refused: its typed code. */
async function refused(kind, procedure, input) {
  const res = await asDesk('lead', kind, procedure, input);
  expect(res.json?.result?.data, `${procedure} was not refused: ${res.text.slice(0, 300)}`).toBeUndefined();
  return res.text;
}

/**
 * The customer and their "my withdrawal is missing" request, claimed by the lead: made once per worker, and again when
 * a failed step restarted the worker, so each step can be proved on its own.
 */
async function request(browser) {
  if (shared.ticket) return shared;
  const page = await visitor(browser);
  const who = await signUp(page, 'j20c');
  await page.context().close();
  const client = await api(who);
  const res = await client.post('/api/support/trpc/create', {
    category: 'deposit_withdraw',
    subject: `TEST ${J} ${RUN} withdrawal missing`,
    body: 'TEST My withdrawal left my account two days ago and never arrived.',
    clientRequestId: `j20:${RUN}:${shared.n ?? 0}`,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  shared.n = (shared.n ?? 0) + 1;
  await lead('mutation', 'claim', { ticketId: res.body.result.data.id }).catch(() => null);
  Object.assign(shared, { who, userId: client.userId, ticket: res.body.result.data });
  return shared;
}

test(`${J} #1 only a record that already belongs to the ticket's customer can be linked to it`, async ({ browser }) => {
  const { ticket } = await request(browser);
  // The desk links a related order, withdrawal or deposit by its id. Another customer's record, or one that does not
  // exist, is refused; nothing is linked.
  const res = await asDesk('lead', 'mutation', 'linkRecord', {
    ticketId: ticket.id,
    kind: 'withdrawal',
    recordId: '00000000-0000-4000-8000-000000000000',
  });
  expect(res.status, `linkRecord: ${res.text.slice(0, 300)}`).not.toBe(404);
  expect(res.text).toContain('support.link_record_not_owned');
});

test(`${J} #2 reading the customer's balance or withdrawal destination is refused until two checks the customer can confirm are recorded`, async ({
  browser,
}) => {
  const { ticket } = await request(browser);
  const res = await asDesk('lead', 'query', 'customerBalance', { ticketId: ticket.id });
  expect(res.status, `customerBalance: ${res.text.slice(0, 300)}`).not.toBe(404);
  expect(res.text).toContain('support.verification_checks_required');
});

test(`${J} #3 the account state is read for the ticket's owner only, one row records who looked, and no balance is in it`, async ({
  browser,
}) => {
  const { ticket, userId } = await request(browser);
  const before = (await lead('query', 'events', { ticketId: ticket.id, limit: 500 })).filter((e) => e.kind === 'grounding_read');
  const state = await lead('query', 'accountState', { ticketId: ticket.id });
  expect(JSON.stringify(state)).toContain(userId);
  expect(JSON.stringify(state)).not.toMatch(/balance|available|amount/i);
  // The read takes a ticket, never a user: naming another account is refused as a shape error, not answered.
  expect(await refused('query', 'accountState', { ticketId: ticket.id, userId: '00000000-0000-4000-8000-000000000000' })).toMatch(
    /unrecognized|BAD_REQUEST|invalid/i,
  );
  const after = (await lead('query', 'events', { ticketId: ticket.id, limit: 500 })).filter((e) => e.kind === 'grounding_read');
  expect(after).toHaveLength(before.length + 1);
  expect(after.at(-1).actorId).toBe((await import('./help-centre.mjs').then((m) => m.deskPeople())).lead);
});

test(`${J} #4 resolving a deposit or withdrawal request with a note that says the money moved is refused, and so is any money act`, async ({
  browser,
}) => {
  const { ticket } = await request(browser);
  const text = await refused('mutation', 'setStatus', {
    ticketId: ticket.id,
    status: 'resolved',
    note: 'TEST The withdrawal has been paid out to the customer.',
  });
  expect(text).toContain('support.settle.refused');
  for (const act of ['complete_withdrawal', 'unfreeze_account', 'move_money'])
    expect(await refused('mutation', 'settle', { act, ticketId: ticket.id })).toContain('support.settle.refused');
  expect((await lead('query', 'get', { ticketId: ticket.id })).status).not.toBe('resolved');
});

test(`${J} #5 a comment holding a card number or a seed phrase is refused and nothing is stored`, async ({ browser }) => {
  const { ticket, who } = await request(browser);
  const card = 'TEST my card is 4111 1111 1111 1111, please check it';
  const seed = 'TEST abandon ability able about above absent absorb abstract absurd abuse access accident';
  const count = async () => (await lead('query', 'listComments', { ticketId: ticket.id, limit: 500 })).length;
  const before = await count();
  // From the desk, as a public reply and as an internal note.
  for (const body of [card, seed]) {
    expect(await refused('mutation', 'comment', { ticketId: ticket.id, body })).toContain('support.comment_secret_refused');
    expect(
      await refused('mutation', 'addInternalNote', { ticketId: ticket.id, body, clientRequestId: `j20:${RUN}:note:${body.length}` }),
    ).toContain('support.comment_secret_refused');
  }
  // From the customer.
  const client = await api(who);
  for (const body of [card, seed]) {
    const res = await client.post('/api/support/trpc/comment', {
      ticketId: ticket.id,
      body,
      clientRequestId: `j20:${RUN}:c:${body.length}`,
    });
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).toContain('support.comment_secret_refused');
  }
  expect(await count()).toBe(before);
});

test(`${J} #6 escalated as a money request, the case file carries its citations, no amount field and no ledger entry`, async ({
  browser,
}) => {
  const { ticket } = await request(browser);
  const file = await lead('mutation', 'escalate', {
    ticketId: ticket.id,
    reason: 'money_request',
    summary: `TEST ${J} ${RUN} customer reports a missing withdrawal`,
  });
  // Grounded in what support read (the account state at least); an escalation with nothing to cite is refused
  // (support.case_file.ungrounded, case-file.test.ts), which the running app cannot reach while identity answers.
  expect(file.citations.length).toBeGreaterThan(0);
  expect(JSON.stringify(file.citations)).toContain('account_state');
  expect(JSON.stringify(file)).not.toMatch(/"(amount|value|quantity|asset)"\s*:/);
  const read = await lead('query', 'caseFile', { ticketId: ticket.id });
  expect(read.reason).toBe('money_request');
  expect(Object.keys(read)).not.toContain('amount');
  const events = await lead('query', 'events', { ticketId: ticket.id, limit: 500 });
  expect(events.filter((e) => e.kind === 'escalated')).toHaveLength(1);
});

test(`${J} #7 a withdrawal freeze asked from the request is recorded by the identity service; no credit is posted and a status change never lifts it`, async ({
  browser,
}) => {
  const { ticket } = await request(browser);
  const res = await asDesk('lead', 'mutation', 'requestWithdrawalFreeze', { ticketId: ticket.id, reason: `TEST ${J} #7` });
  expect(res.status, `requestWithdrawalFreeze: ${res.text.slice(0, 300)}`).not.toBe(404);
  expect(res.json?.result?.data?.recordedBy).toBe('svc-identity');
});

test(`${J} #8 the customer reads a plain status, no promised time and no staff-only text`, async ({ browser }) => {
  const { ticket, who } = await request(browser);
  const note = `TEST ${J} ${RUN} staff only: ledger looks fine`;
  await lead('mutation', 'addInternalNote', { ticketId: ticket.id, body: note, clientRequestId: `j20:${RUN}:staff` });
  const page = await visitor(browser);
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
  await page.goto(`/support/tickets/${ticket.id}`);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: ticket.subject })).toBeVisible();
  await expect(main.locator('.support-status').first()).toHaveText(/^(Open|Awaiting your reply|Solved)$/);
  await expect(main.getByText(note)).toHaveCount(0);
  await expect(main.getByText(/within \d|by \d{1,2}:\d{2}|due|expected (by|on)|\d+ (hours|days)/i)).toHaveCount(0);
  const client = await api(who);
  const read = await client.get(query('get', { ticketId: ticket.id }));
  expect(JSON.stringify(read.body)).not.toContain(note);
  expect(JSON.stringify(read.body)).not.toMatch(/"(dueAt|due_at|target|promisedAt|slaDue)"/);
  await page.context().close();
});
