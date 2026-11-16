// World: stack
import { randomBytes, randomUUID } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, api as ledgerApi, journeyState, json, signOutBrowser, signUpInBrowser } from './stack.mjs';
import { signIn, verify } from './desk.mjs';

// J-bank-19, in the running app (docs/roadmap/journeys.json): I set up my business bank team and approval rules. Tests
// titled "J-bank-19 #<n>" prove a step.
//
// Starts: the owner signs up as a business, is verified, opens a business bank account and works in Business mode
// (the account menu's business profile). The business's money is the TEST partner bank's: the owner's bank money is
// held there (`custody: 'off'`) and TEST 10000 USDT is paid into the business's own partner account
// (`testPartner.fundBusiness`), the partner's figure and no ledger post. A payment is one instruction to the partner,
// under `bank.business.payment:<id>`, sent when the last approval its rule asks for is given; the ledger posts nothing.
//
// The team: a Bookkeeper (view and export), an office manager (view and manage the team, not approve), two approvers
// (the built-in checker role), an advisor, and a newcomer invited by an email no account has yet. Invites last the bank
// profile's TEST 2 minutes (BANK_BUSINESS_INVITE_MINUTES in tooling/profiles/test-owner-values/bank.json); blank, every
// invite refuses bank.business_invite_lifetime_unset (services/svc-bank/src/business/business-team.db.test.ts).
const J = 'J-bank-19';
const RUN = Date.now().toString(36);
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const PARTNER_BANK = 'TEST partner bank';
const FUNDED = '10000';
const INVITE_MS = 2 * 60_000;

test.describe.configure({ mode: 'default' });

/** The person's own svc-bank API through Edge, with a session of its own (not the browser's). */
async function bank(who) {
  const { status, body: login } = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  }).then(json);
  const token = login?.result?.data?.accessToken;
  if (!token) throw new Error(`sign-in for ${who.email} refused: ${status} ${JSON.stringify(login).slice(0, 300)}`);
  const headers = { origin: ORIGIN, authorization: `Bearer ${token}` };
  const answer = async (res) => {
    const body = await res.json();
    if (!res.ok)
      return {
        ok: false,
        status: res.status,
        code: body?.error?.data?.intafacedCode ?? body?.error?.data?.cause?.code ?? body?.error?.data?.code,
        body,
      };
    return { ok: true, data: body.result.data };
  };
  return {
    userId: login.result.data.userId,
    query: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers }).then(answer),
    mutate: (procedure, input) =>
      fetch(`${EDGE}/api/bank/trpc/${procedure}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(input),
      }).then(answer),
  };
}

/** The answer's data, or the test fails with the bank's own refusal. */
function ok(res) {
  expect(res.ok, JSON.stringify(res.body ?? {}).slice(0, 400)).toBe(true);
  return res.data;
}

/** A TEST person with a known email, signed up in the browser and verified; signed out after. */
async function person(page, prefix, options = {}) {
  const handle = `${prefix}${RUN}${randomBytes(2).toString('hex')}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await signUpInBrowser(page, who, options);
  await verify(page, who);
  return who;
}

/** The ledger's figures for `who`: the business's money is the partner's, so these never change in this journey. */
async function ledgerOf(who) {
  return (await ledgerApi(who)).balances();
}

/**
 * The journey's start, made once a run and kept in its run file: the verified owner, signed up as a business, with a
 * business bank account whose money is TEST 10000 USDT at the TEST partner; and the people the team will hold. The first
 * approver joins as a checker (step 4 needs them in two businesses; steps 5 and 6 need them approving).
 */
