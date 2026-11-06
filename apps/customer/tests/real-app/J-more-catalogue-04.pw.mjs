// World: restart
import { test, expect } from './journey.mjs';
import { ADMIN, assertAdminUp, founderSignIn } from './admin.mjs';
import { ORIGIN, api, journeyState, restartWith } from './stack.mjs';
import { signIn } from './desk.mjs';
import { bodyRows } from './tables.mjs';
import { approvedSeller } from './market-listing.mjs';

// J-more-catalogue-04, in the running app (docs/roadmap/journeys.json): review and approve market listings. One test per
// step, titled "J-more-catalogue-04 #<n>", run in order. Founders A and B work the market desk in the admin app at
// /more-ops/market, each on their own console: A asks, B pastes the packet and approves the same request, A runs it.
// Two TEST sellers, each approved through svc-market's own four-eyes vet, publish one listing each through svc-market's
// seller doors; a new listing waits in the review queue (`applied`) until two founders decide it. The review criteria and
// window are the stack's labelled TEST values (tooling/profiles/test-owner-values/market.json); #1 restarts svc-market
// with the criteria blank to see the queue wait, then puts them back. No value moves.
const J = 'J-more-catalogue-04';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const trpcInput = (input) => `?input=${encodeURIComponent(JSON.stringify(input))}`;
const data = (res) => res.body?.result?.data;

/** The run's saved start, or a named failure when the step that writes it did not run. */
function started(...keys) {
  const saved = run.read();
  for (const key of keys)
    if (!saved[key]) throw new Error(`${J} start is missing "${key}": an earlier step did not build it, so this step cannot run`);
  return saved;
}

/** Both founders signed in to their own consoles, in their own browser contexts. */
async function founders(browser) {
  await assertAdminUp();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  const ida = await founderSignIn(a, 'a');
  const idb = await founderSignIn(b, 'b');
  return { a, b, ida, idb };
}

async function openDesk(page) {
  await page.goto(`${ADMIN}/more-ops/market`);
  await expect(page.getByRole('heading', { name: 'Market: listing review', level: 1 })).toBeVisible();
}

const QUEUE = 'Listings waiting for review';
const RULES = 'Listing review criteria and window';
const AUDIT = 'Listing review decisions';
const PUBLIC = 'Public listings';

/** The row of `title` in the desk table `region`, opened, with its control desk. */
async function openRow(page, region, title) {
  const table = page.getByRole('region', { name: region });
  const row = bodyRows(table).filter({ hasText: title });
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: 'Open' }).click();
  return page.getByTestId('row-detail').filter({ has: page.getByTestId('control-desk') });
}

/** A asks for `decision` (Approve or Reject) on `title` with `reason`; returns A's desk and the packet. */
async function askReview(a, title, decision, reason) {
  await openDesk(a);
  const detail = await openRow(a, QUEUE, title);
  if (decision) await detail.getByRole('group', { name: 'Decision' }).getByRole('button', { name: decision }).click();
  const deskA = detail.getByTestId('control-desk');
  await deskA.getByLabel(/^Why/).fill(reason);
  const phrase = (await deskA.locator('label', { hasText: 'to confirm' }).locator('code').textContent()).trim();
  await deskA.getByLabel(/to confirm$/).fill(phrase);
  await deskA.getByRole('button', { name: /^Ask a second operator to approve/ }).click();
  await expect(deskA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return { deskA, phrase, packet: (await deskA.getByLabel('Request packet').inputValue()).trim() };
}

/** B pastes the packet on the same desk section, reads `summary` and approves it. */
async function approveAsB(b, region, title, { packet, phrase, summary }) {
  await openDesk(b);
  const deskB = (await openRow(b, region, title)).getByTestId('control-desk');
  await deskB.getByLabel('Request packet').fill(packet);
  await expect(deskB.getByTestId('packet-summary')).toContainText(summary);
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
}

async function runAsA(deskA, phrase) {
  await deskA.getByLabel(/to approve or run it$/).fill(phrase);
  await deskA.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = deskA.getByTestId('step-reply');
  await expect(reply).toBeVisible({ timeout: 60_000 });
  return reply;
}

/** The founder console's own step call, as the desk sends it, for a step the desk holds back from this founder. */
async function consoleStep(page, packetText, step, confirm) {
  const packet = JSON.parse(Buffer.from(packetText.slice('ifa1.'.length), 'base64url').toString('utf8'));
  return page.evaluate(
    async ({ request, approvalId, step, confirm }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch('/api/more-ops', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify({ step, request, confirm, approvalId }),
        cache: 'no-store',
      });
      const text = await res.text();
      try {
        return { status: res.status, body: JSON.parse(text) };
      } catch {
        return { status: res.status, body: text };
      }
    },
    { request: packet.request, approvalId: packet.approvalId, step, confirm },
  );
}

