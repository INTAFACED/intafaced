// World: restart
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, api, fund, restartWith } from './stack.mjs';
import { codeOf, keyHolder, withKey } from './developer.mjs';

// J-developer-15, in the running app (docs/roadmap/journeys.json): run keys for sub-accounts, teams and agents. One
// test per step, titled "J-developer-15 #<n>", each checking the step's own words. The person is a TEST master account
// with a passkey (only such an account may hold a key; the passkey gives each create its fresh step-up) and two
// sub-accounts, A and B. The master is funded with TEST USDT and the sub-accounts hold nothing, so a balance read says
// whose account answered. The stack's TEST value caps keys per sub-account at two (IDENTITY_PORTFOLIO_KEYS_MAX, LOCAL
// TEST); #2 restarts identity with it blank, as it is until the owner sets it.
const J = 'J-developer-15';
const { apiKeyCreateRequestId } = await import(path.join(ROOT, 'packages/contracts/dist/api-keys.js'));

test.describe.configure({ mode: 'serial' });

/** @type {import('@playwright/test').Page} */
let page;
let who;
let me;
const sub = { a: '', b: '' };
let subKey = '';
/** The agent key #5 makes (trade:read), which #6 uses. */
let agentKey = '';

const BALANCE = '/api/v1/account/balance';

/** Fills the create form for a read key, bound to the sub-account labelled `account` (or none), and presses Create with a passkey. */
async function createOnForm({ name, account }) {
  await page.goto('/uc/safe/api-keys/new');
  await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  await page.getByLabel('Key name').fill(name);
  await page.getByLabel('Sub-account', { exact: true }).selectOption({ label: account });
  await page.getByLabel('Read', { exact: true }).check();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
}

/** Reads the shown-once key, ticks that it is stored, and goes back to the list. */
async function takeShownKey() {
  await expect(page.getByRole('heading', { name: 'Your new key' })).toBeVisible();
  const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page).toHaveURL(/\/uc\/safe\/api-keys$/);
  return key;
}

function keyRow(name) {
  return page
    .getByTestId('api-keys__table')
    .locator('tbody tr')
    .filter({ has: page.getByRole('rowheader', { name, exact: true }) });
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);
  ({ page, who } = await keyHolder(browser, 'jd15'));
  me = await api(who);
  for (const [slot, label] of [
    ['a', 'Sub A'],
    ['b', 'Sub B'],
  ]) {
    const made = await me.post('/api/identity/trpc/subAccounts.create', { label });
    expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
    sub[slot] = made.body.result.data.id;
  }
  fund(who.email, 'USDT', '250');
  const own = await me.balances();
  expect(own.USDT?.total, JSON.stringify(own)).toBe('250');
});

test.afterAll(async () => {
  await page?.context().close();
});

test(`${J} #1 the master creates a key for the second sub-account: it reaches only that account, and the first account's data is refused`, async () => {
  test.setTimeout(180_000);
  // The form lists the master's two sub-accounts, and the key is made for the second one.
  await page.goto('/uc/safe/api-keys/new');
  const options = page.getByLabel('Sub-account', { exact: true }).locator('option');
  await expect(options).toHaveText(['None: a key for this account', 'Sub A', 'Sub B']);
  await createOnForm({ name: 'sub-b-reader', account: 'Sub B' });
  subKey = await takeShownKey();
  expect(subKey).toMatch(/^ifc_/);
  await expect(keyRow('sub-b-reader').getByTestId('api-keys__account')).toHaveText('Sub-account: Sub B');

  // It reaches that account: its balance read answers for sub-account B, which holds nothing, not the master's 250 USDT.
  const own = await withKey(subKey, { path: BALANCE, headers: { 'x-account-id': sub.b } });
  expect(own.status, JSON.stringify(own.body).slice(0, 300)).toBe(200);
  expect(own.body.balances?.USDT?.total ?? '0').not.toBe('250');
  expect(Object.values(own.body.balances ?? {}).every((row) => row.total === '0' || Number(row.total) === 0)).toBe(true);

  // Only that account: the first sub-account's data, and the master's own (no account named), are refused.
  for (const headers of [{ 'x-account-id': sub.a }, {}]) {
    const other = await withKey(subKey, { path: BALANCE, headers });
    expect(other.status, `${JSON.stringify(headers)} ${JSON.stringify(other.body).slice(0, 300)}`).toBeGreaterThanOrEqual(401);
    expect(other.status).toBeLessThan(500);
    expect(other.body?.balances).toBeUndefined();
    expect(codeOf(other.body)).toMatch(/^edge\.api_key_/);
  }
  // A route that would answer for the master's own account is refused at the edge, even with B named.
  const orders = await withKey(subKey, { path: '/api/v1/orders/open', headers: { 'x-account-id': sub.b } });
  expect(orders.status, JSON.stringify(orders.body).slice(0, 300)).toBe(403);
  expect(codeOf(orders.body)).toBe('edge.api_key_denied');
});

