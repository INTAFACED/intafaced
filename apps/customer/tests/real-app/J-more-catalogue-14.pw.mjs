import { test, expect } from './journey.mjs';
import { ADMIN, assertAdminUp, founderSignIn } from './admin.mjs';
import { EDGE, ORIGIN, journeyState } from './stack.mjs';

// J-more-catalogue-14, in the running app (docs/roadmap/journeys.json): onboard an issuer and announce a launch event. One
// test per step, titled "J-more-catalogue-14 #<n>", run in order. Founders A and B work the issuer lens in the admin app at
// /launch, each on their own console: A asks, B pastes the packet and approves the same request, A runs it. Nothing is
// written to a table directly. Every name, price and cap here is TEST. Steps #4 to #7 wait for MC-launch-03 and
// RC-more-catalogue-22 to 24 and fail by name.
const J = 'J-more-catalogue-14';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const MINUTE = 60_000;
const DAY = 86_400_000;

test.describe.configure({ mode: 'default' });

/** The run's saved start, or a named failure when the step that writes it did not run. */
function started(...keys) {
  const saved = run.read();
  for (const key of keys)
    if (!saved[key]) throw new Error(`${J} start is missing "${key}": an earlier step did not build it, so this step cannot run`);
  return saved;
}

const trpcInput = (input) => `?input=${encodeURIComponent(JSON.stringify(input))}`;
/** svc-token's published catalogue, read signed out through Edge, as a customer sees it. */
async function published() {
  const res = await fetch(`${EDGE}/api/token/trpc/launch.events.list${trpcInput({ limit: 200 })}`, { headers: { origin: ORIGIN } });
  expect(res.status).toBe(200);
  return (await res.json()).result.data;
}

/** Both founders signed in to their own consoles, in their own browser contexts. */
async function founders(browser) {
  await assertAdminUp();
  const a = await (await browser.newContext()).newPage();
  const b = await (await browser.newContext()).newPage();
  await founderSignIn(a, 'a');
  await founderSignIn(b, 'b');
  return { a, b };
}

const desk = (page, heading) => page.getByTestId('control-desk').filter({ hasText: heading });

/**
 * One two-founder request on the lens: A fills the form (`fill`) and asks; B opens the same page, pastes the packet, reads
 * `summary` and approves; A runs it. Returns A's step reply.
 */
async function twoFounders({ a, b }, { path, heading, fill, ask, phrase, summary }) {
  await a.goto(`${ADMIN}${path}`);
  await fill(a);
  const deskA = desk(a, heading);
  await deskA.getByLabel(/to confirm$/).fill(phrase);
  await deskA.getByRole('button', { name: ask }).click();
  await expect(deskA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  const packet = (await deskA.getByLabel('Request packet').inputValue()).trim();

  await b.goto(`${ADMIN}${path}`);
  const deskB = desk(b, heading);
  await deskB.getByLabel('Request packet').fill(packet);
  await expect(deskB.getByTestId('packet-summary')).toContainText(summary);
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });

  await deskA.getByLabel(/to approve or run it$/).fill(phrase);
  await deskA.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = deskA.getByTestId('step-reply');
  await expect(reply).toBeVisible({ timeout: 60_000 });
  return reply;
}

/** An issuer review step through the lens. */
function issuerStep(founderPages, issuer, state, revision) {
  const adding = revision === 0;
  return twoFounders(founderPages, {
    path: '/launch',
    heading: 'Review an issuer',
    fill: async (page) => {
      const lens = desk(page, 'Review an issuer').locator('..');
      await lens.getByRole('combobox', { name: /^Issuer\b/ }).selectOption(adding ? '+' : issuer.id);
      if (adding) {
        await lens.getByLabel('New issuer id').fill(issuer.id);
        await lens.getByLabel('New issuer name').fill(issuer.name);
      } else await lens.getByLabel('Next state').selectOption(state);
    },
    ask: 'Ask a second founder to approve this issuer change',
    phrase: `ISSUER ${issuer.id} ${state.toUpperCase()}`,
    summary: adding
      ? `Add issuer ${issuer.id}`
      : state === 'suspended'
        ? `Suspend issuer ${issuer.id}`
        : `Move issuer ${issuer.id} ("${issuer.name}") to ${state}`,
  });
}

/** A launch move through the lens. */
function launchStep(founderPages, launchId, to) {
  return twoFounders(founderPages, {
    path: '/launch',
    heading: 'Move a launch',
    fill: async (page) => {
      const lens = desk(page, 'Move a launch').locator('..');
      await lens.getByRole('combobox', { name: /^Launch\b/ }).selectOption(launchId);
      await lens.getByLabel('Move to').selectOption(to);
    },
    ask: 'Ask a second founder to approve this launch move',
    phrase: `LAUNCH ${launchId} ${to.toUpperCase()}`,
    summary: `Move launch ${launchId} to ${to}`,
  });
}

