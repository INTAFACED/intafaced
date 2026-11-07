// World: none
import { test, expect } from './journey.mjs';
import { signUp } from './desk.mjs';
import { api, fund, ORIGIN } from './stack.mjs';

// J-bank-18, in the running app (docs/roadmap/journeys.json): I stay safe, report a scam and make a complaint. Tests
// titled "J-bank-18 #<n>" prove a step. Steps #1, #3 and #4 (BK-safe-01, BK-safe-02) land with their own slices; this file
// holds the steps built so far, so no step here is written ahead of its code.
//
// #2 (BK-safe-02): the scam warning on a first-time payee, once per payee, with the link to the scam guide. The person is
// funded with TEST USDT only so the bank opens their space; nothing is sent.
//
// #5 and #6 (BK-safe-03): a complaint and a bereavement report, each a request on the support desk with one
// acknowledgement. The stack publishes a TEST final-response limit of 14 calendar days (SUPPORT_COMPLAINT_RESPONSE_DAYS
// in tooling/profiles/test-owner-values/support.json); production stays blank and every deadline reads "not set"
// (proved in services/svc-support/src/safety-cases.test.ts).
const J = 'J-bank-18';
const RUN = Date.now().toString(36);
const LIMIT_DAYS = 14;
const DAY_MS = 86_400_000;

/** A person on a device of their own. */
async function visitor(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN, viewport: { width: 1440, height: 900 } });
  return context.newPage();
}

/** The person's own support doors through Edge, with a session of their own (not the browser's). */
async function support(who) {
  const client = await api(who);
  return {
    mine: async () => {
      const res = await client.get('/api/support/trpc/safety.mine');
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
      return res.body.result.data.acknowledgements;
    },
    tickets: async () => {
      const res = await client.get(`/api/support/trpc/listMine?input=${encodeURIComponent(JSON.stringify({ limit: 200 }))}`);
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
      return res.body.result.data;
    },
    post: (procedure, body) => client.post(`/api/support/trpc/${procedure}`, body),
  };
}

/** Pick another person as the payee on /bank/transfers by handle. */
async function pickPayee(page, handle) {
  await page.getByLabel('Destination').selectOption({ label: 'Another person' });
  await page.getByPlaceholder('@handle').fill(handle);
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByText(`Paying @${handle}`)).toBeVisible();
}

test(`${J} #2 reviews a first-time payee: the warning once per payee with a link to the scam guide`, async ({ browser }) => {
  // Two other people to pay, each signed up on a device of their own.
  const payees = [];
  for (const prefix of ['jb18p', 'jb18q']) {
    const other = await visitor(browser);
    payees.push(await signUp(other, prefix));
    await other.context().close();
  }
  const page = await visitor(browser);
  const who = await signUp(page, 'jb18w');
  expect(fund(who.email, 'USDT', '5').tx).toBeTruthy();
  await page.goto('/bank/transfers');
  const main = page.locator('main');

  // First review of the first payee: the warning, with a link that opens the scam guide.
  await pickPayee(page, payees[0].handle);
  const warning = main.getByTestId('payee-warning');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('First payment to this person: check it is not a scam');
  const guide = warning.getByRole('link', { name: 'Read the scam guide' });
  await expect(guide).toHaveAttribute('href', '/helpdetail?id=kb-security-scam-tactics');
  await warning.getByRole('button', { name: 'I understand' }).click();
  await expect(warning).toHaveCount(0);

  // Once per payee: reviewing the same payee again, after a reload, shows no warning.
  await page.reload();
  await pickPayee(page, payees[0].handle);
  await expect(main.getByText(`Paying @${payees[0].handle}`)).toBeVisible();
  await expect(main.getByTestId('payee-warning')).toHaveCount(0);

  // A different first-time payee gets the warning again.
  await pickPayee(page, payees[1].handle);
  await expect(main.getByTestId('payee-warning')).toBeVisible();

  // The guide it links is a published answer.
  await main.getByTestId('payee-warning').getByRole('link', { name: 'Read the scam guide' }).click();
  await expect(page).toHaveURL(/\/helpdetail\?id=kb-security-scam-tactics/);
  await expect(page.locator('main').getByRole('heading').first()).toBeVisible();
  await expect(page.locator('main')).not.toContainText('not found', { ignoreCase: true });
  await page.context().close();
});

