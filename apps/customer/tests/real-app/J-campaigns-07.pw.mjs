// World: restart, gates
import { test, expect } from './journey.mjs';
import { api, journeyState, restartWith, signOutBrowser } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-campaigns-07, in the running app (docs/roadmap/journeys.json): I become an affiliate partner. One test per step,
// titled "J-campaigns-07 #<n>", run in order. The stack's TEST partner values (tooling/profiles/test-owner-values/
// identity.json) are two qualified invitees to apply, thirty days before a rejected applicant may apply again, and a
// programme depth of two. A qualified invitee is a person introduced directly whose verification was approved.
// #1 and #4 restart identity with one value blank (`LOCAL_STACK_IDENTITY_PARTNER_ELIGIBILITY=off`,
// `LOCAL_STACK_IDENTITY_PARTNER_DEPTH=off`) to see its refusal, and put it back. The operator is one of the stack's two
// TEST operators (tooling/scripts/local-test-gates.mjs), signed in with a second factor.
const J = 'J-campaigns-07';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

function state(...keys) {
  const s = run.read();
  for (const k of keys) if (!s[k]) throw new Error(`${J}: an earlier step left no ${k}, so this step has nothing to act on`);
  return s;
}

/** A person's own identity procedure through Edge: a query by GET, a mutation by POST. */
async function identity(who, procedure, input, { mutation = false } = {}) {
  const client = await api(who);
  const res = mutation
    ? await client.post(`/api/identity/trpc/${procedure}`, input ?? {})
    : await client.get(
        `/api/identity/trpc/${procedure}${input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`}`,
      );
  return {
    status: res.status,
    data: res.body?.result?.data,
    code: res.body?.error?.data?.intafacedCode ?? res.body?.error?.data?.cause?.code ?? res.body?.error?.data?.code,
  };
}

/** The person's own user id: their invitation link names them as the referrer. */
async function userIdOf(who) {
  const share = await identity(who, 'affiliates.createShare', undefined, { mutation: true });
  expect(share.status, JSON.stringify(share)).toBe(200);
  return share.data.referrerId;
}

/** A new TEST account introduced by `referrerId` (attached inside the attach window), verified or not. Signed out after. */
async function invitee(page, prefix, referrerId, verified) {
  const who = await signUp(page, prefix);
  const attached = await identity(who, 'affiliates.attribute', { referrerId }, { mutation: true });
  expect(attached.status, JSON.stringify(attached)).toBe(200);
  if (verified) await verify(page, who);
  else await signOutBrowser(page.context());
  return { ...who, userId: await userIdOf(who) };
}

async function operators() {
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  return { ctx, ops: await gates.operatorSessions(ctx) };
}
const result = (res) => ({
  status: res.status,
  data: res.json?.result?.data,
  code: res.json?.error?.data?.intafacedCode ?? res.json?.error?.data?.cause?.code ?? res.json?.error?.data?.code,
});

const programme = (page) => page.getByRole('region', { name: 'Partner programme' });

test(`${J} #1 Apply as a partner shows my qualified count against the owner's; a blank count refuses with a typed code and no record`, async ({
  page,
}) => {
  run.reset({});
  const partner = await signUp(page, 'jc7p');
  await verify(page, partner);
  const partnerId = await userIdOf(partner);
  // One verified invitee, one who never verified, and a person that invitee brought (not mine directly).
  const a = await invitee(page, 'jc7a', partnerId, true);
  const c = await invitee(page, 'jc7c', partnerId, false);
  run.write({ partner, partnerId, a, c });

  await signIn(page, partner);
  await page.goto('/uc/promotion');
  const box = programme(page);
  await box.getByRole('button', { name: 'Apply as a partner' }).click();
  await expect(box.getByTestId('partner-qualified')).toHaveText('1');
  await expect(box.getByTestId('partner-required')).toHaveText('2');
  await expect(box.getByText('You have fewer qualified invitees than a partner needs. Nothing was filed.')).toBeVisible();
  await expect(box.getByRole('button', { name: 'Submit application' })).toHaveCount(0);
  // Asking the service directly is refused by name, and nothing is filed.
  expect(await identity(partner, 'affiliates.applyPartner', {}, { mutation: true })).toMatchObject({
    status: 403,
    code: 'partner.not_eligible',
  });
  expect((await identity(partner, 'affiliates.myPartnerApplication')).data).toBeNull();

  // A second verified invitee makes two of two.
  await signOutBrowser(page.context());
  const b = await invitee(page, 'jc7b', partnerId, true);
  run.write({ b });
  await signIn(page, partner);
  await page.goto('/uc/promotion');
  await programme(page).getByRole('button', { name: 'Apply as a partner' }).click();
  await expect(programme(page).getByTestId('partner-qualified')).toHaveText('2');
  await expect(programme(page).getByTestId('partner-required')).toHaveText('2');
  await expect(programme(page).getByText('You have enough qualified invitees to apply.')).toBeVisible();
  await expect(programme(page).getByRole('button', { name: 'Submit application' })).toBeVisible();

  // With the owner's count blank: refused by its code, and still no record.
  restartWith('identity', 'LOCAL_STACK_IDENTITY_PARTNER_ELIGIBILITY', false);
  try {
    await page.goto('/uc/promotion');
    await programme(page).getByRole('button', { name: 'Apply as a partner' }).click();
    const refusal = programme(page).getByTestId('partner-refusal');
    await expect(
      refusal.getByText(
        'No application can be made: the owner has not set how many qualified invitees a partner needs. Nothing was recorded.',
      ),
    ).toBeVisible();
    await expect(refusal.getByText('HTTP 412 · partner.eligibility_unset')).toBeVisible();
    await expect(programme(page).getByTestId('partner-qualified')).toHaveCount(0);
    expect(await identity(partner, 'affiliates.applyPartner', {}, { mutation: true })).toMatchObject({
      status: 412,
      code: 'partner.eligibility_unset',
    });
    expect((await identity(partner, 'affiliates.myPartnerApplication')).data).toBeNull();
  } finally {
    restartWith('identity', 'LOCAL_STACK_IDENTITY_PARTNER_ELIGIBILITY', true);
  }
});

