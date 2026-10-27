import { test, expect } from '@playwright/test';
import { defineRequestField, defineRequestForm, replyAsLead, setStatusAsLead } from './help-centre.mjs';
import { signUp } from './desk.mjs';
import { api, ORIGIN } from './stack.mjs';

// J-support-public-02, in the running app (docs/roadmap/journeys.json): a person who found no answer in the help centre
// sends one request to support and follows it at its own address. Tests titled "J-support-public-02 #<n>" prove a step.
const J = 'J-support-public-02';
const RUN = Date.now().toString(36);
// Words no published answer holds, so the help search comes back empty.
const WORDS = `j02 nothing ${RUN}`;

// Not serial: a step that is not built yet fails alone and the run goes on to the next. Steps share one account and one
// request in this worker; a failed step restarts the worker, so the steps after it make their own (see `person`).

/** A visitor on a device of its own. */
async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

/** /help, searched for words with no answer: "No matches" and a way to contact support under it. */
async function emptySearch(page) {
  await page.goto('/help');
  const main = page.locator('main');
  await main.getByRole('textbox', { name: 'Search answers' }).fill(WORDS);
  await main.getByRole('button', { name: 'Search', exact: true }).click();
  const empty = main.locator('.help__empty');
  await expect(empty.getByText('No matches')).toBeVisible();
  return empty;
}

/** The person's own requests, read through Edge with a session of their own. */
async function myRequests(who) {
  const res = await (await api(who)).get(`/api/support/trpc/listMine?input=${encodeURIComponent(JSON.stringify({ limit: 200 }))}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** A step whose earlier step left nothing stops at once, naming what it waits on. */
function need(value, what) {
  if (!value) throw new Error(`${what}, so this step cannot start`);
  return value;
}

/** Fill the request form and stop at the review step. */
async function draft(main, subject, body) {
  await main.getByLabel('Subject', { exact: true }).fill(subject);
  await main.getByLabel('What happened').fill(body);
  await main.getByRole('button', { name: 'Review request' }).click();
}

const shared = {};
const TEST_REQUEST = { category: 'other', subject: `TEST ${J} ${RUN} refused`, body: 'TEST refused by the form rules' };

/** The person of these steps, signed in on a page of its own: the one step 1 made, or a new one when a restart lost it. */
async function person(browser) {
  if (shared.page && !shared.page.isClosed()) return shared.page;
  const page = await visitor(browser);
  if (shared.who) {
    await page.goto('/login');
    await page.fill('input[name=identifier]', shared.who.email);
    await page.fill('input[name=password]', shared.who.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page).not.toHaveURL(/\/login/);
  } else shared.who = await signUp(page, 'j02p');
  shared.page = page;
  return page;
}

test(`${J} #1 "Contact support" under a search with no answer opens /support/new with the search text as the subject`, async ({
  browser,
}) => {
  const page = await visitor(browser);
  shared.who = await signUp(page, 'j02a');
  const empty = await emptySearch(page);
  await empty.getByRole('link', { name: 'Contact support' }).click();
  await expect(page).toHaveURL(/\/support\/new\?/);
  await expect(page.locator('main').getByLabel('Subject', { exact: true })).toHaveValue(WORDS);
  await page.context().close();
});

test(`${J} #2 signed out, the request button asks for a sign-in, keeps the search text and lands back on the form`, async ({ browser }) => {
  need(shared.who, 'step 1 made no account');
  const page = await visitor(browser);
  const empty = await emptySearch(page);
  const main = page.locator('main');
  await empty.getByRole('button', { name: 'Contact support' }).click();
  const prompt = main.getByTestId('request-sign-in');
  await expect(prompt).toBeVisible();
  await expect(main.getByRole('textbox', { name: 'Search answers' })).toHaveValue(WORDS);
  await prompt.getByRole('link', { name: 'Sign in' }).click();
  await page.fill('input[name=identifier]', shared.who.email);
  await page.fill('input[name=password]', shared.who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).toHaveURL(/\/support\/new\?/);
  await expect(main.getByLabel('Subject', { exact: true })).toHaveValue(WORDS);
  shared.page = page;
});

