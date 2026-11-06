import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { existsSync, readFileSync as readText } from 'node:fs';
import { ORIGIN, ROOT, api, fund, mailedLines, restartWith, signOutBrowser, signUpInBrowser, stackFile } from './stack.mjs';
import { asDesk } from './help-centre.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-identity-13, in the running app (docs/roadmap/journeys.json): I think my account was compromised. Tests titled
// "J-identity-13 #<n>" prove a whole step. #3 to #6 follow one TEST person in order (their case, their freeze, their
// checklist), so the file runs serially and a step whose earlier step left nothing stops at once.
const J = 'J-identity-13';

test.describe.configure({ mode: 'serial' });

/** The TEST official channel list on the stack's support service (SUPPORT_OFFICIAL_CHANNELS). */
const CHANNELS = (() => {
  const raw = JSON.parse(readFileSync(new URL('../../../../tooling/profiles/test-owner-values/support.json', import.meta.url), 'utf8'));
  return JSON.parse(raw.values.SUPPORT_OFFICIAL_CHANNELS.value);
})();

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
const query = (route, input) => `${route}?input=${encodeURIComponent(JSON.stringify(input))}`;
const codeOn = (res) =>
  res.body?.error?.data?.intafacedCode ?? res.body?.error?.data?.code ?? res.body?.code ?? res.body?.error?.code ?? null;
const STATUS = '/api/identity/trpc/accountStatus.mine';
const CASE = '/api/identity/trpc/account.compromised.mine';

