// World: restart
import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ORIGIN, api, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { staffSignIn } from './staff.mjs';

// J-academy-17 "Audit grants and certificates, and revoke one", in the founder console (docs/roadmap/journeys.json). One
// test per step, titled "J-academy-17 #<n>", run in order. The person is the stack's TEST compliance staff member
// (identity's TEST roster; staff.mjs). The grants and revokes they audit are made here first, through Academy's own admin
// door with the stack's TEST founders, as an operator would: a fresh TEST learner given staff access to a course with a
// reason, who earns the Foundations certificate, and has it revoked with a reason under the two-founder rule. The
// certificate issue rule is shared, so it is set to automatic for the earn and put back to manual after. #6 revokes
// through the console itself (founder A asks, founder B approves, A runs), for a learner whose certificate XP lifted them
// to the next rank, so the perk that rank gave is seen to stop.
const J = 'J-academy-17';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const COURSE = 'foundations';
const CERT = 'foundations-v1';
const ACCESS_PATH = 'sovereign';

test.describe.configure({ mode: 'serial' });

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

async function read(who, procedure, input) {
  const res = await (await api(who)).get(trpc(procedure, input));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

/** Staff act through Academy's admin door with the stack's TEST founders, the same door the ops desk uses. */
let staffDoor;
async function founders() {
  staffDoor ??= (async () => {
    const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
    const ctx = await gates.makeContext({ log: () => {} });
    const sessions = await gates.approverSessions(ctx);
    return { gates, ctx, sessions, token: await sessions.a.tradeOpsToken() };
  })();
  return staffDoor;
}
async function staff(procedure, input) {
  const { ctx, token } = await founders();
  const res = await ctx.edge.mutate('academy', procedure, input, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
}
const setIssueRule = (mode) =>
  staff('admin.setCertIssueRule', { certId: CERT, mode, delayMinutes: null, reason: `TEST ${J}: issue rule ${mode}` });

/** Founder A proposes, founder B approves, then A revokes: the two-founder rule for a revoke. */
async function revoke(publicId, reason) {
  const { gates, ctx, sessions, token } = await founders();
  const action = 'academy.cert.revoke';
  const payloadHash = `sha256:${createHash('sha256')
    .update(JSON.stringify({ actionType: action, publicId, reason }))
    .digest('hex')}`;
  const approval = await gates.twoPerson(ctx, sessions, {
    actionType: action,
    targetService: 'svc-academy',
    targetId: action,
    expectedVersion: '1',
    payloadHash,
    policyVersion: gates.MARKERS.policyVersion,
  });
  const res = await ctx.edge.mutate('academy', 'admin.revokeCert', { publicId, reason, ...approval }, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
}

/** The stack's grant audit page size switched off (blank) or back on, by restarting svc-academy (academy.mjs). */
function grantAuditPage(on) {
  const before = process.env.LOCAL_STACK_ACADEMY_GRANT_AUDIT;
  if (on) delete process.env.LOCAL_STACK_ACADEMY_GRANT_AUDIT;
  else process.env.LOCAL_STACK_ACADEMY_GRANT_AUDIT = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'academy');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_ACADEMY_GRANT_AUDIT;
    else process.env.LOCAL_STACK_ACADEMY_GRANT_AUDIT = before;
  }
}

test(`${J} #1 opens /academy-ops/grants: grants and revokes newest first, each with actor, time and reason`, async ({ page, browser }) => {
  test.setTimeout(300_000);
  const { sessions } = await founders();
  const founderA = sessions.a.op.userId;
  expect(founderA, 'founder A has a user id').toMatch(/^[0-9a-f-]{36}$/);

  // A fresh TEST learner on the Foundations course, every required item done but the last.
  const learnerTab = await (await browser.newContext()).newPage();
  const who = await signUp(learnerTab, 'ja17');
  await verify(learnerTab, who);
  await signIn(learnerTab, who);
  const session = await api(who);
  const learnerId = session.userId;
  await learnerTab.goto(`/academy/learning/course/${COURSE}`);
  await learnerTab.locator('[data-academy-enrol]').getByRole('button', { name: 'Enrol now', exact: true }).click();
  await expect(learnerTab.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  const items = (await read(who, 'certDefinitions')).find((row) => row.id === CERT).requiredItemSlugs;
  for (const itemSlug of items.slice(0, -1)) {
    const done = await session.post(trpc('markCurriculumComplete'), { itemSlug });
    expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
  }

  // 1. Staff grant the learner access to a course, with a reason.
  const accessReason = `TEST ${J}: staff access for the audit`;
  await staff('admin.grantAccess', { userId: learnerId, pathSlug: ACCESS_PATH, reason: accessReason, expiresAt: null });
  // 2. The learner finishes the course and the certificate is issued by the rule (no person, so no actor).
  await setIssueRule('automatic');
  let publicId;
  try {
    const last = await session.post(trpc('markCurriculumComplete'), { itemSlug: items.at(-1) });
    expect(last.status, JSON.stringify(last.body).slice(0, 300)).toBe(200);
    await expect
      .poll(async () => (await read(who, 'myCerts', { limit: 50 })).find((row) => row.certId === CERT)?.publicId ?? null, {
        timeout: 30_000,
      })
      .not.toBeNull();
    publicId = (await read(who, 'myCerts', { limit: 50 })).find((row) => row.certId === CERT).publicId;
  } finally {
    await setIssueRule('manual');
  }
  // 3. Two founders revoke it, with a reason.
  const revokeReason = `TEST ${J}: revoked for the audit`;
  await revoke(publicId, revokeReason);
  run.reset({ learnerId, publicId, founderA });
  await learnerTab.context().close();

  // Compliance opens the grant audit: the three lines just made are the newest, newest first, each with who and why.
  await staffSignIn(page, browser, 'compliance');
  await page.goto(`${ADMIN}/academy-ops/grants`);
  const audit = page.getByTestId('read-academy.grant-audit');
  await expect(audit.getByRole('heading', { name: 'Grants and revokes' })).toBeVisible({ timeout: 60_000 });
  const rows = audit.getByRole('table').getByRole('row').filter({ hasText: learnerId });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Certificate revoked');
  await expect(rows.nth(0)).toContainText(CERT);
  await expect(rows.nth(0)).toContainText(founderA);
  await expect(rows.nth(0)).toContainText(revokeReason);
  await expect(rows.nth(1)).toContainText('Certificate issued');
  await expect(rows.nth(1)).toContainText(CERT);
  await expect(rows.nth(1)).not.toContainText(founderA);
  await expect(rows.nth(2)).toContainText('Course access granted');
  await expect(rows.nth(2)).toContainText(ACCESS_PATH);
  await expect(rows.nth(2)).toContainText(founderA);
  await expect(rows.nth(2)).toContainText(accessReason);
  // Every line shows its time, and they are newest first: the same lines as the service records them, in its order.
  for (let i = 0; i < 3; i++) await expect(rows.nth(i)).toContainText(/\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2}/);
  const { ctx, token } = await founders();
  const stored = await ctx.edge.query('academy', 'admin.grantAudit', { certificate: CERT }, token);
  expect(stored.status, stored.text.slice(0, 300)).toBe(200);
  const mine = JSON.parse(stored.text).result.data.items.filter((l) => l.accountId === learnerId);
  expect(mine.map((l) => l.kind)).toEqual(['certificate_revoked', 'certificate_granted']);
  expect(Date.parse(mine[0].at)).toBeGreaterThanOrEqual(Date.parse(mine[1].at));

  // With the owner's page size blank, the page says the size is not set, and shows no lines.
  grantAuditPage(false);
  try {
    await page.reload();
    await expect(audit).toContainText('The grant audit page size is not set', { timeout: 60_000 });
    await expect(audit.getByRole('table')).toHaveCount(0);
  } finally {
    grantAuditPage(true);
  }

  // With none for a course, the audit has no line for it: an empty answer, never an invented row.
  const none = await ctx.edge.query('academy', 'admin.grantAudit', { course: `${J}-no-such-course` }, token);
  expect(none.status, none.text.slice(0, 300)).toBe(200);
  expect(JSON.parse(none.text).result.data).toEqual({ items: [], nextCursor: null });
});

/** The learner's rank and perks as identity holds them: { rank, xp, nextRankAt, feeDiscountBps }. */
async function rankOf(session) {
  const rank = await session.get('/api/identity/trpc/rank.get');
  expect(rank.status, JSON.stringify(rank.body).slice(0, 300)).toBe(200);
  const perks = await session.get('/api/identity/trpc/rank.perks');
  expect(perks.status, JSON.stringify(perks.body).slice(0, 300)).toBe(200);
  const { rank: level, xp, nextRankAt } = rank.body.result.data;
  return { rank: level, xp: BigInt(xp), nextRankAt: nextRankAt === null ? null : BigInt(nextRankAt), perks: perks.body.result.data };
}

/** The rank card on the learner's Account page: the lifetime XP and the trading fee discount the rank gives. */
async function expectRankCard(page, xp, feeDiscountBps) {
  await page.goto('/uc/account');
  const card = page.getByTestId('rank-perks');
  const value = (label) => card.locator('dt', { hasText: label }).locator('xpath=following-sibling::dd[1]');
  await expect(value('Lifetime XP')).toHaveText(new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(xp));
  await expect(value('Trading fee discount')).toHaveText(`${feeDiscountBps / 100}%`);
}

/** One founder's console on the Certificates page, scoped to its revoke control. */
async function revokeDesk(page) {
  await page.goto(`${ADMIN}/academy-ops/certificates`, { waitUntil: 'load' });
  const desk = page.getByTestId('revoke-certificate');
  await expect(desk.getByRole('heading', { name: 'Revoke a certificate' })).toBeVisible({ timeout: 60_000 });
  return desk;
}

test(`${J} #6 revokes a certificate with a reason: the verify page shows revoked, the revoke is in the grant audit, and the XP-backed perk stops`, async ({
  page,
  browser,
}) => {
  test.setTimeout(480_000);
  // Every browser this step opens is closed at the end, pass or fail.
  const contexts = [];
  const tab = async (options) => {
    const context = await browser.newContext(options);
    contexts.push(context);
    return context.newPage();
  };
  try {
    // A fresh TEST learner, verified at both levels (identity awards XP for each approval), on the Foundations course.
    const learnerTab = await tab();
    const who = await signUp(learnerTab, 'ja17r');
    await verify(learnerTab, who, 'Basic');
    await signIn(learnerTab, who);
    await verify(learnerTab, who, 'Full');
    await signIn(learnerTab, who);
    const session = await api(who);
    const learnerId = session.userId;

    // The XP the owner published for this certificate. With none, a revoke has no perk to stop, so this step cannot be shown.
    const policy = (await read(who, 'certXpPlane')).policies.find((row) => row.certId === CERT);
    expect(policy, `the stack publishes an XP value for ${CERT}: without one no perk is backed by the certificate`).toBeTruthy();
    const certXp = BigInt(policy.xpDelta);
    expect(certXp > 0n).toBe(true);

    // Before the certificate: the learner's XP and perks, and the certificate's XP is what lifts them to the next rank.
    const before = await rankOf(session);
    expect(before.nextRankAt, 'the learner has a next rank to reach').not.toBeNull();
    expect(
      before.nextRankAt <= certXp,
      `the certificate's ${certXp} XP reaches the next rank from ${before.xp} XP (${before.nextRankAt} to go), so it backs a perk`,
    ).toBe(true);

    // The learner earns the certificate: every required item, issued by the rule (set to automatic for the earn only).
    await learnerTab.goto(`/academy/learning/course/${COURSE}`);
    await learnerTab.locator('[data-academy-enrol]').getByRole('button', { name: 'Enrol now', exact: true }).click();
    await expect(learnerTab.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
    const items = (await read(who, 'certDefinitions')).find((row) => row.id === CERT).requiredItemSlugs;
    for (const itemSlug of items.slice(0, -1)) {
      const done = await session.post(trpc('markCurriculumComplete'), { itemSlug });
      expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
    }
    await setIssueRule('automatic');
    let publicId;
    try {
      const last = await session.post(trpc('markCurriculumComplete'), { itemSlug: items.at(-1) });
      expect(last.status, JSON.stringify(last.body).slice(0, 300)).toBe(200);
      await expect
        .poll(async () => (await read(who, 'myCerts', { limit: 50 })).find((row) => row.certId === CERT)?.publicId ?? null, {
          timeout: 30_000,
        })
        .not.toBeNull();
      publicId = (await read(who, 'myCerts', { limit: 50 })).find((row) => row.certId === CERT).publicId;
    } finally {
      await setIssueRule('manual');
    }

    // With the certificate, the rank holds its XP and the next rank's perk: a trading fee discount the learner did not have.
    await expect.poll(async () => (await rankOf(session)).xp, { timeout: 30_000 }).toBe(before.xp + certXp);
    const earned = await rankOf(session);
    expect(earned.rank).toBeGreaterThan(before.rank);
    expect(earned.perks.feeDiscountBps).toBeGreaterThan(before.perks.feeDiscountBps);
    await expectRankCard(learnerTab, earned.xp, earned.perks.feeDiscountBps);

    // Founder A asks to revoke it with a reason; a blank reason or a malformed code holds the form.
    const reason = `TEST ${J} #6: revoked with a reason after review`;
    const founderA = await tab();
    const founderB = await tab();
    const a = await founderSignIn(founderA, 'a');
    await founderSignIn(founderB, 'b');
    const askDesk = await revokeDesk(founderA);
    const code = askDesk.getByLabel('Public code of the certificate to revoke');
    const ask = askDesk.getByRole('button', { name: /^Ask a second operator to approve the revoke/ });
    await code.fill('not-a-certificate');
    await expect(askDesk).toContainText('That is not a certificate code');
    await expect(ask).toBeDisabled();
    await code.fill(publicId);
    const phrase = `REVOKE CERTIFICATE ${publicId.slice(0, 8)}`;
    await askDesk.getByLabel(/to confirm$/).fill(phrase);
    await expect(ask).toBeDisabled();
    await expect(askDesk).toContainText('Write the reason first');
    await askDesk.getByLabel(/^Why \(shown in the grant audit/).fill(reason);
    await expect(ask).toBeEnabled();
    await ask.click();
    await expect(askDesk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
    const packetText = (await askDesk.getByLabel('Request packet').inputValue()).trim();

    // Founder B approves that exact packet on their own console; founder A runs it.
    const approveDesk = await revokeDesk(founderB);
    await approveDesk.getByLabel('Request packet').fill(packetText);
    await expect(approveDesk.getByTestId('packet-summary')).toContainText(publicId);
    await expect(approveDesk.getByTestId('packet-summary')).toContainText(reason);
    await approveDesk.getByLabel(/to approve or run it$/).fill(phrase);
    await approveDesk.getByRole('button', { name: 'Approve this request' }).click();
    await expect(approveDesk.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
    await askDesk.getByLabel(/to approve or run it$/).fill(phrase);
    await askDesk.getByRole('button', { name: 'Run the approved request' }).click();
    const ran = askDesk.getByTestId('step-reply');
    await expect(ran).toContainText(`certificate ${publicId} is revoked`, { timeout: 60_000 });
    await expect(ran).toContainText(`The ${certXp} XP it gave was sent back to the rank ladder.`);

    // The public verify page, signed out, says revoked.
    const verifyPage = await tab({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
    await verifyPage.goto(`/academy/certificates/verify/${publicId}`);
    await expect(verifyPage.locator(`[data-certificate-verify="${publicId}"]`).getByTestId('verify-status')).toHaveText('Revoked');

    // Compliance sees the revoke in the grant audit: newest line for this learner, founder A, the reason.
    await staffSignIn(page, browser, 'compliance');
    await page.goto(`${ADMIN}/academy-ops/grants`);
    const audit = page.getByTestId('read-academy.grant-audit');
    await expect(audit.getByRole('heading', { name: 'Grants and revokes' })).toBeVisible({ timeout: 60_000 });
    const rows = audit.getByRole('table').getByRole('row').filter({ hasText: learnerId });
    await expect(rows.nth(0)).toContainText('Certificate revoked');
    await expect(rows.nth(0)).toContainText(CERT);
    await expect(rows.nth(0)).toContainText(a.userId);
    await expect(rows.nth(0)).toContainText(reason);

    // The XP the certificate backed is gone from the rank, and the perk it gave is no longer listed.
    await expect.poll(async () => (await rankOf(session)).xp, { timeout: 30_000 }).toBe(before.xp);
    const after = await rankOf(session);
    expect(after.rank).toBe(before.rank);
    expect(after.perks).toEqual(before.perks);
    expect(after.perks.feeDiscountBps).toBeLessThan(earned.perks.feeDiscountBps);
    await expectRankCard(learnerTab, after.xp, after.perks.feeDiscountBps);
    await expect(learnerTab.getByTestId('rank-perks')).not.toContainText(`${earned.perks.feeDiscountBps / 100}%`);
  } finally {
    for (const context of contexts) await context.close().catch(() => undefined);
  }
});
