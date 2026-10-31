import { test, expect } from './journey.mjs';
import { asDesk } from './help-centre.mjs';
import { signUp } from './desk.mjs';
import { api, ORIGIN } from './stack.mjs';

// J-support-public-04, in the running app (docs/roadmap/journeys.json): a signed-in customer whose request the team has
// answered reads the public thread, sends a file, replies, is solved, rates the answer once, and follows up a closed
// request as a new linked one. Tests titled "J-support-public-04 #<n>" prove a step.
const J = 'J-support-public-04';
const RUN = Date.now().toString(36);
const LIST = { limit: 200 };
// A one-pixel PNG: a screenshot as far as the type list and the scanner are concerned.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
// The industry-standard EICAR test string, joined at run time so this file is not itself taken for a virus. The stack's
// LOCAL TEST scanner calls a file infected only when it carries it.
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}$', 'EICAR-STANDARD-ANTIVIRUS-TEST-FILE', '!$H+H*'].join('');

// Not serial: a step that is not built yet fails alone and the run goes on. Steps share one customer and one request in
// this worker; a step whose earlier step left nothing stops at once (see `need`).
const shared = {};

function need(value, what) {
  if (!value) throw new Error(`${what}, so this step cannot start`);
  return value;
}

async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

/** The customer of these steps, signed in on a page of its own; made once per worker. */
async function person(browser) {
  if (shared.page && !shared.page.isClosed()) return shared.page;
  const page = await visitor(browser);
  if (shared.who) {
    await page.goto('/login');
    await page.fill('input[name=identifier]', shared.who.email);
    await page.fill('input[name=password]', shared.who.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page).not.toHaveURL(/\/login/);
  } else shared.who = await signUp(page, 'j04p');
  shared.page = page;
  return page;
}

const query = (procedure, input) => `/api/support/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`;
const code = (res) => JSON.stringify(res.body ?? res.json ?? res.text ?? '').match(/[a-z]+\.[a-z_.]+_[a-z_]+|[a-z]+\.[a-z_]+/g) ?? [];

