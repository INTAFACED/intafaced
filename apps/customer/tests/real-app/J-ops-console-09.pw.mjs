// World: none
import { expect, test } from './journey.mjs';
import { randomBytes } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, mailedLines } from './stack.mjs';
import { localTestAdminDeviceCookie } from '../../../../tooling/scripts/local-test-device.mjs';

// J-ops-console-09: invite a staff member and decide what they may do. Founder A and founder B, each on their own console.
// #1 is the approval policy room (/changes/policy): two founders set one governed type's row, the invite's. #2 is Staff
// (/identity-ops/staff): A asks to invite one named person, B approves the exact person, A runs it, and the person sets
// their own password from the one-time link in their mail (the stack's LOCAL-TEST outbox). Each step's test is written
// from the step's own words; no test-writer is staffed for this area yet (OWNER 212), so the builder wrote them.

const J = 'J-ops-console-09';
const tag = randomBytes(3).toString('hex');
const INVITE = 'identity.staff.invite';

test.use({ timezoneId: 'UTC' });

const decode = (packetText) => JSON.parse(Buffer.from(packetText.trim().slice('ifa1.'.length), 'base64url').toString('utf8'));

/** One approval step posted as the founder signed in on `page`, with the console's own CSRF header. */
const step = (page, endpoint, body) =>
  page.evaluate(
    async ({ endpoint, payload }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify(payload),
      });
      return { status: res.status, body: await res.json() };
    },
    { endpoint, payload: body },
  );

const read = (page, endpoint) => page.evaluate(async (url) => (await fetch(url, { cache: 'no-store' })).json(), endpoint);

async function inviteRow(page) {
  const view = await read(page, '/api/identity-ops/policy');
  expect(view.policies?.kind, JSON.stringify(view).slice(0, 300)).toBe('ok');
  return view.policies.data.find((e) => e.actionType === INVITE);
}

const policyPhrase = `SET POLICY ${INVITE.toUpperCase()}`;

