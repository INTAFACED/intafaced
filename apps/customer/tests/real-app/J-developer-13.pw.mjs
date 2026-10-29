import { createHash, randomBytes } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-developer-13, in the running app (docs/roadmap/journeys.json): let a third-party app act for me, with OAuth. One
// test per step, titled "J-developer-13 #<n>", run in order. #1 makes the start: a verified TEST account registers an app
// on /developers/apps (its own app, so it may authorise it before an operator approves it). The app's side (the
// authorise link, the code exchange, the refresh) is played by this test against Edge, as the app's server would. The
// code and token lifetimes are the stack's TEST OAuth terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #3: the consent page has no scope choice and no choice of account.
// - #5: there is no refresh token.
// - #6: there is no connected apps page.
const J = 'J-developer-13';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const REDIRECT = 'https://app.local-test.invalid/callback';

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** The link the app sends the person to. */
function authorizeUrl({ challenge, state: st = 'st-1', method = 'S256', scope = 'trade:read identity:read' }) {
  const query = new URLSearchParams({ response_type: 'code', client_id: state('clientId'), redirect_uri: REDIRECT, scope });
  if (st) query.set('state', st);
  query.set('code_challenge', challenge);
  query.set('code_challenge_method', method);
  return `/oauth/authorize?${query}`;
}

/** The app's server at the token door (public: no session, the client's own proof). */
async function token(input) {
  const res = await fetch(`${EDGE}/api/identity/trpc/oauth.token`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: state('clientId'), clientSecret: state('clientSecret'), redirectUri: REDIRECT, ...input }),
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, data: body?.result?.data, code: body?.error?.message };
}

async function form(page) {
  await signIn(page, state('who'));
  await page.goto('/developers/apps');
  await expect(page.getByRole('heading', { name: 'Register an app' })).toBeVisible();
  return page.locator('form.apps-form');
}

async function register(box, { name, redirects, scopes }) {
  await box.getByLabel('App name').fill(name);
  await box.getByLabel('Redirect addresses').fill(redirects);
  await box.getByLabel('Scopes the app may ask for').fill(scopes);
  await box.getByRole('button', { name: 'Register app' }).click();
}

test(`${J} #1 registers an app with an https redirect and scopes: the client id and the secret once; bad redirects and interactive scopes refused`, async ({
  page,
}) => {
  test.setTimeout(240_000);
  const who = await signUp(page, 'jdoa');
  await verify(page, who);
  run.reset({ who, tag: Date.now().toString(36) });
  let box = await form(page);
  await register(box, { name: `TEST wild ${state('tag')}`, redirects: 'https://*.local-test.invalid/cb', scopes: 'trade:read' });
  await expect(box.getByRole('alert').last()).toContainText('is not an exact https address');
  await register(box, { name: `TEST http ${state('tag')}`, redirects: 'http://app.local-test.invalid/cb', scopes: 'trade:read' });
  // The refusal names this redirect, not the wildcard one before it.
  await expect(box.getByRole('alert').last()).toContainText('http://app.local-test.invalid/cb');
  await expect(box.getByRole('alert').last()).toContainText('is not an exact https address');
  await register(box, { name: `TEST withdraw ${state('tag')}`, redirects: REDIRECT, scopes: 'trade:withdraw' });
  await expect(box.getByRole('alert').last()).toContainText('A scope that needs an interactive session cannot be declared by an app.');

  await page.reload();
  box = await form(page);
  await register(box, { name: `TEST sync ${state('tag')}`, redirects: REDIRECT, scopes: 'trade:read\nidentity:read' });
  const secret = page.getByTestId('client-secret');
  const clientSecret = (await secret.innerText()).trim();
  expect(clientSecret.length).toBeGreaterThan(16);
  const row = page.locator('[data-testid^="app-"]').filter({ hasText: `TEST sync ${state('tag')}` });
  const clientId = (await row.getAttribute('data-testid')).replace(/^app-/, '');
  run.write({ clientId, clientSecret });
  await page.getByRole('button', { name: 'I have saved it' }).click();
  await page.reload();
  await expect(page.getByText(clientSecret)).toHaveCount(0);
});

