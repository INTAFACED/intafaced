// World: stack
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
  await staff('admin.grantAccess', { userId: learnerId, pathSlug: ACCESS_PATH, reason: accessReason });
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
  const stored = await ctx.edge.query('academy', 'admin.grantAudit', { target: CERT }, token);
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
  const none = await ctx.edge.query('academy', 'admin.grantAudit', { target: `${J}-no-such-course` }, token);
  expect(none.status, none.text.slice(0, 300)).toBe(200);
  expect(JSON.parse(none.text).result.data).toEqual({ items: [], nextCursor: null });
});
