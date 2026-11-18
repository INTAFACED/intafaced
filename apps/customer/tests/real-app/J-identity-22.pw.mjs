// World: book, restart, stack
import { test, expect } from './journey.mjs';
import { openDesk, openOrders, signIn } from './desk.mjs';
import {
  api,
  DEVICE_KEY,
  EDGE,
  fund,
  journeyState,
  mailedCodes,
  ORIGIN,
  signOutBrowser,
  signUpInBrowser,
  testPerson,
  tool,
} from './stack.mjs';

// J-identity-22, in the running app (docs/roadmap/journeys.json): the app lets nobody in until the country list is set.
// Starts on the TEST stack with identity's blocked-countries list set; every person here is a TEST person. #1 restarts
// identity once with no list at all; #2 makes a Cuba resident's account while Cuba is not yet listed, then puts back the
// TEST copy of Hyperliquid's restricted list (the unsigned config rows, which list Cuba). Identity is put back on the
// stack's own list after each step. Moves no money.
const J = 'J-identity-22';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

/**
 * Identity restarted on one blocked-countries list (`LOCAL_STACK_IDENTITY_SCREENING`, tooling/scripts/local-stack-services/
 * identity.mjs): `unset` (no list), `rows` (the TEST copy of Hyperliquid's list), or `null` for the stack's own list. With
 * `list`, identity takes that TEST list from this caller's environment for the restart, as the stack passes any caller's
 * list through. This process's environment is put back as it was.
 */
function identityList(mode, list) {
  const keys = ['LOCAL_STACK_IDENTITY_SCREENING', 'INTAFACED_SANCTIONS_REGIONS', 'INTAFACED_SANCTIONS_LIST_SOURCE'];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  if (mode === null) delete process.env.LOCAL_STACK_IDENTITY_SCREENING;
  else process.env.LOCAL_STACK_IDENTITY_SCREENING = mode;
  if (list) Object.assign(process.env, { INTAFACED_SANCTIONS_REGIONS: list.regions, INTAFACED_SANCTIONS_LIST_SOURCE: list.source });
  try {
    tool('local-test-stack.mjs', 'restart', 'identity');
  } finally {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

/**
 * The TEST copy of Hyperliquid's restricted list as it was before Cuba was listed: the config rows without Cuba, each
 * labelled TEST. A Cuba resident's account is made under it, then the rows list Cuba.
 */
const BEFORE_CUBA = {
  regions: ['IR', 'KP', 'SY', 'UA-43', 'UA-40', 'UA-14', 'UA-09'].map((r) => `${r}:TEST launch row before Cuba was listed`).join(','),
  source: 'TEST: the launch rows before Cuba was listed (J-identity-22 #2)',
};

/** identity's own password sign-in, as the page sends it: the status, the typed code of a refusal, and any session. */
async function signInAnswer(who) {
  const res = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  });
  const body = await res.json();
  const data = body.error?.data;
  return {
    status: res.status,
    code: data?.intafacedCode ?? data?.cause?.code ?? data?.code,
    message: body.error?.message,
    session: body.result?.data?.accessToken ?? null,
  };
}

