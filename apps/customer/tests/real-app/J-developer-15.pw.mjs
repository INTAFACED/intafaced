// World: restart, stack
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, api, fund, restartWith } from './stack.mjs';
import { codeOf, withKey } from './developer.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addAuthenticator, addPasskey, forgetSession, nextCode, virtualAuthenticator } from './identity-factors.mjs';
import { openBusiness, paidCardPayment, payApiOf, signInWithCode, verifiedBusiness } from './merchant.mjs';
import { tableIn } from './tables.mjs';

// J-developer-15, in the running app (docs/roadmap/journeys.json): run keys for sub-accounts, teams and agents. One
// test per step, titled "J-developer-15 #<n>", each checking the step's own words. The person is a TEST master account
// with an authenticator, an approved TEST business (#6's payout is of its settlement) and a passkey (only such an
// account may hold a key; the passkey gives each create its fresh step-up), and two sub-accounts, A and B. The master
// is funded with TEST USDT and the sub-accounts hold nothing, so a balance read says whose account answered. The
// stack's TEST value caps keys per sub-account at two (IDENTITY_PORTFOLIO_KEYS_MAX, LOCAL TEST); #2 restarts identity
// with it blank, as it is until the owner sets it.
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
/** The master's approved TEST business, set up before its passkey; #6's agent key asks to pay out its settlement. */
let merchantId = '';

const BALANCE = '/api/v1/account/balance';

