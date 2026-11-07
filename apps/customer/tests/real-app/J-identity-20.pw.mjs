// World: none
import { expect, test } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { unconfirmedAccount } from './p2p.mjs';
import { randomBytes } from 'node:crypto';
import { api, ORIGIN, signUpInBrowser } from './stack.mjs';
import { businessReadyPerson, openBusiness, sentForReview } from './merchant.mjs';
import { staffSignIn } from './staff.mjs';

// J-identity-20: I work the verification queue (compliance). Signed in to the admin app as compliance (the stack's TEST
// compliance member), on the verification queue. Money: none. The second reviewer is a TEST founder. Every case here is a
// fresh TEST customer's own request, made through identity's own kyc.submit.

/** A fresh TEST customer with one pending verification; returns its record and case ids. */
async function pendingCase(tag) {
  const who = await unconfirmedAccount(tag);
  const customer = await api(who);
  const submitted = await customer.post('/api/identity/trpc/kyc.submit', { tier: 'basic', jurisdiction: 'DE' });
  const record = submitted.body?.result?.data;
  expect(record?.status, JSON.stringify(submitted.body).slice(0, 300)).toBe('pending');
  const history = await customer.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
  const open = history.body?.result?.data?.cases?.find((c) => c.recordId === record.id);
  expect(open?.state, JSON.stringify(history.body).slice(0, 300)).toBe('submitted');
  return { userId: record.userId, recordId: record.id, caseId: open.id, who };
}

/** Pages the queue forward until the case's row shows, reading each page's rows on the way. Returns the row. */
async function pageTo(page, caseId) {
  const seen = new Set();
  for (let n = 0; n < 400; n++) {
    await expect(page.getByTestId('kyc-queue-meta')).toBeVisible({ timeout: 60_000 });
    const rows = page.getByTestId('kyc-queue-row');
    const ids = await rows.evaluateAll((els) => els.map((el) => el.getAttribute('data-case')));
    for (const id of ids) {
      // A cursor page never repeats a case another page showed.
      expect(seen.has(id), `case ${id} shown on two pages`).toBe(false);
      seen.add(id);
    }
    const row = page.locator(`[data-testid="kyc-queue-row"][data-case="${caseId}"]`);
    if ((await row.count()) === 1) return row;
    const next = page.getByRole('button', { name: 'Next page' });
    expect(await next.isEnabled(), `the queue ended without case ${caseId}`).toBe(true);
    const before = await page.getByTestId('kyc-queue-meta').getAttribute('data-page');
    await next.click();
    await expect(page.getByTestId('kyc-queue-meta')).not.toHaveAttribute('data-page', before ?? '', { timeout: 60_000 });
  }
  throw new Error(`case ${caseId} not found in 400 pages`);
}