const issuerRow = (page, id) => page.getByRole('table', { name: 'Issuers' }).locator(`tr[data-issuer="${id}"]`);
const launchRow = (page, id) => page.getByRole('table', { name: 'Launches' }).locator(`tr[data-launch="${id}"]`);
/** A `datetime-local` value in UTC, the way the draft form reads it. */
const utcMinute = (ms) => new Date(Math.floor(ms / MINUTE) * MINUTE).toISOString().slice(0, 16);

test(`${J} starts: signed in to the admin app at /launch (issuer lens); an issuer applied`, async ({ browser }) => {
  test.setTimeout(240_000);
  const nonce = Date.now().toString(36);
  const issuer = { id: `j14-iss-${nonce}`, name: `TEST Issuer ${nonce}` };
  const pages = await founders(browser);
  const reply = await issuerStep(pages, issuer, 'applied', 0);
  await expect(reply).toContainText(`Issuer ${issuer.id} is applied`);
  await pages.a.reload();
  await expect(issuerRow(pages.a, issuer.id).getByTestId('issuer-state')).toHaveText('Applied');
  run.reset({ nonce, issuer });
});

test(`${J} #1 Opens /launch/new as an issuer and saves a draft, then reloads: the stored draft appears`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { nonce, issuer } = started('nonce', 'issuer');
  const pages = await founders(browser);
  const launch = { id: `j14-${nonce}`, name: `TEST Launch ${nonce}`, symbol: `T${nonce.slice(-5).toUpperCase()}` };
  // Every period has begun except close and distribution, so each later move is due as soon as it is approved.
  const now = Date.now();
  const periods = [now - 3 * MINUTE, now - 2 * MINUTE, now - MINUTE, now + DAY, now + 2 * DAY].map(utcMinute);
  const reply = await twoFounders(pages, {
    path: '/launch/new',
    heading: 'Save this launch as a draft',
    fill: async (page) => {
      const form = page.getByRole('form', { name: 'New launch' });
      await form.getByLabel('Launch id').fill(launch.id);
      await form.getByLabel('Issuer').selectOption(issuer.id);
      await form.getByLabel('Type').selectOption('token_sale');
      await form.getByLabel('Project name').fill(launch.name);
      await form.getByLabel('Symbol').fill(launch.symbol);
      for (const [i, name] of ['Announce', 'Snapshot', 'Open', 'Close', 'Distribution'].entries())
        await form.getByLabel(`${name} (UTC)`).fill(periods[i]);
      await form.getByLabel('Allocation method').selectOption('pro_rata');
      await form.getByLabel(/^Cap per account/).fill('250');
      await form.getByLabel(/^Price/).fill('0.5');
      await form.getByLabel(/^Currency/).fill('USDT');
    },
    ask: 'Ask a second founder to approve this draft',
    phrase: `DRAFT LAUNCH ${launch.id}`,
    summary: `Save launch ${launch.id} ("${launch.name}", ${launch.symbol}, token sale) for issuer ${issuer.id} as a draft`,
  });
  await expect(reply).toContainText(`Launch ${launch.id} is saved as a draft`);

  await pages.a.reload();
  await expect(pages.a.getByRole('list', { name: 'Stored drafts' }).locator(`li[data-launch="${launch.id}"]`)).toContainText(launch.name);
  await pages.a.goto(`${ADMIN}/launch`);
  await expect(launchRow(pages.a, launch.id).getByTestId('launch-status')).toHaveText('draft');
  // A draft is not published.
  expect((await published()).map((e) => e.id)).not.toContain(launch.id);
  run.write({ launch });
});

test(`${J} #2 An operator announces an event for an issuer with no onboarding: a typed refusal that the issuer is not onboarded; status unchanged`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { launch } = started('launch');
  const pages = await founders(browser);
  const reply = await launchStep(pages, launch.id, 'announced');
  await expect(reply).toContainText('This issuer is not onboarded');
  await expect(reply).toContainText('launch.issuer_not_onboarded');
  await pages.a.reload();
  await expect(launchRow(pages.a, launch.id).getByTestId('launch-status')).toHaveText('draft');
  expect((await published()).map((e) => e.id)).not.toContain(launch.id);
});

