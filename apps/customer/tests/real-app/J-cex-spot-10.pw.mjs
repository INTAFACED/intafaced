// World: none
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { grantVipTrial, reviewVipApplication } from '../../../../tooling/scripts/local-test-gates.mjs';
import { api, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { J, SCHEDULE, VIP_FROM, myTier, ops, publish, publishTiers, tiersAt } from './cex-spot-10.mjs';

// J-cex-spot-10 #5 #7, in the running app (docs/roadmap/journeys.json): the steps that are ours alone, our tier programme
// and VIP benefits, with the custody layer off as launch runs it. Each test makes its own TEST account, signed up and
// verified and funded nowhere: at launch the person trades on their own venue account, so nothing here touches our
// ledger or our own book. The owner's schedule is written the way two operators would, through svc-trade's two-person
// door (`setFeeSchedule`, cex-spot-10.mjs), as TEST versions, each taken away again when its test ends. #7 is three
// tests, one for each clause of its words (the benefits listed, an unsupported file refused, an approval with no trial
// amount refused): the step passes when all three do. The founder console's review of an application is the operator's
// side of #7, titled "part of", and counts for no step.
// #1 #2 #3 #4 #6 #8 #9 #10 #11 are proven on the person's own venue account, in J-cex-spot-10-venue.pw.mjs. Today's
// custodial desk's checks of them, and of #5 with fills on our own book, are in J-cex-spot-10-custodial.pw.mjs, custody
// on.

test.describe.configure({ mode: 'default' });

test(`${J} #5 opens My tier: the tier, the volume counted and from what, what is excluded, and the next threshold`, async ({
  page,
  stepPicture,
}) => {
  // A fresh account, and two schedule versions (the programme, then none) around a page.
  test.setTimeout(180_000);
  const who = await signUp(page, 'js10tier');
  await verify(page, who);
  const client = await api(who);
  const { snapshotAt } = await publishTiers(120_000, `TEST tier programme, VIP from ${VIP_FROM}`);
  try {
    // The volume counted is the person's own spot fills on our book quoted in USDT or USDC. At launch they trade on their
    // own venue account and have none here, so it is the nothing they have, read from the same fills, never invented.
    let own = 0n;
    let count = 0;
    for (const symbol of ['BTC/USDT', 'ETH/USDC', 'IFC/USDT']) {
      const { status, body } = await client.get(`/api/v1/account/trades?symbol=${encodeURIComponent(symbol)}&limit=100`);
      expect(status, JSON.stringify(body).slice(0, 300)).toBe(200);
      for (const fill of Array.isArray(body) ? body : (body.trades ?? [])) {
        own += toUnits(fill.cost);
        count += 1;
      }
    }
    const tier = await myTier(client);
    expect(toUnits(tier.volume.amount)).toBe(own);
    expect(tier.volume.fills).toBe(count);
    expect(own).toBeLessThan(toUnits(VIP_FROM));
    expect(tier).toMatchObject({
      tier: 'regular',
      lastSnapshot: null,
      volume: { reaches: 'regular' },
      next: { tierId: 'test-vip-1', minVolume30d: VIP_FROM },
      snapshotsRunning: true,
      nextSnapshotAt: snapshotAt.toISOString(),
      snapshots: [],
    });
    expect(toUnits(tier.next.remaining)).toBe(toUnits(VIP_FROM) - own);
    expect(tier.excluded).toEqual(expect.arrayContaining(['futures_and_options', 'bots_and_copy', 'sub_accounts', 'assets']));

    await signIn(page, who);
    await page.goto('/fees/my-tier');
    await expect(page.getByRole('heading', { level: 1, name: 'My fee tier' })).toBeVisible();
    await expect(page.locator('h2[data-tier=regular]')).toHaveText('Your tier: Regular');
    await expect(page.locator(`[data-volume="${tier.volume.amount}"]`)).toHaveText(
      `${tier.volume.amount} counted toward the next snapshot so far, from ${count} trades`,
    );
    await expect(page.locator('[data-reaches=regular]')).toHaveText('At the next snapshot this volume reaches: Regular');
    await expect(page.locator('[data-tier-page=next]')).toHaveText(`Next tier: test-vip-1 from ${VIP_FROM}, ${tier.next.remaining} to go`);
    await expect(page.locator('tr[data-threshold=test-vip-1] td')).toHaveText(VIP_FROM);
    // What counts, and what does not: the asset input is named as not counted, never left out.
    await expect(page.locator('[data-counted=spot]')).toContainText('quoted in USDT, USDC');
    for (const code of tier.excluded) await expect(page.locator(`[data-excluded=${code}]`)).toBeVisible();
    await expect(page.locator('[data-excluded=assets]')).toHaveText('Assets you hold: not counted (no asset thresholds set).');
    await expect(page.locator(`[data-next-snapshot="${snapshotAt.toISOString()}"]`)).toContainText(
      `Next snapshot: ${snapshotAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    );
    await expect(page.locator('[data-tier-page=snapshots]')).toContainText('No snapshot has included you yet.');
    // The step's picture: the tier, the volume and what it counts, what is excluded and the next threshold.
    await stepPicture();
  } finally {
    await publish(SCHEDULE, 'tier programme off');
  }
  // With no programme every account is regular, and the page says the thresholds are not set.
  expect(await myTier(client)).toMatchObject({ tier: 'regular', program: null, volume: null, next: null });
  await page.reload();
  await expect(page.locator('[data-tier-page=thresholds-not-set]')).toHaveText('Thresholds not set. Every account is on the regular tier.');
});

/** A TEST benefits table, never owner values: the VIP tier fills some cells, the regular tier none. */
const NOT_SET = { prioritySupport: null, vipPortal: null, ambassador: null, subAccountCap: null, withdrawalLimit24h: null };
const TEST_BENEFITS = [
  { tierId: 'regular', ...NOT_SET },
  {
    ...NOT_SET,
    tierId: 'test-vip-1',
    prioritySupport: true,
    vipPortal: false,
    subAccountCap: 20,
    withdrawalLimit24h: { asset: 'USDT', amount: '250000' },
  },
];

test(`${J} #7 opens VIP benefits: each tier's published benefits, the person's own tier marked, a blank cell "not set"`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(150_000);
  // Its own fresh account, as every test here.
  const who = await signUp(page, 'vipbenefits');
  await verify(page, who);
  const client = await api(who);
  const tiered = tiersAt(new Date(Date.now() + 3_600_000));
  await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, benefits: TEST_BENEFITS } }, 'TEST benefits table');
  try {
    const read = await myTier(client);
    expect(read.program.benefits).toEqual(TEST_BENEFITS);
    // The person's tier is whatever their last snapshot gave: their row is the one marked.
    const mine = read.tier;
    const label = (tierId) => (tierId === 'regular' ? 'Regular' : tierId);
    await signIn(page, who);
    await page.goto('/fees/my-tier');
    const table = page.locator('[data-tier-page=benefits]');
    await expect(table.getByRole('heading', { level: 2, name: 'VIP benefits' })).toBeVisible();
    await expect(table.locator('tr[aria-current=true]')).toHaveAttribute('data-benefits', mine);
    await expect(table.locator(`tr[data-benefits="${mine}"] th`)).toHaveText(`${label(mine)} (yours)`);
    const regular = table.locator('tr[data-benefits=regular]');
    await expect(regular.locator('td')).toHaveText(['not set', 'not set', 'not set', 'not set', 'not set']);
    const vip = table.locator('tr[data-benefits=test-vip-1]');
    await expect(vip.locator('td')).toHaveText(['Yes', 'No', 'not set', '20', 'up to 250000 USDT']);
    // The step's picture: the benefits listed, before the table is taken away again below.
    await stepPicture();
  } finally {
    await publish(SCHEDULE, 'benefits table off');
  }
  // With no programme there is no table, and the page says so.
  await page.reload();
  await expect(page.locator('[data-benefits=not-set]')).toHaveText('Benefits not set: no tier has published benefits beyond its rates.');
});

