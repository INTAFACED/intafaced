// World: restart
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { api, fund, ORIGIN, ROOT, tool } from './stack.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-bank-18, in the running app (docs/roadmap/journeys.json): I stay safe, report a scam and make a complaint. Tests
// titled "J-bank-18 #<n>" prove a step.
//
// #1 (BK-safe-01): a transfer opened from a blocked region. The stack plays the visitor from the TEST region AA, which no
// country holds: `LOCAL_STACK_TEST_REGION_SERVED=off` on a restart makes Edge stamp every request from AA and gives
// svc-bank a TEST business block for it (as J-wallet-09 #1 does for svc-protocol). The notice's wording is the bank
// profile's TEST wording (BANK_BLOCKED_REGION_NOTICE in tooling/profiles/test-owner-values/bank.json), or blank with
// `LOCAL_STACK_BANK_BLOCKED_REGION_NOTICE=off`. Every switch is put back in the same step.
//
// #2 (BK-safe-02): the scam warning on a first-time payee, in the transfer review of a saved recipient. Saving a
// recipient takes a fresh confirmation, so the person sets up an authenticator first, as J-bank-04 does.
//
// #3 (BK-safe-02): a scam report after sending money. The person sends TEST 5 USDT to another TEST person, then reports
// it with the amount and the transfer id; svc-support asks svc-bank on its signed door whether this person sent that
// transfer before it takes the report. The mule policy is the support profile's TEST wording (SUPPORT_MULE_POLICY), or
// blank with `LOCAL_STACK_SUPPORT_MULE_POLICY=off`, put back in the same step.
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

/** Restart one stack service with these switches set for the restart only; this process's environment is put back. */
function restartWithAll(service, switches) {
  const before = Object.fromEntries(Object.keys(switches).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(switches)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    tool('local-test-stack.mjs', 'restart', service);
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
const SERVED = { LOCAL_STACK_TEST_REGION_SERVED: undefined, LOCAL_STACK_BANK_BLOCKED_REGION_NOTICE: undefined };
const TEST_REGION_REASON = 'TEST region, not served at launch';

test(`${J} #1 opens a transfer from a blocked region: a notice naming the restriction in the owner's wording; with no wording published it says the wording is not published`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const page = await visitor(browser);
  const who = await signUp(page, 'jb18r');
  await verify(page, who);
  const bank = await api(who);
  const requirements = () => bank.get('/api/bank/trpc/railSends.requirements');

  // Served, the transfer form opens and there is no notice.
  await signIn(page, who);
  await page.goto('/bank/transfers');
  const send = page.getByTestId('rail-send');
  await expect(send.getByLabel('Send to')).toBeVisible({ timeout: 30_000 });
  await expect(send.getByTestId('rail-send-region')).toHaveCount(0);
  expect((await requirements()).status).toBe(200);

  try {
    // From the TEST region AA, blocked for the bank, with no wording published.
    restartWithAll('bank', { LOCAL_STACK_TEST_REGION_SERVED: 'off', LOCAL_STACK_BANK_BLOCKED_REGION_NOTICE: 'off' });
    restartWithAll('edge', { LOCAL_STACK_TEST_REGION_SERVED: 'off' });
    await page.goto('/bank/transfers');
    const notice = send.getByTestId('rail-send-region');
    await expect(notice).toBeVisible({ timeout: 30_000 });
    await expect(notice).toHaveAttribute('data-code', 'denied.region_blocked');
    await expect(notice).toContainText('Sending money is not available from your region (AA)');
    await expect(notice.getByTestId('rail-send-region-restriction')).toHaveText(`Restriction: ${TEST_REGION_REASON}`);
    const unpublished = notice.getByTestId('rail-send-region-wording');
    await expect(unpublished).toHaveAttribute('data-published', 'false');
    await expect(unpublished).toHaveText('The wording for this restriction is not published.');
    await expect(send.getByLabel('Send to')).toHaveCount(0);
    // The bank's door refuses the same request by its code, whatever the page shows.
    const refused = await requirements();
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('denied.region_blocked');

    // The owner's wording published (the profile's TEST wording): the notice reads it, still naming the restriction.
    restartWithAll('bank', { LOCAL_STACK_TEST_REGION_SERVED: 'off', LOCAL_STACK_BANK_BLOCKED_REGION_NOTICE: undefined });
    await page.goto('/bank/transfers');
    const published = send.getByTestId('rail-send-region-wording');
    await expect(published).toHaveAttribute('data-published', 'true', { timeout: 30_000 });
    await expect(published).toHaveText(
      "TEST wording, not the owner's: sending money is not offered from where you are now. You can still see your accounts and contact support.",
    );
    await expect(send.getByTestId('rail-send-region-restriction')).toHaveText(`Restriction: ${TEST_REGION_REASON}`);
    expect((await requirements()).status).toBe(403);
  } finally {
    // Edge first, so no request is stamped from the TEST region once the bank serves it again.
    try {
      restartWithAll('edge', { LOCAL_STACK_TEST_REGION_SERVED: undefined });
    } finally {
      restartWithAll('bank', SERVED);
    }
  }
  await page.goto('/bank/transfers');
  await expect(send.getByLabel('Send to')).toBeVisible({ timeout: 30_000 });
  expect((await requirements()).status).toBe(200);
  await page.context().close();
});

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** A verified person with an authenticator, signed in on `page`; `code()` gives the next unused authenticator code. */
async function withAuthenticator(page, prefix) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  await signIn(page, who);
  const { totp } = await totpLib();
  const state = await addAuthenticator(page, totp);
  const code = async () => {
    const next = await nextCode(totp, state.secret, state.step);
    state.step = next.step;
    return next.code;
  };
  return { who, code };
}