async function world(page) {
  const kept = run.read();
  if (kept.accountId) return kept;
  const owner = await person(page, 'jb19o', { accountType: 'business' });
  const book = await person(page, 'jb19b');
  const office = await person(page, 'jb19m');
  const a1 = await person(page, 'jb19x');
  const a2 = await person(page, 'jb19y');
  const advisor = await person(page, 'jb19v');
  const own = await bank(owner);
  ok(await own.mutate('testPartner.set', { custody: 'off' }));
  const accountId = randomUUID();
  const name = `TEST Team ${RUN}`;
  ok(await own.mutate('business.create', { accountId, name, assetId: 'USDT', spendThreshold: '1' }));
  const funded = ok(await own.mutate('testPartner.fundBusiness', { accountId, fundId: `jb19-${accountId}`.slice(0, 64), amount: FUNDED }));
  expect(funded).toMatchObject({ label: PARTNER_BANK, assetId: 'USDT', balance: FUNDED });
  await joinByApi(own, accountId, a1, { role: 'checker' });
  const ownerLedger = await ledgerOf(owner);
  return run.reset({ owner, book, office, a1, a2, advisor, accountId, name, ownerLedger });
}

/** `who` joins through an invite the owner makes, both by API (a step's setup, never a step's proof). */
async function joinByApi(own, accountId, who, invite) {
  const made = ok(
    await own.mutate('businessTeam.invite', {
      accountId,
      inviteId: randomUUID(),
      email: null,
      role: invite.role ?? null,
      roleId: invite.roleId ?? null,
    }),
  );
  const res = await (await bank(who)).mutate('businessTeam.acceptInvite', { token: made.token });
  if (!res.ok && res.code !== 'bank.business_already_member') ok(res);
}

/** Is `who` on the business? A later step makes sure of an earlier one's member without proving it again. */
async function isMember(accountId, who) {
  return (await (await bank(who)).query('businessTeam.overview', { accountId })).ok;
}

/** `who` signed in to the browser, in Business mode on `name`, on the team room. */
async function inBusiness(page, who, name, path = '/bank/business/team') {
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto('/home');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByTestId('profile-business').filter({ hasText: name }).click();
  await page.goto(path);
  await expect(page.getByTestId('team-business')).toHaveText(name);
}

/** `who` signed in to the browser, on `path`, in whatever profile they are in. */
async function signedInAt(page, who, path) {
  await signOutBrowser(page.context());
  await signIn(page, who);
  await page.goto(path);
}

/** The owner's two TEST approval rules of step 5, by API when step 5 itself did not save them. */
async function rules(own, accountId) {
  const now = ok(await own.query('businessTeam.rules', { accountId }));
  for (const [over, approvals] of [
    ['1000', 1],
    ['5000', 2],
  ]) {
    if (!now.some((r) => r.overAmount === over && r.payee === null && r.paymentType === null && r.approvals === approvals)) {
      ok(
        await own.mutate('businessTeam.addRule', {
          accountId,
          ruleId: randomUUID(),
          overAmount: over,
          payee: null,
          paymentType: null,
          approvals,
        }),
      );
    }
  }
}