test('J-identity-20 #1 the queue is a cursor page of pending cases in the owner page size; two reviewers claim at once, one wins and the other sees kyc.case_assigned', async ({
  browser,
}) => {
  test.setTimeout(480_000);
  // More open cases than one page holds, so the page fills and a next page exists, whatever else is waiting on this stack.
  const cases = [];
  for (let i = 0; i < 6; i++) cases.push(await pendingCase(`jq${i}x`));
  const target = cases[0];

  const compliance = await (await browser.newContext()).newPage();
  const founder = await (await browser.newContext()).newPage();
  await staffSignIn(compliance, browser, 'compliance');
  await founderSignIn(founder, 'a');
  try {
    // Opens the queue: a page of pending cases in the owner's page size (the stack's TEST value is 5).
    await compliance.goto(`${ADMIN}/identity-ops/kyc`, { waitUntil: 'load' });
    const meta = compliance.getByTestId('kyc-queue-meta');
    await expect(meta).toBeVisible({ timeout: 60_000 });
    await expect(meta).toHaveAttribute('data-page-size', '5');
    await expect(meta).toHaveAttribute('data-page', '1');
    await expect(compliance.getByTestId('kyc-queue-row')).toHaveCount(5);
    // At least six cases wait, so the page is full and identity gives a marker for the next page.
    await expect(compliance.getByRole('button', { name: 'Next page' })).toBeEnabled();
    // Every row is a pending case nobody else is working yet, or says who holds it.
    for (const label of await compliance.getByTestId('kyc-queue-assignee').allInnerTexts())
      expect(['Nobody', 'You', 'Another reviewer']).toContain(label.trim());

    // The next page is read by its cursor: different cases, never one from the page before.
    const rowCompliance = await pageTo(compliance, target.caseId);
    await expect(rowCompliance.getByTestId('kyc-queue-assignee')).toHaveText('Nobody');

    // The second reviewer (a founder) finds the same case on their own console.
    await founder.goto(`${ADMIN}/identity-ops/kyc`, { waitUntil: 'load' });
    const rowFounder = await pageTo(founder, target.caseId);
    await expect(rowFounder.getByTestId('kyc-queue-assignee')).toHaveText('Nobody');

    // Both claim at once: exactly one wins, the other is told the case is taken (kyc.case_assigned).
    await Promise.all([
      rowCompliance.getByRole('button', { name: 'Claim' }).click(),
      rowFounder.getByRole('button', { name: 'Claim' }).click(),
    ]);
    const outcome = async (row) => {
      await expect(row.getByTestId('kyc-queue-claimed').or(row.getByTestId('kyc-review-refusal'))).toBeVisible({ timeout: 60_000 });
      return (await row.getByTestId('kyc-queue-claimed').count()) === 1
        ? 'won'
        : await row.getByTestId('kyc-review-refusal').getAttribute('data-code');
    };
    const results = [await outcome(rowCompliance), await outcome(rowFounder)];
    expect(results.sort()).toEqual(['kyc.case_assigned', 'won']);
    const loser = results[0] === 'won' ? rowFounder : rowCompliance;
    await expect(loser.getByTestId('kyc-review-refusal')).toContainText('Another reviewer has this case');

    // Each reviewer's queue now names who holds it: the winner reads "You", the other "Another reviewer".
    const winnerRow = loser === rowFounder ? rowCompliance : rowFounder;
    await expect(winnerRow.getByTestId('kyc-queue-assignee')).toHaveText('You', { timeout: 60_000 });
    await expect(loser.getByTestId('kyc-queue-assignee')).toHaveText('Another reviewer', { timeout: 60_000 });
  } finally {
    await compliance.context().close();
    await founder.context().close();
  }
});

