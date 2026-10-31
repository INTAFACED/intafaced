import { createHash } from 'node:crypto';
import { test, expect } from './journey.mjs';
import { EDGE, ORIGIN, api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-academy-05, in the running app (docs/roadmap/journeys.json): earn a certificate for a course and share it. One test
// per step, titled "J-academy-05 #<n>", run in order. The course is the published Foundations path and its certificate is
// the one svc-academy publishes for it. Two TEST learners finish it: one while staff hold certificates for a short delay,
// one with no delay. Staff rules go through Academy's own admin door with the stack's TEST founders, as an operator would,
// and the issue rule goes back to manual at the end.
const J = 'J-academy-05';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const COURSE = 'foundations';
const CERT = 'foundations-v1';
/** The stack's TEST delay and issue sweep (tooling/scripts/local-stack-services/academy.mjs): one minute, swept every 5 s. */
const DELAY_MINUTES = 1;
/** Partners a share menu could name; with no share targets set the sheet names none of them. */
const PARTNERS = /linkedin|facebook|twitter|instagram|whatsapp|telegram|reddit|credly|badgr|accredible/i;

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

const trpc = (procedure, input) =>
  `/api/academy/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`;

/** A read through the customer's own API with the learner's session. */
async function read(who, procedure, input) {
  const res = await (await api(who)).get(trpc(procedure, input));
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return res.body.result.data;
}

const myCerts = async (who) => (await read(who, 'myCerts', { limit: 50 })).filter((row) => row.certId === CERT);
const required = async (who) => (await read(who, 'certDefinitions')).find((row) => row.id === CERT).requiredItemSlugs;

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
  return res;
}
/** A date as the app shows it in English: the long UTC day. */
const day = (iso) => new Intl.DateTimeFormat('en', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(iso));
const setIssueRule = (mode, delayMinutes = null) =>
  staff('admin.setCertIssueRule', { certId: CERT, mode, delayMinutes, reason: `TEST ${J}: issue rule ${mode}` });

/** Founder A proposes, founder B approves, then A revokes: the two-founder rule for a revoke. */
async function revoke(publicId) {
  const { gates, ctx, sessions, token } = await founders();
  const reason = `TEST ${J}: revoked to show the verify page`;
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

/** A verified TEST learner, signed in, enrolled on the course from its page, with every required item but the last done. */
async function learnerUpToLast(page, prefix) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  await signIn(page, who);
  await page.goto(`/academy/learning/course/${COURSE}`);
  await page.locator('[data-academy-enrol]').getByRole('button', { name: 'Enrol now', exact: true }).click();
  await expect(page.getByText(/^You are enrolled on the Free track since /)).toBeVisible();
  const items = await required(who);
  const session = await api(who);
  for (const itemSlug of items.slice(0, -1)) {
    const done = await session.post(trpc('markCurriculumComplete'), { itemSlug });
    expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
  }
  return { who, last: items.at(-1) };
}

/** Completes the open item from its page, pressed twice, and shows the course complete in the outline. */
async function completeLast(page, last) {
  await page.goto(`/academy/${last}`);
  const control = page.locator(`[data-item-completion="${last}"]`);
  await control.getByRole('button', { name: 'Complete and continue', exact: true }).dblclick();
  const outline = page.locator(`[data-academy-outline="${COURSE}"]`);
  await expect(outline.locator(`[data-outline-item="${last}"]`)).toHaveAttribute('data-outline-state', 'completed');
  await expect(outline.getByTestId('course-complete')).toHaveText('Course complete: every item is recorded.');
}

const certCard = (page, id = CERT) => page.locator(`[data-certificate="${id}"]`);