/** Save a German SEPA recipient through the recipient book, confirming with a fresh authenticator code. */
async function savePayee(page, code, nickname, iban) {
  await page.goto('/bank/transfers');
  const book = page.getByTestId('payee-book');
  await book.getByLabel('Country of the account').selectOption({ label: 'Germany' }, { timeout: 30_000 });
  await book.getByLabel('How they are paid').selectOption({ label: 'SEPA (euro bank account)' });
  const form = book.getByTestId('payee-form');
  await form.getByLabel('Account holder’s full name').fill(`${nickname} TEST`);
  await form.getByLabel('IBAN').fill(iban);
  await book.getByLabel('Nickname').fill(nickname);
  await book.getByRole('button', { name: 'Save recipient' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
  await dialog.getByLabel('Authenticator code or recovery code').fill(await code());
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toHaveCount(0, { timeout: 30_000 });
  await expect(book.getByTestId('payee-row').filter({ hasText: nickname })).toHaveCount(1, { timeout: 30_000 });
}

test(`${J} #2 reviews a first-time payee: the warning once per payee with a link to the scam guide`, async ({ browser }) => {
  test.setTimeout(300_000);
  const page = await visitor(browser);
  const { who, code } = await withAuthenticator(page, 'jb18p');
  await savePayee(page, code, 'Bea', 'DE89 3704 0044 0532 0130 00');
  await savePayee(page, code, 'Cem', 'DE44 5001 0517 5407 3249 31');
  const bank = await api(who, { totpCode: await code() });
  const payees = async () => {
    const res = await bank.get(`/api/bank/trpc/railSends.payees?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return Object.fromEntries(res.body.result.data.map((p) => [p.nickname, p]));
  };
  expect((await payees()).Bea.scamWarning).toEqual({ state: 'unread', readAt: null });

  // Reviewing a send to Bea, a first-time payee: the warning, with the scam guide.
  await page.goto('/bank/transfers');
  const send = page.getByTestId('rail-send');
  const to = send.getByLabel('Send to');
  const warning = send.getByTestId('rail-send-scam-warning');
  await to.selectOption({ label: 'Bea · Bea TEST · …3000' }, { timeout: 30_000 });
  await expect(warning).toBeVisible();
  await expect(warning).toContainText('You have not sent to this recipient before');
  await expect(warning).toContainText('We will never ask you to move money to a "safe account"');
  await expect(warning.getByRole('link', { name: 'Read the scam guide' })).toHaveAttribute('href', '/help/official-channels');
  await warning.getByRole('button', { name: 'I have read this' }).click();
  await expect(warning).toHaveCount(0);
  const read = (await payees()).Bea.scamWarning;
  expect(read.state).toBe('read');

  // Once per payee: Bea's review no longer shows it, after a reload too; Cem, another first-time payee, does.
  await page.reload();
  await to.selectOption({ label: 'Bea · Bea TEST · …3000' }, { timeout: 30_000 });
  await expect(send.getByTestId('rail-send-payee')).toBeVisible();
  await expect(warning).toHaveCount(0);
  await to.selectOption({ label: 'Cem · Cem TEST · …4931' });
  await expect(warning).toBeVisible();
  await expect(warning).toHaveAttribute('data-payee', (await payees()).Cem.payeeId);
  // Reading Bea's warning again through the door changes nothing.
  const again = await bank.post('/api/bank/trpc/railSends.readPayeeWarning', { payeeId: (await payees()).Bea.payeeId });
  expect(again.status).toBe(200);
  expect(again.body.result.data.scamWarning).toEqual(read);

  // The link opens the scam guide.
  await warning.getByRole('link', { name: 'Read the scam guide' }).click();
  await expect(page).toHaveURL(/\/help\/official-channels$/);
  await expect(page.getByRole('heading', { name: 'Scam guides' })).toBeVisible();
  expect((await payees()).Cem.scamWarning.state).toBe('unread');
  await page.context().close();
});

test(`${J} #3 reports a scam with an amount and a transfer id: a ticket in the scam category and a case note; the mule policy page`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  // The person who received the money, on a device of their own.
  const other = await visitor(browser);
  const mule = await signUp(other, 'jb18m');
  await verify(other, mule);
  const muleApi = await api(mule);
  await other.context().close();

  const page = await visitor(browser);
  const who = await signUp(page, 'jb18s');
  await verify(page, who);
  expect(fund(who.email, 'USDT', '20').tx).toBeTruthy();
  const bank = await api(who);
  const desk = await support(who);
  const spaces = await bank.get(`/api/bank/trpc/spaces.list?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`);
  expect(spaces.status, JSON.stringify(spaces.body).slice(0, 300)).toBe(200);
  const from = spaces.body.result.data.find((x) => x.kind === 'primary' && x.assetId === 'USDT');
  const transferId = `jb18-scam-${RUN}`;
  const paid = await bank.post('/api/bank/trpc/transfers.toUser', {
    transferId,
    fromSpaceId: from.id,
    toUserId: muleApi.userId,
    amount: '5',
  });
  expect(paid.status, JSON.stringify(paid.body).slice(0, 300)).toBe(200);

  // The bank's services open the scam report.
  await page.goto('/bank');
  await page
    .locator('main')
    .getByRole('link', { name: /Report a scam/ })
    .click();
  await expect(page).toHaveURL(/\/bank\/safety\/scam$/);
  const main = page.locator('main');
  const form = main.getByRole('form', { name: 'Report a scam' });
  await form.getByLabel('Have you sent money').selectOption('after_sending');
  await form.getByLabel('Amount').fill('5');
  await form.getByLabel('Currency or asset').fill('USDT');
  await form.getByLabel('How they contacted you').selectOption('phone_call');
  await form
    .getByLabel('What happened (optional)')
    .fill(`TEST ${J} ${RUN}: a caller said they were the bank and told me to move money to a safe account.`);

  // A transfer the person did not send is refused, and nothing is made.
  await form.getByLabel('Transfer id').fill(`jb18-not-mine-${RUN}`);
  await form.getByRole('button', { name: 'Send scam report' }).click();
  await expect(main).toContainText('That transfer id is not a transfer you sent.');
  expect((await desk.mine()).filter((a) => a.kind === 'scam')).toHaveLength(0);

  // The transfer they sent: one acknowledgement with a reference and the case note naming the amount and the transfer.
  await form.getByLabel('Transfer id').fill(transferId);
  await form.getByRole('button', { name: 'Send scam report' }).click();
  const ack = main.getByRole('status').filter({ hasText: 'Scam report received' });
  await expect(ack).toBeVisible();
  const reference = await ack.getByTestId('safety-ack-reference').innerText();
  expect(reference).toMatch(/^SC-[0-9A-F]{8}$/);
  const note = ack.getByTestId('safety-ack-case-note');
  await expect(note).toContainText(`5 USDT on transfer ${transferId}, which the bank confirms was sent from this account`);
  await expect(note).toContainText('Contacted by a phone call.');

  // The record behind it: one scam acknowledgement on one request in the scam category, naming the amount and transfer.
  const acks = (await desk.mine()).filter((a) => a.kind === 'scam');
  expect(acks).toHaveLength(1);
  const [one] = acks;
  expect(one).toMatchObject({ reference, responseDeadline: null, caseNote: expect.stringContaining(transferId) });
  const scams = (await desk.tickets()).filter((t) => t.category === 'scam');
  expect(scams.map((t) => t.id)).toEqual([one.ticketId]);

  // One report per transfer: the same transfer reported again, in other words, answers with the first acknowledgement.
  const again = await desk.post('safety.reportScam', {
    when: 'after_sending',
    amount: '7',
    assetId: 'USDT',
    transferId,
    contactedBy: 'email',
  });
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data).toEqual(one);
  expect((await desk.tickets()).filter((t) => t.category === 'scam')).toHaveLength(1);
  // The person who received it cannot report it as theirs, and the general request form refuses the category.
  const notTheirs = await (
    await support(mule)
  ).post('safety.reportScam', { when: 'after_sending', amount: '5', assetId: 'USDT', transferId, contactedBy: 'other' });
  expect(notTheirs.status).toBe(403);
  expect(JSON.stringify(notTheirs.body)).toContain('support.scam_transfer_not_yours');
  const general = await desk.post('create', { category: 'scam', subject: 'TEST', body: 'TEST' });
  expect(general.status).toBe(400);
  expect(JSON.stringify(general.body)).toContain('support.category_guided');

  // The request opens from the acknowledgement.
  await ack.getByRole('link', { name: 'Open the request' }).click();
  await expect(page).toHaveURL(new RegExp(`/support/tickets/${one.ticketId}$`));
  await expect(page.locator('main')).toContainText('Scam report');
  await expect(page.locator('main')).toContainText(`Transfer: ${transferId}`);

  // The mule policy page: the owner's wording (here the TEST wording), and with none published, a notice that says so.
  await page.goto('/bank/safety/scam');
  await main.getByRole('link', { name: 'Read our money mule policy' }).click();
  await expect(page).toHaveURL(/\/help\/mule-policy$/);
  const policy = page.getByTestId('mule-policy');
  await expect(policy.getByRole('heading', { name: 'Money mule policy' })).toBeVisible();
  await expect(policy.getByTestId('mule-policy__text')).toContainText('passing it on for someone else is money laundering');
  await expect(policy.getByRole('link', { name: 'Report a scam' })).toHaveAttribute('href', '/bank/safety/scam');
  try {
    restartWithAll('support', { LOCAL_STACK_SUPPORT_MULE_POLICY: 'off' });
    await page.reload();
    await expect(policy.getByTestId('mule-policy__unpublished')).toHaveText('The owner has not published the money mule policy.');
    await expect(policy.getByTestId('mule-policy__text')).toHaveCount(0);
  } finally {
    restartWithAll('support', { LOCAL_STACK_SUPPORT_MULE_POLICY: undefined });
  }
  await page.reload();
  await expect(policy.getByTestId('mule-policy__text')).toBeVisible();
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