test('J-identity-20 #2 a case shows the record, reason codes, history and notes; a decision with a listed reason code stores once, a retry returns the stored result, a different code is refused', async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const target = await pendingCase('jc');
  const compliance = await (await browser.newContext()).newPage();
  const founder = await (await browser.newContext()).newPage();
  await staffSignIn(compliance, browser, 'compliance');
  await founderSignIn(founder, 'a');
  try {
    // Opens the case: the record, the owner's reason codes and the history.
    await compliance.goto(`${ADMIN}/identity-ops/kyc/${target.caseId}`, { waitUntil: 'load' });
    const review = compliance.getByTestId('kyc-case-review');
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(review.getByTestId('kyc-case-record')).toContainText(target.recordId);
    await expect(review.getByTestId('kyc-case-record-status')).toHaveText('pending');
    await expect(review.getByTestId('kyc-case-state')).toHaveText('submitted');
    const codes = review.getByTestId('kyc-case-reason-codes').locator('li');
    await expect(codes).toHaveCount(2);
    await expect(review.getByTestId('kyc-case-reason-codes')).toContainText('document_unreadable');
    await expect(review.getByTestId('kyc-case-reason-codes')).toContainText('name_mismatch');
    const history = review.getByTestId('kyc-case-history').locator('li');
    await expect(history).toHaveCount(1);
    await expect(history.first()).toHaveAttribute('data-state', 'submitted');

    // Notes: a reviewer adds one and it shows on the case; the customer never sees it.
    await expect(review.getByTestId('kyc-case-notes-empty')).toBeVisible();
    const noteText = `TEST: ID photo is blurred (${Date.now()})`;
    await review.getByLabel('Add a note').fill(noteText);
    await review.getByRole('button', { name: 'Add note' }).click();
    await expect(review.getByTestId('kyc-case-note-added')).toBeVisible({ timeout: 60_000 });
    await expect(review.getByTestId('kyc-case-note')).toHaveCount(1);
    await expect(review.getByTestId('kyc-case-note').first()).toContainText(noteText);
    const customer = await api(target.who);
    const own = await customer.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
    expect(JSON.stringify(own.body)).not.toContain(noteText);

    // A decision with a listed reason code: compliance asks, the founder approves that record and that code, compliance runs it.
    const decide = async (code) => {
      await compliance.reload({ waitUntil: 'load' });
      await expect(review).toBeVisible({ timeout: 60_000 });
      await review.getByLabel('Reason code').selectOption(code);
      const desk = review.getByTestId('kyc-case-reject').getByTestId('control-desk');
      const phrase = `REJECT KYC ${target.recordId.slice(0, 8)}`;
      await desk.getByLabel(/to confirm$/).fill(phrase);
      await desk.getByRole('button', { name: 'Ask a second person to approve: reject with this reason' }).click();
      await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
      const packet = (await desk.getByLabel('Request packet').inputValue()).trim();
      await founder.goto(`${ADMIN}/identity-ops/kyc/${target.caseId}`, { waitUntil: 'load' });
      const deskB = founder.getByTestId('kyc-case-review').getByTestId('kyc-case-reject').getByTestId('control-desk');
      await deskB.getByLabel('Request packet').fill(packet);
      await expect(deskB.getByTestId('packet-summary')).toContainText(`reason ${code}`);
      await deskB.getByLabel(/to approve or run it$/).fill(phrase);
      await deskB.getByRole('button', { name: 'Approve this request' }).click();
      await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
      const run = async () => {
        await desk.getByLabel(/to approve or run it$/).fill(phrase);
        await desk.getByRole('button', { name: 'Run the approved request' }).click();
        await expect(desk.getByTestId('step-reply')).toBeVisible({ timeout: 60_000 });
      };
      return { desk, run };
    };

    // Stores once.
    const first = await decide('name_mismatch');
    await first.run();
    await expect(first.desk.getByTestId('step-reply')).toContainText(`as rejected with reason name_mismatch`, { timeout: 60_000 });
    const rejected = await customer.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
    const decided = rejected.body?.result?.data?.cases?.find((c) => c.id === target.caseId);
    expect(decided?.state).toBe('rejected');
    expect(decided?.reason?.code).toBe('name_mismatch');
    expect(decided?.history?.length).toBe(2);

    // A retry of the same decision returns the stored result: the same reason, no new history step.
    await first.run();
    await expect(first.desk.getByTestId('step-reply')).toContainText(`as rejected with reason name_mismatch`, { timeout: 60_000 });
    const again = await customer.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
    const stored = again.body?.result?.data?.cases?.find((c) => c.id === target.caseId);
    expect(stored?.reason?.code).toBe('name_mismatch');
    expect(stored?.history?.length).toBe(2);

    // A different code on the decided case is refused (kyc.case_state) and nothing changes.
    const second = await decide('document_unreadable');
    await second.run();
    await expect(second.desk.getByTestId('step-reply')).toHaveAttribute('data-tone', /danger|warn/, { timeout: 60_000 });
    await expect(second.desk.getByTestId('step-reply')).toContainText('kyc.case_state');
    await compliance.reload({ waitUntil: 'load' });
    await expect(review.getByTestId('kyc-case-state')).toHaveText('rejected', { timeout: 60_000 });
    await expect(review.getByTestId('kyc-case-reason')).toContainText('name_mismatch');
    await expect(review.getByTestId('kyc-case-history').locator('li')).toHaveCount(2);
  } finally {
    await compliance.context().close();
    await founder.context().close();
  }
});