test(`${J} #1 builds a role "Bookkeeper" with view and export only: a member with it sees approvals refused with bank.business_role_forbidden; a role granting a permission the creating admin lacks is refused`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  const own = await bank(w.owner);

  // The owner builds the two roles in the app.
  await inBusiness(page, w.owner, w.name);
  const createRole = async (name, perms) => {
    const form = page.getByRole('form', { name: 'Create role' });
    await form.getByLabel('Role name').fill(name);
    for (const p of perms) await form.getByLabel(p, { exact: true }).check();
    await form.getByRole('button', { name: 'Create role' }).click();
    await expect(page.getByTestId('team-role').filter({ hasText: name })).toHaveCount(1);
  };
  await createRole('Bookkeeper', ['view', 'export']);
  await createRole('Office manager', ['view', 'manage the team']);
  const roles = ok(await own.query('businessTeam.roles', { accountId: w.accountId }));
  const bookkeeper = roles.find((r) => r.name === 'Bookkeeper');
  const officeRole = roles.find((r) => r.name === 'Office manager');
  expect(bookkeeper.permissions).toEqual(['view', 'export']);
  expect(officeRole.permissions).toEqual(['view', 'manage_team']);
  await expect(page.getByTestId('team-role').filter({ hasText: 'Bookkeeper' })).toHaveAttribute('data-permissions', 'view export');

  // The Bookkeeper and the office manager join with those roles.
  await joinByApi(own, w.accountId, w.book, { roleId: bookkeeper.id });
  await joinByApi(own, w.accountId, w.office, { roleId: officeRole.id });
  const members = ok(await own.query('businessTeam.members', { accountId: w.accountId }));
  expect(members.find((m) => m.handle === w.book.handle)).toMatchObject({
    customRole: { name: 'Bookkeeper' },
    permissions: ['view', 'export'],
  });

  // A payment waits for one approval (a TEST rule for one payee and type; step 5's rules are by amount alone).
  ok(
    await own.mutate('businessTeam.addRule', {
      accountId: w.accountId,
      ruleId: randomUUID(),
      overAmount: '0',
      payee: 'TEST Audit firm',
      paymentType: 'international',
      approvals: 1,
    }),
  );
  const paymentId = randomUUID();
  const waiting = ok(
    await own.mutate('businessTeam.propose', {
      accountId: w.accountId,
      paymentId,
      payee: 'TEST Audit firm',
      paymentType: 'international',
      amount: '10',
    }),
  );
  expect(waiting).toMatchObject({ status: 'pending', approvalsNeeded: 1 });

  // The Bookkeeper opens it and approves: refused by name, and it still waits.
  await signedInAt(page, w.book, `/bank/business/payment?id=${paymentId}`);
  await expect(page.getByTestId('team-payment-detail')).toHaveAttribute('data-status', 'pending');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('team-refusal')).toHaveAttribute('data-code', 'bank.business_role_forbidden');
  expect(await (await bank(w.book)).mutate('businessTeam.approve', { paymentId })).toMatchObject({
    ok: false,
    code: 'bank.business_role_forbidden',
  });
  expect(ok(await own.query('businessTeam.payment', { paymentId }))).toMatchObject({ status: 'pending', approvals: [] });

  // The office manager can manage the team but cannot approve, so a role granting approve is refused and none is made.
  await inBusiness(page, w.office, w.name);
  const form = page.getByRole('form', { name: 'Create role' });
  await form.getByLabel('Role name').fill('Approver TEST');
  await form.getByLabel('view', { exact: true }).check();
  await form.getByLabel('approve payments', { exact: true }).check();
  await form.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByTestId('team-refusal')).toHaveAttribute('data-code', 'bank.business_role_grant_exceeds');
  expect(ok(await own.query('businessTeam.roles', { accountId: w.accountId })).map((r) => r.name)).toEqual([
    'Bookkeeper',
    'Office manager',
  ]);

  // The waiting payment is declined, so nothing of this step is sent.
  expect(ok(await own.mutate('businessTeam.reject', { paymentId })).status).toBe('rejected');
  run.write({ bookkeeperRoleId: bookkeeper.id, officeRoleId: officeRole.id });
});

test(`${J} #2 adds an advisor: advisor access needs the owner's approval`, async ({ page }) => {
  test.setTimeout(600_000);
  const w = await world(page);
  const own = await bank(w.owner);
  if (!(await isMember(w.accountId, w.office))) {
    const officeRole =
      w.officeRoleId ??
      ok(
        await own.mutate('businessTeam.createRole', {
          accountId: w.accountId,
          roleId: randomUUID(),
          name: 'Office manager',
          permissions: ['view', 'manage_team'],
        }),
      ).id;
    await joinByApi(own, w.accountId, w.office, { roleId: officeRole });
  }

  // The office manager adds the advisor in the app: it waits for the owner.
  await inBusiness(page, w.office, w.name);
  const add = page.getByRole('form', { name: 'Add advisor' });
  await add.getByLabel('Advisor’s handle').fill(w.advisor.handle);
  await add.getByRole('button', { name: 'Add advisor' }).click();
  const row = page.getByTestId('team-advisor').filter({ hasText: w.advisor.handle });
  await expect(row).toHaveAttribute('data-status', 'pending');
  await expect(row).toContainText('Waiting for the owner’s approval');

  // Until then the advisor reads nothing, and the office manager cannot approve them.
  const adv = await bank(w.advisor);
  expect(await adv.query('businessTeam.overview', { accountId: w.accountId })).toMatchObject({
    ok: false,
    code: 'bank.business_not_member',
  });
  expect(ok(await adv.query('business.list', { limit: 50 })).map((b) => b.id)).not.toContain(w.accountId);
  await row.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('team-refusal')).toHaveAttribute('data-code', 'bank.business_owner_only');
  await expect(row).toHaveAttribute('data-status', 'pending');

  // The owner approves in the app; the advisor then reads the business, and may only read.
  await inBusiness(page, w.owner, w.name);
  const mine = page.getByTestId('team-advisor').filter({ hasText: w.advisor.handle });
  await mine.getByRole('button', { name: 'Approve' }).click();
  await expect(mine).toHaveAttribute('data-status', 'approved');
  const seen = ok(await adv.query('businessTeam.overview', { accountId: w.accountId }));
  expect(seen.me).toMatchObject({ advisor: true, permissions: ['view'] });
  expect(
    await adv.mutate('businessTeam.addRule', {
      accountId: w.accountId,
      ruleId: randomUUID(),
      overAmount: '1',
      payee: null,
      paymentType: null,
      approvals: 1,
    }),
  ).toMatchObject({ ok: false, code: 'bank.business_role_forbidden' });
});