/** Fills the create form for a read key, bound to the sub-account labelled `account` (or none), and presses Create with a passkey. */
async function createOnForm({ name, account }) {
  await page.goto('/uc/safe/api-keys/new');
  await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  await page.getByLabel('Key name').fill(name);
  await page.getByLabel('Sub-account', { exact: true }).selectOption({ label: account });
  await page.getByLabel('Read only', { exact: true }).check();
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
  return (
    page
      .getByTestId('api-keys__table')
      .locator('tbody tr')
      // The row header also holds the Agent badge, so the row is found by its name link, which holds the name only.
      .filter({ has: page.getByRole('link', { name, exact: true }) })
  );
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(480_000);
  // The master: an authenticator first (its only factor then, so a password session may add it), an approved TEST
  // business it owns (#6 pays out from it), then a passkey for each create's step-up. #7's sandbox person is set up the
  // same way.
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  who = await signUp(page, 'jd15');
  await verify(page, who);
  await signInWithCode(page, who, '/uc/safe');
  const { secret, step } = await addAuthenticator(page, totp);
  Object.assign(who, { totp, secret, step });
  await forgetSession(page);
  await signInWithCode(page, who, '/pay/merchant');
  merchantId = await openBusiness(page, who, 'TEST Agent Payout Ltd');
  await verifiedBusiness(page, who, merchantId);
  await forgetSession(page);
  await signInWithCode(page, who, '/uc/safe');
  await addPasskey(page);
  const code = await nextCode(totp, who.secret, who.step);
  who.step = code.step;
  me = await api(who, { totpCode: code.code });
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
  // The list's order is the service's (newest first); the step asks only that both sub-accounts are offered.
  const options = page.getByLabel('Sub-account', { exact: true }).locator('option');
  await expect(options).toHaveCount(3);
  await expect(options.first()).toHaveText('None: a key for this account');
  expect((await options.allTextContents()).slice(1).sort()).toEqual(['Sub A', 'Sub B']);
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
  // The edge's key door answers a denied key 401 (`API_KEY_DENIED`, services/svc-edge/src/api-key-refusal.ts).
  expect(orders.status, JSON.stringify(orders.body).slice(0, 300)).toBe(401);
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

test(`${J} #4 a member with a read role opens the key page: create and revoke are disabled with the reason; the owner changes the role; with roles not published the page says roles not set`, async ({
  browser,
}) => {
  test.setTimeout(360_000);
  // The business team: an organisation the master owns, with a key made for it (bound to sub-account A) on the form.
  const made = await me.post('/api/identity/trpc/createOrg', { name: `TEST team ${Date.now().toString(36)}` });
  expect(made.status, JSON.stringify(made.body).slice(0, 300)).toBe(200);
  const orgId = made.body.result.data.id;
  await page.goto(`/uc/safe/api-keys/new?org=${orgId}`);
  await page.getByLabel('Key name').fill('team-reader');
  await page.getByLabel('Sub-account', { exact: true }).selectOption({ label: 'Sub A' });
  await page.getByLabel('Read only', { exact: true }).check();
  await page.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
  await takeShownKey();

  // A member of the team, given the developer role "Read keys" by the owner on the key page.
  const memberPage = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  const memberWho = await signUp(memberPage, 'jd15m');
  await verify(memberPage, memberWho);
  await signIn(memberPage, memberWho);
  const member = await api(memberWho);
  const added = await me.post('/api/identity/trpc/addOrgMember', { orgId, memberId: member.userId, role: 'trader' });
  expect(added.status, JSON.stringify(added.body).slice(0, 300)).toBe(200);
  const ownerArea = () => page.locator(`[data-testid="api-keys__org"][data-org-id="${orgId}"]`);
  const memberArea = () => memberPage.locator(`[data-testid="api-keys__org"][data-org-id="${orgId}"]`);
  async function ownerSetsRole(label) {
    await page.goto('/uc/safe/api-keys');
    const row = ownerArea().locator(`[data-member-id="${member.userId}"]`);
    await row.getByLabel('Developer role').selectOption({ label });
    await row.getByRole('button', { name: 'Save role' }).click();
    await expect(ownerArea().getByRole('status').filter({ hasText: 'The role is saved.' })).toBeVisible();
    await expect(row.getByLabel('Developer role')).toHaveValue(label === 'Read keys' ? 'keys_read' : 'keys_admin');
  }
  try {
    await expect(ownerArea().getByTestId('api-keys__my-role')).toHaveText('Your developer role: Owner: you manage keys and roles');
    await ownerSetsRole('Read keys');

    // The member opens the key page: the team's key is listed, and Create and Revoke are disabled with the reason.
    await memberPage.goto('/uc/safe/api-keys');
    const reason = 'You can’t create or revoke keys here: your role only reads keys.';
    await expect(memberArea().getByTestId('api-keys__my-role')).toHaveText(
      'Your developer role: Read keys: you see keys but cannot change them',
    );
    await expect(memberArea().getByTestId('api-keys__manage-reason')).toHaveText(reason);
    const create = memberArea().getByTestId('api-keys__org-create');
    await expect(create).toBeDisabled();
    await expect(create).toHaveAccessibleDescription(reason);
    const keyRowM = memberArea()
      .locator('tbody tr')
      .filter({ has: memberPage.getByRole('rowheader', { name: 'team-reader', exact: true }) });
    await expect(keyRowM).toHaveCount(1);
    const revoke = keyRowM.getByRole('button', { name: 'Revoke', exact: true });
    await expect(revoke).toBeDisabled();
    await expect(revoke).toHaveAccessibleDescription(reason);
    // The service holds the same line: the member's revoke and create for the team are refused, and the key still works.
    const keyId = await keyRowM.getAttribute('data-key-id');
    const revoked = await member.post('/api/identity/trpc/developerKeys.revoke', { keyId, orgId });
    expect(revoked.status, JSON.stringify(revoked.body).slice(0, 300)).toBe(403);
    expect(revoked.body?.error?.data?.cause?.code ?? codeOf(revoked.body)).toMatch(/identity\.developer_role_read_only/);
    // A member never raises a role, theirs included.
    const raised = await member.post('/api/identity/trpc/developerKeys.setTeamRole', {
      orgId,
      userId: member.userId,
      role: 'keys_admin',
      requestId: `jd15-raise-${Date.now()}`,
    });
    expect(raised.status, JSON.stringify(raised.body).slice(0, 300)).toBe(403);
    expect(JSON.stringify(raised.body)).toContain('identity.developer_role_denied');

    // The owner can change the role: as a key admin the member's Create and Revoke are enabled.
    await ownerSetsRole('Key admin');
    await memberPage.goto('/uc/safe/api-keys');
    await expect(memberArea().getByTestId('api-keys__my-role')).toHaveText('Your developer role: Key admin: you create and revoke keys');
    await expect(memberArea().getByTestId('api-keys__manage-reason')).toHaveCount(0);
    await expect(memberArea().getByTestId('api-keys__org-create')).toHaveAttribute('href', `/uc/safe/api-keys/new?org=${orgId}`);
    await expect(keyRowM.getByRole('button', { name: 'Revoke', exact: true })).toBeEnabled();

    // With the owner's roles not published, the page says roles not set, and the owner's role change is refused.
    restartWith('identity', 'LOCAL_STACK_IDENTITY_DEVELOPER_ROLES', false);
    try {
      await memberPage.goto('/uc/safe/api-keys');
      await expect(memberArea().getByTestId('api-keys__roles-unset')).toContainText('Roles not set.');
      await expect(memberArea().getByTestId('api-keys__org-create')).toBeDisabled();
      await expect(memberArea().getByTestId('api-keys__manage-reason')).toHaveText('You can’t create or revoke keys here: roles not set.');
      const ownerChange = await me.post('/api/identity/trpc/developerKeys.setTeamRole', {
        orgId,
        userId: member.userId,
        role: 'keys_read',
        requestId: `jd15-unset-${Date.now()}`,
      });
      expect(ownerChange.status, JSON.stringify(ownerChange.body).slice(0, 300)).toBe(412);
      expect(JSON.stringify(ownerChange.body)).toContain('identity.developer_roles_unset');
      await page.goto('/uc/safe/api-keys');
      await expect(ownerArea().getByTestId('api-keys__roles-unset')).toContainText('Roles not set.');
      await expect(ownerArea().locator(`[data-member-id="${member.userId}"]`).getByLabel('Developer role')).toBeDisabled();
    } finally {
      restartWith('identity', 'LOCAL_STACK_IDENTITY_DEVELOPER_ROLES', true);
    }
  } finally {
    await memberPage.context().close();
  }
});

test(`${J} #5 creates an agent key: it is tagged and restricted, and a forbidden scope is refused at create`, async () => {
  test.setTimeout(180_000);
  // A forbidden scope: an agent key asking for a settings permission (identity:write) is refused at create, and none is made.
  await page.goto('/uc/safe/api-keys/new');
  await expect(page.getByRole('heading', { name: 'Create an API key' })).toBeVisible();
  await page.getByLabel('Key name').fill('agent-settings');
  await page.getByLabel('This key is for an AI agent').check();
  await page.getByLabel('Choose', { exact: true }).check();
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
  await page.getByLabel('Choose', { exact: true }).check();
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
  test.setTimeout(480_000);
  expect(agentKey, 'the agent key from #5').toMatch(/^ifc_/);
  // A payout that could really run: the master's business takes a TEST card payment and settles the day, so svc-pay
  // holds a posted settlement with money available to pay out (as J-merchant-02 #5 sets one up). The agent key then
  // asks to pay that settlement out.
  const pay = await payApiOf(who, (next) => {
    who.step = next;
  });
  const paid = await paidCardPayment(pay, merchantId, { key: `${J}:#6:payment:${merchantId}`, amount: '25.00' });
  expect(paid.status).toBe('captured');
  const posted = await pay.mutate('settlement.run', { merchantId, window: new Date().toISOString().slice(0, 10), assetId: 'USDT' });
  expect(posted.status).toBe('posted');
  const settlementBefore = await pay.query('settlement.get', { settlementId: posted.id });
  expect(settlementBefore).toMatchObject({ id: posted.id, merchantId, status: 'posted' });
  expect(settlementBefore.payoutRef ?? null, 'not paid out yet').toBeNull();
  // Read straight from the ledger through svc-pay (not the metrics projection, which fills a moment later).
  const available = async () => (await pay.query('merchant.balances', { merchantId, assetId: 'USDT' })).available;
  const availableBefore = await available();
  expect(availableBefore, 'the posted net is available to pay out').toMatch(/^\d+(\.\d+)?$/);
  expect(availableBefore).not.toMatch(/^0(\.0+)?$/);

  const asked = { settlementId: posted.id, railId: 'crypto-native' };
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

  // No payout runs. Read back from svc-pay: the settlement is still posted, with no payout reference, and the business's
  // available money is where it was; and the master's own money is where it was.
  expect(await pay.query('settlement.get', { settlementId: posted.id })).toEqual(settlementBefore);
  expect(await available()).toBe(availableBefore);
  const own = await me.balances();
  expect(own.USDT?.total, JSON.stringify(own)).toBe('250');

  // A read call runs with the same agent key.
  const read = await withKey(agentKey, { path: BALANCE });
  expect(read.status, JSON.stringify(read.body).slice(0, 300)).toBe(200);
});

test(`${J} #7 the API explorer with a live key builds a write: a typed refusal; with a sandbox key it runs`, async ({ browser }) => {
  test.setTimeout(600_000);
  expect(agentKey, 'the live key from #5').toMatch(/^ifc_(?!test_)/);
  // A person with an approved TEST business (as J-developer-02 sets one up) and a passkey, who holds a sandbox key with
  // the TEST payments preset.
  const { totp } = await import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));
  const sbPage = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  try {
    await virtualAuthenticator(sbPage);
    const sbWho = await signUp(sbPage, 'jd15sb');
    await verify(sbPage, sbWho);
    await signInWithCode(sbPage, sbWho, '/uc/safe');
    const { secret, step } = await addAuthenticator(sbPage, totp);
    Object.assign(sbWho, { totp, secret, step });
    await forgetSession(sbPage);
    await signInWithCode(sbPage, sbWho, '/pay/merchant');
    const merchantId = await openBusiness(sbPage, sbWho);
    await verifiedBusiness(sbPage, sbWho, merchantId);
    await forgetSession(sbPage);
    await signInWithCode(sbPage, sbWho, '/uc/safe');
    delete sbWho.totp;
    await addPasskey(sbPage);
    await sbPage.goto('/developers/sandbox');
    await sbPage.getByRole('textbox', { name: 'Sandbox name' }).fill('explorer');
    await sbPage.getByRole('button', { name: 'Create sandbox' }).click();
    await sbPage.getByRole('link', { name: 'explorer', exact: true }).click();
    await sbPage.getByRole('link', { name: 'Create a sandbox key' }).click();
    await sbPage.getByLabel('Key name').fill('explorer-payments');
    await sbPage.getByLabel('Test payments', { exact: true }).check();
    await sbPage.getByRole('button', { name: 'Create with a passkey', exact: true }).click();
    const sandboxKey = (await sbPage.getByTestId('api-keys__key').textContent())?.trim();
    expect(sandboxKey).toMatch(/^ifc_test_/);
    await sbPage.getByLabel('I have stored this key somewhere safe').check();
    await sbPage.getByRole('button', { name: 'Done' }).click();

    await sbPage.goto('/developers/sandbox/test-values');
    const tokenRow = tableIn(sbPage, 'Test values').getByRole('row', { name: /Decline/ });
    const cardToken = (await tokenRow.getByRole('code').first().textContent())?.trim();
    expect(cardToken).toBeTruthy();

    /** Builds the payment write in the explorer with `key` and sends it; returns the explorer's answer section. */
    async function sendWrite(p, key) {
      await p.goto('/developers/explorer');
      await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
      await p.getByLabel('API key').fill(key);
      await p.getByLabel('Request').selectOption('payment-create');
      await p.getByLabel('Business id').fill(merchantId);
      // The explorer builds the request and shows it as code before anything is sent; the key itself is never printed.
      await expect(p.getByTestId('explorer-code')).toContainText(`POST`);
      await expect(p.getByTestId('explorer-code')).toContainText('/api/pay/v1/payments');
      await expect(p.getByTestId('explorer-code')).not.toContainText(key);
      const body = JSON.parse(await p.getByLabel('Body (JSON)').inputValue());
      expect(body).toMatchObject({ merchantId, railAdapter: 'card-sandbox' });
      // The card token comes from the sandbox's test values page, as the body's hint says.
      body.instrument.token = cardToken;
      await p.getByLabel('Body (JSON)').fill(JSON.stringify(body, null, 2));
      await p.getByRole('button', { name: 'Send', exact: true }).click();
      return p.getByTestId('explorer-answer');
    }

    // A live key: the write is refused with the typed reason, before it reaches the service, and no payment exists.
    // The business's payments as svc-pay lists them, read by its owner before and after the live write.
    const owner = await payApiOf(sbWho, (next) => {
      sbWho.step = next;
    });
    const payments = async () => (await owner.query('payment.list', { merchantId, limit: 25 })).items.map((item) => item.id);
    const paymentsBefore = await payments();
    // The refusal is the stack's own answer: the edge's response to the explorer's request, caught on the wire.
    const liveAnswer = page.waitForResponse((r) => r.url().includes('/api/pay/v1/payments') && r.request().method() === 'POST');
    const live = await sendWrite(page, agentKey);
    const refusedOnWire = await liveAnswer;
    expect(refusedOnWire.status()).toBe(403);
    expect(codeOf(await refusedOnWire.json())).toBe('edge.explorer_live_write_refused');
    await expect(page.getByTestId('explorer-key-mode')).toHaveText('Live key: reads only.');
    await expect(live.getByTestId('explorer-status')).toHaveText('Status 403');
    await expect(live.getByTestId('explorer-refused')).toContainText('Refused: edge.explorer_live_write_refused');
    await expect(live.getByTestId('explorer-refused')).toContainText('Nothing was sent.');
    // No payment exists: svc-pay lists the same payments for the business as before the live write.
    expect(await payments()).toEqual(paymentsBefore);

    // A sandbox key: the same write runs, at the sandbox address, as a sandbox payment.
    const ran = await sendWrite(sbPage, sandboxKey);
    await expect(sbPage.getByTestId('explorer-key-mode')).toHaveText('Sandbox key: sent to your sandbox address.');
    await expect(ran.getByTestId('explorer-status')).toHaveText(/Status 20\d/);
    await expect(ran.getByTestId('explorer-refused')).toHaveCount(0);
    const answered = JSON.parse((await ran.getByTestId('explorer-body').textContent()) ?? '{}');
    expect(answered, JSON.stringify(answered)).toMatchObject({ mode: 'sandbox', status: 'created' });
  } finally {
    await sbPage.context().close();
  }
});
