// World: stack
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { forgetSession } from './identity-factors.mjs';
import { businessReadyPerson, openBusiness, payApiOf, refusedPayCalls, signInWithCode, verifiedBusiness } from './merchant.mjs';
import { stackFile, tool } from './stack.mjs';

// J-merchant-11 in the running app: the owner of a verified business invites their team by email and gives each person
// a role. Email invitations go out through the stack's LOCAL-TEST outbox (`team-invite-outbox.log`, read here as the
// invited person would read their inbox); no email provider is connected, and with the transport off the invitation is
// refused in plain words (outside dependency vendor.email). The lifetime (7 days) is the stack's TEST value
// (tooling/profiles/test-owner-values/pay.json). Steps share one business, so they run in order.
const J = 'J-merchant-11';
test.describe.configure({ mode: 'serial' });

/** The business, its owner and the person invited, made by #1 and used by the steps after it. */
const world = {};

const outbox = () => (existsSync(stackFile('team-invite-outbox.log')) ? readFileSync(stackFile('team-invite-outbox.log'), 'utf8') : '');
/** The invitation mails written to `email` since the outbox held `before` characters, as { purpose, expires, link }. */
function mailsTo(email, before) {
  return outbox()
    .slice(before)
    .split('\n')
    .filter((line) => line.startsWith('LOCAL-TEST ') && line.includes(` email=${email} `))
    .map((line) => ({
      purpose: /purpose=(\S+)/.exec(line)[1],
      expires: /expires=(\S+)/.exec(line)[1],
      link: `/${/link=(\S+)/.exec(line)[1]}`,
    }));
}

/** Pay restarted with no invitation mail transport, as a build with no email provider runs, or back on the outbox. */
function inviteMail(on) {
  const before = process.env.LOCAL_STACK_PAY_TEAM_MAIL;
  if (on) delete process.env.LOCAL_STACK_PAY_TEAM_MAIL;
  else process.env.LOCAL_STACK_PAY_TEAM_MAIL = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'pay');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_PAY_TEAM_MAIL;
    else process.env.LOCAL_STACK_PAY_TEAM_MAIL = before;
  }
}

const members = (page) => page.getByRole('table', { name: 'Members' });
const memberRow = (page, text) => members(page).getByRole('row').filter({ hasText: text });
const masked = (email) => `${email.slice(0, 1)}***${email.slice(email.lastIndexOf('@'))}`;
const confirmDialog = (page) => page.getByRole('dialog').locator('[data-testid="form-stack"] > button').last();

/** The invite form by email: address, role, then the review dialog, which shows the address exactly as it is sent. */
async function inviteByEmail(page, typed, role) {
  const form = page.locator('#invite');
  await form.getByLabel('Email address *').fill(typed);
  await form.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: role });
  await form.getByRole('button', { name: 'Send invitation' }).click();
  return page.getByRole('dialog');
}

/** The owner's own pay API, keeping their authenticator's time step so the next browser sign-in waits for a new code. */
const ownerApi = () => payApiOf(world.owner, (step) => (world.owner.step = step));

