import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-campaigns-05, in the running app (docs/roadmap/journeys.json): I get my referral link and bring a friend. One test
// per step, titled "J-campaigns-05 #<n>", run in order. The referrer is a verified TEST account; the friend signs up from
// the link in a browser of their own. The stack's TEST attach window (IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS, ten
// minutes) and code length are labelled TEST values in tooling/profiles/test-owner-values.json.
// Not here yet: #2 (a signed, tracked share tag per surface), #5 (the rebind offer after the window), #6 (the reviewed
// rebind) and #7 (the relationship lapse); their slices come next.
const J = 'J-campaigns-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

/** The invitation link the page shows, and its token. */
async function shownLink(page) {
  const field = page.getByLabel('Invitation link · private');
  await expect(field).toHaveValue(/\/invite\?token=[0-9a-f-]{36}$/);
  const href = await field.inputValue();
  return { href, token: new URL(href).searchParams.get('token') };
}

/** A person's own identity procedure through Edge (their own session, not the browser's). */
async function identity(who, procedure, input = {}) {
  const res = await (await api(who)).post(`/api/identity/trpc/${procedure}`, input);
  return {
    status: res.status,
    data: res.body?.result?.data,
    code: res.body?.error?.data?.intafacedCode ?? res.body?.error?.data?.cause?.code ?? res.body?.error?.data?.code,
  };
}

/** Opens an invitation link signed in as the page's person, reviews it and accepts; returns the outcome card. */
async function accept(page, token) {
  await page.goto(`/invite?token=${token}`);
  await page.getByRole('button', { name: 'Review invitation' }).click();
  await page.getByRole('button', { name: 'Accept this invitation' }).click();
  return page
    .locator('section.invitation__card')
    .filter({ has: page.locator('h2.invitation__outcome') })
    .last();
}

test(`${J} #1 my referral code and link, with copy`, async ({ page, context }) => {
  run.reset({});
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  const referrer = await signUp(page, 'jc5r');
  await verify(page, referrer);
  run.write({ referrer });
  await signIn(page, referrer);
  await page.goto('/uc/promotion/mycards');

  await page.getByRole('button', { name: 'Review link request' }).click();
  await page.getByRole('button', { name: 'Get or create link' }).click();
  const { href, token } = await shownLink(page);
  expect(href.startsWith(`${ORIGIN}/invite?token=`)).toBe(true);
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('Invitation link copied.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(href);

  const codeCard = page.getByRole('region', { name: 'Your referral code' });
  await expect(codeCard.getByText('No referral code yet')).toBeVisible();
  await codeCard.getByRole('button', { name: 'Get my referral code' }).click();
  const code = (await codeCard.getByTestId('referral-code').innerText()).trim();
  expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
  await codeCard.getByRole('button', { name: 'Copy code' }).click();
  await expect(codeCard.getByText('Referral code copied.')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);

  // The same code comes back after a reload and through the person's own API: one code per account.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Your referral code' }).getByTestId('referral-code')).toHaveText(code);
  expect((await identity(referrer, 'affiliates.createCode')).data.code).toBe(code);
  run.write({ token, code });
});

test(`${J} #3 revoking the link refuses its later opens; creating again gives a new token`, async ({ page }) => {
  const { referrer, token } = state('referrer', 'token');
  await signIn(page, referrer);
  await page.goto('/uc/promotion/mycards');
  await page.getByRole('button', { name: 'Review link request' }).click();
  await page.getByRole('button', { name: 'Get or create link' }).click();
  expect((await shownLink(page)).token).toBe(token);
  await page.getByRole('button', { name: 'Review revocation' }).click();
  await page.getByRole('button', { name: 'Revoke current account link' }).click();
  await expect(page.getByText('Service reported revocation')).toBeVisible();

  // A later open of the old link, signed out, is refused by name and counts no visit.
  const opened = await fetch(`${EDGE}/api/identity/trpc/affiliates.shareHits`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  expect(opened.status).toBe(403);
  expect(opened.body.error.message).toContain('share.revoked');

  await page.goto('/uc/promotion/mycards');
  await page.getByRole('button', { name: 'Review link request' }).click();
  await page.getByRole('button', { name: 'Get or create link' }).click();
  const next = await shownLink(page);
  expect(next.token).not.toBe(token);
  run.write({ token: next.token, revokedToken: token });
});

test(`${J} #4 my friend signs up from the link and is attached to me once`, async ({ browser, page }) => {
  const { referrer, token, revokedToken } = state('referrer', 'token', 'revokedToken');
  const me = await identity(referrer, 'affiliates.createShare');
  expect(me.data.token).toBe(token);
  const referrerId = me.data.referrerId;

  // The friend opens the link signed out, creates an account from it and lands back on the invitation.
  const friendContext = await browser.newContext();
  const friendPage = await friendContext.newPage();
  await friendPage.goto(`/invite?token=${token}`);
  await expect(friendPage.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', `/register?invite=${token}`);
  const friend = await signUp(friendPage, 'jc5f');
  run.write({ friend });
  await friendPage.goto(`/invite?token=${token}`);
  await expect(
    friendPage.getByRole('status').filter({ hasText: 'can still attach a referrer through an invitation link until' }),
  ).toBeVisible();
  let outcome = await accept(friendPage, token);
  await expect(outcome.getByRole('heading', { name: /Referral status\s*recorded\./ })).toBeVisible();

  // The relationship screen shows the referrer and the date.
  await friendPage.getByRole('button', { name: 'Read current status' }).click();
  await expect(friendPage.getByText('A referral is recorded now')).toBeVisible();
  await expect(friendPage.locator('.invitation__current dd').first()).toHaveText(referrerId);
  const edge = (await (await api(friend)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data;
  expect(edge.referrerId).toBe(referrerId);
  await expect(friendPage.locator('.invitation__current time')).toHaveAttribute('datetime', edge.attributedAt);

  // Opening the same link again is the same relationship, not a second one.
  const again = await identity(friend, 'affiliates.shareHits', { token });
  expect(again.data.attributed).toBe(true);
  // A revoked link stays refused for the friend too.
  expect((await identity(friend, 'affiliates.shareHits', { token: revokedToken })).code).toBe('share.revoked');

  // A second attach, to someone else's link, is refused by name.
  const otherContext = await browser.newContext();
  const otherPage = await otherContext.newPage();
  const other = await signUp(otherPage, 'jc5o');
  await otherContext.close();
  const otherLink = await identity(other, 'affiliates.createShare');
  outcome = await accept(friendPage, otherLink.data.token);
  await expect(outcome.getByRole('heading', { name: /Visit recorded\.\s*No referral attached\./ })).toBeVisible();
  await expect(outcome.getByText('Your account already has a referrer from another invitation.', { exact: false })).toBeVisible();
  await expect(outcome.getByText('HTTP 409 · referral.already_set')).toBeVisible();
  expect((await (await api(friend)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data.referrerId).toBe(referrerId);
  await friendContext.close();

  // A self-referral and a cycle are refused by name for the referrer.
  await signIn(page, referrer);
  outcome = await accept(page, token);
  await expect(outcome.getByText('This is your own invitation link. You cannot refer yourself.')).toBeVisible();
  await expect(outcome.getByText('HTTP 409 · referral.self')).toBeVisible();
  const friendLink = await identity(friend, 'affiliates.createShare');
  outcome = await accept(page, friendLink.data.token);
  await expect(outcome.getByText('This person is already in your own referral chain', { exact: false })).toBeVisible();
  await expect(outcome.getByText('HTTP 409 · referral.cycle')).toBeVisible();
  expect((await (await api(referrer)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data).toBeNull();
});
