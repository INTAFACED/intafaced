import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { DEVICE_KEY, EDGE, ORIGIN, signUpInBrowser } from './stack.mjs';

// J-ops-console-04 step #10: archive a customer record. While the account is open the console holds the form and names
// identity's refusal, and an approved archive run anyway is refused (identity.archive_blocked_open_account). Once closed,
// founder A asks with a reason code, founder B approves on their own console, and A runs it: the record is archived and
// every edit control on the account page is disabled with the reason, except releasing an existing hold (lead's ruling
// 2026-10-31: no money is stranded). A reopen two founders approve is then refused by
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

/** Every POST this page sends to the archive route while `run` runs and until the page is idle: a proposal would be one. */
async function archivePostsDuring(page, run) {
  const sent = [];
  const seen = (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/accounts/archive') sent.push(req.postData());
  };
  page.on('request', seen);
  try {
    const result = await run();
    // Requests the page's effects send after it rendered count too: listen until the network is idle, then a short settle.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1_500);
    return { result, sent };
  } finally {
    page.off('request', seen);
  }
}

const HOLD = { coin: 'USDT', amount: '1', reason: 'LOCAL TEST hold check' };

/**
 * Fills each edit desk the way a founder would before asking, without sending anything: a detail with its new value and
 * reason, a reopen reason and phrase, a tier with its reason and phrase, and a hold's coin, amount and reason. Returns the
 * page's desks for the caller to read.
 */
async function fillDesks(page, userId, tag) {
  const details = page.getByTestId('account-details-edit');
  await details.getByLabel('Detail to change').selectOption({ label: 'Phone' });
  await details.getByLabel('New value').fill('LOCAL TEST 000');
  await details.getByLabel(/^Why \(kept in the details history/).fill(`LOCAL TEST details check ${tag}`);
  const closure = page.getByTestId('account-closure');
  await closure.getByLabel(/^Why \(kept in the account’s closure history/).fill(`LOCAL TEST reopen check ${tag}`);
  await closure.getByLabel(/to confirm$/).fill(`REOPEN ACCOUNT ${userId.slice(0, 8)}`);
  const tier = page.getByTestId('account-tier');
  await tier.getByLabel('Move to tier').selectOption('test-standard');
  await tier.getByLabel(/^Why \(kept in the account’s tier history/).fill(`LOCAL TEST tier check ${tag}`);
  await tier.getByLabel(/to confirm$/).fill(`MOVE TIER ${userId.slice(0, 8)}`);
  await fillHold(page);
  return { details, closure, tier, place: page.getByTestId('hold-place') };
}

async function fillHold(page) {
  const place = page.getByTestId('hold-place');
  await place.getByLabel('Coin').fill(HOLD.coin);
  await place.getByLabel('Amount to hold').fill(HOLD.amount);
  await place.getByLabel(/^Reason \(kept with the hold/).fill(HOLD.reason);
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

  // Before the archive, on the same closed record read fresh, each edit desk filled in as a founder would is live: the
  // details save, the reopen request, the tier move request and the hold. Nothing is sent. The same fills after the
  // archive are refused below, so it is the archive that switches them off.
  await openAccount(a, userId);
  const live = await fillDesks(a, userId, tag);
  await expect(live.details.getByRole('button', { name: 'Save the change' })).toBeEnabled();
  await expect(live.closure.getByRole('button', { name: 'Ask a second founder to approve reopening the account' })).toBeEnabled();
  await expect(live.tier.getByRole('button', { name: 'Ask the other founder to approve the tier move' })).toBeEnabled();
  await expect(live.place.getByRole('button', { name: 'Place the hold' })).toBeEnabled();
  ({ closure, archive } = await openAccount(a, userId));

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
  // The same desks after the archive, filled in the same way where a field still takes input: every submit stays off and
  // each desk names identity.account_archived.
  const details = a.getByTestId('account-details-edit');
  await expect(details.getByTestId('account-details-edit-why')).toContainText('identity.account_archived');
  for (const control of await details.locator('input, select, textarea').all()) await expect(control).toBeDisabled();
  await expect(details.getByRole('button', { name: 'Save the change' })).toBeDisabled();
  // Close or reopen, archive and tier: no request form is drawn to type a reason or phrase into, only the switched-off
  // button with the reason.
  for (const [desk, button] of [
    [closure, 'Reopen unavailable'],
    [archive, 'Archive unavailable'],
    [tier, 'Tier move unavailable'],
  ]) {
    await expect(desk.getByTestId('request-form')).toHaveCount(0);
    await expect(desk.getByTestId('control-blocked')).toContainText('identity.account_archived');
    await expect(desk.getByRole('button', { name: button })).toBeDisabled();
  }
  await expect(tier.getByLabel('Move to tier')).toBeDisabled();
  // A new hold: its fields still take input, and with a valid coin, amount and reason it stays off and says why.
  await fillHold(a);
  await expect(a.getByTestId('hold-place-why')).toContainText('identity.account_archived');
  await expect(a.getByTestId('hold-place').getByRole('button', { name: 'Place the hold' })).toBeDisabled();
  // Limit overrides: no override form is drawn, and the panel says why.
  const limits = a.getByTestId('account-limits');
  await expect(limits).toContainText('identity.account_archived');
  await expect(limits.locator('#limit-asset')).toHaveCount(0);
  // Freeze and unfreeze: the record is closed and restricted, so neither the restrict form nor the unfreeze desk is
  // offered as a live control, and the read-only note names both.
  await expect(a.getByTestId('account-readonly-note')).toContainText('cannot be frozen, unfrozen');
  await expect(a.getByTestId('account-closed-note')).toContainText('there is no freeze to lift');
  await expect(a.getByRole('button', { name: /^(Restrict|Restore) access/ })).toHaveCount(0);

  // Releasing an existing hold is the one edit the archive leaves on (lead's ruling 2026-10-31: no money is stranded). The
  // release and confirm desks are drawn with their request forms, nothing on them is switched off by the archive or names
  // it, and the hold picker and amount still take input; their request buttons wait only for a hold to be chosen.
  const releaseArea = a.getByTestId('account-holds');
  await expect(releaseArea.getByLabel('Hold', { exact: true })).toBeEnabled();
  await expect(releaseArea.getByLabel('Amount to release')).toBeEnabled();
  for (const [id, heading] of [
    ['hold-release', 'Release part or all of the hold'],
    ['hold-confirm', 'Confirm the hold'],
  ]) {
    const desk = a.getByTestId(id);
    await expect(desk.getByTestId('request-form')).toBeVisible();
    await expect(desk.getByRole('heading', { name: heading })).toBeVisible();
    await expect(desk.getByTestId('control-blocked')).toHaveCount(0);
    await expect(desk).not.toContainText('identity.account_archived');
    await expect(desk).toContainText('Choose a hold that still holds something.');
  }

  // The freeze/unfreeze desk is drawn switched off on an archived record, saying identity.account_archived (#6981). It
  // stays a by-name check until #6981 is on main: a console without it draws only a note there.
  await expect
    .soft(
      a.getByTestId('account-unfreeze').getByRole('button', { name: 'Restore unavailable' }),
      'the freeze/unfreeze desk is shown, disabled, saying identity.account_archived: it needs #6981 (the archived record draws the unfreeze desk disabled)',
    )
    .toBeVisible({ timeout: 5_000 });

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