test('J-identity-20 #8 an appeal on a final rejection refuses with kyc.case_final; one outside the window is refused', async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  // Two TEST customers, each rejected through the two-person path by the stack's TEST operators.
  const inTime = await pendingCase('ja');
  const late = await pendingCase('jl');
  for (const c of [inTime, late]) {
    const out = await gates.rejectPending(ctx, c.who.handle, 'document_unreadable');
    expect(
      out.every((r) => r.ok),
      JSON.stringify(out),
    ).toBe(true);
  }
  const lateRejectedAt = Date.now();
  const appeal = async (c, body) => {
    const customer = await api(c.who);
    return customer.post('/api/identity/trpc/kyc.appeal.submit', { caseId: c.caseId, body });
  };

  // The customer appeals inside the window; it waits on the case for a reviewer.
  const filed = await appeal(inTime, 'TEST: my ID photo is sharp, please look again');
  expect(filed.body?.result?.data?.decision, JSON.stringify(filed.body).slice(0, 300)).toBeNull();

  const compliance = await (await browser.newContext()).newPage();
  await staffSignIn(compliance, browser, 'compliance');
  try {
    // Compliance (not the reviewer who rejected) decides the appeal: upheld, so the rejection is final.
    await compliance.goto(`${ADMIN}/identity-ops/kyc/${inTime.caseId}`, { waitUntil: 'load' });
    const review = compliance.getByTestId('kyc-case-review');
    await expect(review).toBeVisible({ timeout: 60_000 });
    await expect(review.getByTestId('kyc-case-state')).toHaveText('rejected');
    await expect(review.getByTestId('kyc-case-appeal')).toHaveCount(1);
    await expect(review.getByTestId('kyc-case-appeal').first()).toHaveAttribute('data-decision', 'open');
    await expect(review.getByTestId('kyc-case-appeal').first()).toContainText('please look again');
    await review.getByRole('button', { name: 'Uphold the rejection' }).click();
    await expect(review.getByTestId('kyc-case-appeal-decided')).toBeVisible({ timeout: 60_000 });
    await expect(review.getByTestId('kyc-case-final')).toBeVisible({ timeout: 60_000 });
    await expect(review.getByTestId('kyc-case-appeal').first()).toHaveAttribute('data-decision', 'upheld');

    // An appeal on the final rejection refuses with kyc.case_final: the customer's, and a reviewer's decision on it again.
    const again = await appeal(inTime, 'TEST: one more try');
    expect(again.status).not.toBe(200);
    expect(JSON.stringify(again.body)).toContain('kyc.case_final');
    await review.getByRole('button', { name: 'Uphold the rejection' }).click();
    await expect(review.getByTestId('kyc-case-appeal-refusal')).toHaveAttribute('data-code', 'kyc.case_final', { timeout: 60_000 });

    // One outside the window is refused (the stack's TEST window is 90 seconds), and nothing is filed.
    const wait = lateRejectedAt + 95_000 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const closed = await appeal(late, 'TEST: too late');
    expect(closed.status).not.toBe(200);
    expect(JSON.stringify(closed.body)).toContain('kyc.appeal_closed');
    await compliance.goto(`${ADMIN}/identity-ops/kyc/${late.caseId}`, { waitUntil: 'load' });
    await expect(compliance.getByTestId('kyc-case-review').getByTestId('kyc-case-appeals-empty')).toBeVisible({ timeout: 60_000 });
  } finally {
    await compliance.context().close();
  }
});