test(`${J} #1 invites someone by email: a pending row with the expiry; the address shown as it will be sent and listed masked; an invalid address is caught first; with email off a plain refusal`, async ({
  page,
}) => {
  test.setTimeout(600_000);
  const invitee = await businessReadyPerson(page, 'mtinv', '/pay/merchant');
  await forgetSession(page);
  const owner = await businessReadyPerson(page, 'mtown', '/pay/onboarding');
  const merchantId = await openBusiness(page, owner, 'TEST Crew Ltd');
  await verifiedBusiness(page, owner, merchantId);
  await forgetSession(page);
  await signInWithCode(page, owner, '/pay/team');
  Object.assign(world, { owner, invitee, merchantId });
  const refused = refusedPayCalls(page);
  const invites = [];
  page.on('request', (r) => r.url().includes('merchantOps.team.invite') && invites.push(r.url()));

  // An invalid address is caught on the page, before anything is sent.
  const form = page.locator('#invite');
  await form.getByLabel('Email address *').fill('not an email');
  await expect(form.getByText('Enter one email address, with no spaces.')).toBeVisible();
  await expect(form.getByRole('button', { name: 'Send invitation' })).toBeDisabled();
  expect(invites).toEqual([]);

  // The address as it will be sent: trimmed and lower-cased, in the hint and again in the review before sending.
  const sent = invitee.email.toLowerCase();
  const before = outbox().length;
  const dialog = await inviteByEmail(page, `  ${invitee.email.toUpperCase()}  `, 'Finance');
  await expect(dialog.locator('code').filter({ hasText: sent })).toHaveText(sent);
  await confirmDialog(page).click();
  await expect(page.getByText(`Invitation sent to ${sent}.`)).toBeVisible();

  // Listed masked, pending, with the date it runs out; the full address is nowhere in the list.
  const row = memberRow(page, masked(sent));
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Invited');
  await expect(row).toContainText('Finance');
  await expect(row).not.toContainText('No expiry');
  await expect(members(page)).not.toContainText(sent);

  // The mail went to that address, and the expiry the service stored is the one in it: 7 days, the stack's TEST lifetime.
  await expect.poll(() => mailsTo(sent, before).length).toBe(1);
  const [mail] = mailsTo(sent, before);
  expect(mail.purpose).toBe('team-invite');
  const api = await ownerApi();
  const listed = (await api.query('merchantOps.team.list', { status: 'invited' })).items.find((m) => m.userId === `email:${sent}`);
  expect(listed.expiresAt).toBe(mail.expires);
  const lifetime = Date.parse(mail.expires) - Date.now();
  expect(lifetime).toBeGreaterThan(7 * 86_400_000 - 600_000);
  expect(lifetime).toBeLessThanOrEqual(7 * 86_400_000);
  world.firstLink = mail.link;
  expect(refused).toEqual([]);

  // With email off, sending refuses in plain words, and nothing is saved or mailed.
  const off = `test-off-${invitee.handle}@local-test.invalid`;
  try {
    inviteMail(false);
    await page.reload();
    const outboxBefore = outbox().length;
    const refusedDialog = await inviteByEmail(page, off, 'Viewer');
    await confirmDialog(page).click();
    await expect(
      refusedDialog.getByText(
        'Email invitations are switched off on this system, so no email can be sent and nothing was saved. Invite the person by account ID instead.',
      ),
    ).toBeVisible();
    await expect(page.getByText('pay.team_email_invite_unconfigured')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(memberRow(page, masked(off))).toHaveCount(0);
    expect(outbox().length).toBe(outboxBefore);
  } finally {
    inviteMail(true);
  }
});

test(`${J} #2 resends and deactivates: resend makes the old link fail; an expired invite says Expired; an active member can be deactivated`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  const { owner, invitee } = world;
  const sent = invitee.email.toLowerCase();
  await signInWithCode(page, owner, '/pay/team');

  // Resend: a new mail with a new link.
  const before = outbox().length;
  await memberRow(page, masked(sent)).getByRole('link').first().click();
  await page.getByRole('button', { name: 'Send again' }).click();
  await expect(page.getByRole('dialog')).toContainText(`Send the invitation to ${masked(sent)} again, as Finance.`);
  await confirmDialog(page).click();
  await expect.poll(() => mailsTo(sent, before).length).toBe(1);
  const [resent] = mailsTo(sent, before);
  expect(resent.purpose).toBe('team-invite-resent');
  expect(resent.link).not.toBe(world.firstLink);

  // A second invitation, to an address nobody opens, runs out (the stack's TEST clock): it reads Expired.
  const late = `test-late-${invitee.handle}@local-test.invalid`;
  const lateBefore = outbox().length;
  await inviteByEmail(page, late, 'Viewer');
  await confirmDialog(page).click();
  await expect.poll(() => mailsTo(late, lateBefore).length).toBe(1);
  const [lateMail] = mailsTo(late, lateBefore);
  tool('local-test-stack.mjs', 'expire-team-invites', late);
  await page.goto('/pay/team');
  await expect(memberRow(page, masked(late))).toContainText('Expired');
  await forgetSession(page);

  // The invited person, signed in with the invited address: the old link fails, an expired one says so, the new one works.
  await signInWithCode(page, invitee, '/pay/merchant');
  await page.goto(world.firstLink);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await confirmDialog(page).click();
  await expect(page.getByRole('dialog')).toContainText('This invitation link no longer works.');
  await page.goto(lateMail.link);
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await confirmDialog(page).click();
  await expect(page.getByRole('dialog')).toContainText('This invitation has expired. Ask the business to send it again.');
  // Sign-in binds the invited address to the account without waiting for it, so the newest link may need a second try.
  await expect(async () => {
    await page.goto(resent.link);
    await page.getByRole('button', { name: 'Accept invitation' }).click();
    await confirmDialog(page).click();
    await expect(page.getByText('You joined the team.')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await page.goto('/pay/merchant');
  await expect(page.getByText('TEST Crew Ltd').first()).toBeVisible();
  await forgetSession(page);

  // The owner deactivates the active member: the row reads Deactivated and the person's next request is refused.
  await signInWithCode(page, owner, '/pay/team');
  const active = memberRow(page, 'Finance').filter({ hasText: 'Active' });
  await expect(active).toHaveCount(1);
  await active.getByRole('link').first().click();
  await page.getByRole('button', { name: 'Deactivate' }).click();
  await confirmDialog(page).click();
  await page.goto('/pay/team?status=removed');
  await expect(members(page).getByRole('row').filter({ hasText: 'Deactivated' })).toHaveCount(1);
  const theirs = await payApiOf(invitee, (step) => (invitee.step = step));
  const after = await theirs.answer('merchantOps.team.me', {});
  expect(after.status).toBe(403);
  expect(JSON.stringify(after.body)).toContain('pay.merchant_ops_not_merchant');
});

test(`${J} #3 assigns a predefined role: the role's permission list matches the server table`, async ({ page }) => {
  test.setTimeout(480_000);
  const { owner, invitee } = world;
  // The person comes back by account ID and accepts from their Invitations list.
  await signInWithCode(page, owner, '/pay/team');
  await page.getByRole('button', { name: 'Invite by account ID instead' }).click();
  await page.getByLabel('Account ID *').fill(invitee.userId);
  await page.getByRole('combobox', { name: /^Role \*/ }).selectOption({ label: 'Viewer' });
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await confirmDialog(page).click();
  await forgetSession(page);
  await signInWithCode(page, invitee, '/pay/team');
  const accept = page.locator('li').filter({ hasText: 'Viewer' }).getByRole('button', { name: 'Accept' }).first();
  await expect(async () => {
    await page.reload();
    await expect(accept).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 30_000 });
  await accept.click();
  await confirmDialog(page).click();
  await expect(accept).toHaveCount(0);
  await forgetSession(page);

  // The owner assigns Developer, a predefined role.
  await signInWithCode(page, owner, '/pay/team');
  const row = memberRow(page, 'Viewer').filter({ hasText: 'Active' });
  await row.getByRole('link').first().click();
  await page.getByRole('combobox', { name: 'New role' }).selectOption({ label: 'Developer' });
  await page.getByRole('button', { name: 'Change role' }).click();
  await confirmDialog(page).click();
  const changed = memberRow(page, 'Developer').filter({ hasText: 'Active' });
  await expect(changed).toHaveCount(1);
  await changed.getByRole('link').first().click();
  const shown = await page
    .getByTestId('role-permissions')
    .locator('li[data-permission]')
    .evaluateAll((items) => items.map((li) => li.getAttribute('data-permission')).sort());

  // The server's own table, twice: the catalogue the page reads, and the grants the member's session really carries.
  const api = await ownerApi();
  const catalogue = await api.query('merchantOps.permissions.catalogue', {});
  const table = catalogue.areas
    .flatMap((a) => a.permissions)
    .filter((p) => p.heldBy.includes('developer'))
    .map((p) => p.key)
    .sort();
  expect(shown).toEqual(table);
  expect(shown.length).toBeGreaterThan(0);
  await forgetSession(page);
  const theirs = await payApiOf(invitee, (step) => (invitee.step = step));
  const access = await theirs.query('merchant.myAccess', {});
  const mine = access.memberships.find((m) => m.merchantId === world.merchantId);
  expect(mine.role).toBe('developer');
  const granted = Object.entries(mine.capabilities)
    .filter(([, held]) => held)
    .map(([key]) => key)
    .sort();
  expect(granted).toEqual(table.filter((key) => key in mine.capabilities));
  expect(table.every((key) => key in mine.capabilities)).toBe(true);
  // And the request check agrees: a developer may not manage the team.
  const refusedInvite = await theirs.mutate('merchantOps.team.invite', { userId: owner.userId, role: 'viewer' }).catch((e) => e);
  expect(refusedInvite.status).toBe(403);
  expect(refusedInvite.body).toContain('pay.team_role_forbidden');
});
