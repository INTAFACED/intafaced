import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { ROOT, api, mailedLines, signOutBrowser, signUpInBrowser } from './stack.mjs';
import { keyHolder, makeKey, withKey } from './developer.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';

// J-identity-11, in the running app (docs/roadmap/journeys.json): I freeze my own account and later reactivate it.
// One test per step this build serves, titled "J-identity-11 #<n>". Every person here is a TEST person on the local
// stack, signed up through the browser (J-identity-01) with a fresh TEST password kept only in memory for the run.
const J = 'J-identity-11';

test.describe.configure({ mode: 'default' });

function person(prefix = 'jf') {
  const handle = `${prefix}${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  return { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
}

const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/** Freezes the person's own account from Security with their password; every session ends. Returns when it was asked. */
async function freezeOwn(page, who) {
  await page.goto('/uc/safe');
  const card = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'Freeze your account' }) });
  await card.getByLabel('Your password').fill(who.password);
  // Taken before the click, so it is never later than the freeze the service records.
  const frozenAt = Date.now();
  await card.getByRole('button', { name: 'Freeze my account' }).click();
  // The freeze ends this session too: the room shows the frozen card until its next read finds the session gone, then
  // drops to signed out. Either is the answer; the sign-in after it proves the freeze.
  await expect(
    page.getByRole('heading', { name: 'You froze this account' }).or(page.getByRole('heading', { name: 'Sign in to continue' })),
  ).toBeVisible();
  return frozenAt;
}

/** Signs in again through /login to an account its owner froze; the sign-in lands on that freeze. */
async function signInFrozen(page, who) {
  await page.goto('about:blank');
  await signOutBrowser(page.context());
  await page.goto('/login');
  await page.fill('input[name=identifier]', who.email);
  await page.fill('input[name=password]', who.password);
  await page.getByRole('button', { name: /^sign in$/i }).click();
  const frozen = page.getByTestId('frozen-by-you');
  await expect(frozen).toBeVisible();
  return frozen;
}

const ACTIONS = [
  'Sign in',
  'Trade',
  'Create API keys',
  'Change your password',
  'Change your sign-in methods',
  'Reset your password',
  'Reset your second factor',
  'Add recovery keys or change their plan',
  'Add a withdrawal address',
  'Start a send to a withdrawal address',
];

test(`${J} #1 Account status lists what I can still do and what I cannot; an active account blocks nothing`, async ({ page }) => {
  await signUpInBrowser(page, person());
  await page.goto('/uc/account');
  const status = page.getByTestId('account-status');
  await expect(status.getByRole('heading', { name: 'Account status' })).toBeVisible();
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'active');
  await expect(status.getByTestId('account-status__state')).toHaveText('Your account is active. Nothing is restricted.');
  await expect(status.getByTestId('account-status__can').locator('li')).toHaveText(ACTIONS);
  await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText(['Nothing']);
  await expect(status.getByTestId('account-status__restrictions')).toHaveCount(0);

  // A restriction shows in both lists with its reason and how it ends: the owner's own security lock.
  await page.goto('/uc/safe');
  await page.getByRole('button', { name: 'Turn on the lock' }).click();
  await page.getByRole('button', { name: 'Turn it on now' }).click();
  await expect(page.getByText('The lock is on.').first()).toBeVisible();
  await page.goto('/uc/account');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'restricted');
  const lock = status.getByTestId('account-status__restrictions').locator('li[data-kind="security_lock"]');
  await expect(lock).toContainText('Security lock');
  await expect(lock).toContainText('Reason: you turned it on.');
  await expect(lock).toContainText('It holds until you ask to unlock it in Security.');
  await expect(status.getByTestId('account-status__cannot').locator('li')).toHaveText(ACTIONS.slice(3));
  await expect(status.getByTestId('account-status__can').locator('li')).toHaveText(['Sign in', 'Trade', 'Create API keys']);
});