test(`${J} #3 invites a member by email or link: an invite to a new email; opened after expiry it is refused with bank.business_invite_expired and the admin can resend; a revoked invite refuses`, async ({
  page,
}) => {
  test.setTimeout(900_000);
  const w = await world(page);
  await inBusiness(page, w.owner, w.name);
  await expect(page.getByTestId('team-invite-lifetime')).toHaveText('An invite lasts 2 minutes.');
  const invites = page.getByTestId('team-invites');
  const link = page.getByTestId('team-invite-link');
  /** The link shown now, or '' while none is. */
  const shown = async () => ((await link.count()) ? await link.getByLabel('Invite link').inputValue() : '');
  /** Sends one invite and waits for its own link: the box shows the newest link, so it waits until that changes. */
  const send = async (email, role) => {
    const prior = await shown();
    const form = page.getByRole('form', { name: 'Send invite' });
    await form.getByLabel('Email (leave blank to invite by link)').fill(email);
    await form.getByLabel('Role').selectOption({ label: role });
    await form.getByRole('button', { name: 'Send invite' }).click();
    await expect.poll(shown).not.toBe(prior);
    return link;
  };

  // A link invite for the second approver, made first so it expires while the rest of the step runs.
  const toApprover = await send('', 'checker');
  await expect(toApprover).toContainText('Anyone signed in with it can join.');
  const expiringUrl = await toApprover.getByLabel('Invite link').inputValue();
  const madeAt = Date.now();
  expect(expiringUrl).toMatch(/\/bank\/business\/join#[A-Za-z0-9_-]{16,}$/);

  // An invite to an email no account has yet: listed as open until its time, with its link to send.
  const newcomer = {
    handle: `jb19n${RUN}${randomBytes(2).toString('hex')}`,
    password: `TEST-${randomBytes(9).toString('base64url')}-9a`,
  };
  newcomer.email = `${newcomer.handle}@local-test.invalid`;
  const toEmail = await send(newcomer.email, 'viewer');
  await expect(toEmail).toContainText(`Send this link to ${newcomer.email} yourself; only that account can use it.`);
  const emailUrl = await toEmail.getByLabel('Invite link').inputValue();
  const emailed = invites.getByTestId('team-invite').filter({ hasText: newcomer.email });
  await expect(emailed).toHaveAttribute('data-status', 'open');
  await expect(emailed).toContainText('until');

  // A third invite, revoked: its link refuses.
  const revokedUrl = await (await send('', 'viewer')).getByLabel('Invite link').inputValue();
  const own = await bank(w.owner);
  const listed = ok(await own.query('businessTeam.invites', { accountId: w.accountId }));
  const revoked = listed.find((i) => i.kind === 'link' && i.role === 'viewer' && i.status === 'open');
  await invites.locator(`[data-invite="${revoked.id}"]`).getByRole('button', { name: 'Revoke' }).click();
  await expect(invites.locator(`[data-invite="${revoked.id}"]`)).toHaveAttribute('data-status', 'revoked');
  await signedInAt(page, w.book, new URL(revokedUrl).pathname + new URL(revokedUrl).hash);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByTestId('team-refusal')).toHaveAttribute('data-code', 'bank.business_invite_revoked');

  // Another account opening the email invite is refused; the newcomer signs up with that email and joins.
  expect(await (await bank(w.book)).mutate('businessTeam.acceptInvite', { token: new URL(emailUrl).hash.slice(1) })).toMatchObject({
    ok: false,
    code: 'bank.business_invite_wrong_person',
  });
  await signOutBrowser(page.context());
  await signUpInBrowser(page, newcomer);
  await verify(page, newcomer);
  await signedInAt(page, newcomer, new URL(emailUrl).pathname + new URL(emailUrl).hash);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByTestId('team-joined')).toContainText(`You joined ${w.name}.`);

  // The approver's link, opened after its two minutes: refused by name, and it shows as expired to the owner.
  await page.waitForTimeout(Math.max(0, madeAt + INVITE_MS + 5_000 - Date.now()));
  await signedInAt(page, w.a2, new URL(expiringUrl).pathname + new URL(expiringUrl).hash);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByTestId('team-refusal')).toHaveAttribute('data-code', 'bank.business_invite_expired');
  expect(await isMember(w.accountId, w.a2)).toBe(false);

  // The owner sends it again; the old link no longer works, the new one does.
  await inBusiness(page, w.owner, w.name);
  const expired = page.getByTestId('team-invite').filter({ hasText: 'Expired' }).first();
  await expect(expired).toHaveAttribute('data-status', 'expired');
  const before = await shown();
  await expired.getByRole('button', { name: 'Send again' }).click();
  await expect.poll(shown).not.toBe(before);
  const againUrl = await shown();
  expect(againUrl).not.toBe(expiringUrl);
  expect(await (await bank(w.a2)).mutate('businessTeam.acceptInvite', { token: new URL(expiringUrl).hash.slice(1) })).toMatchObject({
    ok: false,
    code: 'bank.business_invite_replaced',
  });
  await signedInAt(page, w.a2, new URL(againUrl).pathname + new URL(againUrl).hash);
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByTestId('team-joined')).toContainText(`You joined ${w.name}.`);
  const members = ok(await own.query('businessTeam.members', { accountId: w.accountId }));
  expect(members.find((m) => m.handle === w.a2.handle)).toMatchObject({ role: 'checker' });
  expect(members.find((m) => m.handle === newcomer.handle)).toMatchObject({ role: 'viewer' });
});