test(`${J} #3 Onboards the issuer and announces: the event appears in the catalogue with its issuer state`, async ({ browser, page }) => {
  test.setTimeout(420_000);
  const { issuer, launch } = started('issuer', 'launch');
  const pages = await founders(browser);
  await expect(await issuerStep(pages, issuer, 'reviewing', 1)).toContainText(`Issuer ${issuer.id} is reviewing`);
  await expect(await issuerStep(pages, issuer, 'onboarded', 2)).toContainText(`Issuer ${issuer.id} is onboarded`);
  await expect(await launchStep(pages, launch.id, 'announced')).toContainText(`Launch ${launch.id} is announced`);

  const listed = (await published()).find((e) => e.id === launch.id);
  expect(listed).toMatchObject({ status: 'announced', state: 'upcoming', issuer: { id: issuer.id, state: 'onboarded' } });
  // The customer's catalogue, signed out, shows the card with its issuer state.
  await page.goto('/launch');
  const card = page
    .getByRole('list', { name: 'Launch events' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: new RegExp(launch.name) }) });
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId('launch-issuer-state')).toHaveText('Onboarded');
  run.write({ announced: true });
});

// Steps #4 to #7 wait for slices not yet built. They stay cheap (no founder sign-in, a short timeout) and fail naming the
// slice; the lens lists each of them under "Not wired yet" with its blocker. Each becomes a real check when its slice lands.
test(`${J} #4 Reads the commits and refunds panel: progress reads for the event`, async ({ page }) => {
  started('announced');
  // MC-launch-03 (commit, allocation and refund through the ledger) is not built: no progress panel exists yet.
  await page.goto(`${ADMIN}/launch`);
  await expect(page.getByRole('region', { name: 'Commits and refunds' }), 'MC-launch-03 is not built').toBeVisible({ timeout: 5_000 });
});

test(`${J} #5 Records fundraising milestones and investor records on the event: milestones with their state`, async ({ page }) => {
  started('announced');
  await page.goto(`${ADMIN}/launch`);
  await expect(page.getByRole('region', { name: 'Fundraising milestones' }), 'RC-more-catalogue-22 is not built').toBeVisible({
    timeout: 5_000,
  });
});

test(`${J} #6 Records a wrapped or structured issuance: the issuance with its kind`, async ({ page }) => {
  started('announced');
  await page.goto(`${ADMIN}/launch`);
  await expect(page.getByRole('region', { name: 'Structured issuance' }), 'RC-more-catalogue-23 is not built').toBeVisible({
    timeout: 5_000,
  });
});

test(`${J} #7 Reviews the marketing claims evidence register before announcing: each claim with its evidence or a block`, async ({
  page,
}) => {
  started('announced');
  await page.goto(`${ADMIN}/launch`);
  await expect(page.getByRole('region', { name: 'Marketing claims' }), 'RC-more-catalogue-24 is not built').toBeVisible({ timeout: 5_000 });
});

test(`${J} #8 Moves the issuer to suspended: its open events close and the move is audited`, async ({ browser, page }) => {
  test.setTimeout(420_000);
  const { issuer, launch } = started('issuer', 'launch', 'announced');
  const pages = await founders(browser);
  // The launch opens through the same lens: snapshot, then open.
  await expect(await launchStep(pages, launch.id, 'snapshot')).toContainText(`Launch ${launch.id} is snapshot`);
  await expect(await launchStep(pages, launch.id, 'open')).toContainText(`Launch ${launch.id} is open`);
  expect((await published()).find((e) => e.id === launch.id)).toMatchObject({ status: 'open', state: 'open' });

  await expect(await issuerStep(pages, issuer, 'suspended', 3)).toContainText(`Issuer ${issuer.id} is suspended`);
  await pages.a.reload();
  await expect(issuerRow(pages.a, issuer.id).getByTestId('issuer-state')).toHaveText('Suspended');
  const row = launchRow(pages.a, launch.id);
  await expect(row.getByTestId('launch-status')).toHaveText('closed');
  // The audit: the issuer's move and the launch's close, each with who asked and who approved, the close naming its cause.
  await row.getByText(/^History/).click();
  const close = row.locator('[data-testid="launch-move"][data-cause="issuer_suspended"]');
  await expect(close).toHaveCount(1);
  await expect(close).toContainText('open → closed, closed because its issuer was suspended');
  const issuerHistory = issuerRow(pages.a, issuer.id);
  await issuerHistory.getByText(/^History/).click();
  await expect(issuerHistory.getByTestId('launch-move').last()).toContainText('onboarded → suspended');
  // The customer catalogue reads it as past, with its issuer suspended.
  expect((await published()).find((e) => e.id === launch.id)).toMatchObject({
    status: 'closed',
    state: 'past',
    issuer: { state: 'suspended' },
  });
  await page.goto('/launch');
  const card = page
    .getByRole('list', { name: 'Launch events' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('link', { name: new RegExp(launch.name) }) });
  await expect(card.getByTestId('launch-issuer-state')).toHaveText('Suspended');
});
