// World: restart
import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { api, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { staffSignIn } from './staff.mjs';

// J-academy-17 "Audit grants and certificates, and revoke one", in the founder console (docs/roadmap/journeys.json). One
// test per step, titled "J-academy-17 #<n>", run in order. The person is the stack's TEST compliance staff member
// (identity's TEST roster; staff.mjs). The grants and revokes they audit are made here first, through Academy's own admin
// door with the stack's TEST founders, as an operator would: a fresh TEST learner given staff access to a course with a
// reason, who earns the Foundations certificate, and has it revoked with a reason under the two-founder rule. The
// certificate issue rule is shared, so it is set to automatic for the earn and put back to manual after.
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
  // The learner's lines for this step's own subjects, each matched whole: the Foundations certificate and the access path.
  // Other journeys' TEST programmes that hold the same items issue their own certificates to the learner too
  // (`programme:test-j05-…` on #7781's run 42743679485); those are their lines, not this step's.
  const own = (subject) => page.getByRole('cell', { name: subject, exact: true });
  const rows = audit
    .getByRole('table')
    .getByRole('row')
    .filter({ hasText: learnerId })
    .filter({ has: own(CERT).or(own(ACCESS_PATH)) });
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

// ─── #2 to #4: the certificate design and the issued list (AC-certificates-03) ───────────────────────────────────────
// The Foundations design is one record every journey shares: this file activates it only inside #3 and switches it off
// again before #3 ends, so no other file's certificate ever prints this file's TEST design.
// The person is the TEST compliance staff member, as in #1: saving, activating and deactivating a design and making an
// export are compliance work (`admin:compliance`), which the compliance role holds and plain `admin:write` does not.

const designCard = (page) => page.locator(`[data-cert-design="${CERT}"]`);
const outcome = (page) => page.getByTestId('cert-desk-outcome');
const SIGNER = { name: `TEST Signer ${J}`, role: 'TEST Head of Academy' };
const designTitle = (n) => `TEST Foundations design ${run.read().stamp ?? ''} v${n}`;

/** Opens the designs page as the compliance staff member, with the Foundations card visible. */
async function openDesigns(page, browser) {
  await staffSignIn(page, browser, 'compliance');
  await page.goto(`${ADMIN}/academy-ops/certificates/designs`);
  await expect(designCard(page)).toBeVisible({ timeout: 60_000 });
  return designCard(page);
}

/** Fills the design form and saves it with a reason; answers once the page shows the outcome. */
async function saveDesign(page, { title, signatories, disclaimer, reason }) {
  const card = designCard(page);
  const form = card.getByTestId('cert-design-form');
  await form.getByLabel('Design title').fill(title);
  await form.getByLabel('Design body').fill(`TEST ${J}: completed every Foundations lesson.`);
  // Take every signatory off, then put in the ones asked for, so a design left from an earlier run starts the same.
  while ((await form.getByTestId('cert-signatory').count()) > 0) await form.getByRole('button', { name: /^Remove signatory 1$/ }).click();
  for (const [i, s] of signatories.entries()) {
    await form.getByRole('button', { name: 'Add signatory' }).click();
    await form.getByLabel(`Signatory ${i + 1} name`).fill(s.name);
    await form.getByLabel(`Signatory ${i + 1} role`).fill(s.role);
  }
  await form.getByLabel('Design disclaimer').fill(disclaimer);
  await form.getByLabel('Design reason').fill(reason);
  await form.getByRole('button', { name: 'Save design' }).click();
  await expect(outcome(page)).toBeVisible();
}

async function staffRead(procedure, input) {
  const { ctx, token } = await founders();
  const res = await ctx.edge.query('academy', procedure, input, token);
  expect(res.status, res.text.slice(0, 300)).toBe(200);
  return JSON.parse(res.text).result.data;
}

test(`${J} #2 activating a certificate design with no signatory, then with a blank disclaimer, each refuses with its own typed reason`, async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  run.write({ stamp: Date.now().toString(36) });
  const card = await openDesigns(page, browser);

  // A draft with no signatory saves, and activating it refuses by name.
  await saveDesign(page, { title: designTitle(1), signatories: [], disclaimer: 'TEST disclaimer', reason: `TEST ${J}: draft` });
  await expect(outcome(page)).toHaveAttribute('data-code', '');
  await expect(card).toHaveAttribute('data-state', 'draft');
  await card.getByLabel('Activation reason').fill(`TEST ${J}: activate with no signatory`);
  await card.getByRole('button', { name: /^Activate revision \d+$/ }).click();
  await expect(outcome(page)).toHaveAttribute('data-code', 'academy.cert_signatory_missing');
  await expect(outcome(page)).toContainText('The design has no signatory');
  await expect(card).toHaveAttribute('data-state', 'draft');

  // With a signatory and a blank disclaimer, activating refuses for the disclaimer, a different reason.
  await saveDesign(page, { title: designTitle(1), signatories: [SIGNER], disclaimer: '', reason: `TEST ${J}: signatory added` });
  await expect(outcome(page)).toHaveAttribute('data-code', '');
  await card.getByLabel('Activation reason').fill(`TEST ${J}: activate with a blank disclaimer`);
  await card.getByRole('button', { name: /^Activate revision \d+$/ }).click();
  await expect(outcome(page)).toHaveAttribute('data-code', 'academy.cert_disclaimer_unset');
  await expect(outcome(page)).toContainText('The disclaimer is blank');
  await expect(card).toHaveAttribute('data-state', 'draft');

  // The service holds it as svc-academy says: a draft, active for nothing.
  const stored = await staffRead('admin.certDesign', { certId: CERT });
  expect(stored.design.activeRevision).toBeNull();
  expect(stored.design.current.signatories).toEqual([SIGNER]);
  expect(stored.design.current.disclaimer).toBeNull();
});