function person(prefix) {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

// The person #3 to #6 follow, with their authenticator, kept in this worker's memory only.
const s = {};
function need(...keys) {
  for (const key of keys) if (s[key] === undefined) throw new Error(`an earlier step left no ${key}`);
}

/** A fresh authenticator code for the person, never a step already used. */
async function code() {
  const { totp } = await totpLib();
  const next = await nextCode(totp, s.secret, s.step);
  s.step = next.step;
  return next.code;
}

/** Signs the person in on the page with their password and a fresh authenticator code. */
async function signInWithCode(page) {
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  await page.goto('/login');
  await page.fill('input[name=totp]', await code());
  await page.fill('input[name=identifier]', s.who.email);
  await page.fill('input[name=password]', s.who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

/** The person's open case, as identity answers it to them. */
async function caseOf(session) {
  const read = await session.get(CASE);
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  return read.body.result.data.case;
}

const checklistItem = (page, item) => page.getByTestId('compromised__checklist').locator(`li[data-item="${item}"]`);

test(`${J} #1 the official channels page says whether a domain is on the published list, and the scam guides open; with no list published the page says so and checks nothing`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const [domain] = CHANNELS.domains;
  const [sender] = CHANNELS.senders;
  expect(domain, 'the TEST list names a domain').toBeTruthy();

  // Security links to the page, where a signed-in person starts.
  await signUpInBrowser(page, person('jo'));
  await page.goto('/uc/safe');
  await page.getByTestId('security__checklist').getByRole('link', { name: 'Official channels and scam guides' }).click();
  await expect(page).toHaveURL(/\/help\/official-channels$/);
  const room = page.getByTestId('official-channels');
  await expect(room.getByRole('heading', { level: 1 })).toHaveText('Official channels');
  // The list is the owner's (on this stack a TEST list, labelled so).
  await expect(room.getByTestId('official-channels__list')).toContainText(domain);
  await expect(room.getByTestId('official-channels__list')).toContainText(sender);
  await expect(room.getByTestId('official-channels__test')).toBeVisible();

  const check = async (value) => {
    await room.getByLabel('Domain or sender address').fill(value);
    await room.getByRole('button', { name: 'Check' }).click();
    return room.getByTestId('official-channels__result');
  };
  // A listed domain, typed with a different case and a trailing dot: official.
  let result = await check(`${domain.toUpperCase()}.`);
  await expect(result).toHaveAttribute('data-verdict', 'official');
  await expect(result).toContainText(`${domain} is on our official list.`);
  // The listed sender address: official.
  result = await check(sender);
  await expect(result).toHaveAttribute('data-verdict', 'official');
  // A lookalike (one letter more, or the name under another domain): not on the list, never called safe or unsafe.
  const lookalike = domain.replace(/^([^.]+)/, '$1s');
  result = await check(lookalike);
  await expect(result).toHaveAttribute('data-verdict', 'not_listed');
  await expect(result).toContainText(`${lookalike} is not on our official list.`);
  result = await check(`login.${domain}.example.invalid`);
  await expect(result).toHaveAttribute('data-verdict', 'not_listed');
  await expect(result).not.toContainText(/\bsafe\b/i);

  // The scam guides: each opens its article.
  const guides = room.getByTestId('official-channels__guides');
  await expect(guides.getByRole('link')).toHaveText([
    'How scams work',
    'Spoofed text messages',
    'Unknown tokens and dust in your wallet',
    'If your email may be compromised',
  ]);
  await guides.getByRole('link', { name: 'Spoofed text messages' }).click();
  await expect(page).toHaveURL(/\/helpdetail\?id=kb-security-spoofed-sms$/);
  await expect(page.getByRole('heading', { name: 'Spoofed text messages' })).toBeVisible();
  await expect(page.getByText('We never ask for a verification code by text or phone.')).toBeVisible();

  // With no list published, the page says so, and the check box takes nothing.
  restartWith('support', 'SUPPORT_OFFICIAL_CHANNELS', false);
  try {
    await page.goto('/help/official-channels');
    await expect(room.getByTestId('official-channels__unpublished')).toHaveText('The owner has not published the official channel list.');
    await expect(room.getByLabel('Domain or sender address')).toBeDisabled();
    await expect(room.getByRole('button', { name: 'Check' })).toBeDisabled();
    await expect(room.getByTestId('official-channels__list')).toHaveCount(0);
    await expect(room.getByTestId('official-channels__result')).toHaveCount(0);
    // The guides do not depend on the list.
    await expect(room.getByTestId('official-channels__guides').getByRole('link')).toHaveCount(4);
  } finally {
    restartWith('support', 'SUPPORT_OFFICIAL_CHANNELS', true);
  }
  await page.goto('/help/official-channels');
  await expect(room.getByTestId('official-channels__list')).toContainText(domain);
});

test(`${J} #2 a phishing report signed in or out is a ticket in the phishing category; signed out it is rate limited; an oversize paste is refused with the cap`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const headers = `Received: from mail.example.invalid\nFrom: "Support" <help@lookalike.example.invalid>\nSubject: TEST verify your account`;

  // Signed in: Security has the report button, and it opens a request already set to a scam report.
  const page = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const who = person('jp');
  await signUpInBrowser(page, who);
  await page.goto('/uc/safe');
  await page.getByRole('link', { name: 'Report a scam message' }).click();
  await expect(page).toHaveURL(/\/support\/new\?topic=phishing$/);
  await expect(page.getByRole('combobox', { name: 'Topic' })).toHaveValue('phishing');
  await expect(page.getByRole('note')).toContainText('Do not click links, open attachments or reply to the message.');
  await page.getByLabel('Subject', { exact: true }).fill('TEST a mail asked for my password');
  await page.getByLabel('What happened').fill('TEST a mail that looks like yours asked me to sign in on another site.');

  // An oversize paste is refused with the cap, and nothing is sent.
  const field = page.getByLabel('Message headers (optional)');
  await field.fill('x'.repeat(10_001));
  await expect(page.getByTestId('support__headers-cap')).toHaveText(
    'Message headers can be at most 10,000 characters. This paste is 10,001. Nothing was sent.',
  );
  await expect(page.getByRole('button', { name: 'Review request' })).toBeDisabled();
  const session = await api(who);
  const tooLong = await session.post('/api/support/trpc/create', {
    category: 'phishing',
    subject: 'TEST oversize',
    body: 'TEST oversize headers',
    messageHeaders: 'x'.repeat(10_001),
  });
  expect(tooLong.status, JSON.stringify(tooLong.body).slice(0, 300)).toBe(400);
  expect(codeOn(tooLong)).toBe('support.headers_too_long');
  expect(JSON.stringify(tooLong.body)).toContain('10000');

  await field.fill(headers);
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Request created')).toBeVisible();
  const mine = await session.get(query('/api/support/trpc/listMine', { limit: 100 }));
  expect(mine.status).toBe(200);
  const reported = mine.body.result.data.filter((ticket) => ticket.subject === 'TEST a mail asked for my password');
  expect(reported.map((ticket) => ticket.category)).toEqual(['phishing']);
  expect(mine.body.result.data.filter((ticket) => ticket.subject === 'TEST oversize')).toEqual([]);

  // Signed out: the guest form takes the same report, headers included, and the mailed link opens one phishing ticket.
  const guest = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const email = `${person('jq').handle}@local-test.invalid`;
  const run = randomBytes(3).toString('hex');
  async function guestSend(subject) {
    await guest.goto('/support/new?topic=phishing');
    const form = guest.getByTestId('support-guest-new');
    await form.getByLabel('Your email address').fill(email);
    await expect(form.getByRole('combobox', { name: 'Topic' })).toHaveValue('phishing');
    await form.getByLabel('Subject', { exact: true }).fill(subject);
    await form.getByLabel('What happened').fill('TEST a text message asked for my code.');
    await form.getByLabel('Message headers (optional)').fill(headers);
    await form.getByRole('button', { name: 'Send request' }).click();
  }
  await guestSend(`TEST ${run} guest phishing 1`);
  await expect(guest.getByTestId('support-guest-check-email')).toBeVisible();
  const guestMail = () => {
    const file = stackFile('status-mail-outbox.log');
    if (!existsSync(file)) return [];
    return readText(file, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('LOCAL-TEST '))
      .map((line) => JSON.parse(line.slice('LOCAL-TEST '.length)))
      .filter((mail) => mail.purpose === 'guest-verify' && mail.to === email);
  };
  await expect.poll(() => guestMail().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  const link = /(http\S+\/support\/guest\/verify#token=\S+)/.exec(guestMail().at(-1).text)?.[1];
  expect(link).toBeTruthy();
  await guest.goto(link);
  await guest.getByTestId('support-guest-verify').getByRole('button', { name: 'Open my request' }).click();
  await expect(guest.getByTestId('support-guest-ticket')).toBeVisible({ timeout: 15_000 });
  // The support desk holds it as a phishing report, with the pasted headers.
  const desk = await asDesk('lead', 'query', 'listAll', { limit: 500, q: `TEST ${run} guest phishing 1` });
  expect(desk.status, desk.text.slice(0, 300)).toBe(200);
  const held = desk.json.result.data.filter((row) => row.subject === `TEST ${run} guest phishing 1`);
  expect(held.map((row) => [row.category, row.messageHeaders])).toEqual([['phishing', headers]]);

  // The TEST limit is 3 requests an hour per address: the next two are taken, the one after is refused by name.
  await guestSend(`TEST ${run} guest phishing 2`);
  await expect(guest.getByTestId('support-guest-check-email')).toBeVisible();
  await guestSend(`TEST ${run} guest phishing 3`);
  await expect(guest.getByTestId('support-guest-check-email')).toBeVisible();
  await guestSend(`TEST ${run} guest phishing 4`);
  await expect(guest.getByTestId('support-guest-refusal')).toHaveAttribute('data-code', 'support.guest_rate_limited');
});

test(`${J} #3 "my account is compromised" ends every session and key, freezes the account and opens one case; pressing again returns the same case`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { totp } = await totpLib();
  // A verified person with a live key and a second sign-in, and an authenticator (the lift and the code need one).
  const { page, who } = await keyHolder(browser, 'jc');
  s.who = who;
  s.page = page;
  const key = await makeKey(page, { name: 'compromised', preset: 'Read only' });
  const before = await api(who);
  expect((await withKey(key, { path: STATUS })).status).toBe(200);
  const added = await addAuthenticator(page, totp);
  s.secret = added.secret;
  s.step = added.step;
  // TEST funds, so #5 can show the report moves none.
  expect(fund(who.email, 'USDT', '250').tx).toBeTruthy();
  expect((await caseOf(before)) ?? null).toBeNull();

  // From Security, the person opens the guided page and confirms with their password.
  await page.goto('/uc/safe');
  await page.getByRole('link', { name: 'My account is compromised' }).click();
  await expect(page).toHaveURL(/\/uc\/safe\/compromised$/);
  const room = page.getByTestId('compromised');
  await expect(room.getByRole('heading', { level: 1 })).toHaveText('My account is compromised');
  await expect(room.getByTestId('compromised__what')).toContainText('Every sign-in and every API key ends, this one too.');
  await expect(room.getByTestId('compromised__what')).toContainText('Your account is frozen, so no money can leave it.');
  await expect(room).not.toContainText(/recover your funds|get your money back/i);
  await room.getByLabel('Your password').fill(who.password);
  const startedAt = Date.now();
  await room.getByRole('button', { name: 'Secure my account now' }).click();
  await expect(
    page.getByRole('heading', { name: 'Your account is secured' }).or(page.getByRole('heading', { name: 'Sign in to continue' })),
  ).toBeVisible();

  // No session and no key remain (Edge may hold a session's authority for its cache window, so it is waited out once).
  const { EDGE_AUTHORITY_CACHE_MAX_MS } = await import(path.join(ROOT, 'tooling/scripts/local-test-gates.mjs'));
  await new Promise((resolve) => setTimeout(resolve, EDGE_AUTHORITY_CACHE_MAX_MS + 100));
  expect((await before.get(STATUS)).status).toBe(401);
  const oldKey = await withKey(key, { path: STATUS });
  expect(oldKey.status).toBe(401);
  expect(codeOn(oldKey)).toBe('edge.api_key_revoked');

  // Signed in again: the account is frozen by its owner, for a compromise, and one case is open.
  const after = await api(who, { totpCode: await code() });
  s.session = after;
  const status = (await after.get(STATUS)).body.result.data;
  expect(status.state).toBe('frozen_self');
  expect(status.restrictions.map((restriction) => restriction.kind)).toEqual(['self_freeze']);
  const opened = await caseOf(after);
  expect(opened).not.toBeNull();
  expect(Date.parse(opened.openedAt)).toBeGreaterThanOrEqual(startedAt - 5_000);
  expect(opened.sessionsEnded).toBeGreaterThanOrEqual(2);
  expect(opened.keysEnded).toBe(1);
  s.caseId = opened.id;
  const keys = (await after.get(query('/api/identity/trpc/apiKeys.list', { limit: 200 }))).body.result.data;
  expect(keys.filter((record) => record.name === 'compromised').map((record) => record.revoked)).toEqual([true]);

  // Pressing again returns the same case and ends nothing more.
  const again = await after.post('/api/identity/trpc/account.compromised.start', { password: who.password });
  expect(again.status, JSON.stringify(again.body).slice(0, 300)).toBe(200);
  expect(again.body.result.data.caseId).toBe(s.caseId);
  expect(again.body.result.data.changed).toBe(false);
  expect((await after.get(STATUS)).status).toBe(200);

  // The page shows the one case, from identity.
  await signInWithCode(page);
  await page.goto('/uc/safe/compromised');
  await expect(room.getByTestId('compromised__case')).toHaveAttribute('data-case-id', s.caseId);
  await expect(room.getByRole('button', { name: 'Secure my account now' })).toHaveCount(0);
});

test(`${J} #4 the checklist ticks itself when identity sees a password change and a device review`, async () => {
  test.setTimeout(300_000);
  need('who', 'page', 'caseId', 'secret');
  const { page, who } = s;
  const room = page.getByTestId('compromised');
  await page.goto('/uc/safe/compromised');
  await expect(checklistItem(page, 'password')).toHaveAttribute('data-done', 'false');
  await expect(checklistItem(page, 'devices')).toHaveAttribute('data-done', 'false');
  // Ending every key was part of securing the account, so that item is done already.
  await expect(checklistItem(page, 'api_keys')).toHaveAttribute('data-done', 'true');
  await expect(room.getByTestId('compromised__checklist').locator('li')).toHaveCount(5);

  // A password change waits for the freeze to end: the person reactivates from Security after the TEST wait.
  const opened = await caseOf(s.session);
  const due = Date.parse(opened.openedAt) + 21_000;
  if (Date.now() < due) await page.waitForTimeout(due - Date.now());
  await page.goto('/uc/safe');
  const frozen = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'You froze this account' }) });
  await frozen.getByRole('button', { name: 'Reactivate my account' }).click();
  const confirm = frozen.getByTestId('step-up-confirm');
  await confirm.getByLabel('Authenticator code').fill(await code());
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Your account is active again.')).toBeVisible();

  // The person changes their password in Security; nothing is ticked by hand.
  const password = page.getByTestId('security__password');
  const next = `TEST-${randomBytes(9).toString('base64url')}-4c`;
  await password.getByLabel('Current password').fill(who.password);
  await password.getByLabel('New password', { exact: true }).fill(next);
  await password.getByLabel('Repeat the new password').fill(next);
  await password.getByRole('button', { name: 'Change password' }).click();
  await expect(password).toContainText('Your password was changed');
  who.password = next;
  // A changed password may end this sign-in; the page is signed in again if so.
  await page.goto('/uc/safe/compromised');
  if (await page.getByRole('heading', { name: 'Sign in to continue' }).isVisible()) {
    await signInWithCode(page);
    await page.goto('/uc/safe/compromised');
  }
  await expect(checklistItem(page, 'password')).toHaveAttribute('data-done', 'true');
  await expect(checklistItem(page, 'devices')).toHaveAttribute('data-done', 'false');

  // The device review: the person goes through their devices and says they reviewed them.
  await checklistItem(page, 'devices').getByRole('link', { name: 'Review your devices' }).click();
  await expect(page.getByTestId('devices__compromise-review')).toBeVisible();
  await page.getByRole('button', { name: 'I reviewed these devices' }).click();
  await expect(page.getByTestId('devices__compromise-review')).toContainText('Reviewed');
  await page.goto('/uc/safe/compromised');
  await expect(checklistItem(page, 'devices')).toHaveAttribute('data-done', 'true');
  await expect(checklistItem(page, 'password')).toHaveAttribute('data-done', 'true');

  // Identity holds the same: the items were done by what it saw, with when.
  s.session = await api(who, { totpCode: await code() });
  const held = await caseOf(s.session);
  expect(held.id).toBe(s.caseId);
  const done = Object.fromEntries(held.checklist.map((item) => [item.item, item.doneAt !== null]));
  expect(done).toMatchObject({ password: true, devices: true, api_keys: true });
});