/** Compliance asks for an approval of the case's level, the founder approves it on their console, compliance runs it. */
async function approveLevel(compliance, founder, c) {
  await compliance.goto(`${ADMIN}/identity-ops/kyc/${c.caseId}`, { waitUntil: 'load' });
  const desk = compliance.getByTestId('kyc-case-approve').getByTestId('control-desk');
  const phrase = `APPROVE KYC ${c.recordId.slice(0, 8)}`;
  await desk.getByLabel(/to confirm$/).fill(phrase, { timeout: 60_000 });
  await desk.getByRole('button', { name: 'Ask a second person to approve: approve this level' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packet = (await desk.getByLabel('Request packet').inputValue()).trim();
  await founder.goto(`${ADMIN}/identity-ops/kyc/${c.caseId}`, { waitUntil: 'load' });
  const deskB = founder.getByTestId('kyc-case-approve').getByTestId('control-desk');
  await deskB.getByLabel('Request packet').fill(packet, { timeout: 60_000 });
  await expect(deskB.getByTestId('packet-summary')).toContainText(`Approve verification request ${c.recordId}`);
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
  await desk.getByLabel(/to approve or run it$/).fill(phrase);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText(`Identity recorded request ${c.recordId} as approved`, { timeout: 60_000 });
}

/** The capability states the case page shows, read again from identity. */
async function capabilityStates(page, caseId) {
  await page.goto(`${ADMIN}/identity-ops/kyc/${caseId}`, { waitUntil: 'load' });
  const rows = page.getByTestId('kyc-case-capability');
  await expect(rows).toHaveCount(5, { timeout: 60_000 });
  return Object.fromEntries(
    await rows.evaluateAll((els) => els.map((el) => [el.getAttribute('data-capability'), el.getAttribute('data-state')])),
  );
}

test('J-identity-20 #6 approving a level turns its mapped capabilities active in one step; a mapping not set grants nothing', async ({
  browser,
}) => {
  test.setTimeout(480_000);
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const basic = await pendingCase('jb');
  const compliance = await (await browser.newContext()).newPage();
  const founder = await (await browser.newContext()).newPage();
  await staffSignIn(compliance, browser, 'compliance');
  await founderSignIn(founder, 'a');
  try {
    // Before: the request marks basic's mapped capabilities pending (the stack's TEST mapping: crypto custody, transfer, trade).
    const before = await capabilityStates(compliance, basic.caseId);
    expect(before).toEqual({
      custody_crypto: 'pending',
      custody_fiat: 'unrequested',
      transfer_crypto: 'pending',
      transfer_fiat: 'unrequested',
      trade_crypto: 'pending',
    });
    await expect(compliance.getByTestId('kyc-case-level-grants')).toContainText('custody_crypto, transfer_crypto, trade_crypto');

    // One approval turns all three active in one step; what is mapped to a higher level stays off.
    await approveLevel(compliance, founder, basic);
    expect(await capabilityStates(compliance, basic.caseId)).toEqual({
      custody_crypto: 'active',
      custody_fiat: 'unrequested',
      transfer_crypto: 'active',
      transfer_fiat: 'unrequested',
      trade_crypto: 'active',
    });
    await expect(compliance.getByTestId('kyc-case-record-status')).toHaveText('approved');

    // A level with no mapping of its own grants nothing: a person who holds full asks for institutional, which the TEST
    // mapping leaves unset; approving it changes no capability.
    const holder = await pendingCase('ji');
    const record = await (await api(holder.who)).post('/api/identity/trpc/kyc.submit', { tier: 'full', jurisdiction: 'DE' });
    expect(record.body?.result?.data?.status, JSON.stringify(record.body).slice(0, 300)).toBe('pending');
    const approved = await gates.approvePending(ctx, null, { userIds: [holder.userId] });
    expect(approved.length, JSON.stringify(approved)).toBeGreaterThan(0);
    const customer = await api(holder.who);
    const inst = await customer.post('/api/identity/trpc/kyc.submit', { tier: 'institutional', jurisdiction: 'DE' });
    expect(inst.body?.result?.data?.status, JSON.stringify(inst.body).slice(0, 300)).toBe('pending');
    const hist = await customer.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 10 }))}`);
    const instCase = hist.body?.result?.data?.cases?.find((c) => c.recordId === inst.body.result.data.id);
    expect(instCase?.state).toBe('submitted');
    const institutional = { caseId: instCase.id, recordId: instCase.recordId };
    const held = await capabilityStates(compliance, institutional.caseId);
    await expect(compliance.getByTestId('kyc-case-level-unmapped')).toContainText('No capability is mapped to institutional');
    await approveLevel(compliance, founder, institutional);
    expect(await capabilityStates(compliance, institutional.caseId)).toEqual(held);
    await expect(compliance.getByTestId('kyc-case-record-status')).toHaveText('approved');
  } finally {
    await compliance.context().close();
    await founder.context().close();
  }
});

test('J-identity-20 #3 a request for information with a deadline: the case becomes "information requested" with tasks; the customer is told', async ({
  browser,
  page,
}) => {
  test.setTimeout(480_000);
  // A TEST customer signed up in this browser, with one pending request.
  const handle = `jr${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const who = { handle, email: `${handle}@local-test.invalid`, password: `TEST-${randomBytes(9).toString('base64url')}-9a` };
  await signUpInBrowser(page, who);
  const customer = await api(who);
  const submitted = await customer.post('/api/identity/trpc/kyc.submit', { tier: 'basic', jurisdiction: 'DE' });
  const record = submitted.body?.result?.data;
  expect(record?.status, JSON.stringify(submitted.body).slice(0, 300)).toBe('pending');
  const history = async () =>
    (await customer.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`)).body?.result?.data
      ?.cases ?? [];
  const caseId = (await history()).find((c) => c.recordId === record.id)?.id;
  expect(caseId).toBeTruthy();

  const compliance = await (await browser.newContext()).newPage();
  await staffSignIn(compliance, browser, 'compliance');
  try {
    // Compliance raises a request for two items; the owner's deadline (the stack's TEST value: 7 days) applies to each.
    await compliance.goto(`${ADMIN}/identity-ops/kyc/${caseId}`, { waitUntil: 'load' });
    const review = compliance.getByTestId('kyc-case-review');
    await expect(review.getByTestId('kyc-case-rfi')).toBeVisible({ timeout: 60_000 });
    await review.getByLabel('Item code 1').fill('proof_of_address');
    await review.getByLabel('What to send 1').fill('TEST: a utility bill from the last three months');
    await review.getByRole('button', { name: 'Add an item' }).click();
    await review.getByLabel('Item code 2').fill('source_of_funds');
    await review.getByLabel('What to send 2').fill('TEST: a payslip or bank statement');
    const askedAt = Date.now();
    await review.getByRole('button', { name: 'Request information' }).click();
    await expect(review.getByTestId('kyc-case-rfi-sent')).toBeVisible({ timeout: 60_000 });

    // The case becomes "information requested" with two tasks, each due seven days out.
    await expect(review.getByTestId('kyc-case-state')).toHaveText('info_requested', { timeout: 60_000 });
    const tasks = review.getByTestId('kyc-case-task');
    await expect(tasks).toHaveCount(2);
    await expect(tasks.nth(0)).toHaveAttribute('data-task', 'proof_of_address');
    await expect(tasks.nth(1)).toHaveAttribute('data-task', 'source_of_funds');
    for (const t of await tasks.all()) await expect(t).toHaveAttribute('data-state', 'requested');
    const due = await tasks.nth(0).locator('time').getAttribute('datetime');
    const days = (Date.parse(due ?? '') - askedAt) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    // It waits on the customer, so it leaves the review queue's open cases.
    await expect(review.getByTestId('kyc-case-rfi')).toHaveCount(0);

    // The customer is told: their verification page shows the case as "Information requested" with each task and its deadline.
    await page.goto(`${ORIGIN}/verification`);
    const shown = page.locator(`[data-testid="verification__case"][data-case="${caseId}"]`);
    await expect(shown).toHaveAttribute('data-state', 'info_requested', { timeout: 60_000 });
    await expect(shown).toContainText('Information requested');
    const items = shown.getByTestId('verification__case-task');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('TEST: a utility bill from the last three months');
    await expect(items.nth(0)).toContainText('Due');
    await expect(items.nth(1)).toContainText('TEST: a payslip or bank statement');
    const theirs = (await history()).find((c) => c.id === caseId);
    expect(theirs?.state).toBe('info_requested');
    expect(theirs?.tasks?.map((t) => t.key)).toEqual(['proof_of_address', 'source_of_funds']);
  } finally {
    await compliance.context().close();
  }
});

test('J-identity-20 #9 a business application shows compliance the same status the business sees', async ({ browser, page }) => {
  test.setTimeout(480_000);
  // A TEST business sends its verification for review from its own onboarding step, which then reads "in review".
  const who = await businessReadyPerson(page, 'jk');
  const merchantId = await openBusiness(page, who, 'TEST Identity Twenty Ltd');
  await sentForReview(page, who);
  await page.goto('/pay/onboarding/verification');
  const businessNote = page.getByRole('note').filter({ hasText: 'INTAFACED' });
  await expect(businessNote).toBeVisible({ timeout: 60_000 });
  const businessSees = (await businessNote.innerText()).trim();

  const compliance = await (await browser.newContext()).newPage();
  await staffSignIn(compliance, browser, 'compliance');
  try {
    // Compliance opens the application from the verification queue by the business's merchant id.
    await compliance.goto(`${ADMIN}/identity-ops/kyc`, { waitUntil: 'load' });
    await compliance.getByLabel('Merchant id').fill(merchantId);
    await compliance.getByRole('button', { name: 'Open business application' }).click();
    const app = compliance.getByTestId('kyb-application');
    await expect(app).toHaveAttribute('data-merchant', merchantId, { timeout: 60_000 });
    await expect(app.getByTestId('kyb-application-status')).toHaveAttribute('data-status', 'pending');
    // The same status, in the same words the business reads.
    await expect(app.getByTestId('kyb-application-business-sees')).toHaveText(businessSees);
  } finally {
    await compliance.context().close();
  }
});