/** TEST application rules, never owner values: PDF or PNG proofs up to 256 KB. */
const TEST_APPLICATION = { proofTypes: ['application/pdf', 'image/png'], maxBytes: 256 * 1024 };
/** A TEST proof: the smallest well-formed PDF header and a line naming it TEST. */
const TEST_PDF = Buffer.from('%PDF-1.4\n% TEST proof of VIP status elsewhere, not a real statement\n%%EOF\n');

test(`${J} #7 applies with a proof file: a type not accepted is refused naming the accepted ones, a PDF waits for review`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  // Its own fresh applicant: an application is never deleted, so a step re-run alone must not meet the last one.
  const who = await signUp(page, 'vipapply');
  await verify(page, who);
  const client = await api(who);
  const tiered = tiersAt(new Date(Date.now() + 3_600_000));
  await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, application: TEST_APPLICATION } }, 'TEST VIP application rules');
  try {
    const before = await client.get('/api/v1/vip/applications');
    expect(before.status, JSON.stringify(before.body).slice(0, 300)).toBe(200);
    expect(before.body).toEqual({ rules: TEST_APPLICATION, closed: null, applications: [] });
    await signIn(page, who);
    await page.goto('/fees/my-tier');
    const card = page.locator('[data-tier-page=vip-apply]');
    await expect(card.getByRole('heading', { level: 2, name: 'Apply for a VIP tier' })).toBeVisible();
    await expect(card.locator('[data-vip=rules]')).toHaveText('Accepted files: PDF, PNG, up to 256 KB.');
    await expect(card.locator('[data-vip=none]')).toHaveText('You have not applied.');
    const file = card.getByLabel('Proof file');
    const send = card.getByRole('button', { name: 'Send application' });

    // A type the owner does not accept: the service refuses it and the card names what is accepted.
    await file.setInputFiles({ name: 'statement.txt', mimeType: 'text/plain', buffer: Buffer.from('TEST statement') });
    let answer = page.waitForResponse((r) => r.url().endsWith('/api/v1/vip/applications') && r.request().method() === 'POST');
    await send.click();
    expect((await answer).status()).toBe(400);
    await expect(card.locator('[data-vip-result=refused]')).toHaveText('Not sent: text/plain is not an accepted file. Accepted: PDF, PNG.');
    // The step's picture: the unsupported file refused, before the card goes on to the next file.
    await stepPicture();

    // Named a PDF but not one: refused by its bytes, not its name.
    await file.setInputFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: Buffer.from('TEST not a pdf') });
    answer = page.waitForResponse((r) => r.url().endsWith('/api/v1/vip/applications') && r.request().method() === 'POST');
    await send.click();
    expect((await answer).status()).toBe(400);
    await expect(card.locator('[data-vip-result=refused]')).toHaveText('Not sent: this file is not a PDF. Accepted: PDF, PNG.');
    expect((await client.get('/api/v1/vip/applications')).body.applications).toEqual([]);

    // A PDF: kept, waiting for review, and the form gives way to the waiting line.
    await file.setInputFiles({ name: 'statement.pdf', mimeType: 'application/pdf', buffer: TEST_PDF });
    await card.getByLabel('Note for the reviewer (optional)').fill('TEST: VIP at another venue');
    answer = page.waitForResponse((r) => r.url().endsWith('/api/v1/vip/applications') && r.request().method() === 'POST');
    await send.click();
    expect((await answer).status()).toBe(201);
    await expect(card.locator('[data-vip-result=sent]')).toHaveText('Application sent: statement.pdf is waiting for review.');
    await expect(card.locator('[data-vip=waiting]')).toBeVisible();
    await expect(card.locator('form')).toHaveCount(0);
    await expect(card.locator('tr[data-vip-application=pending] td').last()).toHaveText('Waiting for review');

    // The person's read is metadata: the file's name, type, size and digest, never its bytes.
    const after = await client.get('/api/v1/vip/applications');
    expect(after.body.applications).toHaveLength(1);
    const [kept] = after.body.applications;
    expect(kept).toMatchObject({
      status: 'pending',
      note: 'TEST: VIP at another venue',
      proof: {
        fileName: 'statement.pdf',
        contentType: 'application/pdf',
        byteLength: TEST_PDF.length,
        sha256: createHash('sha256').update(TEST_PDF).digest('hex'),
      },
    });
    expect(JSON.stringify(after.body)).not.toContain(TEST_PDF.toString('base64'));
  } finally {
    await publish(SCHEDULE, 'application rules off');
  }
  // With no rules published, applications are not open, and the waiting application is still listed.
  await page.reload();
  const card = page.locator('[data-tier-page=vip-apply]');
  await expect(card.locator('[data-vip=not-open]')).toHaveText('Applications are not open: no accepted proof file is published.');
  await expect(card.locator('tr[data-vip-application=pending]')).toHaveCount(1);
});