test(`${J} #4 switches between business and personal accounts: a user in two businesses picks one and every read follows it`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const w = await world(page);
  const a1 = await bank(w.a1);
  const second = run.read().secondId ?? randomUUID();
  const secondName = `TEST Second ${RUN}`;
  const made = await a1.mutate('business.create', {
    accountId: second,
    name: run.read().secondName ?? secondName,
    assetId: 'USDT',
    spendThreshold: '1',
  });
  ok(made);
  run.write({ secondId: second, secondName: made.data.name });

  // In the first business: its name, the owner on its team, and its balance at the partner.
  await inBusiness(page, w.a1, w.name);
  await expect(page.getByTestId('team-room')).toHaveAttribute('data-account', w.accountId);
  await expect(page.getByTestId('team-member').filter({ hasText: w.owner.handle })).toHaveCount(1);
  await expect(page.getByTestId('team-balance')).toContainText(PARTNER_BANK);

  // Picking the second: every read is the second's. Only its owner is on it, and it holds nothing at a partner.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByTestId('profile-business').filter({ hasText: made.data.name }).click();
  await page.goto('/bank/business/team');
  await expect(page.getByTestId('team-business')).toHaveText(made.data.name);
  await expect(page.getByTestId('team-room')).toHaveAttribute('data-account', second);
  await expect(page.getByTestId('team-member')).toHaveCount(1);
  await expect(page.getByTestId('team-member').filter({ hasText: w.a1.handle })).toHaveCount(1);
  await expect(page.getByTestId('team-member').filter({ hasText: w.owner.handle })).toHaveCount(0);
  await expect(page.getByTestId('team-balance')).toHaveText('This business’s money is not held at a partner bank.');
  await expect(page.getByTestId('team-payments')).toContainText('No payments yet.');

  // Personal: no business is read, so no company figure is shown as theirs.
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByTestId('profile-personal').click();
  await page.goto('/bank/business/team');
  await expect(page.getByText('Choose a business').first()).toBeVisible();
  await expect(page.getByTestId('team-room')).toHaveCount(0);
  await expect(page.getByTestId('team-balance')).toHaveCount(0);
});