/** svc-market's public catalogue, read signed out: what a shopper can see. */
async function publicIds() {
  const res = await fetch(`${ORIGIN}/api/market/trpc/listings${trpcInput({ limit: 50 })}`);
  expect(res.status).toBe(200);
  return (await res.json()).result.data.map((row) => row.id);
}

/** The seller's own listing as svc-market answers it to them. */
async function ownListing(client, listingId) {
  const res = await client.get(`/api/market/trpc/myListings${trpcInput({ limit: 50 })}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return data(res).find((row) => row.id === listingId);
}

test(`${J} starts: signed in to the admin app at /more-ops/market; listings are waiting`, async ({ browser, page }) => {
  test.setTimeout(300_000);
  const nonce = `T${Date.now().toString(36)}`;
  // Two TEST sellers, each with one listing published through svc-market's seller doors: a strategy subscription and a
  // one-time data listing. Each waits in the review queue.
  const one = await approvedSeller(page);
  const toApprove = `TEST ${nonce} strategy for review`;
  const created = data(
    await one.client.post('/api/market/trpc/createStrategyListing', {
      title: toApprove,
      description: 'TEST strategy listing on the local test stack. Not a real strategy.',
      assetId: 'USDT',
      price: '7',
      periodSeconds: 30 * 86_400,
    }),
  );
  expect(created).toMatchObject({ title: toApprove, reviewState: 'applied' });
  const sellerPage = await (await browser.newContext({ baseURL: ORIGIN })).newPage();
  const two = await approvedSeller(sellerPage);
  const toReject = `TEST ${nonce} data listing for review`;
  const second = data(
    await two.client.post('/api/market/trpc/createNonStrategyListing', {
      title: toReject,
      description: 'TEST data listing on the local test stack. Not real data.',
      offerType: 'one_time',
      category: 'data',
      assetId: 'USDT',
      price: '3',
    }),
  );
  expect(second).toMatchObject({ title: toReject, reviewState: 'applied' });
  // Neither is public while it waits.
  const ids = await publicIds();
  expect(ids).not.toContain(created.id);
  expect(ids).not.toContain(second.id);

  const { a, ida, idb } = await founders(browser);
  await openDesk(a);
  run.reset({
    nonce,
    founderA: ida.userId,
    founderB: idb.userId,
    toApprove,
    approveId: created.id,
    sellerOne: one.seller,
    toReject,
    rejectId: second.id,
    sellerTwo: two.seller,
  });
});

test(`${J} #1 Opens the review queue: applied listings with seller, terms and criteria; criteria blank shows the queue waiting`, async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const { toApprove, toReject, approveId } = started('toApprove', 'toReject', 'approveId');
  const { a } = await founders(browser);
  await openDesk(a);
  const queue = a.getByRole('region', { name: QUEUE });
  for (const [title, type, price] of [
    [toApprove, 'subscription', '7'],
    [toReject, 'one_time', '3'],
  ]) {
    const row = bodyRows(queue).filter({ hasText: title });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('TEST seller');
    await expect(row).toContainText(type);
    await expect(row).toContainText(price);
    await expect(row).toContainText('USDT');
    await expect(row).toContainText('applied');
  }
  // The criteria are svc-market's, as the stack's TEST owner value publishes them, with the review window.
  const rules = a.getByTestId(`read-market.listing-review-rules`);
  await expect(rules.getByTestId('record')).toContainText('TEST criteria');
  await expect(rules.getByTestId('record')).toContainText('open');

  // With the criteria blank, the queue waits: the desk says so, and svc-market refuses a decision by name.
  restartWith('market', 'LOCAL_STACK_MARKET_REVIEW_CRITERIA', false);
  try {
    await openDesk(a);
    const blank = a.getByTestId(`read-market.listing-review-rules`).getByTestId('record');
    await expect(blank).toContainText('not set');
    await expect(blank).toContainText('waiting: no listing can be approved until the review criteria are set');
    await expect(bodyRows(a.getByRole('region', { name: QUEUE })).filter({ hasText: toApprove })).toHaveCount(1);
    expect(await publicIds()).not.toContain(approveId);
  } finally {
    restartWith('market', 'LOCAL_STACK_MARKET_REVIEW_CRITERIA', true);
  }
});