/** Founder `a` fills the row form on /changes/policy and asks; returns the packet text. */
async function askPolicy(a, values) {
  await a.goto(`${ADMIN}/changes/policy`, { waitUntil: 'load' });
  const desk = a.getByTestId('control-desk');
  await desk.getByLabel('Action').selectOption(INVITE);
  await desk.getByLabel('Approvals needed, other than the requester').fill(values.requiredApprovals);
  await desk.getByLabel('Who may approve').selectOption(values.approverAudience);
  await desk.getByLabel('Applied only by (service)').fill(values.applier);
  await desk.getByLabel('Longest life of a request, in seconds').fill(values.maxAgeSeconds);
  await desk.getByLabel(/to confirm$/).fill(policyPhrase);
  await desk.getByRole('button', { name: 'Ask a second founder to approve this policy' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return (await desk.getByLabel('Request packet').inputValue()).trim();
}

/** The other founder approves that exact packet on their own console page. */
async function approveOn(page, path, packetText, phrase, summary) {
  await page.goto(`${ADMIN}${path}`, { waitUntil: 'load' });
  const desk = page.getByTestId('control-desk');
  await desk.getByLabel('Request packet').fill(packetText);
  await expect(desk.getByTestId('packet-summary')).toContainText(summary);
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Approve this request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
}

/** The requester runs the approved packet from their own desk (it still holds the packet they made). */
async function runOn(page, phrase) {
  const desk = page.getByTestId('control-desk');
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = desk.getByTestId('step-reply');
  await expect(reply).toContainText('The service answered', { timeout: 60_000 });
  return reply;
}

const WHOLE_ROW = { requiredApprovals: '1', approverAudience: 'founder', applier: 'svc-identity', maxAgeSeconds: '600' };

/** The invite row set to one founder other than the requester, by two founders, if it is not already. */
async function ensureInvitePolicy(a, b) {
  const row = await inviteRow(a);
  if (row.state === 'set' && row.policy.approverAudience === 'founder' && row.policy.applier === 'svc-identity') return;
  const packet = await askPolicy(a, WHOLE_ROW);
  await approveOn(b, '/changes/policy', packet, policyPhrase, INVITE);
  await expect(await runOn(a, policyPhrase)).toContainText('now needs 1 approver(s)');
}

test(`${J} #1 sets the approval policy for an action: a blank count is policy_unset and nothing applies, the author cannot approve their own request, a payload changed after approval is refused`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');

  // A blank count: two founders agree to it, and the row is unset. Nothing of the type applies: an invite is refused.
  const blankPacket = await askPolicy(a, { ...WHOLE_ROW, requiredApprovals: '' });
  await approveOn(b, '/changes/policy', blankPacket, policyPhrase, 'blank approver(s)');
  await expect(await runOn(a, policyPhrase)).toContainText('action_approval.policy_unset');
  const unset = await inviteRow(a);
  expect(unset).toMatchObject({ state: 'unset', code: 'action_approval.policy_unset', source: 'console' });
  await a.reload({ waitUntil: 'load' });
  await expect(a.getByTestId('policy-row').filter({ hasText: INVITE })).toHaveAttribute('data-state', 'unset');
  await expect(a.getByTestId('policy-row').filter({ hasText: INVITE })).toContainText('action_approval.policy_unset');
  const invite = {
    kind: INVITE,
    requestId: `staff-invite-j09-${tag}-blank`,
    email: `staff-j09-${tag}-blank@local-test.invalid`,
    displayName: 'J09 blank policy',
  };
  const refusedInvite = await step(a, '/api/identity-ops/staff', { step: 'propose', request: invite, confirm: `INVITE ${invite.email.toUpperCase()}` });
  expect(refusedInvite.body.ok, JSON.stringify(refusedInvite.body)).toBe(false);
  expect(refusedInvite.body.refusal.code).toBe('action_approval.policy_unset');

  // A whole row: the author approving their own request is refused by identity, and the row is unchanged.
  const packetText = await askPolicy(a, WHOLE_ROW);
  const packet = decode(packetText);
  const own = await step(a, '/api/identity-ops/policy', {
    step: 'approve',
    request: packet.request,
    confirm: policyPhrase,
    approvalId: packet.approvalId,
  });
  expect(own.body.ok, JSON.stringify(own.body)).toBe(false);
  expect(own.body.refusal.code).toBe('action_approval.same_person');
  await approveOn(b, '/changes/policy', packetText, policyPhrase, '1 approver(s)');

  // A payload changed after approval makes the approval invalid for it: identity refuses it and writes nothing.
  const changed = await step(a, '/api/identity-ops/policy', {
    step: 'execute',
    request: { ...packet.request, maxAgeSeconds: '86400' },
    confirm: policyPhrase,
    approvalId: packet.approvalId,
    operationId: packet.operationId,
  });
  expect(changed.body.ok, JSON.stringify(changed.body)).toBe(false);
  expect(changed.body.refusal.code).toBe('action_approval.payload_mismatch');
  expect(await inviteRow(a)).toMatchObject({ state: 'unset', rowVersion: unset.rowVersion });

  // The approved row itself applies.
  await expect(await runOn(a, policyPhrase)).toContainText('now needs 1 approver(s) other than the requester, from founder');
  const set = await inviteRow(a);
  expect(set).toMatchObject({
    state: 'set',
    source: 'console',
    policy: { requiredApprovals: 1, approverAudience: 'founder', applier: 'svc-identity', maxAgeSeconds: 600 },
  });
  expect(Number(set.rowVersion)).toBe(Number(unset.rowVersion) + 1);
  await a.reload({ waitUntil: 'load' });
  await expect(a.getByTestId('policy-row').filter({ hasText: INVITE })).toHaveAttribute('data-state', 'set');
  await expect(a.getByTestId('policy-row').filter({ hasText: INVITE })).toContainText('1 other than the requester');
});

test(`${J} #2 invites a staff member: the same founder approving is refused same_person, a second founder approves, the person sets their own password at first connection`, async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');
  await ensureInvitePolicy(a, b);

  const person = { email: `staff-j09-${tag}@local-test.invalid`, name: `J09 Staff ${tag}` };
  const phrase = `INVITE ${person.email.toUpperCase()}`;
  await a.goto(`${ADMIN}/identity-ops/staff`, { waitUntil: 'load' });
  await expect(a.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
  const desk = a.getByTestId('control-desk');
  await desk.getByLabel('Their email').fill(person.email);
  await desk.getByLabel('Their name').fill(person.name);
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: 'Ask a second founder to approve the invite' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packetText = (await desk.getByLabel('Request packet').inputValue()).trim();
  const packet = decode(packetText);
  await expect(desk.getByRole('button', { name: 'Approve this request' })).toBeDisabled();

  // The same founder approving is refused by identity with its typed code.
  const own = await step(a, '/api/identity-ops/staff', { step: 'approve', request: packet.request, confirm: phrase, approvalId: packet.approvalId });
  expect(own.body.ok, JSON.stringify(own.body)).toBe(false);
  expect(own.body.refusal.code).toBe('action_approval.same_person');
  const before = await read(a, '/api/identity-ops/staff');
  expect(before.staff.kind).toBe('ok');
  expect(before.staff.data.some((s) => s.email === person.email)).toBe(false);

  // A second founder approves; A runs it; the person is invited and their link is mailed.
  await approveOn(b, '/identity-ops/staff', packetText, phrase, person.email);
  await expect(await runOn(a, phrase)).toContainText(`${person.name} (${person.email}) is invited`);
  await expect(desk.getByTestId('step-reply')).toContainText('one-time link was handed to the mail service');
  await a.reload({ waitUntil: 'load' });
  await expect(a.getByTestId('staff-row').filter({ hasText: person.email })).toHaveAttribute('data-status', 'invited');

  const mail = mailedLines(person.email, 'staff-invite');
  expect(mail, 'one invite mail to the person').toHaveLength(1);
  const link = /\blink=(\S+)/.exec(mail[0])?.[1];
  expect(link).toMatch(/^staff-welcome\?token=[A-Za-z0-9_-]{32,}$/);

  // The person opens the link in their own browser and sets their own password.
  const theirs = await browser.newContext();
  await theirs.addCookies([localTestAdminDeviceCookie(ADMIN)]);
  const p = await theirs.newPage();
  await p.goto(`${ADMIN}/${link}`, { waitUntil: 'load' });
  await expect(p.getByTestId('staff-welcome-name')).toHaveText(person.name);
  await expect(p.getByTestId('staff-welcome-email')).toHaveText(person.email);
  const password = `Staff-J09-${randomBytes(12).toString('base64url')}-Own!`;
  await p.getByLabel('Your new password').fill(password);
  await p.getByLabel('The same password again').fill(password);
  await p.getByRole('button', { name: 'Set my password' }).click();
  await expect(p.getByTestId('staff-welcome-done')).toContainText(`Your staff account for ${person.email} is active`, { timeout: 60_000 });

  // The password is theirs: identity signs them in with it. The link works once.
  const login = await fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier: person.email, password, deviceKey: DEVICE_KEY }),
  });
  const signedIn = await login.json();
  expect(login.status, JSON.stringify(signedIn).slice(0, 300)).toBe(200);
  const userId = signedIn.result?.data?.userId ?? signedIn.result?.data?.json?.userId;
  expect(userId).toMatch(/^[0-9a-f-]{36}$/);
  await p.goto(`${ADMIN}/${link}`, { waitUntil: 'load' });
  await expect(p.getByTestId('staff-welcome-invalid')).toContainText('identity.staff_invite_invalid');

  const after = await read(a, '/api/identity-ops/staff');
  const entry = after.staff.data.find((s) => s.email === person.email);
  expect(entry).toMatchObject({ status: 'active', userId, displayName: person.name, invitedBy: (await read(a, '/api/session')).userId });
  await a.reload({ waitUntil: 'load' });
  await expect(a.getByTestId('staff-row').filter({ hasText: person.email })).toHaveAttribute('data-status', 'active');
  await theirs.close();
});