test(`${J} #5 sets approval rules by amount, payee and payment type: two TEST rules saved; a payment of 6000.00 needs two distinct approvers`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const w = await world(page);
  const own = await bank(w.owner);
  if (!(await isMember(w.accountId, w.a2))) await joinByApi(own, w.accountId, w.a2, { role: 'checker' });

  await inBusiness(page, w.owner, w.name);
  const save = async (over, approvals, { payee = '', type = 'any type' } = {}) => {
    const form = page.getByRole('form', { name: 'Save rule' });
    await form.getByLabel('Over (USDT)').fill(over);
    await form.getByLabel('Payee (leave blank for any)').fill(payee);
    await form.getByLabel('Payment type').selectOption({ label: type });
    await form.getByLabel('Approvers needed').selectOption(String(approvals));
    await form.getByRole('button', { name: 'Save rule' }).click();
    await expect(page.locator(`[data-testid="team-rule"][data-over="${over}"][data-approvals="${approvals}"]`)).toHaveCount(1);
  };
  // Two TEST rules, each set by amount, payee and payment type: any payee and any type, over 1000 one approver, over 5000 two.
  await save('1000', 1);
  await save('5000', 2);
  await expect(page.locator('[data-testid="team-rule"][data-over="1000"]')).toHaveText('Over 1000 USDT, any payee, any type: 1 approvers');
  await expect(page.locator('[data-testid="team-rule"][data-over="5000"]')).toHaveText('Over 5000 USDT, any payee, any type: 2 approvers');
  const saved = ok(await own.query('businessTeam.rules', { accountId: w.accountId }));
  expect(saved.filter((r) => r.overAmount === '1000' && r.approvals === 1 && r.payee === null && r.paymentType === null)).toHaveLength(1);
  expect(saved.filter((r) => r.overAmount === '5000' && r.approvals === 2 && r.payee === null && r.paymentType === null)).toHaveLength(1);

  // The owner proposes TEST 6000.00: the over-5000 rule applies, two approvers, and nothing has been sent.
  const form = page.getByRole('form', { name: 'Propose payment' });
  await form.getByLabel('Payee').fill('TEST Supplier GmbH');
  await form.getByLabel('Payment type').selectOption({ label: 'domestic' });
  await form.getByLabel('Amount (USDT)').fill('6000.00');
  await form.getByRole('button', { name: 'Propose payment' }).click();
  const row = page.locator('[data-testid="team-payment"][data-amount="6000"]').first();
  await expect(row).toHaveAttribute('data-status', 'pending');
  await expect(row).toContainText('Waiting for 2 more approval(s)');
  const paymentId = await row.getAttribute('data-payment');
  const p = ok(await own.query('businessTeam.payment', { paymentId }));
  expect(p).toMatchObject({
    amount: '6000',
    approvalsNeeded: 2,
    rule: { overAmount: '5000', approvals: 2 },
    partnerMoveId: null,
    status: 'pending',
  });

  // Two distinct approvers: the same approver twice still counts once, and the 6000.00 payment keeps waiting, unsent.
  const checker = await bank(w.a1);
  expect(ok(await checker.mutate('businessTeam.approve', { paymentId }))).toMatchObject({
    status: 'pending',
    approvals: [{ userId: w.a1.userId }],
  });
  expect(await checker.mutate('businessTeam.approve', { paymentId })).toMatchObject({ ok: false, code: 'bank.business_already_approved' });
  await signedInAt(page, w.a1, `/bank/business/payment?id=${paymentId}`);
  await expect(page.getByTestId('team-payment-approval')).toHaveCount(1);
  await expect(page.getByTestId('team-payment-result')).toHaveText('Waiting for 1 more approval(s)');
  expect(ok(await own.query('businessTeam.payment', { paymentId }))).toMatchObject({ status: 'pending', partnerMoveId: null });
  // #6 starts from a payment nobody has approved yet: it proposes its own when this one has an approval.
  run.write({ paymentId });
});