test(`${J} #5 a stolen-funds report is a case note and changes no balance`, async () => {
  test.setTimeout(120_000);
  need('who', 'page', 'caseId', 'session');
  const { page } = s;
  const before = await s.session.balances();
  expect(before.USDT?.total).toBe('250');

  await page.goto('/uc/safe/compromised');
  const report = page.getByTestId('compromised__stolen-funds');
  await expect(report).toContainText('This report is a note on your case. It moves no money and does not promise any back.');
  const text = `TEST 120 USDT left my account to an address I do not know (${randomUUID()}).`;
  await report.getByLabel('What happened').fill(text);
  await report.getByRole('button', { name: 'File the report' }).click();
  await expect(report.getByRole('status')).toHaveText('Report filed on your case.');
  await expect(page.getByTestId('compromised__notes').locator('li')).toContainText([text]);

  // Identity holds it as a note on the same case; a report sent again with the same request id is not a second note.
  const held = await caseOf(s.session);
  expect(held.id).toBe(s.caseId);
  expect(held.notes.filter((note) => note.body === text).map((note) => note.kind)).toEqual(['stolen_funds']);
  const clientRequestId = `j13-${randomUUID()}`;
  const once = await s.session.post('/api/identity/trpc/account.compromised.reportStolenFunds', { body: 'TEST once', clientRequestId });
  const twice = await s.session.post('/api/identity/trpc/account.compromised.reportStolenFunds', { body: 'TEST once', clientRequestId });
  expect(once.status, JSON.stringify(once.body).slice(0, 300)).toBe(200);
  expect(twice.body.result.data.noteId).toBe(once.body.result.data.noteId);
  expect((await caseOf(s.session)).notes.filter((note) => note.body === 'TEST once')).toHaveLength(1);

  // No balance moved.
  expect(await s.session.balances()).toEqual(before);
});