test(`${J} #2 submitting the application shows status submitted`, async ({ page }) => {
  const { partner } = state('partner');
  await signIn(page, partner);
  await page.goto('/uc/promotion');
  const box = programme(page);
  await box.getByRole('button', { name: 'Apply as a partner' }).click();
  await box.getByRole('button', { name: 'Submit application' }).click();
  await expect(box.getByTestId('partner-status')).toHaveText('Submitted');
  await expect(box.getByText('An operator reviews your application. This page shows the decision when it is made.')).toBeVisible();
  await expect(box.getByRole('button', { name: 'Apply as a partner' })).toHaveCount(0);

  // The status stays after a reload, and submitting again files nothing new.
  await page.reload();
  await expect(programme(page).getByTestId('partner-status')).toHaveText('Submitted');
  const mine = await identity(partner, 'affiliates.myPartnerApplication');
  expect(mine.data).toMatchObject({ state: 'submitted', qualifiedCount: 2, requiredCount: 2 });
  const again = await identity(partner, 'affiliates.applyPartner', {}, { mutation: true });
  expect(again.data.applicationId).toBe(mine.data.applicationId);
  run.write({ applicationId: mine.data.applicationId });
});

test(`${J} #3 an operator approves with a reason and the partner portal opens; a rejection shows its category and reapply date`, async ({
  page,
}) => {
  const { partner, applicationId } = state('partner', 'applicationId');
  // The applicant has no operator scope to decide their own.
  expect(
    (await identity(partner, 'affiliates.decidePartner', { applicationId, decision: 'approve', reason: 'TEST self' }, { mutation: true }))
      .status,
  ).toBe(403);

  const { ctx, ops } = await operators();
  const op = ops.a;
  const queue = result(await ctx.edge.query('identity', 'affiliates.partnerQueue', { limit: 100 }, await op.approvalToken()));
  expect(queue.status, JSON.stringify(queue)).toBe(200);
  expect(queue.data.map((x) => x.applicationId)).toContain(applicationId);
  // A reason is required.
  const bare = result(
    await ctx.edge.mutate(
      'identity',
      'affiliates.decidePartner',
      { applicationId, decision: 'approve', reason: '' },
      await op.approvalToken(),
    ),
  );
  expect(bare.status).toBe(400);
  const reason = 'TEST: two verified invitees and a clean record';
  const approved = result(
    await ctx.edge.mutate('identity', 'affiliates.decidePartner', { applicationId, decision: 'approve', reason }, await op.approvalToken()),
  );
  expect(approved.status, JSON.stringify(approved)).toBe(200);
  expect(approved.data).toMatchObject({ state: 'approved', decisionReason: reason });

  await signIn(page, partner);
  await page.goto('/uc/promotion');
  const box = programme(page);
  await expect(box.getByTestId('partner-status')).toHaveText('Approved');
  const portal = box.getByRole('region', { name: 'Partner portal' });
  await expect(portal).toBeVisible();
  await expect(portal.getByTestId('partner-approval-reason')).toHaveText(reason);
  await expect(portal.getByRole('button', { name: 'Open my sub-tree' })).toBeVisible();

  // A second applicant with two verified invitees of their own is rejected: the category and reapply date show.
  await signOutBrowser(page.context());
  const other = await signUp(page, 'jc7r');
  await verify(page, other);
  const otherId = await userIdOf(other);
  const r1 = await invitee(page, 'jc7ra', otherId, true);
  await invitee(page, 'jc7rb', otherId, true);
  const filed = await identity(other, 'affiliates.applyPartner', {}, { mutation: true });
  expect(filed.status, JSON.stringify(filed)).toBe(200);
  // A rejection must name a category.
  const uncategorised = result(
    await ctx.edge.mutate(
      'identity',
      'affiliates.decidePartner',
      { applicationId: filed.data.applicationId, decision: 'reject', reason: 'TEST: no category' },
      await op.approvalToken(),
    ),
  );
  expect(uncategorised).toMatchObject({ status: 400, code: 'partner.invalid' });
  const rejected = result(
    await ctx.edge.mutate(
      'identity',
      'affiliates.decidePartner',
      {
        applicationId: filed.data.applicationId,
        decision: 'reject',
        reason: 'TEST: invitees have not traded',
        category: 'not_enough_activity',
      },
      await op.approvalToken(),
    ),
  );
  expect(rejected.status, JSON.stringify(rejected)).toBe(200);
  const decidedAt = Date.parse(rejected.data.decidedAt);
  expect(Date.parse(rejected.data.reapplyAt) - decidedAt).toBe(30 * 86_400_000);

  await signIn(page, other);
  await page.goto('/uc/promotion');
  const theirs = programme(page);
  await expect(theirs.getByTestId('partner-status')).toHaveText('Rejected');
  await expect(theirs.getByTestId('partner-reject-category')).toHaveText('Not enough activity from your invitees');
  await expect(theirs.getByTestId('partner-reapply-at')).toHaveText(rejected.data.reapplyAt.slice(0, 10));
  await expect(theirs.getByRole('region', { name: 'Partner portal' })).toHaveCount(0);
  await expect(theirs.getByRole('button', { name: 'Apply as a partner' })).toHaveCount(0);
  // The operator's own notes never reach the person; applying again before the date is refused.
  await expect(theirs.getByText('TEST: invitees have not traded')).toHaveCount(0);
  const mine = await identity(other, 'affiliates.myPartnerApplication');
  expect(mine.data).toMatchObject({ state: 'rejected', rejectCategory: 'not_enough_activity', approvalReason: null });
  expect(await identity(other, 'affiliates.applyPartner', {}, { mutation: true })).toMatchObject({
    status: 409,
    code: 'partner.reapply_too_soon',
  });
  run.write({ other, otherInvitee: r1 });
});