test(`${J} #2 Approves alone: a typed refusal needing a second founder`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { toApprove, approveId } = started('toApprove', 'approveId');
  const { a } = await founders(browser);
  const { deskA, packet, phrase } = await askReview(a, toApprove, 'Approve', 'TEST listing meets the TEST criteria (J-more-catalogue-04)');
  // The desk holds approval back from the founder who asked; the approval service refuses the same step sent anyway.
  await deskA.getByLabel(/to approve or run it$/).fill(phrase);
  await expect(deskA.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
  const alone = await consoleStep(a, packet, 'approve', phrase);
  expect(alone.body.ok, JSON.stringify(alone)).toBe(false);
  expect(alone.body.refusal?.code, JSON.stringify(alone)).toBe('action_approval.same_person');
  // Running it with no second approval is refused too, and the listing still waits.
  await deskA.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(deskA.getByTestId('step-reply')).toHaveAttribute('data-tone', /danger|warn/, { timeout: 60_000 });
  expect(await publicIds()).not.toContain(approveId);
  run.write({ alonePacket: packet });
});

test(`${J} #3 A second founder approves: the listing becomes approved and appears in the public list with an audit row`, async ({
  browser,
  page,
}) => {
  test.setTimeout(300_000);
  const { toApprove, approveId, founderA, founderB, sellerOne } = started('toApprove', 'approveId', 'founderA', 'founderB', 'sellerOne');
  const pages = await founders(browser);
  const reason = 'TEST listing meets the TEST criteria (J-more-catalogue-04)';
  const { deskA, packet, phrase } = await askReview(pages.a, toApprove, 'Approve', reason);
  await approveAsB(pages.b, QUEUE, toApprove, { packet, phrase, summary: `Approve market listing ${approveId}` });
  const reply = await runAsA(deskA, phrase);
  await expect(reply).toContainText('svc-market answered and its returned listing review is approved');

  // svc-market's own answers: public, and approved for its seller.
  expect(await publicIds()).toContain(approveId);
  expect(await ownListing(await api(sellerOne), approveId)).toMatchObject({ reviewState: 'approved' });
  // A shopper sees it in the Market.
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Market', level: 1 })).toBeVisible();
  const card = page.getByRole('article').filter({ hasText: toApprove });
  await expect(card).toHaveCount(1);
  await expect(card.locator('[data-review-state]')).toHaveAttribute('data-review-state', 'approved');
  // The audit row: the listing, the decision, the reason and the two founders.
  await openDesk(pages.a);
  const audit = bodyRows(pages.a.getByRole('region', { name: AUDIT })).filter({ hasText: approveId });
  await expect(audit.filter({ hasText: 'approved' })).toHaveCount(1);
  const row = audit.filter({ hasText: 'approved' });
  await expect(row).toContainText(reason);
  await expect(row).toContainText(founderA);
  await expect(row).toContainText(founderB);
  // Gone from the queue.
  await expect(bodyRows(pages.a.getByRole('region', { name: QUEUE })).filter({ hasText: toApprove })).toHaveCount(0);
});

