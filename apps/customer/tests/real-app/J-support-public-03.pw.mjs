import { readFileSync, existsSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { asDesk, ensureDeskGroup } from './help-centre.mjs';
import { journeyState, ORIGIN, restartWith, stackFile, tool } from './stack.mjs';

// J-support-public-03, in the running app (docs/roadmap/journeys.json): someone with no account asks for help, confirms
// their address by the emailed link, and reads and replies on that one request by link. svc-support stores the request and
// asks svc-notify's guest verification door to mail the link, which lands in the stack's LOCAL TEST outbox. Tests titled
// "J-support-public-03 #<n>" prove a whole step.
const J = 'J-support-public-03';

test.describe.configure({ mode: 'serial' });

const state = journeyState(J);
const RUN = Date.now().toString(36);
const address = (tag) => `j03-${tag}-${RUN}@example.test`;

/** The guest verification mail svc-notify wrote to the outbox for this address, oldest first. */
function guestMail(email) {
  const file = stackFile('status-mail-outbox.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('LOCAL-TEST '))
    .map((line) => JSON.parse(line.slice('LOCAL-TEST '.length)))
    .filter((mail) => mail.purpose === 'guest-verify' && mail.to === email);
}

/** The link in the latest guest mail to this address, once it has arrived. */
async function mailedLink(email, count = 1) {
  await expect.poll(() => guestMail(email).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(count);
  const text = guestMail(email).at(-1).text;
  const link = /(http\S+\/support\/guest\/verify#token=\S+)/.exec(text)?.[1];
  expect(link, text).toBeTruthy();
  return link;
}

/** A browser with no account and no session. */
async function guest(browser) {
  const context = await browser.newContext({ baseURL: ORIGIN });
  return context.newPage();
}

/** The signed-out request form, filled and sent. */
async function sendRequest(page, { email, subject, topic = 'Something else' }) {
  if (!page.url().endsWith('/support/new')) await page.goto('/support/new');
  const form = page.getByTestId('support-guest-new');
  await form.getByLabel('Your email address').fill(email);
  await form.getByRole('combobox', { name: 'Topic' }).selectOption({ label: topic });
  await form.getByLabel('Subject', { exact: true }).fill(subject);
  await form.getByLabel('What happened').fill(`TEST ${J} ${RUN}: I cannot get into my account.`);
  await form.getByRole('button', { name: 'Send request' }).click();
  return form;
}

/** Every request the support lead can see whose subject holds this text. */
async function deskRequests(text, filter) {
  const res = await asDesk('lead', 'query', 'listAll', { limit: 500, q: text, ...(filter ? { filter } : {}) });
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return res.json.result.data.filter((row) => row.subject.includes(text));
}

/** Opens the emailed link and presses Open; the request page it lands on. */
async function openLink(page, link) {
  await page.goto(link);
  const verify = page.getByTestId('support-guest-verify');
  await expect(verify.getByRole('heading', { name: 'Open your request' })).toBeVisible();
  await verify.getByRole('button', { name: 'Open my request' }).click();
  await expect(page).toHaveURL(/\/support\/guest\/request$/);
  const ticket = page.getByTestId('support-guest-ticket');
  await expect(ticket).toBeVisible({ timeout: 15_000 });
  return ticket.getAttribute('data-ticket-id');
}

test(`${J} #1 /support/new signed out is the same request form with an email field`, async ({ browser }) => {
  state.reset({});
  const page = await guest(browser);
  await page.goto('/support/new');
  const form = page.getByTestId('support-guest-new');
  await expect(form.getByRole('heading', { name: 'New request' })).toBeVisible();
  await expect(form.getByLabel('Your email address')).toBeVisible();
  // The signed-in form's own fields, under the same labels.
  await expect(form.getByRole('combobox', { name: 'Topic' })).toBeVisible();
  await expect(form.getByLabel('Subject', { exact: true })).toBeVisible();
  await expect(form.getByLabel('What happened')).toBeVisible();
  await expect(page.getByText('Sign in to continue')).toHaveCount(0);
});

test(`${J} #2 sending it shows "check your email" and opens no request yet`, async ({ browser }) => {
  const page = await guest(browser);
  const email = address('main');
  const subject = `TEST ${J} ${RUN} main`;
  await sendRequest(page, { email, subject });
  const sent = page.getByTestId('support-guest-check-email');
  await expect(sent.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(sent).toContainText(email);
  // The link went out, and no request exists until it is used.
  const link = await mailedLink(email);
  expect(link.startsWith(`${ORIGIN}/support/guest/verify#token=`)).toBe(true);
  expect(await deskRequests(subject)).toHaveLength(0);
  state.write({ email, subject, link });
});

test(`${J} #3 with no email sender, the send says so with vendor.email and the request waits`, async ({ browser }) => {
  // Two restarts of svc-support fit in this step's own limit.
  test.setTimeout(240_000);
  const email = address('nosender');
  const subject = `TEST ${J} ${RUN} no sender`;
  restartWith('support', 'LOCAL_STACK_SUPPORT_GUEST_MAIL', false);
  let restored = false;
  try {
    const page = await guest(browser);
    const form = await sendRequest(page, { email, subject });
    const off = form.getByTestId('support-guest-not-connected');
    await expect(off).toContainText('A verification email needs an email delivery provider. It is switched off in this build.');
    await expect(off.locator('[data-not-connected="vendor.email"]')).toBeVisible();
    expect(guestMail(email)).toHaveLength(0);
    expect(await deskRequests(subject)).toHaveLength(0);
    // The request was kept, waiting: once a sender exists, sending the same form again mails that request's link.
    restartWith('support', 'LOCAL_STACK_SUPPORT_GUEST_MAIL', true);
    restored = true;
    await form.getByRole('button', { name: 'Send request' }).click();
    await expect(page.getByTestId('support-guest-check-email')).toBeVisible({ timeout: 15_000 });
    await mailedLink(email);
  } finally {
    if (!restored) restartWith('support', 'LOCAL_STACK_SUPPORT_GUEST_MAIL', true);
  }
});

test(`${J} #4 the emailed link opens one request, and opening it again opens the same one`, async ({ browser }) => {
  const { link, subject } = state.read();
  expect(link, 'step 2 sent no link').toBeTruthy();
  const page = await guest(browser);
  const first = await openLink(page, link);
  await expect(page.getByRole('heading', { name: subject })).toBeVisible();
  const second = await openLink(await guest(browser), link);
  expect(second).toBe(first);
  const made = await deskRequests(subject);
  expect(made).toHaveLength(1);
  expect(made[0].id).toBe(first);
  state.write({ ticketId: first });
});

test(`${J} #5 too many requests from one address are refused with no request stored; a blank limit names the setting`, async ({
  browser,
}) => {
  // Two restarts of svc-support fit in this step's own limit.
  test.setTimeout(240_000);
  const email = address('busy');
  const page = await guest(browser);
  // The stack's TEST limit is three per address per hour.
  for (let n = 1; n <= 3; n += 1) {
    await sendRequest(page, { email, subject: `TEST ${J} ${RUN} busy ${n}` });
    await expect(page.getByTestId('support-guest-check-email')).toBeVisible();
    await page.getByRole('button', { name: 'Send another request' }).click();
  }
  const form = await sendRequest(page, { email, subject: `TEST ${J} ${RUN} busy 4` });
  const refused = form.getByTestId('support-guest-refusal');
  await expect(refused).toHaveAttribute('data-code', 'support.guest_rate_limited');
  await expect(refused).toContainText('This address has sent too many requests.');
  await mailedLink(email, 3);
  expect(guestMail(email)).toHaveLength(3);
  // With the owner's limit blank, every guest request refuses and names the setting.
  restartWith('support', 'LOCAL_STACK_SUPPORT_GUEST_RATE', false);
  try {
    const blank = await guest(browser);
    const other = address('unset');
    const unset = (await sendRequest(blank, { email: other, subject: `TEST ${J} ${RUN} unset` })).getByTestId('support-guest-refusal');
    await expect(unset).toHaveAttribute('data-code', 'support.guest_rate_limit_unset');
    await expect(unset).toContainText('SUPPORT_GUEST_RATE_LIMIT is not set');
    expect(guestMail(other)).toHaveLength(0);
  } finally {
    restartWith('support', 'LOCAL_STACK_SUPPORT_GUEST_RATE', true);
  }
});

test(`${J} #6 the guest reads and replies through the link on that one request; the link is not a sign-in`, async ({ browser }) => {
  const { link, subject, ticketId } = state.read();
  expect(ticketId, 'step 4 opened no request').toBeTruthy();
  const page = await guest(browser);
  // The page's own calls carry the access token; keep the last one to try it elsewhere.
  let access = null;
  page.on('request', (request) => {
    if (request.url().includes('/support/trpc/guestThread')) access = JSON.parse(request.postData() ?? '{}').access ?? access;
  });
  await openLink(page, link);
  const room = page.getByTestId('support-guest-request');
  await expect(room.getByRole('heading', { name: subject })).toBeVisible();
  await expect(room.getByTestId('support-guest-not-a-sign-in')).toContainText('It does not sign you in.');
  const reply = `TEST ${J} ${RUN} guest reply`;
  await room.getByLabel('Your reply').fill(reply);
  await room.getByRole('button', { name: 'Send reply' }).click();
  await expect(room.getByTestId('support-guest-reply-note')).toHaveText('Reply sent.');
  await expect(room.getByTestId('support-guest-thread')).toContainText(reply);
  // The team sees the reply on that request.
  const thread = await asDesk('lead', 'query', 'listComments', { ticketId, limit: 100 });
  expect(thread.json.result.data.map((comment) => comment.body)).toContain(reply);
  // The link is not a session: the account pages ask to sign in, and the token is refused as one.
  await page.goto('/support/tickets');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();
  expect(access, 'the request page sent no access token').toBeTruthy();
  const mine = await fetch(`${ORIGIN}/api/support/trpc/listMine?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`, {
    headers: { authorization: `Bearer ${access}` },
  });
  expect(mine.status).toBe(401);
});

test(`${J} #7 an expired link is refused as expired, with a way back to the form`, async ({ browser }) => {
  test.setTimeout(240_000);
  const email = address('expired');
  const before = process.env.LOCAL_STACK_SUPPORT_GUEST_LINK_TTL;
  // Links last one minute for this step only.
  process.env.LOCAL_STACK_SUPPORT_GUEST_LINK_TTL = '1';
  try {
    tool('local-test-stack.mjs', 'restart', 'support');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_SUPPORT_GUEST_LINK_TTL;
    else process.env.LOCAL_STACK_SUPPORT_GUEST_LINK_TTL = before;
  }
  try {
    const page = await guest(browser);
    await sendRequest(page, { email, subject: `TEST ${J} ${RUN} expired` });
    await expect(page.getByTestId('support-guest-check-email')).toBeVisible();
    const link = await mailedLink(email);
    await page.waitForTimeout(65_000);
    await page.goto(link);
    await page.getByRole('button', { name: 'Open my request' }).click();
    const dead = page.getByTestId('support-guest-link-dead');
    await expect(page.getByRole('heading', { name: 'This link has expired' })).toBeVisible();
    await expect(dead).toHaveAttribute('data-code', 'support.guest_link_expired');
    await page.getByTestId('support-guest-back').click();
    await expect(page).toHaveURL(/\/support\/new$/);
    await expect(page.getByTestId('support-guest-new')).toBeVisible();
  } finally {
    tool('local-test-stack.mjs', 'restart', 'support');
  }
});

test(`${J} #8 a fraud report lands in the compliance group, not in the general queue`, async ({ browser }) => {
  const compliance = await ensureDeskGroup('TEST Compliance');
  const email = address('fraud');
  const subject = `TEST ${J} ${RUN} fraud`;
  const page = await guest(browser);
  await sendRequest(page, { email, subject, topic: 'Report fraud on my account' });
  await expect(page.getByTestId('support-guest-check-email')).toBeVisible();
  const ticketId = await openLink(page, await mailedLink(email));
  // In the compliance group the owner named.
  const grouped = await deskRequests(subject, { field: 'group', op: 'eq', value: compliance.id });
  expect(grouped.map((row) => row.id)).toEqual([ticketId]);
  // Not among the ungrouped requests of the general queue, and not in an agent's list outside that group.
  expect(await deskRequests(subject, { field: 'group', op: 'eq', value: null })).toHaveLength(0);
  const agent = await asDesk('agent', 'query', 'listAll', { limit: 500, q: subject });
  expect(agent.status, agent.text.slice(0, 300)).toBe(200);
  expect(agent.json.result.data.map((row) => row.id)).not.toContain(ticketId);
});