test(`${J} #6 opens the approval detail page and approves: the rule that applied, each approval and the result; the maker who is also in the approver pool is refused; the second approval sends one instruction to the partner, once`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const w = await world(page);
  const own = await bank(w.owner);
  if (!(await isMember(w.accountId, w.a2))) await joinByApi(own, w.accountId, w.a2, { role: 'checker' });
  await rules(own, w.accountId);
  let paymentId = run.read().paymentId;
  const before = paymentId ? ok(await own.query('businessTeam.payment', { paymentId })) : null;
  if (!before || before.status !== 'pending' || before.approvals.length > 0) {
    paymentId = randomUUID();
    ok(
      await own.mutate('businessTeam.propose', {
        accountId: w.accountId,
        paymentId,
        payee: 'TEST Supplier GmbH',
        paymentType: 'domestic',
        amount: '6000.00',
      }),
    );
  }
  const ledgers = { owner: await ledgerOf(w.owner), a1: await ledgerOf(w.a1), a2: await ledgerOf(w.a2) };
  const balanceBefore = ok(await own.query('businessTeam.overview', { accountId: w.accountId })).partner.amount;
  const path = `/bank/business/payment?id=${paymentId}`;

  // The page names the rule that applied. The owner proposed it and holds approve, and is refused.
  await signedInAt(page, w.owner, path);
  await expect(page.getByTestId('team-payment-rule')).toHaveText('Over 5000 USDT, any payee, any type: 2 approvers');
  await expect(page.getByTestId('team-payment-rule')).toHaveAttribute('data-needed', '2');
  const me = ok(await own.query('businessTeam.overview', { accountId: w.accountId })).me;
  expect(me.permissions).toContain('approve');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('team-refusal')).toHaveAttribute('data-code', 'bank.business_self_approve');
  await expect(page.getByTestId('team-payment-approval')).toHaveCount(0);

  // The first approver: one approval listed, still waiting, nothing at the partner yet.
  await signedInAt(page, w.a1, path);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByTestId('team-payment-approval')).toHaveCount(1);
  await expect(page.getByTestId('team-payment-result')).toHaveText('Waiting for 1 more approval(s)');
  expect(await (await bank(w.a1)).mutate('businessTeam.approve', { paymentId })).toMatchObject({
    ok: false,
    code: 'bank.business_already_approved',
  });
  expect(ok(await own.query('businessTeam.payment', { paymentId })).partnerMoveId).toBeNull();

  // The second: sent to the partner, with the partner's own reference.
  await signedInAt(page, w.a2, path);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const result = page.getByTestId('team-payment-result');
  await expect(result).toHaveAttribute('data-status', 'sent');
  await expect(result).toHaveText(`Sent to ${PARTNER_BANK}`);
  await expect(page.getByTestId('team-payment-approval')).toHaveCount(2);
  await expect(page.getByTestId('team-payment-approval').nth(0)).toHaveAttribute('data-handle', w.a1.handle);
  await expect(page.getByTestId('team-payment-approval').nth(1)).toHaveAttribute('data-handle', w.a2.handle);
  const moveId = await result.getAttribute('data-move');
  expect(moveId).toMatch(/^test-partner-move-/);

  // Once: approving again sends nothing; the partner has one line for it and took exactly 6000 from the business.
  expect(await (await bank(w.a2)).mutate('businessTeam.approve', { paymentId })).toMatchObject({
    ok: false,
    code: 'bank.business_approval_inactive',
  });
  expect(ok(await own.mutate('businessTeam.resend', { paymentId }))).toMatchObject({ status: 'sent', partnerMoveId: moveId });
  const after = ok(await own.query('businessTeam.overview', { accountId: w.accountId })).partner;
  expect(Number(balanceBefore) - Number(after.amount)).toBe(6000);
  const lines = ok(await own.query('businessTeam.spend', { accountId: w.accountId })).members.find((m) => m.handle === w.owner.handle);
  expect(lines.partnerLines).toBeGreaterThanOrEqual(1);

  // The ledger posted nothing for any of them.
  expect(await ledgerOf(w.owner)).toEqual(ledgers.owner);
  expect(await ledgerOf(w.a1)).toEqual(ledgers.a1);
  expect(await ledgerOf(w.a2)).toEqual(ledgers.a2);
  expect(await ledgerOf(w.owner)).toEqual(w.ownerLedger);
});