/** The freeze link on the newest security notice mailed to `email`, as the path the mail links to. */
async function mailedFreezeLink(email) {
  let link = null;
  await expect
    .poll(
      () => {
        const lines = mailedLines(email, 'factor-changed').filter((line) => / freeze=/.test(line));
        link = lines.length ? /\bfreeze=(\S+)/.exec(lines.at(-1))[1] : null;
        return link;
      },
      { timeout: 30_000 },
    )
    .toMatch(/^freeze\/confirm#token=[A-Za-z0-9_-]{40,}$/);
  return `/${link}`;
}

/** The bank's withdrawal guard, asked as the address form asks it before any code: may this person add this address? */
const WITHDRAW_TO = '0x52908400098527886E0F7030069857D2E4169EE7';
const withdrawalCheck = (session) =>
  session.get(`/api/bank/trpc/ramps.destinations.check?input=${encodeURIComponent(JSON.stringify({ ref: WITHDRAW_TO }))}`);
const refusalOf = (res) => res.body?.error?.data?.intafacedCode ?? res.body?.error?.data?.cause?.code ?? null;

/** The typed code on an Edge or service refusal, wherever the answer carries it. */
const codeOn = (res) =>
  res.body?.error?.data?.intafacedCode ?? res.body?.error?.data?.code ?? res.body?.code ?? res.body?.error?.code ?? null;
const query = (route, input) => `${route}?input=${encodeURIComponent(JSON.stringify(input))}`;
/** Every live sign-in of the person, as identity lists them to the person themself. */
const sessionsOf = async (session) =>
  (await session.get(query('/api/identity/trpc/listSessions', { userId: session.userId, limit: 200 }))).body.result.data.sessions;
/** The person's key named `name`, as identity lists the person's keys. */
const keyNamed = async (session, name) =>
  (await session.get(query('/api/identity/trpc/apiKeys.list', { limit: 200 }))).body.result.data.filter((record) => record.name === name);

test(`${J} #2 Freeze my account from the mailed link: no session and no key remain, the link used twice shows the stored result, a withdrawal is refused`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  // A verified person with a passkey (only such an account holds an API key) and a live key. Adding the passkey is a
  // security change, so identity mails the "your sign-in methods changed" notice, and that notice carries the link.
  const { page, who } = await keyHolder(browser, 'jl');
  const key = await makeKey(page, { name: 'freeze-me', preset: 'Read only' });
  const session = await api(who);
  const STATUS = '/api/identity/trpc/accountStatus.mine';
  expect((await session.get(STATUS)).status).toBe(200);
  expect((await withKey(key, { path: STATUS })).status).toBe(200);
  // Before the freeze identity lists the key live and more than one sign-in (the browser's and this one).
  expect((await keyNamed(session, 'freeze-me')).map((record) => record.revoked)).toEqual([false]);
  const before = await sessionsOf(session);
  expect(before.length).toBeGreaterThanOrEqual(2);
  // Before the freeze the withdrawal guard lets this person go on to the address form.
  const open = await withdrawalCheck(session);
  expect(open.status, JSON.stringify(open.body).slice(0, 300)).toBe(200);
  expect(open.body.result.data.address).toBe('ok');

  // A link nobody was sent gets the one generic page and freezes nothing.
  const stranger = await (await browser.newContext()).newPage();
  await stranger.goto(`/freeze/confirm#token=${randomBytes(32).toString('base64url')}`);
  await stranger.getByRole('button', { name: 'Freeze my account' }).click();
  await expect(stranger.getByRole('heading', { level: 1 })).toHaveText('This freeze link does not work');
  expect((await session.get(STATUS)).body.result.data.state).toBe('active');

  // "This was not me": the person opens the link from the notice in a browser that is not signed in.
  const link = await mailedFreezeLink(who.email);
  const mailbox = await (await browser.newContext()).newPage();
  await mailbox.goto(link);
  await expect(mailbox.getByRole('heading', { level: 1 })).toHaveText('Freeze your account');
  // Opening the page spent nothing: the account still reads active.
  expect((await session.get(STATUS)).body.result.data.state).toBe('active');
  await mailbox.getByRole('button', { name: 'Freeze my account' }).click();
  await expect(mailbox.getByRole('heading', { level: 1 })).toHaveText('Your account is frozen');
  await expect(mailbox.getByTestId('freeze-link-result')).toHaveAttribute('data-first-use', 'true');
  const first = await mailbox.getByTestId('freeze-link-result').locator('time').getAttribute('datetime');
  expect(Number.isNaN(Date.parse(first))).toBe(false);

  // No session and no key remain: the sign-in made before the freeze is refused as revoked, the key as revoked, and
  // the browser's own session is signed out. Edge may hold a session's authority for its cache window, so the first
  // read waits that window out once.
  const { EDGE_AUTHORITY_CACHE_MAX_MS } = await import(path.join(ROOT, 'tooling/scripts/local-test-gates.mjs'));
  await new Promise((resolve) => setTimeout(resolve, EDGE_AUTHORITY_CACHE_MAX_MS + 100));
  const oldSession = await session.get(STATUS);
  expect(oldSession.status, JSON.stringify(oldSession.body).slice(0, 300)).toBe(401);
  // Edge passes an ended sign-in on as signed out, so identity's own door answers it: not signed in. That the sign-in
  // itself is gone is read below from identity's list of the person's sessions.
  expect(codeOn(oldSession), JSON.stringify(oldSession.body)).toBe('UNAUTHORIZED');
  const oldKey = await withKey(key, { path: STATUS });
  expect(oldKey.status, JSON.stringify(oldKey.body).slice(0, 300)).toBe(401);
  expect(codeOn(oldKey), JSON.stringify(oldKey.body)).toBe('edge.api_key_revoked');
  await page.goto('/uc/safe');
  await expect(page.getByRole('heading', { name: 'Sign in to continue' })).toBeVisible();

  // Signed in again, identity lists only this new sign-in and the key as revoked, and the account reads frozen by its
  // owner since the moment the link page showed.
  const again = await api(who);
  const listed = await sessionsOf(again);
  expect(listed.map((seat) => seat.isCurrent)).toEqual([true]);
  expect(before.map((seat) => seat.id)).not.toContain(listed[0].id);
  expect((await keyNamed(again, 'freeze-me')).map((record) => record.revoked)).toEqual([true]);
  const frozen = (await again.get(STATUS)).body.result.data;
  expect(frozen.state).toBe('frozen_self');
  expect(frozen.restrictions.map((restriction) => [restriction.kind, restriction.since])).toEqual([['self_freeze', first]]);

  // The same link again, opened from the mail in a new tab, shows the result stored at its first use and changes nothing.
  // (A goto on the open tab would only change its fragment, so the page would not load again.)
  const reopened = await mailbox.context().newPage();
  await reopened.goto(link);
  await reopened.getByRole('button', { name: 'Freeze my account' }).click();
  await expect(reopened.getByRole('heading', { level: 1 })).toHaveText('This link was already used');
  await expect(reopened.getByTestId('freeze-link-result')).toHaveAttribute('data-first-use', 'false');
  await expect(reopened.getByTestId('freeze-link-result').locator('time')).toHaveAttribute('datetime', first);
  // Changes nothing: the freeze reads the same, and the sign-in made after the first use is still live and still the only one.
  await new Promise((resolve) => setTimeout(resolve, EDGE_AUTHORITY_CACHE_MAX_MS + 100));
  const still = await again.get(STATUS);
  expect(still.status).toBe(200);
  expect(still.body.result.data).toEqual(frozen);
  expect((await sessionsOf(again)).map((seat) => seat.id)).toEqual([listed[0].id]);

  // The bank's withdrawal guard refuses the frozen account by name.
  const refused = await withdrawalCheck(again);
  expect(refused.status).toBe(412);
  expect(refusalOf(refused)).toBe('bank.account_frozen_self');
});