/** A tRPC read of identity's, as the signed-in person. */
async function identityRead(session, procedure, input) {
  const query = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  const res = await session.get(`/api/identity/trpc/${procedure}${query}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

test(`${J} #1 with the blocked-countries list switched off for one restart, sign-up and sign-in are both refused with a typed reason saying the list is not set; no account is made and no room opens`, async ({
  page,
}) => {
  test.setTimeout(420_000);
  // Someone who already has an account, made while the list was set, to try signing in.
  const known = testPerson('jk');
  await signUpInBrowser(page, known);
  await signOutBrowser(page.context());
  const newcomer = testPerson('jn');

  identityList('unset');
  try {
    // Sign-up: refused on the page with the reason and its code; the code step never opens and nothing is mailed.
    await page.goto('/register');
    await page.getByRole('radio', { name: 'Email', exact: true }).check();
    await page.getByLabel('Email address', { exact: true }).fill(newcomer.email);
    await page.getByLabel('Handle', { exact: true }).fill(newcomer.handle);
    await page.getByLabel('Password', { exact: true }).fill(newcomer.password);
    await page.getByRole('combobox', { name: 'Country you live in', exact: true }).selectOption('DE');
    await page.getByRole('radio', { name: 'No, I am not a US person', exact: true }).check();
    await page.getByLabel('Date of birth', { exact: true }).fill('1990-05-01');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    const refusedUp = page.getByRole('alert');
    await expect(refusedUp).toContainText('Sign-up is paused: the blocked-countries list is not set. Nothing was created.', {
      timeout: 15_000,
    });
    await expect(refusedUp.locator('small')).toHaveText('identity.screening_unset');
    await expect(page.getByRole('heading', { name: 'Check your email', exact: true })).toHaveCount(0);
    expect(mailedCodes(newcomer.email)).toEqual([]);

    // Sign-in: the known person's right password is refused by identity with the same typed reason, and no session opens.
    const answer = await signInAnswer(known);
    expect(answer.status).toBe(412);
    expect(answer.code).toBe('identity.screening_unset');
    expect(answer.message).toBe('Sign-in is paused: the blocked-countries list is not set. Nobody can sign in until it is.');
    expect(answer.session).toBeNull();
    // On the page: the same reason and code, and the person stays on the sign-in page.
    await page.goto('/login');
    await page.fill('input[name=identifier]', known.email);
    await page.fill('input[name=password]', known.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(
      page.getByText('Sign-in is paused: the blocked-countries list is not set. Nobody can sign in until it is.', { exact: true }),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.locator('small', { hasText: 'identity.screening_unset' })).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    // No room opens: a room asked for directly stays closed and asks the person to sign in.
    await page.goto('/uc/account');
    await expect(page.getByRole('main').getByRole('heading', { name: 'Sign in to continue', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account menu', exact: true })).toHaveCount(0);
  } finally {
    identityList(null);
  }

  // With the list back: the newcomer has no account (sign-in refuses the address as unknown), and the known person signs in.
  const none = await signInAnswer(newcomer);
  expect(none.status).toBe(401);
  expect(none.code).toBe('auth.invalid_credentials');
  expect((await signInAnswer(known)).session).toEqual(expect.any(String));
});

test(`${J} #2 with the TEST list back, a person whose account was made before their country was listed is refused at the trading checks, naming that the country is not served; the desk keeps refusing orders; nothing else about them is stored`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  // A Cuba resident signs up while identity's list does not yet list Cuba.
  const cuban = testPerson('jc');
  identityList(null, BEFORE_CUBA);
  try {
    await signUpInBrowser(page, cuban, { country: 'CU' });
    await signOutBrowser(page.context());
  } finally {
    // The TEST copy of Hyperliquid's restricted list, which lists Cuba.
    identityList('rows');
  }
  run.write({ cuban });

  try {
    // The trading checks: legal name, and the country given at sign-up (Cuba) confirmed.
    await signIn(page, cuban);
    await page.goto('/verification');
    const checks = page.getByRole('form', { name: /trading checks/i });
    await expect(checks).toBeVisible();
    await checks.getByRole('textbox', { name: /legal name/i }).fill(`TEST Trader ${cuban.handle}`);
    await expect(checks.getByRole('combobox', { name: /country you live in/i })).toHaveValue('CU');
    await checks.getByRole('checkbox', { name: 'I live in Cuba', exact: true }).check();
    const answered = page.waitForResponse((r) => r.request().method() === 'POST' && r.url().includes('/kyc.tradingChecks.run'));
    await checks.getByRole('button', { name: /run the checks/i }).click();
    const answer = await answered;
    // Refused by identity itself, and on the page in words that name the country as not served.
    expect(answer.status()).toBe(403);
    expect(JSON.stringify(await answer.json())).toContain('kyc.region_blocked');
    const refused = checks.locator('[data-code="kyc.region_blocked"]');
    await expect(refused).toHaveText('Cuba is not served, so trading is not offered there. Nothing was checked or kept.');

    // Nothing else about the person is stored: no check outcome (the legal name is kept only with one), no verification
    // record or case, and the level stays none. The page offers the same form again, never "under review".
    const session = await api(cuban);
    expect(await identityRead(session, 'kyc.tradingChecks.read')).toMatchObject({ state: 'not_run', country: 'CU', listSet: true });
    expect(await identityRead(session, 'kyc.status', { limit: 50 })).toEqual({ tier: 'none', tradingOnly: false, records: [] });
    await page.goto('/verification');
    await expect(page.getByRole('form', { name: /trading checks/i })).toBeVisible();
    await expect(page.getByText(/under review/i)).toHaveCount(0);

    // The desk keeps refusing orders: it asks to verify, and an order sent anyway is refused; none rests. TEST funds first,
    // so the refusal is the verification one, never an empty balance.
    expect(fund(cuban.email, 'USDT', '100').tx).toBeTruthy();
    await openDesk(page, cuban);
    await page.locator('[role=tab]', { hasText: /^Limit$/ }).click();
    await page.getByRole('textbox', { name: 'Price', exact: true }).first().fill('1000');
    await page.getByRole('textbox', { name: 'Amount', exact: true }).first().fill('0.01');
    await expect(page.locator('#dk-reason-buy')).toContainText('Verify your identity first');
    await expect(page.getByRole('button', { name: 'Buy BTC', exact: true })).toBeDisabled();
    const order = await session.post('/api/v1/orders', {
      symbol: 'BTC/USDT',
      type: 'limit',
      side: 'buy',
      amount: '0.01',
      price: '1000',
      clientOrderId: `${J}-${Date.now()}`,
    });
    expect(order.status, JSON.stringify(order.body).slice(0, 300)).toBe(403);
    expect(JSON.stringify(order.body)).toMatch(/kyc_required/);
    expect(await openOrders(cuban)).toHaveLength(0);
  } finally {
    identityList(null);
  }
});