test(`${J} #2 an organisation key without an account id is refused; a blank sub-account key cap refuses one more sub-account key`, async () => {
  test.setTimeout(300_000);
  // An organisation the master administers; a key for it that names no account is refused before anything is made.
  const org = await me.post('/api/identity/trpc/createOrg', { name: `TEST desk ${Date.now().toString(36)}` });
  expect(org.status, JSON.stringify(org.body).slice(0, 300)).toBe(200);
  const listed = await me.get(`/api/identity/trpc/developerKeys.list?input=${encodeURIComponent(JSON.stringify({ limit: 200 }))}`);
  expect(listed.status).toBe(200);
  const asked = { name: 'org-bot', scopes: ['trade:read'], orgId: org.body.result.data.id };
  const refused = await me.post('/api/identity/trpc/developerKeys.create', {
    ...asked,
    requestId: apiKeyCreateRequestId(me.userId, listed.body.result.data.keys, asked),
  });
  expect(refused.status, JSON.stringify(refused.body).slice(0, 300)).toBe(400);
  expect(refused.body?.error?.data?.cause?.code).toBe('identity.key_account_required');
  const after = await me.get(`/api/identity/trpc/developerKeys.list?input=${encodeURIComponent(JSON.stringify({ limit: 200 }))}`);
  expect(after.body.result.data.keys.map((key) => key.name)).not.toContain('org-bot');

  // With the owner's cap on keys per sub-account blank, one more key for sub-account B is refused, and none is made.
  restartWith('identity', 'LOCAL_STACK_IDENTITY_PORTFOLIO_KEY_CAP', false);
  try {
    await createOnForm({ name: 'sub-b-second', account: 'Sub B' });
    await expect(page.getByRole('alert')).toHaveText(
      'The number of keys a sub-account may hold is not set, so sub-account keys are refused. Nothing was created.',
    );
    await page.goto('/uc/safe/api-keys');
    await expect(keyRow('sub-b-reader')).toHaveCount(1);
    await expect(keyRow('sub-b-second')).toHaveCount(0);
  } finally {
    restartWith('identity', 'LOCAL_STACK_IDENTITY_PORTFOLIO_KEY_CAP', true);
  }
});

test(`${J} #3 deleting a sub-account key: it stops verifying at once`, async () => {
  test.setTimeout(180_000);
  const before = await withKey(subKey, { path: BALANCE, headers: { 'x-account-id': sub.b } });
  expect(before.status, JSON.stringify(before.body).slice(0, 300)).toBe(200);

  await page.goto('/uc/safe/api-keys');
  const row = keyRow('sub-b-reader');
  await row.getByRole('button', { name: 'Revoke', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'The key is revoked.' })).toBeVisible();

  // At once: the very next call is refused, with no wait in between.
  const after = await withKey(subKey, { path: BALANCE, headers: { 'x-account-id': sub.b } });
  expect(after.status, JSON.stringify(after.body).slice(0, 300)).toBe(401);
  expect(codeOf(after.body)).toBe('edge.api_key_revoked');
  await page.reload();
  await expect(row.getByRole('button', { name: 'Revoke', exact: true })).toHaveCount(0);
});