test(`${J} #2 starts the flow without state, then with a plain challenge: the invalid-request refusal; nothing shared`, async ({
  page,
}) => {
  await signIn(page, state('who'));
  const { challenge } = pkce();
  await page.goto(authorizeUrl({ challenge, state: '' }));
  await expect(page.getByText('The request has no state value.')).toBeVisible();
  await page.goto(authorizeUrl({ challenge, method: 'plain' }));
  await expect(page.getByText('The request must use code_challenge_method=S256.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Allow' })).toHaveCount(0);
});

/** The person's consent, choosing one scope and the sub-account; returns the code the app receives. */
async function consent(page) {
  await signIn(page, state('who'));
  const { verifier, challenge } = pkce();
  await page.goto(authorizeUrl({ challenge }));
  await expect(page.getByRole('heading', { name: /Allow .* to use your account\?/ })).toBeVisible();
  await page.getByRole('checkbox', { name: 'See your account profile' }).uncheck(UNBUILT);
  await page.getByRole('radio', { name: `TEST oauth ${state('tag')}` }).check();
  await page.route(`${REDIRECT}**`, (route) => route.fulfill({ body: 'TEST app' }));
  const back = page.waitForRequest((req) => req.url().startsWith(REDIRECT));
  await page.getByRole('button', { name: 'Allow' }).click();
  return { code: new URL((await back).url()).searchParams.get('code'), verifier };
}

test(`${J} #3 approves the consent choosing scopes and one of two accounts: only the granted account is visible to the app`, async ({
  page,
}) => {
  const me = await api(state('who'));
  const sub = await me.post('/api/identity/trpc/subAccounts.create', { label: `TEST oauth ${state('tag')}` });
  expect(sub.status, JSON.stringify(sub.body).slice(0, 300)).toBe(200);
  const { code, verifier } = await consent(page);
  run.write({ code, verifier, subId: sub.body.result.data.id });
  const issued = await token({ grantType: 'authorization_code', code, codeVerifier: verifier });
  const seen = await fetch(`${EDGE}/api/identity/trpc/me`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${issued.data.accessToken}` },
  });
  expect((await seen.json()).result.data.userId).toBe(state('subId'));
  const { code: next, verifier: nextVerifier } = await consent(page);
  run.write({ code: next, verifier: nextVerifier });
});

test(`${J} #4 the app exchanges the code: tokens once; a wrong verifier is invalid_grant; a second use of the code revokes them`, async () => {
  const wrong = await token({ grantType: 'authorization_code', code: state('code'), codeVerifier: 'x'.repeat(43) });
  expect(wrong.code).toBe('oauth.invalid_grant');
  const first = await token({ grantType: 'authorization_code', code: state('code'), codeVerifier: state('verifier') });
  expect(first.data.accessToken).toMatch(/^ifct_/);
  const again = await token({ grantType: 'authorization_code', code: state('code'), codeVerifier: state('verifier') });
  expect(again.code).toBe('oauth.invalid_grant');
  const after = await fetch(`${EDGE}/api/identity/trpc/me`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${first.data.accessToken}` },
  });
  expect(after.status).toBe(401);
});

test(`${J} #5 the app refreshes twice with the same refresh token: the chain is revoked`, async ({ page }) => {
  const { code, verifier } = await consent(page);
  const issued = await token({ grantType: 'authorization_code', code, codeVerifier: verifier });
  const refresh = issued.data.refreshToken;
  expect(refresh).toBeTruthy();
  await token({ grantType: 'refresh_token', refreshToken: refresh });
  const second = await token({ grantType: 'refresh_token', refreshToken: refresh });
  expect(second.code).toBe('oauth.invalid_grant');
  const after = await fetch(`${EDGE}/api/identity/trpc/me`, {
    headers: { origin: ORIGIN, authorization: `Bearer ${issued.data.accessToken}` },
  });
  expect(after.status).toBe(401);
});

test(`${J} #6 revokes the app under connected apps: the app's next call fails typed; re-consent is offered`, async ({ page }) => {
  await signIn(page, state('who'));
  await page.goto('/uc/safe/connected-apps');
  await expect(page.getByRole('heading', { name: 'Connected apps', level: 1 })).toBeVisible(UNBUILT);
});