test(`${J} #4 my sub-tree shows only my own downline to the programme depth; a blank depth refuses accrual and payout`, async ({
  page,
}) => {
  const { partner, partnerId, a, b, c, other, otherInvitee } = state('partner', 'partnerId', 'a', 'b', 'c', 'other', 'otherInvitee');
  // Below my invitee a: a level-two person, and below them a level-three person, past the TEST depth of two.
  const d = await invitee(page, 'jc7d', a.userId, false);
  const e = await invitee(page, 'jc7e', d.userId, false);

  await signIn(page, partner);
  await page.goto('/uc/promotion');
  const portal = programme(page).getByRole('region', { name: 'Partner portal' });
  await portal.getByRole('button', { name: 'Open my sub-tree' }).click();
  const tree = portal.getByRole('region', { name: 'My sub-tree' });
  await expect(tree.getByTestId('partner-tree-depth')).toHaveText('2');
  const rows = tree.getByTestId('partner-tree-member');
  const shown = (await rows.allInnerTexts()).map((t) => t.split('\t').slice(0, 2).join(' ').trim());
  expect(shown.sort()).toEqual([`${a.handle} 1`, `${b.handle} 1`, `${c.handle} 1`, `${d.handle} 2`].sort());
  // The level-three person is counted, never named; another partner's people never appear.
  await expect(tree.getByTestId('partner-tree-beyond')).toHaveText('1');
  for (const stranger of [e.handle, other.handle, otherInvitee.handle, partner.handle])
    await expect(tree.getByText(stranger)).toHaveCount(0);
  // A person who is not an approved partner has no portal and no sub-tree.
  expect(await identity(other, 'affiliates.mySubTree')).toMatchObject({ status: 403, code: 'partner.not_partner' });

  // Commission walks at most the programme depth: a fee by the level-three person accrues to the two people above them
  // (hops 0 and 1) and never to me at hop 2 (a dry run under TEST simulation rates; it records and moves nothing).
  const { ctx, ops } = await operators();
  const op = ops.a;
  const fee = {
    feeEventId: `jc7:${e.userId}:dry`,
    userId: e.userId,
    feeAmount: '10',
    asset: 'USDC',
    sourceModule: 'trade',
    tiers: [
      { hop: 0, rate: '0.1' },
      { hop: 1, rate: '0.05' },
      { hop: 2, rate: '0.02' },
    ],
  };
  const dry = result(await ctx.edge.query('identity', 'affiliates.accrueDryRun', fee, await op.tradeOpsToken()));
  expect(dry.status, JSON.stringify(dry)).toBe(200);
  expect(dry.data.rows.map((r) => [r.beneficiaryId, r.hop, r.commissionAmount])).toEqual([
    [d.userId, 0, '1'],
    [a.userId, 1, '0.5'],
  ]);
  expect(dry.data.rows.some((r) => r.beneficiaryId === partnerId)).toBe(false);

  // With the owner's depth blank: the sub-tree, accrual and payout each refuse by the same code.
  restartWith('identity', 'LOCAL_STACK_IDENTITY_PARTNER_DEPTH', false);
  try {
    await page.goto('/uc/promotion');
    const again = programme(page).getByRole('region', { name: 'Partner portal' });
    await again.getByRole('button', { name: 'Open my sub-tree' }).click();
    const refusal = again.getByTestId('partner-refusal');
    await expect(
      refusal.getByText('No sub-tree is shown and no commission is accrued or paid: the owner has not set the programme depth.'),
    ).toBeVisible();
    await expect(refusal.getByText('HTTP 412 · affiliate.programme_depth_unset')).toBeVisible();
    await expect(again.getByRole('region', { name: 'My sub-tree' })).toHaveCount(0);

    const { ctx: ctx2, ops: ops2 } = await operators();
    const accrue = result(await ctx2.edge.query('identity', 'affiliates.accrueDryRun', fee, await ops2.a.tradeOpsToken()));
    expect(accrue).toMatchObject({ status: 412, code: 'affiliate.programme_depth_unset' });
    const payout = result(
      await ctx2.edge.mutate('identity', 'affiliates.payout', { feeEventId: fee.feeEventId, dryRun: true }, await ops2.a.tradeOpsToken()),
    );
    expect(payout).toMatchObject({ status: 412, code: 'affiliate.programme_depth_unset' });
  } finally {
    restartWith('identity', 'LOCAL_STACK_IDENTITY_PARTNER_DEPTH', true);
  }
});
