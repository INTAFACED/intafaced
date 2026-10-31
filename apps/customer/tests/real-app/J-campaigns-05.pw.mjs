import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { EDGE, ORIGIN, api, journeyState, mailedCodes, nextMailedCode, restartWith, tool, signOutBrowser } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-campaigns-05, in the running app (docs/roadmap/journeys.json): I get my referral link and bring a friend. One test
// per step, titled "J-campaigns-05 #<n>", run in order. The referrer is a verified TEST account; the friend signs up from
// the link in a browser of their own. The stack's TEST attach window (IDENTITY_REFERRAL_ATTACH_WINDOW_SECONDS, ten
// minutes) and code length are labelled TEST values in tooling/profiles/test-owner-values.json.
// The second person in #6 is one of the stack's two TEST operators (tooling/scripts/local-test-gates.mjs), signed in with
// a second factor, as the founder-ops desk would. #5 moves one TEST account's sign-up time back (`local-test-gates.mjs
// age`) instead of waiting out the window; the blank-window refusal is proved in svc-identity's referral-attach test,
// since the stack runs one owner value.
// #7 runs on the stack's TEST inactivity period (IDENTITY_REFERRAL_LAPSE_PERIOD_SECONDS, one hour) and sweep cadence (five
// seconds); `age` moves the friend's relationship back past the period instead of waiting an hour.
// Not here yet: #2 (a signed, tracked share tag per surface); its slice comes next.
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

/** The friend signs up from the invitation's own "Create account" link (details, then the mailed code) and lands back
 * on the invitation, as the sign-up page sends a person who came from one. */
