// World: restart
import { expect, test } from './journey.mjs';
import { ADMIN } from './admin.mjs';
import { unconfirmedAccount } from './p2p.mjs';
import { api, restartService } from './stack.mjs';

// J-identity-20, in the running app (docs/roadmap/journeys.json): I work the verification queue (compliance). Only #6 is
// here: two founders approve a level from the verification case in the founder console (founder A asks, founder B
// approves that verification, A runs it), and the capabilities the owner maps to the level go active in that one step.
// With no mapping set (identity restarted with it blank, as a build is before the owner publishes one) the same approval
// grants nothing. The other steps need the review queue's own doors and are not here.
const J = 'J-identity-20';
/** Every capability the TEST mapping gives level Full (tooling/profiles/test-owner-values/identity.json). */
const CAPABILITIES = ['custody_crypto', 'transfer_crypto', 'trade_crypto', 'custody_fiat', 'transfer_fiat'];

/** A fresh TEST person who asked for Full: their record (identity's answer to the request) and their one case. */
async function askedForFull(prefix) {
  const who = await unconfirmedAccount(prefix);
  const own = await api(who);
  const submitted = await own.post('/api/identity/trpc/kyc.submit', { tier: 'full', jurisdiction: 'DE' });
  expect(submitted.status, JSON.stringify(submitted.body).slice(0, 300)).toBe(200);
  const record = submitted.body.result.data;
  expect(record.status).toBe('pending');
  const history = await own.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
  const [only] = history.body.result.data.cases;
  expect(only).toMatchObject({ recordId: record.id, state: 'submitted', tier: 'full' });
  return { who, own, record, caseId: only.id };
}

/** The person's own capabilities and their one case, as identity answers them to the person. */
async function readBack(own) {
  const caps = await own.get('/api/identity/trpc/kyc.capabilities.get');
  expect(caps.status, JSON.stringify(caps.body).slice(0, 300)).toBe(200);
  const history = await own.get(`/api/identity/trpc/kyc.history?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`);
  const states = Object.fromEntries(caps.body.result.data.capabilities.map((c) => [c.capability, c.state]));
  return { mapped: caps.body.result.data.mapped, states, cases: history.body.result.data.cases };
}

/** The verification's case row on the console's case page, opened to its approve desk. */
async function caseDesk(page, userId, caseId) {
  await page.goto(`${ADMIN}/accounts/${userId}/kyc/${caseId}`, { waitUntil: 'load' });
  const read = page.getByTestId('read-identity.kyc-case');
  await expect(read.locator('tbody > tr')).toHaveCount(1, { timeout: 60_000 });
  await read.locator('tbody > tr').first().getByRole('button', { name: 'Open', exact: true }).click();
  return read.getByTestId('row-detail').getByTestId('kyc-approve').getByTestId('control-desk');
}

/** Founder A asks to approve `recordId`, founder B approves that exact verification, and A runs it. Returns A's reply. */
async function approveInConsole(a, b, { userId, caseId, recordId }) {
  const phrase = `APPROVE VERIFICATION ${recordId.slice(0, 8)}`;
  const deskA = await caseDesk(a, userId, caseId);
  await deskA.getByLabel(/to confirm$/).fill(phrase);
  await deskA.getByRole('button', { name: 'Ask a second founder to approve this verification', exact: true }).click();
  await expect(deskA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packet = (await deskA.getByLabel('Request packet', { exact: true }).inputValue()).trim();
  // A cannot approve their own request.
  await expect(deskA.getByRole('button', { name: 'Approve this request', exact: true })).toBeDisabled();

  const deskB = await caseDesk(b, userId, caseId);
  await deskB.getByLabel('Request packet', { exact: true }).fill(packet);
  await expect(deskB.getByTestId('packet-summary')).toContainText(`Approve verification ${recordId}`);
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request', exact: true }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });

  await deskA.getByLabel(/to approve or run it$/).fill(phrase);
  await deskA.getByRole('button', { name: 'Run the approved request', exact: true }).click();
  const reply = deskA.getByTestId('step-reply');
  await expect(reply).toContainText(`Identity approved verification ${recordId} at level full`, { timeout: 60_000 });
  return reply;
}

test(`${J} #6 approves a level: the mapped capabilities go active in one step; a mapping not set grants nothing`, async ({ founders }) => {
  test.setTimeout(420_000);
  const { page: a } = await founders.console('a');
  const { page: b } = await founders.console('b');

  // With the TEST mapping: a person asked for Full, and everything Full includes waits for review.
  const mapped = await askedForFull('jq6m');
  const before = await readBack(mapped.own);
  expect(before.mapped).toBe(true);
  for (const name of CAPABILITIES) expect(before.states[name], name).toBe('pending');

  // The two founders approve it in the console; the next read, with nothing else done, has every mapped capability active.
  await approveInConsole(a, b, { userId: mapped.record.userId, caseId: mapped.caseId, recordId: mapped.record.id });
  const after = await readBack(mapped.own);
  expect(after.cases[0]).toMatchObject({ id: mapped.caseId, state: 'approved' });
  for (const name of CAPABILITIES) expect(after.states[name], name).toBe('active');

  // The case page reads the case approved.
  await a.goto(`${ADMIN}/accounts/${mapped.record.userId}/kyc/${mapped.caseId}`, { waitUntil: 'load' });
  await expect(a.getByTestId('read-identity.kyc-case').locator('tbody > tr').first()).toContainText(/approved/i, { timeout: 60_000 });

  // With no mapping set: the same approval approves the level and grants no capability.
  await restartService('identity', { LOCAL_STACK_IDENTITY_KYC_CAPABILITIES: 'unset' });
  try {
    const unmapped = await askedForFull('jq6u');
    const waiting = await readBack(unmapped.own);
    expect(waiting.mapped).toBe(false);
    await approveInConsole(a, b, { userId: unmapped.record.userId, caseId: unmapped.caseId, recordId: unmapped.record.id });
    const granted = await readBack(unmapped.own);
    expect(granted.cases[0]).toMatchObject({ id: unmapped.caseId, state: 'approved' });
    expect(granted.mapped).toBe(false);
    for (const name of CAPABILITIES) expect(granted.states[name], name).not.toBe('active');
  } finally {
    await restartService('identity', { LOCAL_STACK_IDENTITY_KYC_CAPABILITIES: undefined });
  }
});