test(`${J} #1 the last required item completes the course; with a delay rule the certificate waits, with none it is issued once`, async ({
  page,
  browser,
}) => {
  test.setTimeout(300_000);
  // Staff hold Foundations certificates for a TEST delay: the first learner finishes and has no certificate yet.
  await setIssueRule('delayed', DELAY_MINUTES);
  const waiting = await learnerUpToLast(page, 'ja5w');
  await completeLast(page, waiting.last);
  expect(await myCerts(waiting.who)).toHaveLength(0);
  await page.goto('/academy/certificates');
  await expect(certCard(page)).toHaveAttribute('data-state', 'issuing');
  await expect(certCard(page).getByTestId('certificate-issue')).toContainText(/^Issued automatically on .+, after the 1-minute wait\.$/);

  // No delay: the second learner finishes, presses Complete twice, and holds exactly one certificate at once.
  await setIssueRule('automatic');
  const context = await browser.newContext({ baseURL: ORIGIN });
  const second = await context.newPage();
  const earner = await learnerUpToLast(second, 'ja5');
  const session = await api(earner.who);
  run.reset({
    waiting: waiting.who,
    earner: earner.who,
    xpBefore: (await session.get('/api/identity/trpc/rank.get')).body.result.data.xp,
    balancesBefore: await session.balances(),
  });
  await completeLast(second, earner.last);
  const issued = await myCerts(earner.who);
  expect(issued).toHaveLength(1);
  run.write({ code: issued[0].publicId, issuedAt: issued[0].grantedAt });
  await second.goto('/academy/certificates');
  await expect(certCard(second)).toHaveAttribute('data-state', 'earned');
  await context.close();

  // The delay passes and the sweep issues the first learner's certificate, once.
  await expect
    .poll(async () => (await myCerts(waiting.who)).length, { timeout: (DELAY_MINUTES * 60 + 60) * 1000, intervals: [5000] })
    .toBe(1);
  const held = await myCerts(waiting.who);
  run.write({ waitingCode: held[0].publicId });
  await page.reload();
  await expect(certCard(page)).toHaveAttribute('data-state', 'earned');
  expect(await myCerts(waiting.who)).toHaveLength(1);
});

test(`${J} #2 the Certificates tab lists my course and programme certificates, and a path with no published design says so`, async ({
  page,
}) => {
  const { earner } = state('earner');
  // Staff publish a programme of the one course this learner finished; the learner's programme read issues its certificate.
  const slug = `test-j05-${Date.now().toString(36)}`;
  const title = `TEST J-academy-05 programme ${slug.slice('test-j05-'.length)}`;
  await staff('admin.saveProgramme', {
    slug,
    title,
    summary: 'TEST Foundations only.',
    courseSlugs: [COURSE],
    expectedRevision: null,
    reason: `TEST ${J}: a programme of the course this learner finished`,
  });
  const mine = (await read(earner, 'programmes', { limit: 50, mine: true })).find((row) => row.slug === slug);
  expect(mine?.certificate.state, JSON.stringify(mine)).toBe('earned');
  await signIn(page, earner);
  await page.goto('/academy/certificates');
  const courses = page.locator('[data-certificates="courses"]');
  await expect(courses.getByRole('heading', { name: 'Course certificates' })).toBeVisible();
  await expect(certCard(page)).toHaveAttribute('data-state', 'earned');
  // Markets, Builder and Sovereign have no published certificate: each is still shown, with the typed refusal.
  for (const path of ['markets', 'builder', 'sovereign']) {
    const card = courses.locator(`[data-certificate-path="${path}"]`);
    await expect(card).toHaveAttribute('data-state', 'unpublished');
    await expect(card.locator('[data-code="academy.certificate_unpublished"]')).toHaveText(
      'This path has no published certificate design, so it issues no certificate.',
    );
  }
  const programmes = page.locator('[data-certificates="programmes"]');
  await expect(programmes.getByRole('heading', { name: 'Programme certificates' })).toBeVisible();
  // The programme certificate this learner holds is listed with its title, date and serial, and links to its check page.
  const card = programmes.locator(`[data-certificate="programme:${slug}"]`);
  await expect(card).toHaveAttribute('data-state', 'earned');
  await expect(card.getByRole('heading', { level: 4 })).toHaveText(title);
  await expect(card.getByRole('status')).toHaveText(`Programme certificate earned on ${day(mine.certificate.grantedAt)}.`);
  await expect(card.getByTestId('programme-certificate-serial')).toHaveText(`Serial number ${mine.certificate.publicId}`);
  await expect(card.getByRole('link', { name: 'Check this certificate', exact: true })).toHaveAttribute(
    'href',
    `/academy/certificates/verify/${mine.certificate.publicId}`,
  );
});

