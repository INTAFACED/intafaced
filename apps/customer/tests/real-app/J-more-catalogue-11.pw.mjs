import { test, expect } from '@playwright/test';
import { EDGE, ORIGIN, api, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { createEvent, moveEvent, onboardedIssuer } from './launch.mjs';

// J-more-catalogue-11, in the running app (docs/roadmap/journeys.json): browse a token launch and read its terms. One test
// per step, titled "J-more-catalogue-11 #<n>". No money moves.
// Step 1 runs first, on a stack with no published launch. Then the start is built through svc-token's own founder doors
// (tests/real-app/launch.mjs), never injected: a TEST issuer is onboarded; "I" sign up, verify and stake 100 TEST IFC;
// an open launch with a TEST pro-rata cap and a TEST price is announced, its snapshot sealed after my stake, and opened;
// and a past launch with no allocation rule and no price is announced and cancelled. Browsing steps run signed out.
const J = 'J-more-catalogue-11';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const MINUTE = 60_000;
const DAY = 86_400_000;
const STAKE = '100';

test.describe.configure({ mode: 'default' });

const trpcInput = (input) => `?input=${encodeURIComponent(JSON.stringify(input))}`;
const data = (res) => res.body?.result?.data;
const cards = (page) => page.getByRole('list', { name: 'Launch events' }).getByRole('listitem');
const card = (page, name) => cards(page).filter({ has: page.getByRole('link', { name }) });

/** The catalogue as svc-token publishes it, read signed out through Edge. */
async function published(input = {}) {
  const res = await fetch(`${EDGE}/api/token/trpc/launch.events.list${trpcInput({ limit: 200, ...input })}`, { headers: { origin: ORIGIN } });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

async function openCatalogue(page) {
  await page.goto('/launch');
  await expect(page.getByRole('heading', { name: 'Launch', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Launches', selected: true })).toBeVisible();
}

async function openLaunch(page, launch) {
  await openCatalogue(page);
  await card(page, launch.label).getByRole('link', { name: launch.label }).click();
  await expect(page).toHaveURL(new RegExp(`/launch/${launch.id}$`));
  await expect(page.getByRole('heading', { name: launch.label })).toBeVisible();
}

test(`${J} #1 Opens /launch with no events: the full layout, filters and empty state; no sample card`, async ({ page }) => {
  run.reset({});
  expect(await published(), 'the stack must start with no published launch').toEqual([]);
  await openCatalogue(page);
  for (const tab of ['Launches', 'Journey', 'Check', 'Requirements', 'Participation']) await expect(page.getByRole('tab', { name: tab })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Type' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'State' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No launch events yet' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Launch events' })).toHaveCount(0);
  await expect(page.getByTestId('launch-issuer-state')).toHaveCount(0);
});

test(`${J} starts: signed in or out; one open and one past launch event exist`, async ({ page }) => {
  test.setTimeout(240_000);
  const tag = Date.now().toString(36);
  const issuer = await onboardedIssuer(`tst-issuer-${tag}`, `TEST Issuer ${tag}`);

  // "I" stake before the snapshot, so the sealed snapshot holds my row.
  const who = await signUp(page, 'lc');
  await verify(page, who);
  expect(fund(who.email, 'IFC', STAKE).tx).toBeTruthy();
  const client = await api(who);
  const staked = await client.post('/api/token/trpc/stake', { amount: STAKE, tier: 'flex', stakeId: `${J}:stake:${tag}` });
  expect(staked.status, JSON.stringify(staked.body).slice(0, 300)).toBe(200);
  expect(data(staked)).toMatchObject({ amount: STAKE, status: 'active' });

  const now = Date.now();
  const at = (ms) => new Date(ms).toISOString();
  const open = {
    id: `tst-open-${tag}`,
    issuerId: issuer.id,
    type: 'token_sale',
    projectName: `TEST Open Launch ${tag}`,
    symbol: 'TSTO',
    periods: {
      announceAt: at(now - MINUTE),
      snapshotAt: at(now - MINUTE),
      openAt: at(now - MINUTE),
      closeAt: at(now + 30 * DAY),
      distributionAt: at(now + 31 * DAY),
    },
    allocation: { method: 'pro_rata', perUserCap: '250', ticketSize: null, tierWeights: null },
    terms: { price: '0.5', paymentAsset: 'USDT', rateSource: null },
  };
  const past = {
    id: `tst-past-${tag}`,
    issuerId: issuer.id,
    type: 'whitelist_drop',
    projectName: `TEST Past Launch ${tag}`,
    symbol: 'TSTP',
    periods: {
      announceAt: at(now - 3 * DAY),
      snapshotAt: at(now - 3 * DAY),
      openAt: at(now - 2 * DAY),
      closeAt: at(now - DAY),
      distributionAt: at(now - DAY),
    },
    allocation: { method: null, perUserCap: null, ticketSize: null, tierWeights: null },
    terms: { price: null, paymentAsset: null, rateSource: null },
  };
  let revision = await createEvent(open);
  for (const to of ['announced', 'snapshot', 'open']) revision = (await moveEvent(open.id, to, revision)).revision;
  revision = await createEvent(past);
  for (const to of ['announced', 'cancelled']) revision = (await moveEvent(past.id, to, revision)).revision;

  const label = (e) => `${e.projectName} (${e.symbol})`;
  run.write({ who, open: { id: open.id, label: label(open) }, past: { id: past.id, label: label(past) } });
  const listed = await published();
  expect(listed.find((e) => e.id === open.id)).toMatchObject({ status: 'open', state: 'open', issuer: { state: 'onboarded' } });
  expect(listed.find((e) => e.id === past.id)).toMatchObject({ status: 'cancelled', state: 'past', issuer: { state: 'onboarded' } });
});

test(`${J} #2 Opens it with two events and filters by state: only matching cards, each with its issuer state`, async ({ page }) => {
  const { open, past } = run.read();
  await openCatalogue(page);
  await expect(card(page, open.label)).toHaveCount(1);
  await expect(card(page, past.label)).toHaveCount(1);

  const state = page.getByRole('combobox', { name: 'State' });
  await state.selectOption({ label: 'Open' });
  await expect(card(page, past.label)).toHaveCount(0);
  await expect(card(page, open.label)).toHaveCount(1);
  await expect(cards(page)).toHaveCount((await published({ state: 'open' })).length);
  for (const c of await cards(page).all()) {
    await expect(c).toContainText('Open');
    await expect(c.getByTestId('launch-issuer-state')).toBeVisible();
  }
  await expect(card(page, open.label).getByTestId('launch-issuer-state')).toHaveText('Onboarded');

  await state.selectOption({ label: 'Past' });
  await expect(card(page, open.label)).toHaveCount(0);
  await expect(card(page, past.label)).toHaveCount(1);
  await expect(cards(page)).toHaveCount((await published({ state: 'past' })).length);
  for (const c of await cards(page).all()) {
    await expect(c).toContainText('Ended');
    await expect(c.getByTestId('launch-issuer-state')).toBeVisible();
  }
  await expect(card(page, past.label).getByTestId('launch-issuer-state')).toHaveText('Onboarded');
});

test(`${J} #3 Opens a launch at /launch/<id>: allocation panel (method, cap, weights, or "not set"); terms panel with price, currency, rate or "price not set"`, async ({
  page,
}) => {
  const { open, past } = run.read();
  await openLaunch(page, open);
  const allocation = page.getByRole('region', { name: 'Allocation' });
  await expect(allocation).toContainText(/Method\s*Pro rata by holdings/);
  await expect(allocation).toContainText(/Cap\s*250 TSTO/);
  await expect(allocation).toContainText(/Weights\s*not set/);
  const terms = page.getByRole('region', { name: 'Terms' });
  await expect(terms).toContainText(/Price\s*0\.5 USDT/);
  await expect(terms).toContainText(/Currency\s*USDT/);
  await expect(terms).toContainText(/Rate\s*rate not set/);

  // The past launch stores no rule and no price: each blank field says so.
  await page.goto(`/launch/${past.id}`);
  await expect(page.getByRole('heading', { name: past.label })).toBeVisible();
  const blank = page.getByRole('region', { name: 'Allocation' });
  for (const field of ['Method', 'Cap', 'Weights']) await expect(blank).toContainText(new RegExp(`${field}\\s*not set`));
  await expect(page.getByRole('region', { name: 'Terms' })).toContainText(/Price\s*price not set/);
});

test(`${J} #4 Checks my eligibility: the requirements list with unmet items (identity verification)`, async ({ page }) => {
  test.setTimeout(180_000);
  const { open } = run.read();
  const unverified = await signUp(page, 'lu');
  await signIn(page, unverified);
  await openLaunch(page, open);
  await page.getByRole('button', { name: 'Check my eligibility' }).click();
  const items = page.getByRole('list', { name: 'Requirements' }).getByRole('listitem');
  await expect(items).toHaveCount(6);
  const identity = items.filter({ hasText: 'Identity verification' });
  await expect(identity).toContainText('Not met');
  await expect(identity).toContainText('Needs basic; yours: none');
  for (const met of ['Issuer onboarded', 'Launch open']) await expect(items.filter({ hasText: met })).not.toContainText('Not met');
  await expect(page.getByText(/^You do not meet every requirement\./)).toBeVisible();

  // The page shows the service's own answer for this account, item for item.
  const answer = data(await (await api(unverified)).get(`/api/token/trpc/launch.eligibility${trpcInput({ id: open.id })}`));
  expect(answer.eligible).toBe(false);
  expect(answer.requirements.find((r) => r.id === 'identity_verification')).toEqual({
    id: 'identity_verification',
    met: false,
    required: 'basic',
    actual: 'none',
  });
});

test(`${J} #5 Reads my basis for an allocation by holdings: my basis equals the stored snapshot row, the cap as a decimal string`, async ({
  page,
}) => {
  const { who, open } = run.read();
  await signIn(page, who);
  await openLaunch(page, open);
  const basis = page.getByRole('region', { name: 'Your basis' });
  await expect(basis).toContainText('Snapshot taken');
  await expect(basis).toContainText(/Method\s*Pro rata by holdings/);

  // The stored snapshot row is what I staked before the seal; the page shows that row and the stored cap unchanged.
  const stored = data(await (await api(who)).get(`/api/token/trpc/launch.basis${trpcInput({ id: open.id })}`));
  expect(stored).toMatchObject({ method: 'pro_rata', basis: STAKE, perUserCap: '250', reason: null });
  await expect(basis.getByTestId('launch-basis')).toHaveText(`${stored.basis} IFC staked`);
  await expect(basis.getByTestId('launch-cap')).toHaveText(`${stored.perUserCap} TSTO`);
  await expect(basis.getByTestId('launch-cap')).toHaveText(/^\d+(\.\d+)? \w+$/);
});