test(`${J} #5 files a complaint: an acknowledgement once with the deadline from the owner's limit`, async ({ browser }) => {
  const page = await visitor(browser);
  const who = await signUp(page, 'jb18c');
  const desk = await support(who);

  // The bank's services open the complaint form.
  await page.goto('/bank');
  await page
    .locator('main')
    .getByRole('link', { name: /Make a complaint/ })
    .click();
  await expect(page).toHaveURL(/\/bank\/safety\/complaint$/);
  const main = page.locator('main');
  const form = main.getByRole('form', { name: 'Make a complaint' });
  await form.getByLabel('What is it about').selectOption('payments');
  await form.getByLabel('What went wrong').fill(`TEST ${J} ${RUN}: my transfer was held for a week with no reason.`);
  await form.getByLabel('What you want us to do (optional)').fill('TEST explain why it was held');
  const before = Date.now();
  await form.getByRole('button', { name: 'Send complaint' }).click();

  // One acknowledgement: a reference, when, and the final-response date from the owner's limit.
  const ack = main.getByRole('status').filter({ hasText: 'Complaint received' });
  await expect(ack).toBeVisible();
  const reference = await ack.getByTestId('safety-ack-reference').innerText();
  expect(reference).toMatch(/^CP-[0-9A-F]{8}$/);
  const deadline = ack.getByTestId('safety-ack-deadline');
  await expect(deadline).toHaveAttribute('data-status', 'set');
  await expect(deadline).toContainText('Final response due by');
  await expect(deadline).toContainText(`${LIMIT_DAYS} calendar days from the acknowledgement`);

  // The record behind it: one acknowledgement, its deadline exactly the owner's limit after it, on one complaint request.
  const acks = (await desk.mine()).filter((a) => a.kind === 'complaint');
  expect(acks).toHaveLength(1);
  const [one] = acks;
  expect(one.reference).toBe(reference);
  expect(Date.parse(one.acknowledgedAt)).toBeGreaterThanOrEqual(before - 60_000);
  expect(one.responseDeadline).toEqual({ status: 'set', limitDays: LIMIT_DAYS, dueAt: expect.any(String) });
  expect(Date.parse(one.responseDeadline.dueAt) - Date.parse(one.acknowledgedAt)).toBe(LIMIT_DAYS * DAY_MS);
  const complaints = (await desk.tickets()).filter((t) => t.category === 'complaint');
  expect(complaints.map((t) => t.id)).toEqual([one.ticketId]);

  // Once: the same complaint sent again under its key answers with the same acknowledgement and makes nothing new.
  const replay = { requestKey: `jb18-${RUN}-replay`, topic: 'cards', details: `TEST ${J} ${RUN}: card declined twice in a shop.` };
  const first = await desk.post('safety.complain', replay);
  const second = await desk.post('safety.complain', replay);
  expect(first.status, JSON.stringify(first.body).slice(0, 300)).toBe(200);
  expect(second.status).toBe(200);
  expect(second.body.result.data).toEqual(first.body.result.data);
  expect((await desk.mine()).filter((a) => a.kind === 'complaint')).toHaveLength(2);

  // A complaint is made only through its form: the general request form refuses the category.
  const general = await desk.post('create', { category: 'complaint', subject: 'TEST', body: 'TEST' });
  expect(general.status).toBe(400);
  expect(JSON.stringify(general.body)).toContain('support.category_guided');

  // After a reload the room lists the complaints, each once, the one made here under its reference.
  await page.reload();
  const earlier = main.getByTestId('safety-earlier-complaint');
  await expect(earlier.locator(`[data-reference="${reference}"]`)).toHaveCount(1);
  await expect(earlier.locator('[data-testid="safety-ack-complaint"]')).toHaveCount(2);
  // The request it made opens from the acknowledgement, as a complaint.
  await earlier.locator(`[data-reference="${reference}"]`).getByRole('link', { name: 'Open the request' }).click();
  await expect(page).toHaveURL(new RegExp(`/support/tickets/${one.ticketId}$`));
  await expect(page.locator('main')).toContainText('Complaint about payments and transfers');
  await page.context().close();
});

test(`${J} #6 a family reports a deceased customer: a reporting form and an acknowledgement`, async ({ browser }) => {
  const page = await visitor(browser);
  const who = await signUp(page, 'jb18d');
  const desk = await support(who);

  await page.goto('/bank');
  await page
    .locator('main')
    .getByRole('link', { name: /Report a death/ })
    .click();
  await expect(page).toHaveURL(/\/bank\/safety\/bereavement$/);
  const main = page.locator('main');
  const form = main.getByRole('form', { name: 'Report a death' });
  // The reporting form: who died, when, and who is reporting.
  await form.getByLabel('Full name of the person who died').fill(`Ada TEST ${RUN}`);
  await form.getByLabel('Their email or handle, if you know it (optional)').fill(`ada-${RUN}@local-test.invalid`);
  const day = new Date(Date.now() - 3 * DAY_MS).toISOString().slice(0, 10);
  await form.getByLabel('Date of death').fill(day);
  await form.getByLabel('Your relation to them').selectOption('child');
  await form.getByLabel('Your full name').fill('Ben TEST');
  await form.getByLabel('How we can reach you').fill(who.email);
  await form.getByRole('button', { name: 'Send report' }).click();

  // An acknowledgement with its reference.
  const ack = main.getByRole('status').filter({ hasText: 'Report received' });
  await expect(ack).toBeVisible();
  const reference = await ack.getByTestId('safety-ack-reference').innerText();
  expect(reference).toMatch(/^BR-[0-9A-F]{8}$/);

  // One acknowledgement on one bereavement request carrying what the form said.
  const acks = (await desk.mine()).filter((a) => a.kind === 'bereavement');
  expect(acks).toHaveLength(1);
  expect(acks[0]).toMatchObject({ reference, responseDeadline: null });
  const reports = (await desk.tickets()).filter((t) => t.category === 'bereavement');
  expect(reports.map((t) => t.id)).toEqual([acks[0].ticketId]);
  expect(reports[0].body).toContain(`Customer who died: Ada TEST ${RUN}`);
  expect(reports[0].body).toContain(`Date of death: ${day}`);
  expect(reports[0].body).toContain('Reported by: Ben TEST (child)');

  // A date of death in the future is refused by its code, and nothing is made.
  const future = new Date(Date.now() + 3 * DAY_MS).toISOString().slice(0, 10);
  const refused = await desk.post('safety.reportBereavement', {
    requestKey: `jb18-${RUN}-future`,
    deceasedName: 'Ada TEST',
    dateOfDeath: future,
    relation: 'child',
    reporterName: 'Ben TEST',
    reporterContact: who.email,
  });
  expect(refused.status).toBe(400);
  expect(JSON.stringify(refused.body)).toContain('support.bereavement_date_invalid');
  expect((await desk.mine()).filter((a) => a.kind === 'bereavement')).toHaveLength(1);
  await page.context().close();
});