test(`${J} #3 Signing in again after freezing lands on a typed "frozen by you" page with the lift path, not a generic error`, async ({
  page,
}) => {
  test.setTimeout(120_000);
  const who = person('jg');
  await signUpInBrowser(page, who);
  await freezeOwn(page, who);

  // The sign-in succeeds and lands on the person's own freeze, typed from identity's account status, with no refusal.
  const frozen = await signInFrozen(page, who);
  await expect(frozen).toHaveAttribute('data-state', 'frozen_self');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('You froze this account');
  await expect(frozen.getByTestId('frozen-by-you__since')).toHaveText(/^Frozen on .+\.$/);
  // The stack's TEST wait (IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS=20) has not passed, so the page says from when.
  const lift = frozen.getByTestId('frozen-by-you__lift');
  await expect(lift).toHaveAttribute('data-lift', 'liftAt');
  await expect(lift).toHaveText(/^You can reactivate it yourself from .+, in Security, with your authenticator code or a passkey\.$/);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('failure')).toHaveCount(0);

  // The page states what identity holds: the same account reads frozen by its owner, with one self freeze.
  const own = await api(who);
  const read = await own.get('/api/identity/trpc/accountStatus.mine');
  expect(read.status).toBe(200);
  expect(read.body.result.data.state).toBe('frozen_self');
  expect(read.body.result.data.restrictions.map((restriction) => restriction.kind)).toEqual(['self_freeze']);
  // What the page says the freeze stops is exactly what identity's guard refuses for it.
  const stops = await frozen
    .getByTestId('frozen-by-you__stops')
    .locator('li')
    .evaluateAll((items) => items.map((li) => li.getAttribute('data-action')));
  expect(stops).toEqual(read.body.result.data.restrictions[0].blocks);
  expect(stops.length).toBeGreaterThan(0);

  // The lift path: Security holds the reactivation for this freeze.
  await frozen.getByRole('button', { name: 'Reactivate in Security' }).click();
  await expect(page).toHaveURL(/\/uc\/safe$/);
  const card = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'You froze this account' }) });
  await expect(card.getByRole('button', { name: 'Reactivate my account' })).toBeVisible();
});