test(`${J} #7 compliance approves with no trial published: the grant is refused vip.trial_unset, then granted once one is`, async ({
  page,
  stepPicture,
}) => {
  test.setTimeout(240_000);
  // Its own fresh applicant, as above.
  const who = await signUp(page, 'vipreview');
  await verify(page, who);
  const client = await api(who);
  const { ctx, sessions } = await ops();
  const tiered = tiersAt(new Date(Date.now() + 3_600_000));
  // The application rules are published and no trial is: an approval can grant none.
  await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, application: TEST_APPLICATION } }, 'TEST VIP rules, no trial');
  let applicationId;
  try {
    const sent = await client.post('/api/v1/vip/applications', {
      requestId: `vip-review-${Date.now()}`,
      proof: { fileName: 'statement.pdf', contentType: 'application/pdf', bytesBase64: TEST_PDF.toString('base64') },
    });
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(201);
    applicationId = sent.body.application.id;

    // Two TEST operators: one proposes the approval at identity, the other approves it, the first applies it.
    const reviewed = await reviewVipApplication(ctx, { applicationId, decision: 'approve', sessions });
    const decided = reviewed.json?.result?.data;
    expect(decided, JSON.stringify(reviewed.json).slice(0, 400)).toBeTruthy();
    expect(decided.application).toMatchObject({ id: applicationId, status: 'approved_no_trial', trial: null });
    expect(decided.trialRefusal).toBe('vip.trial_unset');
    const approval = decided.application.events.at(-1);
    expect(approval).toMatchObject({ status: 'approved_no_trial', actorRole: 'compliance' });
    expect(approval.approverId).toBeTruthy();
    expect(approval.approverId).not.toBe(approval.actorId);

    // Granting the trial is refused by name, and the application stays as it was.
    const grant = await grantVipTrial(ctx, { applicationId, sessions });
    expect(grant.json?.error?.data?.cause?.code, JSON.stringify(grant.json).slice(0, 400)).toBe('vip.trial_unset');
    const mine = await client.get('/api/v1/vip/applications');
    expect(mine.body.applications.map((a) => [a.id, a.status])).toEqual([[applicationId, 'approved_no_trial']]);

    // The person sees the decision on My tier, and stays on the tier their volume gives.
    await signIn(page, who);
    await page.goto('/fees/my-tier');
    const card = page.locator('[data-tier-page=vip-apply]');
    await expect(card.locator('tr[data-vip-application=approved_no_trial] td').last()).toHaveText('Approved, no trial period set');
    await expect(page.locator('[data-tier-page=tier] h2')).toHaveText('Your tier: Regular');
    await expect(page.locator('[data-tier-page=trial]')).toHaveCount(0);
    // The step's picture: the approval with no trial amount, and no trial on the person's tier.
    await stepPicture();

    // Once the owner publishes a trial, the grant goes through with its own approval: the tier is the trial's until it ends.
    const trial = { tierId: 'test-vip-1', days: 1 };
    await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, application: TEST_APPLICATION, trial } }, 'TEST VIP trial');
    const granted = await grantVipTrial(ctx, { applicationId, sessions });
    const after = granted.json?.result?.data;
    expect(after, JSON.stringify(granted.json).slice(0, 400)).toBeTruthy();
    expect(after.application).toMatchObject({ status: 'approved', trial: { tierId: 'test-vip-1', days: 1 } });
    const tier = await myTier(client);
    expect(tier.tier).toBe('test-vip-1');
    expect(tier.trial).toMatchObject({ applicationId, tierId: 'test-vip-1', endsAt: after.application.trial.endsAt });
    await page.reload();
    await expect(page.locator('[data-tier-page=tier] h2')).toHaveText('Your tier: test-vip-1');
    await expect(page.locator('[data-tier-page=trial]')).toContainText('From your VIP trial, until ');
    await expect(card.locator('tr[data-vip-application=approved] td').last()).toHaveText('Approved');
  } finally {
    await publish(SCHEDULE, 'VIP rules off');
  }
});