test(`${J} #5 creates an agent key: it is tagged and restricted, and a forbidden scope is refused at create`, async () => {
  test.setTimeout(180_000);
  // A forbidden scope: an agent key asking for a settings permission (identity:write) is refused at create, and none is made.
  await page.goto('/uc/safe/api-keys/new');
  await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  await page.getByLabel('Key name').fill('agent-settings');
  await page.getByLabel('This key is for an AI agent').check();
  await page.getByLabel('Custom', { exact: true }).check();
  await page.getByRole('checkbox', { name: /^trade:read/ }).check();
  await page.getByRole('checkbox', { name: /^identity:write/ }).check();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'An agent key cannot hold refund, payout, withdrawal or settings permissions. Remove them and try again. Nothing was created.',
  );

  // The refusal is the service's own typed one, not only the form's: the same ask sent straight to identity is refused.
  const asked = { name: 'agent-probe', scopes: ['identity:write'], kind: 'agent' };
  const probe = await me.post('/api/identity/trpc/developerKeys.create', {
    ...asked,
    requestId: apiKeyCreateRequestId(me.userId, [], asked),
  });
  expect(probe.status, JSON.stringify(probe.body).slice(0, 300)).toBe(403);
  expect(probe.body?.error?.data?.cause?.code).toBe('identity.agent_scope_forbidden');

  // An agent key with a read permission is made, and the list tags it as an agent key holding only that permission.
  await page.goto('/uc/safe/api-keys/new');
  await page.getByLabel('Key name').fill('agent-reader');
  await page.getByLabel('This key is for an AI agent').check();
  await page.getByLabel('Custom', { exact: true }).check();
  await page.getByRole('checkbox', { name: /^trade:read/ }).check();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  agentKey = await takeShownKey();
  const row = keyRow('agent-reader');
  await expect(row.getByTestId('api-keys__agent')).toHaveText('Agent');
  await expect(row).toContainText('trade:read');
  await expect(row).not.toContainText('identity:write');
  await expect(keyRow('agent-settings')).toHaveCount(0);
  // A person's own key carries no agent tag.
  await expect(page.getByTestId('api-keys__agent')).toHaveCount(1);

  // It works for what it holds: a read call runs. The service's record says it is an agent key with that one permission.
  const read = await withKey(agentKey, { path: BALANCE });
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
  const listed = await me.get(`/api/identity/trpc/developerKeys.list?input=${encodeURIComponent(JSON.stringify({ limit: 200 }))}`);
  const record = listed.body.result.data.keys.find((key) => key.name === 'agent-reader');
  expect(record).toMatchObject({ kind: 'agent', scopes: ['trade:read'] });
});

test(`${J} #6 the agent key attempts a payout: an approval row appears and no payout runs; a read call runs`, async () => {
  test.setTimeout(180_000);
  expect(agentKey, 'the agent key from #5').toMatch(/^ifc_/);
  const asked = { settlementId: '9f1c2b3a-0000-4000-8000-00000000d015', railId: 'test-rail' };
  const PAYOUT = '/api/pay/trpc/settlement.payout';
  const approvalsPath = `/api/identity/trpc/developerKeys.approvals?input=${encodeURIComponent(JSON.stringify({ limit: 50 }))}`;

  // The attempt is held at the door: a typed answer naming the waiting row, and nothing is forwarded to the service.
  const attempt = await withKey(agentKey, { method: 'POST', path: PAYOUT, body: asked });
  expect(attempt.status, JSON.stringify(attempt.body).slice(0, 300)).toBe(202);
  expect(codeOf(attempt.body)).toBe('edge.agent_approval_required');
  expect(attempt.body.approval).toMatchObject({ keyName: 'agent-reader', action: 'pay.payout', status: 'waiting' });
  // The same attempt again is the same row, not a second one.
  const again = await withKey(agentKey, { method: 'POST', path: PAYOUT, body: asked });
  expect(again.status).toBe(202);
  expect(again.body.approval.id).toBe(attempt.body.approval.id);

  // An approval row appears: the owner's list holds exactly this one, waiting.
  const approvals = await me.get(approvalsPath);
  expect(approvals.status, JSON.stringify(approvals.body).slice(0, 300)).toBe(200);
  expect(approvals.body.result.data.approvals).toEqual([
    expect.objectContaining({ id: attempt.body.approval.id, keyName: 'agent-reader', action: 'pay.payout', status: 'waiting' }),
  ]);
  // And the key page shows it, saying nothing was sent.
  await page.goto('/uc/safe/api-keys');
  const row = page.getByTestId('api-keys__approvals').locator('tbody tr');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('agent-reader');
  await expect(row).toContainText('Send a payout');
  await expect(row).toContainText('Waiting for you. Nothing was sent.');

  // No payout runs. Read back: the master's money is where it was.
  const own = await me.balances();
  expect(own.USDT?.total, JSON.stringify(own)).toBe('250');

  // A read call runs with the same agent key.
  const read = await withKey(agentKey, { path: BALANCE });
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
});