test(`${J} #3 a request type shows its form: a conditional field is required only when its value is picked, and a dependent field refuses a child that does not belong`, async ({
  browser,
}) => {
  // The run's own request type: a device choice, a system that depends on it, and a phone model asked only for a phone.
  const id = (name) => `j02-${RUN}-${name}`;
  const reason = `TEST ${J} #3`;
  // Everything defined here is retired in `finally`, even when a later definition fails, so no run leaves live
  // definitions counting against the desk's caps.
  const defined = [];
  let form = null;
  const field = async (definition) => {
    const row = await defineRequestField(definition);
    defined.unshift(row);
    return row;
  };
  try {
    const device = await field({
      id: id('device'),
      label: 'Device',
      kind: 'choice',
      options: [
        { value: 'phone', label: 'Phone' },
        { value: 'computer', label: 'Computer' },
      ],
      expectedRevision: 0,
      reason,
    });
    const system = await field({
      id: id('system'),
      label: 'System',
      kind: 'choice',
      options: [
        { value: 'ios', label: 'iOS' },
        { value: 'android', label: 'Android' },
        { value: 'windows', label: 'Windows' },
      ],
      parent: { fieldId: device.id, allowed: { phone: ['ios', 'android'], computer: ['windows'] } },
      expectedRevision: 0,
      reason,
    });
    const model = await field({ id: id('model'), label: 'Phone model', kind: 'text', expectedRevision: 0, reason });
    form = await defineRequestForm({
      id: id('form'),
      name: `TEST Device problem ${RUN}`,
      fields: [
        { fieldId: device.id, required: true },
        { fieldId: system.id, required: true },
        { fieldId: model.id, required: true, showWhen: { fieldId: device.id, value: 'phone' } },
      ],
      expectedRevision: 0,
      reason,
    });
    const page = await person(browser);
    await page.goto('/support/new');
    const main = page.locator('main');
    await main.getByRole('combobox', { name: 'Request type' }).selectOption({ label: form.name });
    const phoneModel = main.getByRole('textbox', { name: 'Phone model (required)' });
    await expect(phoneModel).toHaveCount(0);
    // A computer: the system offers only what a computer runs, and no phone model is asked.
    await main.getByRole('combobox', { name: 'Device (required)' }).selectOption({ label: 'Computer' });
    const systems = main.getByRole('combobox', { name: 'System (required)' }).locator('option');
    await expect(systems).toHaveText(['Pick one', 'Windows']);
    await expect(phoneModel).toHaveCount(0);
    // A phone: the phone model appears and must be answered before the review.
    await main.getByRole('combobox', { name: 'Device (required)' }).selectOption({ label: 'Phone' });
    await expect(systems).toHaveText(['Pick one', 'iOS', 'Android']);
    await main.getByRole('combobox', { name: 'System (required)' }).selectOption({ label: 'iOS' });
    await expect(phoneModel).toBeVisible();
    await expect(phoneModel).toHaveAttribute('required', '');
    await main.getByLabel('Subject', { exact: true }).fill(`TEST ${J} ${RUN} device`);
    await main.getByLabel('What happened').fill('TEST The app closes when I open it.');
    await expect(main.getByRole('button', { name: 'Review request' })).toBeDisabled();
    await phoneModel.fill('TEST P7');
    await expect(main.getByRole('button', { name: 'Review request' })).toBeEnabled();

    // The service applies the same rules: a child its parent does not allow, and an answer to a hidden field, are refused.
    const client = await api(shared.who);
    const send = (values, key) =>
      client.post('/api/support/trpc/create', { ...TEST_REQUEST, clientRequestId: `j02:${RUN}:${key}`, form: { formId: form.id, values } });
    expect(JSON.stringify((await send({ [device.id]: 'computer', [system.id]: 'ios' }, 'child')).body)).toContain(
      'support.field_value_invalid',
    );
    expect(JSON.stringify((await send({ [device.id]: 'computer', [system.id]: 'windows', [model.id]: 'x' }, 'hidden')).body)).toContain(
      'support.field_value_invalid',
    );
    expect((await myRequests(shared.who)).filter((row) => row.subject === TEST_REQUEST.subject)).toHaveLength(0);
  } finally {
    if (form)
      await defineRequestForm({
        id: form.id,
        name: form.name,
        fields: form.fields,
        retired: true,
        expectedRevision: form.revision,
        reason,
      });
    // Newest first: a dependent field is retired before the field it depends on.
    for (const row of defined) {
      const { revision, updatedAt: _at, ...definition } = row;
      await defineRequestField({ ...definition, retired: true, expectedRevision: revision, reason });
    }
  }
});

test(`${J} #4 a fraud-report category says it goes to compliance, and an unknown category is refused by name`, async ({ browser }) => {
  const page = await person(browser);
  // An unknown category is refused with its own code, not a shape error.
  const res = await (
    await api(shared.who)
  ).post('/api/support/trpc/create', {
    category: `j02-unknown-${RUN}`,
    subject: 'TEST unknown category',
    body: 'TEST',
    clientRequestId: `j02:${RUN}:unknown`,
  });
  expect(JSON.stringify(res.body)).toContain('support.category_unknown');
  // The owner's fraud-report category (SP-tickets-01 category list) names where it goes.
  await page.goto('/support/new');
  const main = page.locator('main');
  await expect(main.getByText('goes to our compliance team')).toBeVisible({ timeout: 5_000 });
});

