import { createHash } from 'node:crypto';
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
/** The run's saved start, or a named failure when the step that writes it did not run. */
function started(...keys) {
  const saved = run.read();
  for (const key of keys)
    if (!saved[key]) throw new Error(`${J} start is missing "${key}": the starts step did not build the launches, so this step cannot run`);
  return saved;
}
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const METHOD_LABELS = { pro_rata: 'Pro rata by holdings', tickets: 'Tickets', tiered: 'Tiered' };
const ISSUER_STATE_LABELS = { applied: 'Applied', reviewing: 'In review', onboarded: 'Onboarded', suspended: 'Suspended' };
const STATE_LABELS = { upcoming: 'Upcoming', open: 'Open', past: 'Past' };
const cards = (page) => page.getByRole('list', { name: 'Launch events' }).getByRole('listitem');
const card = (page, name) => cards(page).filter({ has: page.getByRole('link', { name }) });

/** The catalogue as svc-token publishes it, read signed out through Edge. */
async function published(input = {}) {
  const res = await fetch(`${EDGE}/api/token/trpc/launch.events.list${trpcInput({ limit: 200, ...input })}`, {
    headers: { origin: ORIGIN },
  });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** One launch as svc-token publishes it, read signed out through Edge. */
async function launchEvent(id) {
  const res = await fetch(`${EDGE}/api/token/trpc/launch.events.get${trpcInput({ id })}`, { headers: { origin: ORIGIN } });
  const body = await res.json();
  expect(res.status, JSON.stringify(body).slice(0, 300)).toBe(200);
  return body.result.data;
}

/** Stakes `amount` IFC on the flex tier. The stake id is a name-based (version 5) uuid from the business key, so a retried
 * step stakes once. */
async function stake(who, amount, key) {
  const hex = createHash('sha256').update(key).digest('hex');
  const stakeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  const staked = await (await api(who)).post('/api/token/trpc/stake', { amount, tier: 'flex', stakeId });
  expect(staked.status, JSON.stringify(staked.body).slice(0, 300)).toBe(200);
  expect(data(staked)).toMatchObject({ amount, status: 'active' });
}

async function openCatalogue(page) {
  await page.goto('/launch');
  await expect(page.getByRole('heading', { name: 'Launch', level: 1 })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Launch sections' }).getByRole('button', { name: 'Launches', pressed: true })).toBeVisible();
}

/** Each requirement's label on the page, by the service's requirement id. */
const REQUIREMENT_LABELS = {
  identity_verification: 'Identity verification',
  region: 'Region',
  account_active: 'Active account',
  main_account: 'Main account (not a sub-account)',
  issuer_onboarded: 'Issuer onboarded',
  event_open: 'Launch open',
};
const requirementItems = (page) => page.getByRole('list', { name: 'Requirements' }).getByRole('listitem');
const requirement = (page, id) =>
  requirementItems(page).filter({ has: page.locator('strong').getByText(REQUIREMENT_LABELS[id], { exact: true }) });

/** The page lists exactly the service's requirements, each once, met or not met as the service answered. */
async function expectRequirements(page, requirements) {
  expect(requirements.map((r) => r.id).sort()).toEqual(Object.keys(REQUIREMENT_LABELS).sort());
  await expect(requirementItems(page)).toHaveCount(requirements.length);
  for (const r of requirements) {
    const item = requirement(page, r.id);
    await expect(item).toHaveCount(1);
    await expect(item).toHaveAttribute('data-met', String(r.met));
    await expect(item.locator('.launch-catalogue-badge')).toHaveText(r.met ? 'Met' : 'Not met');
  }
}

/** The cards are exactly the service's events for the filter, each once, with that event's state and issuer state. */
async function expectCards(page, events, stateWord) {
  const label = (e) => `${e.projectName} (${e.symbol})`;
  await expect(cards(page)).toHaveCount(events.length);
  expect((await cards(page).getByRole('link').allTextContents()).sort()).toEqual(events.map(label).sort());
  for (const e of events) {
    const c = card(page, label(e));
    await expect(c).toHaveCount(1);
    await expect(c.getByTestId('launch-state')).toHaveText(stateWord);
    await expect(c.getByTestId('launch-issuer-state')).toHaveText(ISSUER_STATE_LABELS[e.issuer.state]);
  }
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
  for (const section of ['Launches', 'Issuer journey', 'Pre-listing check', 'Requirements', 'My participation'])
    await expect(page.getByRole('group', { name: 'Launch sections' }).getByRole('button', { name: section })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Type' })).toBeVisible();
  // The State filter offers All plus each state the service filters by, each exactly once; the service refuses any other.
  await expect(page.getByRole('combobox', { name: 'State' }).getByRole('option')).toHaveText(['All', ...Object.values(STATE_LABELS)]);
  for (const s of Object.keys(STATE_LABELS)) expect(await published({ state: s })).toEqual([]);
  const other = await fetch(`${EDGE}/api/token/trpc/launch.events.list${trpcInput({ limit: 200, state: 'finished' })}`, {
    headers: { origin: ORIGIN },
  });
  expect(other.status).toBe(400);
  await expect(page.getByRole('heading', { name: 'No launch events yet' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Launch events' })).toHaveCount(0);
  const main = page.getByRole('main');
  await expect(main.getByTestId('launch-issuer-state')).toHaveCount(0);
  await expect(main.getByTestId('launch-state')).toHaveCount(0);
  await expect(main.locator('a[href^="/launch/"]')).toHaveCount(0);
  await expect(main).not.toContainText(/\bTEST\b|Price|Pro rata/);
});

test(`${J} starts: signed in or out; one open and one past launch event exist`, async ({ page }) => {
  test.setTimeout(240_000);
  const tag = Date.now().toString(36);
  const issuer = await onboardedIssuer(`tst-issuer-${tag}`, `TEST Issuer ${tag}`);

  // "I" stake before the snapshot, so the sealed snapshot holds my row.
  const who = await signUp(page, 'lc');
  await verify(page, who);
  expect(fund(who.email, 'IFC', STAKE).tx).toBeTruthy();
  await stake(who, STAKE, `${J}:stake:${tag}`);

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
  const { open, past } = started('open', 'past');
  await openCatalogue(page);
  // Signed out: the app offers to log in.
  await expect(page.getByRole('link', { name: 'Log in' })).toBeVisible();
  await expect(card(page, open.label)).toHaveCount(1);
  await expect(card(page, past.label)).toHaveCount(1);

  const state = page.getByRole('combobox', { name: 'State' });
  await state.selectOption({ label: 'Open' });
  await expect(card(page, past.label)).toHaveCount(0);
  await expect(card(page, open.label)).toHaveCount(1);
  await expectCards(page, await published({ state: 'open' }), 'Open');
  await expect(card(page, open.label).getByTestId('launch-issuer-state')).toHaveText('Onboarded');

  await state.selectOption({ label: 'Past' });
  await expect(card(page, open.label)).toHaveCount(0);
  await expect(card(page, past.label)).toHaveCount(1);
  await expectCards(page, await published({ state: 'past' }), 'Ended');
  await expect(card(page, past.label).getByTestId('launch-issuer-state')).toHaveText('Onboarded');
});

test(`${J} #3 Opens a launch at /launch/<id>: allocation panel (method, cap, weights, or "not set"); terms panel with price, currency, rate or "price not set"`, async ({
  page,
}) => {
  const { open, past } = started('open', 'past');
  await openLaunch(page, open);
  // Signed out: eligibility and basis ask me to sign in.
  for (const region of ['Who may take part', 'Your basis'])
    await expect(page.getByRole('region', { name: region })).toContainText('Sign in to check your eligibility and read your basis.');
  // Each figure is the service's own, read back for this launch.
  const event = await launchEvent(open.id);
  expect(event.allocation).toMatchObject({ method: 'pro_rata', tierWeights: null });
  expect(event.terms).toMatchObject({ rateSource: null });
  const allocation = page.getByRole('region', { name: 'Allocation' });
  await expect(allocation).toContainText(new RegExp(`Method\\s*${METHOD_LABELS[event.allocation.method]}`));
  await expect(allocation).toContainText(new RegExp(`Cap\\s*${escape(event.allocation.perUserCap)} ${event.symbol}`));
  await expect(allocation).toContainText(/Weights\s*not set/);
  const terms = page.getByRole('region', { name: 'Terms' });
  await expect(terms).toContainText(new RegExp(`Price\\s*${escape(event.terms.price)} ${event.terms.paymentAsset}`));
  await expect(terms).toContainText(new RegExp(`Currency\\s*${event.terms.paymentAsset}`));
  await expect(terms).toContainText(/Rate\s*rate not set/);

  // The past launch stores no rule and no price: each blank field says so.
  const stored = await launchEvent(past.id);
  expect(stored.allocation).toEqual({ method: null, perUserCap: null, ticketSize: null, tierWeights: null });
  expect(stored.terms).toEqual({ price: null, paymentAsset: null, rateSource: null });
  await page.goto(`/launch/${past.id}`);
  await expect(page.getByRole('heading', { name: past.label })).toBeVisible();
  const blank = page.getByRole('region', { name: 'Allocation' });
  for (const field of ['Method', 'Cap', 'Weights']) await expect(blank).toContainText(new RegExp(`${field}\\s*not set`));
  const blankTerms = page.getByRole('region', { name: 'Terms' });
  await expect(blankTerms).toContainText(/Price\s*price not set/);
  await expect(blankTerms).toContainText(/Currency\s*not set/);
  await expect(blankTerms).toContainText(/Rate\s*rate not set/);
});

test(`${J} #4 Checks my eligibility: the requirements list with unmet items (identity verification)`, async ({ page }) => {
  test.setTimeout(180_000);
  const { open } = started('open');
  const unverified = await signUp(page, 'lu');
  run.write({ unverified });
  await signIn(page, unverified);
  await openLaunch(page, open);
  await page.getByRole('button', { name: 'Check my eligibility' }).click();
  await expect(page.getByText(/^You do not meet every requirement\./)).toBeVisible();

  // The service's own answer for this account: identity verification is unmet, needing basic with none held.
  const answer = data(await (await api(unverified)).get(`/api/token/trpc/launch.eligibility${trpcInput({ id: open.id })}`));
  expect(answer.eligible).toBe(false);
  expect(answer.requirements.find((r) => r.id === 'identity_verification')).toEqual({
    id: 'identity_verification',
    met: false,
    required: 'basic',
    actual: 'none',
  });
  // The page lists every requirement the service answered, each exactly once, met or not met as the service says.
  await expectRequirements(page, answer.requirements);
  await expect(requirement(page, 'identity_verification')).toContainText('Needs basic; yours: none');
});

test(`${J} #5 Reads my basis for an allocation by holdings: my basis equals the stored snapshot row, the cap as a decimal string`, async ({
  page,
}) => {
  test.setTimeout(180_000);
  const { who, open } = started('who', 'open');
  // After the seal I stake more. The snapshot row stays what I held at the seal, so a basis read from today's holdings
  // would show the sum and fail here.
  const MORE = '40';
  expect(fund(who.email, 'IFC', MORE).tx).toBeTruthy();
  await stake(who, MORE, `${J}:stake-after-seal:${open.id}`);

  await signIn(page, who);
  await openLaunch(page, open);
  const basis = page.getByRole('region', { name: 'Your basis' });
  await expect(basis).toContainText('Snapshot taken');
  await expect(basis).toContainText(/Method\s*Pro rata by holdings/);

  // The stored snapshot row is what I staked before the seal; the page shows that row and the stored cap unchanged.
  const stored = data(await (await api(who)).get(`/api/token/trpc/launch.basis${trpcInput({ id: open.id })}`));
  expect(stored).toMatchObject({ method: 'pro_rata', basis: STAKE, perUserCap: '250', reason: null });
  await expect(basis.getByTestId('launch-basis')).toHaveText(`${STAKE} IFC staked`);
  await expect(basis.getByTestId('launch-cap')).toHaveText(`${stored.perUserCap} TSTO`);
  await expect(basis.getByTestId('launch-cap')).toHaveText(/^\d+(\.\d+)? \w+$/);
});

test(`${J} ends: I know the issuer state, allocation rule, price and who may take part, and the page told me what blocks me`, async ({
  page,
}) => {
  const { open, unverified } = started('open');
  if (!unverified) throw new Error(`${J} #4 made no unverified account, so the end has no one to act as`);
  await signIn(page, unverified);
  await openLaunch(page, open);
  // Each figure on the page is the service's own, read back for this launch.
  const event = data(await (await api(unverified)).get(`/api/token/trpc/launch.events.get${trpcInput({ id: open.id })}`));
  expect(event).toMatchObject({ id: open.id, issuer: { state: 'onboarded' }, allocation: { method: 'pro_rata' } });
  // This page shows one launch, so its one issuer state is this launch's.
  const issuerState = page.getByRole('main').getByTestId('launch-issuer-state');
  await expect(issuerState).toHaveCount(1);
  await expect(issuerState).toHaveText(ISSUER_STATE_LABELS[event.issuer.state]);
  const allocation = page.getByRole('region', { name: 'Allocation' });
  await expect(allocation).toContainText(new RegExp(`Method\\s*${METHOD_LABELS[event.allocation.method]}`));
  await expect(allocation).toContainText(new RegExp(`Cap\\s*${escape(event.allocation.perUserCap)} ${event.symbol}`));
  await expect(page.getByRole('region', { name: 'Terms' })).toContainText(
    new RegExp(`Price\\s*${escape(event.terms.price)} ${event.terms.paymentAsset}`),
  );
  // Who may take part, and what blocks me: every requirement as the service answers it, and the unmet one named.
  await page.getByRole('button', { name: 'Check my eligibility' }).click();
  await expect(page.getByText(/^You do not meet every requirement\./)).toBeVisible();
  const answer = data(await (await api(unverified)).get(`/api/token/trpc/launch.eligibility${trpcInput({ id: open.id })}`));
  await expectRequirements(page, answer.requirements);
  const unmet = answer.requirements.filter((r) => !r.met).map((r) => r.id);
  expect(unmet).toEqual(['identity_verification']);
  const blocker = answer.requirements.find((r) => r.id === 'identity_verification');
  await expect(requirement(page, 'identity_verification')).toContainText(`Needs ${blocker.required}; yours: ${blocker.actual}`);
});