test(`${J} #4 Asking to reactivate before the wait is over is refused with the seconds left; after it, step-up lifts the freeze`, async ({
  page,
}) => {
  // The stack's waiting time is the TEST owner value IDENTITY_SELF_FREEZE_LIFT_WAIT_SECONDS=20; a blank one refuses
  // (svc-identity self-freeze-lift tests). The lift needs a second factor, so the person adds an authenticator app.
  test.setTimeout(180_000);
  const who = person('jr');
  await signUpInBrowser(page, who);

  // The person freezes their own account from Security; every session ends.
  const frozenAt = await freezeOwn(page, who);

  // They sign in again and Account status names their own freeze.
  await signInFrozen(page, who);
  await page.goto('/uc/account');
  const status = page.getByTestId('account-status');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'frozen_self');
  await expect(status.getByTestId('account-status__restrictions').locator('li[data-kind="self_freeze"]')).toHaveCount(1);

  // Too soon: the service refuses with the whole seconds left, and no confirmation is asked for.
  await page.goto('/uc/safe');
  const frozen = page.getByTestId('security__card').filter({ has: page.getByRole('heading', { name: 'You froze this account' }) });
  await frozen.getByRole('button', { name: 'Reactivate my account' }).click();
  const refusal = frozen.getByTestId('freeze__lift-refusal');
  await expect(refusal).toHaveText(/^Too soon\. You can reactivate in \d+ seconds?\.$/);
  const left = Number((await refusal.textContent()).match(/in (\d+) second/)[1]);
  const elapsed = Math.ceil((Date.now() - frozenAt) / 1000);
  expect(left).toBeGreaterThanOrEqual(1);
  expect(left).toBeLessThanOrEqual(20);
  expect(left + elapsed).toBeGreaterThanOrEqual(20);
  await expect(frozen.getByTestId('step-up-confirm')).toHaveCount(0);

  // The person adds an authenticator app (a freeze stops only new API keys), then waits out the rest.
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  const due = frozenAt + 21_000;
  if (Date.now() < due) await page.waitForTimeout(due - Date.now());

  // After the wait: the same button asks for a fresh code, and the code lifts the freeze.
  await page.goto('/uc/safe');
  await frozen.getByRole('button', { name: 'Reactivate my account' }).click();
  const confirm = frozen.getByTestId('step-up-confirm');
  await expect(confirm).toBeVisible();
  const next = await nextCode(totp, secret, step);
  await confirm.getByLabel('Authenticator code').fill(next.code);
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText('Your account is active again.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Freeze your account' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You froze this account' })).toHaveCount(0);

  // Account status agrees: nothing is restricted any more.
  await page.goto('/uc/account');
  await expect(status.getByTestId('account-status__state')).toHaveAttribute('data-state', 'active');
  await expect(status.getByTestId('account-status__restrictions')).toHaveCount(0);
});

// Still red, named: a staff freeze's own page, the staff-only lift and the appeal path wait for the appeal door
// (I-account-lifecycle-12), which identity does not serve yet.
test(`${J} #5 A staff freeze shows its own page that only staff can lift, with the appeal path`, () => {
  throw new Error('step #5 is not built yet: no appeal door in svc-identity (I-account-lifecycle-12)');
});