test(`${J}, part of #7, compliance decides in the founder console: the proof saved for a reason, a second founder approves, the trial starts`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // Its own fresh applicant, as above, with a TEST one-day trial published, so an approval grants it.
  const who = await signUp(page, 'vipdesk');
  await verify(page, who);
  const client = await api(who);
  const tiered = tiersAt(new Date(Date.now() + 3_600_000));
  const trial = { tierId: 'test-vip-1', days: 1 };
  await publish({ ...tiered, tierProgram: { ...tiered.tierProgram, application: TEST_APPLICATION, trial } }, 'TEST VIP trial for the desk');
  const a = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const b = await (await browser.newContext()).newPage();
  try {
    const sent = await client.post('/api/v1/vip/applications', {
      requestId: `vip-desk-${Date.now()}`,
      proof: { fileName: 'statement.pdf', contentType: 'application/pdf', bytesBase64: TEST_PDF.toString('base64') },
    });
    expect(sent.status, JSON.stringify(sent.body).slice(0, 300)).toBe(201);
    const applicationId = sent.body.application.id;

    // Founder A opens the room: what an approval grants now, and the application waiting.
    await founderSignIn(a, 'a');
    await a.goto(`${ADMIN}/trade-ops/vip-applications`);
    const room = a.locator('[data-room=vip-applications]');
    await expect(room).toContainText('An approval grants now');
    await expect(room).toContainText('test-vip-1 for 1 day');
    const row = room.getByRole('row').filter({ hasText: client.userId });
    await expect(row).toContainText('Waiting for review');
    await row.getByRole('button', { name: 'Open' }).click();
    const panel = a.locator('[data-vip-desk=open]');
    await expect(panel).toContainText(`Application ${applicationId}`);

    // The proof is saved, never shown, and only for a stated reason: the bytes are the ones the person sent.
    const reason = 'TEST statement checked against the venue';
    await panel.getByLabel(/^Reason \(12 to 500/).fill(reason);
    const [download] = await Promise.all([a.waitForEvent('download'), panel.getByRole('button', { name: 'Save the proof file' }).click()]);
    expect(download.suggestedFilename()).toBe('statement.pdf');
    const saved = await download.path();
    expect(createHash('sha256').update(readFileSync(saved)).digest('hex')).toBe(createHash('sha256').update(TEST_PDF).digest('hex'));
    await expect(panel).toContainText('The opening is in the audit.');

    // A asks for the approval; applying it before a second founder approves decides nothing.
    await panel.getByRole('button', { name: 'Ask a second founder to approve' }).click();
    await expect(panel).toContainText('Request filed');
    const valueOf = (label) => panel.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');
    const approvalId = (await valueOf('Approval id (apply with this once approved)').innerText()).trim();
    const payloadHash = (await valueOf('Payload hash (the approver confirms this)').innerText()).trim();
    expect(payloadHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    await panel.getByLabel('Approved request id').fill(approvalId);
    const apply = async () => {
      await panel.getByRole('button', { name: 'Apply the approved decision' }).click();
      const dialog = a.getByRole('alertdialog');
      await expect(dialog).toContainText('the person is on test-vip-1 for 1 day, from now');
      await dialog.getByRole('button', { name: 'Apply decision' }).click();
      return dialog;
    };
    const early = await apply();
    await expect(early).toContainText('still waiting for a second founder');
    await early.getByRole('button', { name: 'Cancel' }).click();
    expect((await client.get('/api/v1/vip/applications')).body.applications.map((x) => x.status)).toEqual(['pending']);

    // Founder B first checks what the request is: the same decision and reason in the room give the same hash.
    const approver = await founderSignIn(b, 'b');
    await b.goto(`${ADMIN}/trade-ops/vip-applications`);
    await b
      .locator('[data-room=vip-applications]')
      .getByRole('row')
      .filter({ hasText: client.userId })
      .getByRole('button', { name: 'Open' })
      .click();
    const bPanel = b.locator('[data-vip-desk=open]');
    await bPanel.getByLabel(/^Reason \(12 to 500/).fill(reason);
    await bPanel.getByRole('button', { name: 'Work out the hash to check' }).click();
    await expect(bPanel.locator('[data-vip-desk=check]')).toContainText(payloadHash);
    await expect(bPanel.locator('[data-vip-desk=check]')).toContainText('test-vip-1 for 1 day');

    // B approves exactly that hash in Freezes & approvals; A applies it.
    await b.goto(`${ADMIN}/trade-ops/approvals`);
    // The pending list loads after the page and lands above the form, moving "Approve request": act once it is in, or a
    // press before it lands and a release after miss the button (J-cex-spot-17 #4, main run 42455893390, #7536).
    await expect(b.getByRole('grid', { name: 'Approvals waiting for this operator' })).toBeVisible();
    await b.getByLabel('Approval id', { exact: true }).fill(approvalId);
    await b.getByLabel('Payload hash you reviewed').fill(payloadHash);
    await b.getByRole('button', { name: 'Approve request' }).click();
    const approveDialog = b.getByRole('alertdialog');
    await expect(approveDialog).toBeVisible();
    await approveDialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect(approveDialog.locator('[data-outcome=ok]')).toBeVisible();

    // Applied: the panel stays open on the decided application and says what was done.
    await apply();
    await expect(panel.locator('[data-vip-desk=applied]')).toContainText('Applied: approved, on test-vip-1 until ');
    await expect(panel).toContainText('Approved');
    await expect(panel).toContainText(`approved by ${approver.userId}`);
    await expect(panel).toContainText(/test-vip-1, 1 days?, /);

    // The person is on the trial's tier until it ends.
    const tier = await myTier(client);
    expect(tier.tier).toBe('test-vip-1');
    expect(tier.trial).toMatchObject({ applicationId, tierId: 'test-vip-1' });
    await signIn(page, who);
    await page.goto('/fees/my-tier');
    await expect(page.locator('[data-tier-page=tier] h2')).toHaveText('Your tier: test-vip-1');
    await expect(page.locator('[data-tier-page=trial]')).toContainText('From your VIP trial, until ');
  } finally {
    await a.context().close();
    await b.context().close();
    await publish(SCHEDULE, 'VIP rules off');
  }
});
