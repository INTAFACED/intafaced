import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, signUpInBrowser } from './stack.mjs';

// J-ops-console-04 step #10: archive a customer record. While the account is open the console holds the form and names
// identity's refusal, and an approved archive run anyway is refused (identity.archive_blocked_open_account). Once closed,
// founder A asks with a reason code, founder B approves on their own console, and A runs it: the record is archived and
// every edit control on the account page is disabled with the reason. A reopen two founders approve is then refused by
// identity (identity.account_archived). The stack leaves the owner's dormancy period blank, so identity proposes no
// dormant customer, the console lists none and sends nothing, and it says the period is not set.

const login = (who) =>
  fetch(`${EDGE}/api/identity/trpc/auth.login`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceKey: DEVICE_KEY, identifier: who.email, password: who.password }),
  });

/** One step of a two-founder request on `endpoint`, posted as the signed-in founder in `page` (the console's own CSRF header). */
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

const archiveState = (page, userId) =>
  page.evaluate(async (id) => (await fetch(`/api/accounts/archive?id=${id}`, { cache: 'no-store' })).json(), userId);

/** What identity proposes for archive under the owner's dormancy period, as the console reads it. */
const archiveProposals = (page) =>
  page.evaluate(async () => {
    const res = await fetch('/api/accounts/archive?proposals=true', { cache: 'no-store' });
    return { status: res.status, body: await res.json() };
  });

/** Every POST this page sends to the archive route while `run` runs: a proposal would be one of them. */
async function archivePostsDuring(page, run) {
  const sent = [];
  const seen = (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/accounts/archive') sent.push(req.postData());
  };
  page.on('request', seen);
  try {
    return { result: await run(), sent };
  } finally {
    page.off('request', seen);
  }
}

const decode = (text) => JSON.parse(Buffer.from(text.slice('ifa1.'.length), 'base64url').toString('utf8'));

/** Propose, approve (the other founder) and run one request through the route, returning the run's answer. */
async function twoFounders(proposer, approver, endpoint, request, confirm) {
  const proposed = await step(proposer, endpoint, { step: 'propose', request, confirm });
  expect(proposed.body.ok, JSON.stringify(proposed.body).slice(0, 300)).toBe(true);
  const packet = decode(proposed.body.packet);
  const approved = await step(approver, endpoint, { step: 'approve', request, confirm, approvalId: packet.approvalId });
  expect(approved.body.ok, JSON.stringify(approved.body).slice(0, 300)).toBe(true);
  return step(proposer, endpoint, {
    step: 'execute',
    request,
    confirm,
    approvalId: packet.approvalId,
    operationId: packet.operationId,
  });
}

async function openAccount(page, userId) {
  await page.goto(`${ADMIN}/accounts`, { waitUntil: 'load' });
  await page.getByLabel('Account area').selectOption('identity');
  await page.getByLabel('Platform user ID').fill(userId);
  await page.getByRole('button', { name: 'Inspect account' }).click();
  await expect(page.getByTestId('account-closure-status')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('account-archive-status')).toBeVisible({ timeout: 60_000 });
  return { closure: page.getByTestId('account-closure'), archive: page.getByTestId('account-archive') };
}