test(`${J} #7 opens team spend and departments: by-member totals equal the partner's lines; a member without the grant sees only themselves; a department with a blank budget says so`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const w = await world(page);
  const own = await bank(w.owner);
  if (!(await isMember(w.accountId, w.book))) {
    const role =
      w.bookkeeperRoleId ??
      ok(
        await own.mutate('businessTeam.createRole', {
          accountId: w.accountId,
          roleId: randomUUID(),
          name: 'Bookkeeper',
          permissions: ['view', 'export'],
        }),
      ).id;
    await joinByApi(own, w.accountId, w.book, { roleId: role });
  }
  // A small TEST payment under every rule, sent at once, so the owner has a partner line whatever ran before.
  ok(
    await own.mutate('businessTeam.propose', {
      accountId: w.accountId,
      paymentId: randomUUID(),
      payee: 'TEST Cafe',
      paymentType: 'domestic',
      amount: '12.50',
    }),
  );

  await inBusiness(page, w.owner, w.name, '/bank/business/spend');
  const depName = `Operations TEST ${RUN}`;
  const add = page.getByRole('form', { name: 'Add department' });
  await add.getByLabel('Department name').fill(depName);
  await add.getByRole('button', { name: 'Add department' }).click();
  const dep = page.getByTestId('team-department').filter({ hasText: depName });
  await expect(dep.getByTestId('team-department-budget')).toHaveText('No budget set');
  await expect(dep).toHaveAttribute('data-budget', '');
  await page.getByLabel(`Department for ${w.owner.handle}`).selectOption({ label: depName });
  await page
    .getByRole('listitem')
    .filter({ has: page.getByLabel(`Department for ${w.owner.handle}`) })
    .getByRole('button', { name: 'Set department' })
    .click();

  // Every member's partner lines equal the business's own record of what it sent, and the department sums them.
  const rows = page.getByTestId('team-spend-member');
  await expect(rows.filter({ hasText: w.owner.handle })).toHaveCount(1);
  for (const row of await rows.all()) {
    expect(await row.getAttribute('data-partner')).toBe(await row.getAttribute('data-record'));
  }
  const ownerRow = rows.filter({ hasText: w.owner.handle });
  const ownerTotal = await ownerRow.getAttribute('data-partner');
  expect(Number(ownerTotal)).toBeGreaterThanOrEqual(12.5);
  expect(Number(await ownerRow.getAttribute('data-lines'))).toBeGreaterThanOrEqual(1);
  await expect(dep).toHaveAttribute('data-spent', ownerTotal);
  const spend = ok(await own.query('businessTeam.spend', { accountId: w.accountId }));
  expect(spend).toMatchObject({ scope: 'team', partnerLabel: PARTNER_BANK });
  const sent = ok(await own.query('businessTeam.payments', { accountId: w.accountId })).filter(
    (p) => p.status === 'sent' && p.makerUserId === me(spend, w.owner),
  );
  expect(sent.reduce((sum, p) => sum + Number(p.amount), 0)).toBe(Number(ownerTotal));

  // The Bookkeeper has no team spend grant: only their own line, and no departments.
  await signedInAt(page, w.book, '/home');
  await page.getByRole('button', { name: 'Account menu' }).click();
  await page.getByTestId('profile-business').filter({ hasText: w.name }).click();
  await page.goto('/bank/business/spend');
  await expect(page.getByTestId('team-spend-self')).toBeVisible();
  await expect(page.getByTestId('team-spend-member')).toHaveCount(1);
  await expect(page.getByTestId('team-spend-member')).toHaveAttribute('data-handle', w.book.handle);
  await expect(page.getByTestId('team-department')).toHaveCount(0);
});

/** The owner's user id in a spend read, by handle. */
function me(spend, who) {
  return spend.members.find((m) => m.handle === who.handle).userId;
}