test(`${J} #4 Rejects another with a reason: the seller sees the reason`, async ({ browser, page }) => {
  test.setTimeout(300_000);
  const { toReject, rejectId, sellerTwo } = started('toReject', 'rejectId', 'sellerTwo');
  const pages = await founders(browser);
  const reason = 'TEST rejection: the description names no data source (J-more-catalogue-04)';
  const { deskA, packet, phrase } = await askReview(pages.a, toReject, 'Reject', reason);
  await approveAsB(pages.b, QUEUE, toReject, { packet, phrase, summary: `Reject market listing ${rejectId}` });
  const reply = await runAsA(deskA, phrase);
  await expect(reply).toContainText('svc-market answered and its returned listing review is rejected');
  expect(await ownListing(await api(sellerTwo), rejectId)).toMatchObject({ reviewState: 'rejected', reviewReason: reason });
  expect(await publicIds()).not.toContain(rejectId);
  // The seller, signed in, sees the state and the founders' reason on their own listing.
  await signIn(page, sellerTwo);
  await page.goto('/market/mine');
  const card = page.getByRole('article').filter({ hasText: toReject });
  await expect(card.locator('[data-review-state]')).toHaveAttribute('data-review-state', 'rejected');
  await expect(card.locator('[data-review-state]')).toHaveText('Rejected by the Market’s operators');
  await expect(card.getByTestId('review-reason')).toHaveText(reason);
});

test(`${J} #5 Takes down an approved listing: it leaves the public list and the reason shows in the audit`, async ({ browser, page }) => {
  test.setTimeout(300_000);
  const { toApprove, approveId, founderA, founderB } = started('toApprove', 'approveId', 'founderA', 'founderB');
  const pages = await founders(browser);
  const reason = 'TEST takedown: the listing is withdrawn for the journey (J-more-catalogue-04)';
  await openDesk(pages.a);
  const detail = await openRow(pages.a, PUBLIC, toApprove);
  const deskA = detail.getByTestId('control-desk');
  await deskA.getByLabel(/^Why/).fill(reason);
  const phrase = `TAKE DOWN LISTING ${approveId.slice(0, 8)}`;
  await deskA.getByLabel(/to confirm$/).fill(phrase);
  await deskA.getByRole('button', { name: /^Ask a second operator to approve the takedown/ }).click();
  await expect(deskA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packet = (await deskA.getByLabel('Request packet').inputValue()).trim();
  await approveAsB(pages.b, PUBLIC, toApprove, { packet, phrase, summary: `Take down market listing ${approveId}` });
  const reply = await runAsA(deskA, phrase);
  await expect(reply).toContainText('svc-market answered and its returned listing is taken down');

  expect(await publicIds()).not.toContain(approveId);
  await page.goto('/market');
  await expect(page.getByRole('heading', { name: 'Market', level: 1 })).toBeVisible();
  await expect(page.getByRole('article').filter({ hasText: toApprove })).toHaveCount(0);
  await openDesk(pages.a);
  const audit = bodyRows(pages.a.getByRole('region', { name: AUDIT }))
    .filter({ hasText: approveId })
    .filter({ hasText: 'taken_down' });
  await expect(audit).toHaveCount(1);
  await expect(audit).toContainText(reason);
  await expect(audit).toContainText(founderA);
  await expect(audit).toContainText(founderB);
});

test(`${J} ends: one listing approved by two founders, one rejected with a reason, one taken down`, async () => {
  const { approveId, rejectId, sellerOne, sellerTwo } = started('approveId', 'rejectId', 'sellerOne', 'sellerTwo');
  expect(await ownListing(await api(sellerOne), approveId)).toMatchObject({ reviewState: 'taken_down' });
  expect(await ownListing(await api(sellerTwo), rejectId)).toMatchObject({ reviewState: 'rejected' });
  const ids = await publicIds();
  expect(ids).not.toContain(approveId);
  expect(ids).not.toContain(rejectId);
});