test(`${J} #3 the certificate sheet shows its serial number and offers only Copy link and Print, naming no partner`, async ({
  page,
  context,
}) => {
  const { earner, code } = state('earner', 'code');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  await signIn(page, earner);
  await page.goto('/academy/certificates');
  await certCard(page).getByRole('button', { name: 'View certificate', exact: true }).click();
  const sheet = page.locator(`[data-certificate-sheet="${CERT}"]`);
  await expect(sheet.getByTestId('certificate-serial')).toHaveText(`Serial number ${code}`);
  const share = sheet.getByTestId('certificate-share');
  await expect(share.getByRole('button')).toHaveText(['Copy link', 'Print']);
  await expect(sheet).not.toContainText(PARTNERS);

  await share.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(share.getByRole('status')).toHaveText('Link copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`${ORIGIN}/academy/certificates/verify/${code}`);

  await page.evaluate(() => {
    window.__printed = 0;
    window.print = () => {
      window.__printed += 1;
    };
  });
  await share.getByRole('button', { name: 'Print', exact: true }).click();
  expect(await page.evaluate(() => window.__printed)).toBe(1);
});

test(`${J} #4 the public verify page says valid with the issue date, revoked once revoked, and refuses reads past the rate limit`, async ({
  browser,
}) => {
  const { code, waitingCode, issuedAt } = state('code', 'waitingCode', 'issuedAt');
  // Signed out, as anyone the link was sent to.
  const context = await browser.newContext({ baseURL: ORIGIN, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto(`/academy/certificates/verify/${code}`);
  const answer = page.locator(`[data-certificate-verify="${code}"]`);
  await expect(answer.getByTestId('verify-status')).toHaveText('Valid');
  await expect(answer).toContainText('Foundations');
  // The issue date is the day the certificate was stored as issued.
  await expect(answer.getByTestId('verify-issued')).toHaveText(day(issuedAt));

  // Staff revoke the other learner's certificate (two founders); its verify page now says revoked.
  await revoke(waitingCode);
  await page.goto(`/academy/certificates/verify/${waitingCode}`);
  await expect(page.locator(`[data-certificate-verify="${waitingCode}"]`).getByTestId('verify-status')).toHaveText('Revoked');

  // Reads past the owner's rate limit are refused with the typed rate error, and the page says so.
  let limited = null;
  for (let n = 0; n < 60 && !limited; n += 1) {
    const res = await fetch(`${EDGE}${trpc('certVerify', { publicId: code })}`, { headers: { origin: ORIGIN } });
    const body = await res.json();
    if (res.status !== 200) limited = body;
  }
  expect(JSON.stringify(limited)).toContain('academy.verify_rate_limited');
  await page.goto(`/academy/certificates/verify/${code}`);
  const refusal = page.locator('[data-code="academy.verify_rate_limited"]');
  await expect(refusal).toBeVisible();
  await context.close();
});

test(`${J} #5 after the certificate my rank shows the XP the owner published for it; no perk is invented and no balance moved`, async ({
  page,
}) => {
  const { earner, xpBefore, balancesBefore } = state('earner', 'balancesBefore');
  await signIn(page, earner);
  const policy = (await read(earner, 'certXpPlane')).policies.find((row) => row.certId === CERT);
  const session = await api(earner);
  if (policy) {
    // The owner published an XP value for this certificate: the rank ladder got exactly that much.
    await expect
      .poll(async () => BigInt((await session.get('/api/identity/trpc/rank.get')).body.result.data.xp) - BigInt(xpBefore), {
        timeout: 30_000,
      })
      .toBe(BigInt(policy.xpDelta));
  }
  const rank = (await session.get('/api/identity/trpc/rank.get')).body.result.data;
  // With no XP published for it, the certificate left the rank ladder where it was.
  if (!policy) expect(rank.xp).toBe(xpBefore);
  await page.goto('/academy/certificates');
  await certCard(page).getByRole('button', { name: 'View certificate', exact: true }).click();
  const xp = page.locator(`[data-certificate-sheet="${CERT}"]`).getByTestId('certificate-xp');
  await expect(xp.getByTestId('certificate-xp-text')).toHaveText(
    policy
      ? `This certificate is worth ${policy.xpDelta} XP on your rank. Perks come with your rank, not with the certificate.`
      : 'This certificate carries no XP: no XP value is published for it, so your rank and perks did not change.',
  );
  await xp.getByRole('link', { name: 'See your rank', exact: true }).click();
  await expect(page).toHaveURL(/\/uc\/account$/);
  // The rank page shows the lifetime XP the ladder holds now.
  const lifetime = page.getByTestId('rank-perks').locator('dt', { hasText: 'Lifetime XP' }).locator('xpath=following-sibling::dd[1]');
  await expect(lifetime).toHaveText(new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(BigInt(rank.xp)));
  // A certificate never posts to the ledger.
  expect(await session.balances()).toEqual(balancesBefore);
  // Put the issue rule back as it was before this journey.
  await setIssueRule('manual');
});