/** The customer's own request rows, through Edge. */
async function mine(who) {
  const res = await (await api(who)).get(query('listMine', LIST));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** A request the customer sends through Edge, with a business key of this run. */
async function send(who, subject, extra = {}) {
  const res = await (
    await api(who)
  ).post('/api/support/trpc/create', {
    category: 'other',
    subject,
    body: `TEST ${subject}`,
    clientRequestId: `j04:${RUN}:${subject}`,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** A desk call that must succeed, as the lead. */
async function lead(kind, procedure, input) {
  const res = await asDesk('lead', kind, procedure, input);
  const row = res.json?.result?.data;
  if (row === undefined) throw new Error(`${procedure} refused (${res.status}): ${res.text.slice(0, 300)}`);
  return row;
}

const row = (main, subject) => main.getByRole('button', { name: `Open request: ${subject}` });

/**
 * The answered request of these steps: the one step 1 made, or, when a failed step restarted the worker and lost it, a
 * new one made the same way (a request the team has replied to), so each step can still be proved on its own.
 */
async function answered(browser) {
  const page = await person(browser);
  if (!shared.ticket) {
    const ticket = await send(shared.who, `TEST ${J} ${RUN} answered again`);
    await lead('mutation', 'comment', { ticketId: ticket.id, body: `TEST ${J} ${RUN} the team asks for a screenshot` });
    shared.ticket = ticket;
  }
  return { ticket: shared.ticket, page };
}

/** TEST attachment limits (LOCAL TEST values, not owner decisions), set by the lead when any is blank. */
const TEST_LIMITS = { maxBytes: 1_048_576, allowedTypes: ['image/png', 'text/plain'], maxCount: 5 };
async function testLimits(expectedRevision, reason) {
  return lead('mutation', 'setAttachmentSettings', { ...TEST_LIMITS, expectedRevision, reason });
}

/** The team marks the request solved, unless it already is. */
async function solved(ticket, step) {
  const now = await lead('query', 'get', { ticketId: ticket.id });
  if (now.status !== 'resolved')
    await lead('mutation', 'setStatus', { ticketId: ticket.id, status: 'resolved', note: `TEST ${J} ${step} solved` });
}

test(`${J} #1 "My requests" after the team replied lists that request first as "Awaiting your reply"`, async ({ browser }) => {
  const page = await person(browser);
  // The answered request is the older one: it still comes first, because it waits on the customer.
  const replied = await send(shared.who, `TEST ${J} ${RUN} answered`);
  const other = await send(shared.who, `TEST ${J} ${RUN} newer`);
  await lead('mutation', 'comment', { ticketId: replied.id, body: `TEST ${J} ${RUN} the team asks for a screenshot` });
  shared.ticket = replied;
  await page.goto('/support/tickets');
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await expect(row(main, replied.subject)).toContainText('Awaiting your reply');
  await expect(row(main, other.subject)).toBeVisible();
  const first = main.getByRole('button', { name: /^Open request: / }).first();
  await expect(first).toHaveAccessibleName(`Open request: ${replied.subject}`);
});

test(`${J} #2 the request shows the public thread only: a staff-only note is never listed, exported or in the events`, async ({
  browser,
}) => {
  const { ticket, page } = await answered(browser);
  const note = `TEST ${J} ${RUN} staff only, never for the customer`;
  await lead('mutation', 'claim', { ticketId: ticket.id }).catch(() => null);
  await lead('mutation', 'addInternalNote', { ticketId: ticket.id, body: note, clientRequestId: `j04:${RUN}:note` });
  await page.goto(`/support/tickets/${ticket.id}`);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: ticket.subject })).toBeVisible();
  await expect(main.getByText(`TEST ${J} ${RUN} the team asks for a screenshot`)).toBeVisible();
  await expect(main.getByText(note)).toHaveCount(0);
  // The same through every customer read: comments, events and the customer's case export.
  const client = await api(shared.who);
  for (const [procedure, input] of [
    ['listComments', { ticketId: ticket.id, limit: 500 }],
    ['events', { ticketId: ticket.id, limit: 500 }],
    ['get', { ticketId: ticket.id }],
  ]) {
    const res = await client.get(query(procedure, input));
    expect(res.status, `${procedure}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
    expect(JSON.stringify(res.body), procedure).not.toContain(note);
  }
  // The desk does hold the note, so its absence above is the customer's view and not a lost write.
  expect(JSON.stringify(await lead('query', 'listComments', { ticketId: ticket.id, limit: 500 }))).toContain(note);
});

test(`${J} #3 attaching a screenshot: the control states the service's limits, and the file shows being checked, then checked`, async ({
  browser,
}) => {
  const { ticket, page } = await answered(browser);
  const client = await api(shared.who);
  const limits = async () => {
    const res = await client.get('/api/support/trpc/attachmentLimits');
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return res.body.result.data;
  };
  // The owner's limits are blank until set. With the count blank, an attach is a typed refusal naming that setting, and
  // nothing is stored. The lead blanks it here so the refusal is seen whatever an earlier run left.
  const reason = `TEST ${J} #3`;
  let set = await lead('mutation', 'setAttachmentSettings', { maxCount: null, expectedRevision: (await limits()).revision, reason });
  expect(set.missing).not.toBeNull();
  const refused = await client.post('/api/support/trpc/attach', {
    ticketId: ticket.id,
    clientRequestId: `j04:${RUN}:blank`,
    contentType: 'image/png',
    bodyBase64: PNG.toString('base64'),
  });
  expect(refused.status).not.toBe(200);
  expect(JSON.stringify(refused.body)).toContain(
    set.missing === 'support.attachment_max_count' ? 'support.attachment_count_unset' : 'support.',
  );
  expect((await client.get(query('ticketAttachments', { ticketId: ticket.id, limit: 50 }))).body.result.data).toHaveLength(0);
  await page.goto(`/support/tickets/${ticket.id}`);
  const main = page.locator('main');
  await expect(main.getByTestId('attach-limits')).toContainText('Attaching files is switched off.');
  // The lead sets TEST limits (LOCAL TEST values, not owner decisions); the control states what the service answers.
  set = await testLimits(set.revision, reason);
  expect(set.missing).toBeNull();
  await page.reload();
  await expect(main.getByTestId('attach-limits')).toContainText(
    /Up to \d+ files per request, each up to .+\. Accepted types: .*image\/png/,
  );
  await main.getByLabel('File to attach').setInputFiles({ name: 'screenshot.png', mimeType: 'image/png', buffer: PNG });
  await main.getByRole('button', { name: 'Review attachment' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Attach file' }).click();
  const files = main.getByTestId('attach-files');
  await expect(files.getByRole('listitem')).toHaveCount(1, { timeout: 10_000 });
  await expect(files.getByRole('listitem').first()).toContainText(/Being checked|Checked/);
  await expect(async () => {
    await main.getByRole('button', { name: 'Check for new replies' }).last().click();
    await expect(files.getByRole('listitem').first()).toContainText('Checked', { timeout: 1_000 });
    await expect(files.getByRole('listitem').first()).not.toContainText('Being checked');
  }).toPass({ timeout: 20_000 });
  await expect(files.getByRole('listitem').first().getByRole('button', { name: 'Download' })).toBeVisible();
});

test(`${J} #4 a file the scanner blocks shows as not accepted and is never offered for download; another customer's request id answers as not found`, async ({
  browser,
}) => {
  const { ticket, page } = await answered(browser);
  // The TEST limits step 3 sets, in case a restart ran this step without it.
  const limits = (await (await api(shared.who)).get('/api/support/trpc/attachmentLimits')).body.result.data;
  if (limits.missing) await testLimits(limits.revision, `TEST ${J} #4`);
  await page.goto(`/support/tickets/${ticket.id}`);
  const main = page.locator('main');
  await main.getByLabel('File to attach').setInputFiles({ name: 'blocked.txt', mimeType: 'text/plain', buffer: Buffer.from(EICAR) });
  await main.getByRole('button', { name: 'Review attachment' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Attach file' }).click();
  const blocked = main.getByTestId('attach-files').getByRole('listitem').filter({ hasText: 'text/plain' });
  await expect(async () => {
    await main.getByRole('button', { name: 'Check for new replies' }).last().click();
    await expect(blocked).toContainText('Not accepted', { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await expect(blocked.getByRole('button', { name: 'Download' })).toHaveCount(0);
  // The service refuses its bytes too.
  const files = await (await api(shared.who)).get(query('ticketAttachments', { ticketId: ticket.id, limit: 50 }));
  const infected = files.body.result.data.find((file) => file.contentType === 'text/plain');
  const download = await (
    await api(shared.who)
  ).get(query('attachmentDownload', { attachmentId: need(infected, 'no blocked file listed').id }));
  expect(download.status).not.toBe(200);
  // Someone else holding the request id reads it, its files and its download as not found.
  const other = await visitor(browser);
  const stranger = await signUp(other, 'j04s');
  const client = await api(stranger);
  for (const path of [
    query('get', { ticketId: ticket.id }),
    query('ticketAttachments', { ticketId: ticket.id, limit: 50 }),
    query('attachmentDownload', { attachmentId: infected.id }),
  ]) {
    const res = await client.get(path);
    expect(res.status, path).toBe(404);
  }
  await other.goto(`/support/tickets/${ticket.id}`);
  await expect(other.locator('main').getByText('We could not find this request')).toBeVisible();
  await other.context().close();
});

test(`${J} #5 a reply moves the request back to "Open" and the team sees it; a reply on a solved request reopens the same request with its history`, async ({
  browser,
}) => {
  const { ticket, page } = await answered(browser);
  const main = page.locator('main');
  const reply = async (words) => {
    await page.goto(`/support/tickets/${ticket.id}`);
    await main.getByLabel('Write a reply').fill(words);
    await main.getByRole('button', { name: 'Review reply' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Send reply' }).click();
    await expect(main.getByText(words)).toBeVisible();
  };
  const first = `TEST ${J} ${RUN} here is my answer`;
  await reply(first);
  await expect(main.locator('.support-status').first()).toHaveText('Open');
  expect(JSON.stringify(await lead('query', 'listComments', { ticketId: ticket.id, limit: 500 }))).toContain(first);

  await lead('mutation', 'setStatus', { ticketId: ticket.id, status: 'resolved', note: `TEST ${J} #5 solved` });
  const again = `TEST ${J} ${RUN} it is back`;
  await reply(again);
  await expect(main.locator('.support-status').first()).toHaveText('Open');
  // The same request: its earlier replies are still on it, and no second request was made.
  await expect(main.getByText(first)).toBeVisible();
  expect((await mine(shared.who)).filter((r) => r.subject === ticket.subject)).toHaveLength(1);
});

test(`${J} #6 once the team marks it solved, the request asks for a rating in the app, with thank-you text and the rating form`, async ({
  browser,
}) => {
  const { ticket, page } = await answered(browser);
  await solved(ticket, '#6');
  await page.goto(`/support/tickets/${ticket.id}`);
  const main = page.locator('main');
  await expect(main.getByText('This request is solved. Tell us how it went by rating it below.')).toBeVisible();
  await expect(main.getByRole('combobox', { name: 'Your score' })).toBeVisible();
  await expect(main.getByLabel('Anything to add (optional)')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Review rating' })).toBeEnabled();
});

test(`${J} #7 a rating with a note is stored once; opening it again shows the stored rating, never a second`, async ({ browser }) => {
  const { ticket, page } = await answered(browser);
  await solved(ticket, '#7');
  await page.goto(`/support/tickets/${ticket.id}`);
  const main = page.locator('main');
  await main.getByRole('combobox', { name: 'Your score' }).selectOption({ label: '4 · Helpful' });
  await main.getByLabel('Anything to add (optional)').fill(`TEST ${J} ${RUN} quick answer`);
  await main.getByRole('button', { name: 'Review rating' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send rating' }).click();
  await expect(main.getByText('Thank you. You rated this request 4 out of 5.')).toBeVisible();
  await page.reload();
  await expect(main.getByText('Thank you. You rated this request 4 out of 5.')).toBeVisible();
  await expect(main.getByRole('combobox', { name: 'Your score' })).toHaveCount(0);
  // A second rating, under a key of its own, is refused and the stored one stays.
  const client = await api(shared.who);
  const second = await client.post('/api/support/trpc/rate', { ticketId: ticket.id, score: 1, clientRequestId: `j04:${RUN}:rate-again` });
  expect(second.status).not.toBe(200);
  const stored = await client.get(query('rating', { ticketId: ticket.id }));
  expect(stored.body.result.data).toMatchObject({ score: 4, note: `TEST ${J} ${RUN} quick answer` });
});

test(`${J} #8 solved with no mail sender set: the in-app prompt shows and the rating mail waits with vendor.email`, async ({ browser }) => {
  const { ticket } = await answered(browser);
  await solved(ticket, '#8');
  const client = await api(shared.who);
  // The in-app ask: one notice for this request, however often it was solved.
  let ask;
  await expect(async () => {
    const res = await client.get(`/api/notify/trpc/notify.list?input=${encodeURIComponent(JSON.stringify({ limit: 100 }))}`);
    expect(res.status).toBe(200);
    const rows = res.body.result.data.items ?? res.body.result.data;
    const asks = rows.filter((row) => row.kind === 'support.rate_request' && JSON.stringify(row).includes(ticket.id));
    expect(asks, JSON.stringify(rows.map((row) => row.kind))).toHaveLength(1);
    ask = asks[0];
  }).toPass({ timeout: 20_000 });
  // The mailed ask has no sender on this stack: its email delivery waits, named vendor.email, and nothing claims it sent.
  const deliveries = await client.get(
    `/api/notify/trpc/notify.deliveries?input=${encodeURIComponent(JSON.stringify({ notificationId: ask.id }))}`,
  );
  expect(deliveries.status, JSON.stringify(deliveries.body).slice(0, 300)).toBe(200);
  const email = deliveries.body.result.data.find((row) => row.channel === 'email');
  expect(email, `the rating ask's deliveries: ${JSON.stringify(deliveries.body.result.data)}`).toMatchObject({
    status: 'pending',
    refusalCode: 'vendor.email',
    acceptedAt: null,
  });
  // The in-app prompt shows on the request.
  const page = await person(browser);
  await page.goto(`/support/tickets/${ticket.id}`);
  await expect(page.locator('main').getByText(/You rated this request|This request is solved\. Tell us how it went/)).toBeVisible();
});

test(`${J} #9 writing on a closed request is refused with a typed reason and nothing stored; "follow up" makes a new request linked to it`, async ({
  browser,
}) => {
  const { ticket, page } = await answered(browser);
  await lead('mutation', 'setStatus', { ticketId: ticket.id, status: 'closed', note: `TEST ${J} #9 closed` });
  const client = await api(shared.who);
  const before = (await client.get(query('listComments', { ticketId: ticket.id, limit: 500 }))).body.result.data.length;
  const refused = await client.post('/api/support/trpc/comment', {
    ticketId: ticket.id,
    body: 'TEST late words',
    clientRequestId: `j04:${RUN}:late`,
  });
  expect(refused.status).not.toBe(200);
  expect(code(refused).some((c) => c.startsWith('support.'))).toBe(true);
  expect((await client.get(query('listComments', { ticketId: ticket.id, limit: 500 }))).body.result.data).toHaveLength(before);

  await page.goto(`/support/tickets/${ticket.id}`);
  const main = page.locator('main');
  await expect(main.getByText('This request is closed, so it cannot take replies.')).toBeVisible();
  await expect(main.getByLabel('Write a reply')).toHaveCount(0);
  await main.getByRole('button', { name: 'Ask a follow-up' }).click();
  await expect(page).toHaveURL(/\/support\/new/);
  await expect(main.getByText(/This new request follows/)).toBeVisible();
  // The link is in the address, so a fresh load of the form still follows the closed request.
  await page.reload();
  await expect(main.getByText(/This new request follows/)).toBeVisible();
  const subject = `TEST ${J} ${RUN} follow-up`;
  await main.getByLabel('Subject', { exact: true }).fill(subject);
  await main.getByLabel('What happened').fill('TEST One more question about the same thing.');
  await main.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send request' }).click();
  await expect(page).toHaveURL(/\/support\/tickets\/[0-9a-f-]{36}$/);
  const follow = (await mine(shared.who)).find((r) => r.subject === subject);
  expect(need(follow, 'no follow-up request').id).not.toBe(ticket.id);
  // The team sees the link to the closed request it follows.
  expect((await lead('query', 'ticketLifecycle', { ticketId: follow.id })).followsTicketId).toBe(ticket.id);
  // The closed request is still closed and unchanged.
  expect((await client.get(query('get', { ticketId: ticket.id }))).body.result.data.status).toBe('closed');
});