test(`${J} #6 the anti-phishing code set afterwards rides on the next security mail`, async ({ browser }) => {
  test.setTimeout(180_000);
  need('who', 'page', 'secret');
  const { page, who } = s;
  await page.goto('/uc/safe');
  const card = page.getByTestId('security__anti-phishing');
  const word = `Kite${randomBytes(3).toString('hex')}`;
  await card.getByRole('button', { name: 'Set a code' }).click();
  await card.getByLabel('New code (4 to 20 letters and digits)').fill(word);
  await card.getByLabel('6-digit code from your authenticator app').fill(await code());
  await card.getByRole('button', { name: 'Save with code' }).click();
  await expect(card.getByRole('status')).toHaveText('Anti-phishing code saved.');

  // The next security mail: a password reset asked for from a signed-out browser.
  const resets = mailedLines(who.email, 'password-reset').length;
  const out = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await out.goto('/findPwd');
  await out.getByLabel('Email address', { exact: true }).fill(who.email);
  await out.getByRole('button', { name: 'Send reset code' }).click();
  await expect(out.getByLabel('Code from the email')).toBeVisible();
  await expect.poll(() => mailedLines(who.email, 'password-reset').length, { timeout: 30_000 }).toBeGreaterThan(resets);
  expect(mailedLines(who.email, 'password-reset').at(-1)).toMatch(new RegExp(` anti_phishing=${word}$`));
});