test(`${J} #5 the review step sends one request with an audit event and "Open"; a lost reply re-reads the stored request and makes no second one`, async ({
  browser,
}) => {
  const page = await person(browser);
  const main = page.locator('main');
  const subject = `TEST ${J} ${RUN} request`;
  const body = `TEST I searched for "${WORDS}" and found no answer.`;
  await page.goto(`/support/new?subject=${encodeURIComponent(WORDS)}`);
  await draft(main, subject, body);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(subject)).toBeVisible();
  // The service stores the request, but its answer never reaches the page.
  let dropped = 0;
  await page.route('**/api/support/trpc/create**', async (route) => {
    if (dropped > 0) return route.continue();
    dropped += 1;
    await route.fetch();
    await route.abort('connectionreset');
  });
  await dialog.getByRole('button', { name: 'Send request' }).click();
  // The page names the unconfirmed outcome and re-reads the stored request by its own key; it does not send again.
  await main.getByRole('button', { name: 'Check original outcome' }).click();
  await expect(page).toHaveURL(/\/support\/tickets\/[0-9a-f-]{36}$/);
  await page.unroute('**/api/support/trpc/create**');
  expect(dropped).toBe(1);
  const mine = (await myRequests(shared.who)).filter((row) => row.subject === subject);
  expect(mine).toHaveLength(1);
  shared.ticket = mine[0];
  await expect(main.getByRole('heading', { name: subject })).toBeVisible();
  await expect(main.locator('.support-status').first()).toHaveText('Open');
  await expect(main.getByText('Request opened')).toBeVisible();
});

test(`${J} #6 the request has its own address: a fresh page at /support/tickets/:ticketId opens it`, async ({ browser }) => {
  need(shared.ticket, 'step 5 made no request');
  const page = shared.page;
  await page.goto(`/support/tickets/${shared.ticket.id}`);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: shared.ticket.subject })).toBeVisible();
  // Someone else holding the address reads it as not found, the same as an address that never existed.
  const other = await visitor(browser);
  await signUp(other, 'j02b');
  await other.goto(`/support/tickets/${shared.ticket.id}`);
  await expect(other.locator('main').getByText('We could not find this request')).toBeVisible();
  await expect(other.locator('main').getByText(shared.ticket.subject)).toHaveCount(0);
  await other.context().close();
});

test(`${J} #7 "My requests" at /support/tickets shows Awaiting your reply, Open and Solved; with nothing yet, an honest empty state`, async ({
  browser,
}) => {
  need(shared.ticket, 'step 5 made no request');
  const page = shared.page;
  const main = page.locator('main');
  const row = () => main.getByRole('button', { name: `Open request: ${shared.ticket.subject}` });

  await page.goto('/support/tickets');
  await expect(main.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await expect(row()).toContainText('Open');

  // The team answers: the request now waits on the person.
  await replyAsLead(shared.ticket.id, `TEST ${J} ${RUN} the team asks a question`);
  await page.reload();
  await expect(row()).toContainText('Awaiting your reply');

  // The team solves it.
  await setStatusAsLead(shared.ticket.id, 'resolved', `TEST ${J} #7 solved`);
  await page.reload();
  await expect(row()).toContainText('Solved');

  // Someone with no requests sees an honest empty state and no row.
  const fresh = await visitor(browser);
  await signUp(fresh, 'j02c');
  await fresh.goto('/support/tickets');
  const freshMain = fresh.locator('main');
  await expect(freshMain.getByRole('heading', { name: 'My requests' })).toBeVisible();
  await expect(freshMain.getByText('You have not sent us a request yet')).toBeVisible();
  await expect(freshMain.locator('.support-row')).toHaveCount(0);
  await fresh.context().close();
});

// Last, so its failure while unbuilt does not cost the steps before it their shared request.
test(`${J} #6 the request shows its type and priority where the owner allows it`, async ({ browser }) => {
  const ticket = need(shared.ticket, 'step 5 made no request');
  const page = await person(browser);
  await page.goto(`/support/tickets/${ticket.id}`);
  const main = page.locator('main');
  await expect(main.getByRole('heading', { name: ticket.subject })).toBeVisible();
  // Customer-visible type and priority are SP-tickets-04's owner setting; until it lands the request shows neither.
  await expect(main.getByText('Request type', { exact: true })).toBeVisible({ timeout: 5_000 });
});