test(`${J} #3 editing an active design with issued certificates warns, and the issued certificate keeps printing its original revision`, async ({
  page,
  browser,
}) => {
  test.setTimeout(360_000);
  const card = await openDesigns(page, browser);
  const firstTitle = designTitle(1);
  await saveDesign(page, { title: firstTitle, signatories: [SIGNER], disclaimer: `TEST ${J}: disclaimer`, reason: `TEST ${J}: ready` });
  await card.getByLabel('Activation reason').fill(`TEST ${J}: activate`);
  await card.getByRole('button', { name: /^Activate revision \d+$/ }).click();
  await expect(card).toHaveAttribute('data-state', 'active');
  const issuedUnder = (await staffRead('admin.certDesign', { certId: CERT })).design.activeRevision;
  expect(issuedUnder).toBeGreaterThan(0);

  const learnerTab = await (await browser.newContext()).newPage();
  try {
    // A fresh TEST learner earns Foundations while the design is active, so their certificate is issued under it.
    const who = await signUp(learnerTab, 'ja17d');
    await verify(learnerTab, who);
    await signIn(learnerTab, who);
    const session = await api(who);
    await learnerTab.goto(`/academy/learning/course/${COURSE}`);
    await learnerTab.locator('[data-academy-enrol]').getByRole('button', { name: 'Enrol now', exact: true }).click();
    await expect(learnerTab.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
    const items = (await read(who, 'certDefinitions')).find((row) => row.id === CERT).requiredItemSlugs;
    await setIssueRule('automatic');
    try {
      for (const itemSlug of items) {
        const done = await session.post(trpc('markCurriculumComplete'), { itemSlug });
        expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
      }
      await expect
        .poll(async () => (await read(who, 'myCerts', { limit: 50 })).find((row) => row.certId === CERT)?.design?.revision ?? null, {
          timeout: 30_000,
        })
        .toBe(issuedUnder);
    } finally {
      await setIssueRule('manual');
    }

    // Staff edit the active design: the page warns before the save, and the save says the issued one keeps its revision.
    await page.reload();
    await expect(card.getByTestId('cert-design-edit-warning')).toContainText('keep printing the revision they were issued under');
    await saveDesign(page, {
      title: designTitle(2),
      signatories: [SIGNER],
      disclaimer: `TEST ${J}: disclaimer`,
      reason: `TEST ${J}: new wording after issue`,
    });
    await expect(outcome(page)).toHaveAttribute('data-code', '');
    await expect(page.getByTestId('cert-design-warning')).toContainText('keep printing the revision they were issued under');
    const after = await staffRead('admin.certDesign', { certId: CERT });
    expect(after.design.activeRevision).toBe(issuedUnder + 1);
    expect(after.design.current.title).toBe(designTitle(2));

    // The learner's certificate still prints the revision it was issued under, word for word.
    await learnerTab.goto('/academy/certificates');
    await learnerTab.locator(`[data-certificate="${CERT}"]`).getByRole('button', { name: 'View certificate' }).click();
    const sheet = learnerTab.locator(`[data-certificate-sheet="${CERT}"] article`);
    await expect(sheet).toHaveAttribute('data-design-revision', String(issuedUnder));
    await expect(sheet.getByRole('heading', { level: 2 })).toHaveText(firstTitle);
    await expect(sheet).not.toContainText(designTitle(2));
    await expect(sheet.getByTestId('certificate-signatories')).toContainText(SIGNER.name);
    await expect(sheet.getByTestId('certificate-design-revision')).toHaveText(`Design revision ${issuedUnder}`);
    const mine = (await read(who, 'myCerts', { limit: 50 })).find((row) => row.certId === CERT);
    expect(mine.design).toMatchObject({ revision: issuedUnder, title: firstTitle });
  } finally {
    await learnerTab.context().close();
    // Put the shared design back out of use, so no other journey's certificate prints it.
    await staff('admin.deactivateCertDesign', { certId: CERT, reason: `TEST ${J}: put back after the step` });
  }
  await page.reload();
  await expect(card).toHaveAttribute('data-state', 'draft');
});

test(`${J} #4 the issued list and its export agree, with zero counts and an empty state when none`, async ({ page, browser }) => {
  test.setTimeout(240_000);
  await staffSignIn(page, browser, 'compliance');

  // None issued for a certificate: zero counts and the empty state, never an invented row.
  await page.goto(`${ADMIN}/academy-ops/certificates/issued?certificate=test-${J.toLowerCase()}-none`);
  await expect(page.getByTestId('issued-empty')).toContainText('valid 0, revoked 0', { timeout: 60_000 });
  await expect(page.getByTestId('issued-total')).toHaveAttribute('data-count', '0');
  await expect(page.getByTestId('issued-counts')).toHaveCount(0);

  // The whole list: the counts on the page are svc-academy's, and include this file's issued and revoked certificates.
  await page.goto(`${ADMIN}/academy-ops/certificates/issued`);
  const counts = page.getByTestId('issued-counts');
  await expect(counts).toBeVisible({ timeout: 60_000 });
  const stored = await staffRead('admin.issuedCerts', { certificate: null });
  for (const c of stored.counts) {
    const row = counts.locator(`tr[data-cert="${c.certId}"]`);
    await expect(row.locator('[data-status="valid"]')).toHaveText(String(c.valid));
    await expect(row.locator('[data-status="revoked"]')).toHaveText(String(c.revoked));
  }
  const foundations = stored.counts.find((c) => c.certId === CERT);
  expect(foundations.valid, 'the certificate earned in #3 counts as valid').toBeGreaterThanOrEqual(1);
  expect(foundations.revoked, 'the certificate revoked in #1 counts as revoked').toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('issued-total')).toHaveAttribute('data-count', String(stored.total));

  // Export it: the stored file holds one row per issued certificate, and its rows by certificate and status are the counts.
  const make = page.getByRole('button', { name: /^Make export \d+$/ });
  const n = Number((await make.textContent()).replace(/\D+/g, ''));
  await make.click();
  await expect(outcome(page)).toHaveAttribute('data-code', '');
  const exported = page.getByTestId('cert-exports').locator(`tr[data-export="${n}"]`);
  await expect(exported).toBeVisible();
  const download = await page.request.get(`${ADMIN}/api/academy-cert-designs?export=${n}`);
  expect(download.status()).toBe(200);
  const csv = await download.text();
  expect(createHash('sha256').update(csv, 'utf8').digest('hex')).toBe(download.headers()['x-report-sha256']);
  const lines = csv
    .trim()
    .split('\r\n')
    .slice(2)
    .map((l) => l.split(','));
  const now = await staffRead('admin.issuedCerts', { certificate: null });
  expect(lines).toHaveLength(now.total);
  await expect(exported.getByTestId('export-rows')).toHaveText(String(now.total));
  for (const c of now.counts) {
    expect(lines.filter((l) => l[2] === c.certId && l[3] === 'valid')).toHaveLength(c.valid);
    expect(lines.filter((l) => l[2] === c.certId && l[3] === 'revoked')).toHaveLength(c.revoked);
  }
  expect(lines.some((l) => l[0] === run.read().publicId && l[3] === 'revoked')).toBe(true);
});