async function signUpFromInvitation(page, token) {
  const handle = `jc5f${Date.now().toString(36)}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await page.goto(`/invite?token=${token}`);
  await page.getByRole('link', { name: 'Create account' }).click();
  await expect(page).toHaveURL(`/register?invite=${token}`);
  const seen = mailedCodes(who.email).length;
  await page.getByLabel('Email address').fill(who.email);
  await page.getByLabel('Handle').fill(who.handle);
  await page.getByLabel('Password').fill(who.password);
  await page.getByLabel('Country you live in').selectOption('DE');
  await page.getByLabel('Date of birth').fill('1990-05-01');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await page.getByLabel('Code from the email').fill(await nextMailedCode(who.email, seen));
  await page.getByRole('button', { name: 'Confirm and open my account' }).click();
  await expect(page).toHaveURL(`/invite?token=${token}`);
  return who;
}

/** Opens an invitation link signed in as the page's person, reviews it and accepts; returns the outcome card. */
async function accept(page, token) {
  await page.goto(`/invite?token=${token}`);
  await page.getByRole('button', { name: 'Review invitation' }).click();
  await page.getByRole('button', { name: 'Accept this invitation' }).click();
  return page
    .locator('section[data-testid="invitation__card"]')
    .filter({ has: page.locator('h2[data-testid="invitation__outcome"]') })
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

  // The friend opens the link signed out, creates an account from it and lands back on the invitation. The account is
  // made with the link's referrer (sign-up completion, outside the late-attach window); accepting confirms it.
  const friendContext = await browser.newContext();
  const friendPage = await friendContext.newPage();
  const friend = await signUpFromInvitation(friendPage, token);
  run.write({ friend });
  expect((await (await api(friend)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data.referrerId).toBe(referrerId);
  await expect(
    friendPage.getByRole('status').filter({ hasText: 'can still attach a referrer through an invitation link until' }),
  ).toBeVisible();
  let outcome = await accept(friendPage, token);
  await expect(outcome.getByRole('heading', { name: /Referral status\s*recorded\./ })).toBeVisible();

  // The relationship screen shows the referrer and the date.
  await friendPage.getByRole('button', { name: 'Read current status' }).click();
  await expect(friendPage.getByText('A referral is recorded now')).toBeVisible();
  await expect(friendPage.getByTestId('invitation__current').locator('dd').first()).toHaveText(referrerId);
  const edge = (await (await api(friend)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data;
  expect(edge.referrerId).toBe(referrerId);
  await expect(friendPage.getByTestId('invitation__current').locator('time')).toHaveAttribute('datetime', edge.attributedAt);

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

/** The stack's two TEST operators with live second-factor sessions (a and b). */
async function operators() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  return { ctx, ops: await gates.operatorSessions(ctx) };
}
const result = (res) => ({
  status: res.status,
  data: res.json?.result?.data,
  code: res.json?.error?.data?.cause?.code ?? res.json?.error?.data?.code,
});

test(`${J} #5 after the window: refused by name and offered a reviewed change`, async ({ page }) => {
  const { referrer, token } = state('referrer', 'token');
  const late = await signUp(page, 'jc5l');
  // Time passes for this TEST account only: its sign-up moves back an hour, past the stack's ten-minute TEST window.
  expect(tool('local-test-gates.mjs', 'age', late.handle, '3600')).toContain('LOCAL TEST');
  run.write({ late });
  await signOutBrowser(page.context());
  await signIn(page, late);

  const outcome = await accept(page, token);
  await expect(outcome.getByRole('heading', { name: /Visit recorded\.\s*No referral attached\./ })).toBeVisible();
  await expect(outcome.getByText('The time to join through an invitation link has passed for your account.')).toBeVisible();
  await expect(outcome.getByText('HTTP 403 · referral.attach_window_closed')).toBeVisible();
  await expect(page.locator('[data-window="closed"]')).toBeVisible();
  expect((await (await api(late)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data).toBeNull();

  // The offer: a reason, then a request a second person reviews. Nothing changes yet.
  const change = page.getByRole('region', { name: 'Referrer change review' });
  await expect(change.getByText('No referrer change request on this account.')).toBeVisible();
  await change
    .getByLabel('Why should the person who sent this link become your referrer?')
    .fill('TEST: the link reached me after I signed up');
  await change.getByRole('button', { name: 'Request a review' }).click();
  await expect(change.locator('[data-rebind="under_review"]')).toContainText('waiting for a second person to review it');
  const referrerId = (await identity(referrer, 'affiliates.createShare')).data.referrerId;
  await expect(change.locator('dd[data-testid="invitation__private"]')).toHaveText(referrerId);
  await expect(change.getByRole('button', { name: 'Request a review' })).toHaveCount(0);

  // Asking again for the same link is the same request; nothing is attached until the review.
  const again = await identity(late, 'affiliates.requestRebind', { token, reason: 'TEST: asking again' });
  const mine = (await (await api(late)).get('/api/identity/trpc/affiliates.myRebind')).body.result.data;
  expect(again.data.requestId).toBe(mine.requestId);
  expect((await (await api(late)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data).toBeNull();
  run.write({ requestId: mine.requestId, referrerId });

  // With no window set at all, a new account inside any window is refused by that name, never as "too late".
  await signOutBrowser(page.context());
  const unsetWho = await signUp(page, 'jc5u');
  restartWith('identity', 'LOCAL_STACK_IDENTITY_REFERRAL_WINDOW', false);
  try {
    await signOutBrowser(page.context());
    await signIn(page, unsetWho);
    const unset = await accept(page, token);
    await expect(unset.getByRole('heading', { name: /Visit recorded\.\s*No referral attached\./ })).toBeVisible();
    await expect(
      unset.getByText('Joining through an invitation link is closed: the owner has not set how long after sign-up it is allowed.'),
    ).toBeVisible();
    await expect(unset.getByText('HTTP 412 · referral.attach_window_unset')).toBeVisible();
    await expect(unset.getByText('The time to join through an invitation link has passed for your account.')).toHaveCount(0);
    await expect(page.locator('[data-window="unset"]')).toBeVisible();
    const direct = await identity(unsetWho, 'affiliates.shareHits', { token });
    expect(direct.code).toBe('referral.attach_window_unset');
    expect((await (await api(unsetWho)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data).toBeNull();
  } finally {
    restartWith('identity', 'LOCAL_STACK_IDENTITY_REFERRAL_WINDOW', true);
  }
});

test(`${J} #6 a second person approves; the new parent applies from then; approving my own is refused`, async ({ page }) => {
  const { late, token, requestId, referrerId } = state('late', 'token', 'requestId', 'referrerId');
  // The person cannot decide their own request.
  expect((await identity(late, 'affiliates.decideRebind', { requestId, decision: 'approve', reason: 'TEST self' })).status).toBe(403);

  const { ctx, ops } = await operators();
  // An operator who asks for a change of their own cannot approve it either: a second person must.
  const opA = ops.a;
  const own = result(await ctx.edge.query('identity', 'affiliates.myRebind', undefined, opA.token));
  if (own.data && ['submitted', 'under_review'].includes(own.data.state))
    await ctx.edge.mutate('identity', 'affiliates.withdrawRebind', { requestId: own.data.requestId }, opA.token);
  // On a fresh stack the operator's own account is minutes old and could still attach by link, which needs no review:
  // half an hour passes for it, past the ten-minute window and short of the one-hour lapse period.
  if (result(await ctx.edge.query('identity', 'affiliates.attachWindow', undefined, opA.token)).data?.state === 'open')
    expect(tool('local-test-gates.mjs', 'age', opA.op.handle, '1800')).toContain('LOCAL TEST');
  const asked = result(
    await ctx.edge.mutate('identity', 'affiliates.requestRebind', { token, reason: 'TEST: operator asks for their own change' }, opA.token),
  );
  expect(asked.status).toBe(200);
  const self = result(
    await ctx.edge.mutate(
      'identity',
      'affiliates.decideRebind',
      { requestId: asked.data.requestId, decision: 'approve', reason: 'TEST self-approval' },
      await opA.approvalToken(),
    ),
  );
  expect(self).toMatchObject({ status: 412, code: 'action_approval.same_person' });
  const closed = result(
    await ctx.edge.mutate(
      'identity',
      'affiliates.decideRebind',
      { requestId: asked.data.requestId, decision: 'reject', reason: 'TEST: no invitation evidence' },
      await ops.b.approvalToken(),
    ),
  );
  expect(closed.data).toMatchObject({ state: 'rejected', decisionReason: 'TEST: no invitation evidence' });

  // Operator A reviews the person's request; it is in the queue and approval applies it once.
  const queue = result(await ctx.edge.query('identity', 'affiliates.rebindQueue', { limit: 100 }, await opA.approvalToken()));
  expect(queue.data.map((r) => r.requestId)).toContain(requestId);
  const before = Date.now();
  const approved = result(
    await ctx.edge.mutate(
      'identity',
      'affiliates.decideRebind',
      { requestId, decision: 'approve', reason: 'TEST: link reached them after sign-up' },
      await opA.approvalToken(),
    ),
  );
  expect(approved.data).toMatchObject({ state: 'approved', toReferrerId: referrerId, decidedBy: opA.op.userId });
  expect(Date.parse(approved.data.appliedAt)).toBeGreaterThanOrEqual(before - 5_000);
  // A repeat by the other operator is the same decision, consumed once.
  const repeat = result(
    await ctx.edge.mutate(
      'identity',
      'affiliates.decideRebind',
      { requestId, decision: 'approve', reason: 'TEST repeat' },
      await ops.b.approvalToken(),
    ),
  );
  expect(repeat.data).toMatchObject({ state: 'approved', decidedBy: opA.op.userId, appliedAt: approved.data.appliedAt });

  // The person's screens: the referrer from the approval time on, and the approved request.
  const edge = (await (await api(late)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data;
  expect(edge.referrerId).toBe(referrerId);
  expect(edge.attributedAt).toBe(approved.data.appliedAt);
  await signIn(page, late);
  await page.goto(`/invite?token=${token}`);
  await page.getByRole('button', { name: 'Read current status' }).click();
  await expect(page.getByText('A referral is recorded now')).toBeVisible();
  await expect(page.getByTestId('invitation__current').locator('dl dd').first()).toHaveText(referrerId);
  await expect(page.getByTestId('invitation__current').locator('dl time').first()).toHaveAttribute('datetime', edge.attributedAt);
  const change = page.getByRole('region', { name: 'Referrer change review' });
  await expect(change.locator('[data-rebind="approved"]')).toContainText('The new referrer applies from');
  await expect(change.getByText('TEST: link reached them after sign-up')).toBeVisible();
});

test(`${J} #7 my relationship screen shows the referrer and the date; with no fee for the period it ends and stops earning`, async ({
  page,
}) => {
  const { referrer, friend } = state('referrer', 'friend');
  const referrerId = (await identity(referrer, 'affiliates.createShare')).data.referrerId;
  const edge = (await (await api(friend)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data;
  expect(edge.referrerId).toBe(referrerId);

  // The relationship screen: the referrer, the date, and when it ends without a fee.
  await signIn(page, friend);
  await page.goto('/uc/promotion/mypromotion');
  const mine = page.getByRole('region', { name: 'Your recorded referrer' });
  await expect(mine.locator('p[title]')).toHaveAttribute('title', referrerId);
  await expect(mine.locator('time')).toHaveAttribute('datetime', edge.attributedAt);
  const term = page.getByRole('region', { name: 'How long this relationship lasts' });
  await expect(term.getByText('If you pay no fee for 1 hour, this relationship ends')).toBeVisible();
  const standing = (await (await api(friend)).get('/api/identity/trpc/affiliates.myLapse')).body.result.data;
  expect(standing).toMatchObject({ state: 'active', periodSeconds: 3600, lastActivityAt: edge.attributedAt });
  expect(Date.parse(standing.endsAt) - Date.parse(edge.attributedAt)).toBe(3_600_000);
  await expect(term.locator('time').nth(1)).toHaveAttribute('datetime', standing.endsAt);

  // While it lasts, a fee the friend pays earns the referrer a commission: the commission engine's dry run (it writes
  // nothing and posts nothing) under a TEST simulation tier, since the owner's rates are blank, names the referrer.
  const { ctx, ops } = await operators();
  const friendApi = await api(friend);
  const friendId = friendApi.userId;
  const dryRun = async (n) =>
    result(
      await ctx.edge.query(
        'identity',
        'affiliates.accrueDryRun',
        {
          feeEventId: `TEST-${J}-7-${n}-${friend.handle}`,
          userId: friendId,
          feeAmount: '1',
          asset: 'USDT',
          tiers: [{ hop: 0, rate: '0.1' }],
        },
        await ops.a.tradeOpsToken(),
      ),
    );
  const before = await dryRun('before');
  expect(before.data?.rows, JSON.stringify(before)).toHaveLength(1);
  expect(before.data.rows[0]).toMatchObject({ beneficiaryId: referrerId, payerId: friendId, hop: 0, commissionAmount: '0.1' });

  // An hour passes for the friend with no fee: the sweep ends the relationship once.
  expect(tool('local-test-gates.mjs', 'age', friend.handle, '3700')).toContain('LOCAL TEST');
  let lapse;
  await expect
    .poll(async () => (lapse = (await (await api(friend)).get('/api/identity/trpc/affiliates.myLapse')).body.result.data).ended, {
      timeout: 30_000,
    })
    .not.toBeNull();
  expect(lapse).toMatchObject({ state: 'none', ended: { referrerId, periodSeconds: 3600 } });
  expect((await (await api(friend)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data).toBeNull();
  // Commission stops: nobody is above the friend any more, so no fee of theirs can accrue to the referrer.
  expect((await (await api(friend)).get('/api/identity/trpc/affiliates.myAncestors')).body.result.data).toEqual([]);
  // The same fee now earns nobody a commission.
  const after = await dryRun('after');
  expect(after.data?.rows, JSON.stringify(after)).toEqual([]);

  await page.reload();
  await expect(page.getByRole('region', { name: 'Your recorded referrer' }).getByText('No referrer on record')).toBeVisible();
  const ended = page.getByRole('region', { name: 'Ended relationship' });
  await expect(ended.locator('[title]').first()).toHaveAttribute('title', referrerId);
  await expect(ended.locator('time').last()).toHaveAttribute('datetime', lapse.ended.lapsedAt);
  await expect(ended.getByText('It ended after 1 hour with no fee from you.')).toBeVisible();

  // The window runs again from the lapse, so the friend can be attached through a link again.
  const window = (await (await api(friend)).get('/api/identity/trpc/affiliates.attachWindow')).body.result.data;
  expect(window).toMatchObject({ state: 'open', reopenedAt: lapse.ended.lapsedAt });
  const { token } = state('token');
  const outcome = await accept(page, token);
  await expect(outcome.getByRole('heading', { name: /Referral status\s*recorded\./ })).toBeVisible();
  await expect(page.getByText('Your earlier referral relationship ended', { exact: false })).toBeVisible();
  expect((await (await api(friend)).get('/api/identity/trpc/affiliates.myReferrer')).body.result.data.referrerId).toBe(referrerId);
});