/** A asks on a desk; returns the packet text. */
async function ask(desk, { reasonLabel, reasonCode, why, phrase, submit }) {
  await desk.getByLabel(reasonLabel).selectOption(reasonCode);
  await desk.getByLabel(/^Why/).fill(why);
  await desk.getByLabel(/to confirm$/).fill(phrase);
  await desk.getByRole('button', { name: submit }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return (await desk.getByLabel('Request packet').inputValue()).trim();
}

async function approveOn(page, userId, panel, packetText, phrase, summary) {
  const desk = (await openAccount(page, userId))[panel];
  await desk.getByLabel('Request packet').fill(packetText);
  await expect(desk.getByTestId('packet-summary')).toContainText(summary);
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Approve this request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('Approved.');
}

test('J-ops-console-04 #10 archive only a closed customer, then every edit control is disabled and says why', async ({ browser }) => {
  test.setTimeout(420_000);
  const tag = randomUUID().slice(0, 8);
  const who = { handle: `ops410${tag}`, email: `ops410-${tag}@local-test.invalid`, password: `Ops410-${tag}-Test!pass` };
  const customer = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  await signUpInBrowser(customer, who);
  const signedIn = await login(who);
  expect(signedIn.status, 'the open customer can sign in').toBe(200);
  const userId = (await signedIn.json()).result.data.userId;

  const a = await (await browser.newContext()).newPage();
  const founderA = await founderSignIn(a, 'a');
  const b = await (await browser.newContext()).newPage();
  const founderB = await founderSignIn(b, 'b');

  // Open: the console holds the archive form and names identity's refusal; no dormancy period is set on the stack.
  const opened = await archivePostsDuring(a, () => openAccount(a, userId));
  let { closure, archive } = opened.result;
  await expect(archive.getByTestId('account-archive-status')).toContainText('Open, not archived');
  await expect(archive).toContainText('identity.archive_blocked_open_account');
  const dormancy = archive.getByTestId('account-archive-dormancy');
  await expect(dormancy).toContainText('Dormancy period: not set');
  // A blank dormancy period makes no proposal: identity answers no period and an empty list, the console lists no
  // customer, and opening the account sent nothing to the archive route.
  expect(await archiveProposals(a)).toMatchObject({ status: 200, body: { dormancyDays: null, proposals: [] } });
  await expect(dormancy.locator('li')).toHaveCount(0);
  await expect(dormancy).not.toContainText('Identity proposes these closed records');
  expect(opened.sent, 'opening the account sends no archive request').toEqual([]);
  await expect(archive.getByRole('button', { name: 'Ask a second founder to approve the archive' })).toBeDisabled();

  // Even with two founders, identity refuses to archive the open account and nothing changes.
  const archivePhrase = `ARCHIVE CUSTOMER ${userId.slice(0, 8)}`;
  const open = await archiveState(a, userId);
  expect(open).toMatchObject({ status: 'active', archivedAt: null });
  const early = await twoFounders(
    a,
    b,
    '/api/accounts/archive',
    {
      kind: 'identity.account.archive',
      userId,
      reasonCode: 'dormant',
      reason: `LOCAL TEST archive while open ${tag}`,
      version: open.version,
    },
    archivePhrase,
  );
  expect(early.body).toMatchObject({ ok: false, refusal: { code: 'identity.archive_blocked_open_account' } });
  expect((await login(who)).status, 'still open after the refusal').toBe(200);

  // Close it at the customer's request on the closure desk (B approves, A runs).
  const closePhrase = `CLOSE ACCOUNT ${userId.slice(0, 8)}`;
  const closePacket = await ask(closure, {
    reasonLabel: 'Reason code',
    reasonCode: 'customer_request',
    why: `LOCAL TEST customer letter ${tag}`,
    phrase: closePhrase,
    submit: 'Ask a second founder to approve closing the account',
  });
  await approveOn(b, userId, 'closure', closePacket, closePhrase, `Close account ${userId}`);
  await closure.getByLabel(/to approve or run it$/).fill(closePhrase);
  await closure.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(closure.getByTestId('account-closure-status')).toContainText('Closed by the customer', { timeout: 60_000 });
  // The archive panel reads the closed record again on its own.
  await expect(archive.getByTestId('account-archive-status')).toContainText('Closed, not archived', { timeout: 60_000 });

  // Archive: A asks with a reason code, B approves on their own console, A runs it.
  const archiveWhy = `LOCAL TEST dormant closed record ${tag}`;
  const archivePacket = await ask(archive, {
    reasonLabel: 'Archive reason code',
    reasonCode: 'dormant',
    why: archiveWhy,
    phrase: archivePhrase,
    submit: 'Ask a second founder to approve the archive',
  });
  await approveOn(b, userId, 'archive', archivePacket, archivePhrase, `Archive customer ${userId} for good`);
  await archive.getByLabel(/to approve or run it$/).fill(archivePhrase);
  await archive.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(archive.getByTestId('account-archive-status')).toContainText('Archived on', { timeout: 60_000 });
  const done = archive.getByTestId('account-archive-history').locator('tbody tr').filter({ hasText: archiveWhy });
  await expect(done).toHaveCount(1);
  await expect(done).toContainText('changed');
  await expect(done).toContainText(founderA.userId.slice(0, 8));
  await expect(done).toContainText(founderB.userId.slice(0, 8));

  // Read again from scratch: every edit control is disabled and says why.
  ({ closure, archive } = await openAccount(a, userId));
  await expect(a.getByTestId('account-readonly-note')).toContainText('identity.account_archived');
  await expect(closure).toContainText('identity.account_archived');
  await expect(closure.getByRole('button', { name: 'Reopen unavailable' })).toBeDisabled();
  await expect(archive.getByRole('button', { name: 'Archive unavailable' })).toBeDisabled();
  await expect(archive.getByLabel('Archive reason code')).toBeDisabled();
  const tier = a.getByTestId('account-tier');
  await expect(tier).toContainText('identity.account_archived');
  await expect(tier.getByRole('button', { name: 'Tier move unavailable' })).toBeDisabled();
  // No new hold on an archived record.
  await expect(a.getByTestId('hold-place-why')).toContainText('identity.account_archived');
  await expect(a.getByRole('button', { name: 'Place the hold' })).toBeDisabled();
  // The customer's details: every field and the save are off, with the reason.
  const details = a.getByTestId('account-details-edit');
  await expect(details.getByTestId('account-details-edit-why')).toContainText('identity.account_archived');
  for (const control of await details.locator('input, select, textarea, button').all()) await expect(control).toBeDisabled();
  // Limit overrides: no override form is offered, and the panel says why.
  const limits = a.getByTestId('account-limits');
  await expect(limits).toContainText('identity.account_archived');
  // Every button on the edit desks is off: details, close or reopen, archive, holds, tier and limits.
  for (const id of ['account-details', 'account-closure', 'account-archive', 'account-holds', 'account-tier', 'account-limits']) {
    const enabled = await a
      .getByTestId(id)
      .locator('button')
      .evaluateAll((all) => all.filter((b) => !b.disabled).map((b) => b.textContent.trim()));
    expect(enabled, `${id}: no button is left on after the archive`).toEqual([]);
  }
  // Freeze and unfreeze: the record is closed and restricted, so neither the restrict form nor the unfreeze desk is
  // offered as a live control, and the read-only note names both.
  await expect(a.getByTestId('account-readonly-note')).toContainText('cannot be frozen, unfrozen');
  await expect(a.getByTestId('account-closed-note')).toContainText('there is no freeze to lift');
  await expect(a.getByRole('button', { name: /^(Restrict|Restore) access/ })).toHaveCount(0);

  // The row asks for every edit control to be shown disabled with its reason. Two desks are not: the freeze/unfreeze desk
  // is not drawn at all on an archived record (only a note stands in for it), and the hold release and confirm desks are
  // left open by design ("a hold already placed could still be released") and never name the archive. Each fails by name.
  await expect
    .soft(
      a.getByTestId('account-unfreeze').getByRole('button', { name: 'Restore unavailable' }),
      'the freeze/unfreeze desk is shown, disabled, saying identity.account_archived: on an archived record it is not drawn at all (OPS-accounts-desk-02)',
    )
    .toBeVisible({ timeout: 5_000 });
  for (const id of ['hold-release', 'hold-confirm'])
    await expect
      .soft(
        a.getByTestId(id),
        `the ${id} desk is disabled and says identity.account_archived: it is not switched off by the archive (OPS-accounts-desk-02)`,
      )
      .toContainText('identity.account_archived', { timeout: 5_000 });

  // Identity refuses a reopen two founders approved, and the person stays out.
  const archived = await archiveState(a, userId);
  expect(archived).toMatchObject({ status: 'closed', archiveReasonCode: 'dormant' });
  const reopenPhrase = `REOPEN ACCOUNT ${userId.slice(0, 8)}`;
  const reopen = await twoFounders(
    a,
    b,
    '/api/accounts/closure',
    { kind: 'identity.account.reopen', userId, reason: `LOCAL TEST try reopen ${tag}`, version: archived.version },
    reopenPhrase,
  );
  expect(reopen.body).toMatchObject({ ok: false, refusal: { code: 'identity.account_archived' } });
  expect((await login(who)).status, 'the archived customer stays out').toBe(403);

  // Still no period, still no proposal: the archived record is not listed, and nothing was proposed.
  expect(await archiveProposals(a)).toMatchObject({ status: 200, body: { dormancyDays: null, proposals: [] } });
  const reread = await archivePostsDuring(a, () => openAccount(a, userId));
  await expect(reread.result.archive.getByTestId('account-archive-dormancy')).toContainText('Dormancy period: not set');
  await expect(reread.result.archive.getByTestId('account-archive-dormancy').locator('li')).toHaveCount(0);
  expect(reread.sent, 'reading the archived account sends no archive request').toEqual([]);
});
