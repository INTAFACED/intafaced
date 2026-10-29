import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { api, fund, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { tableIn, bodyRows } from './tables.mjs';

// J-more-catalogue-09, in the running app (docs/roadmap/journeys.json): read a governance proposal and cast my vote. One
// test per step, titled "J-more-catalogue-09 #<n>", run in order. No value moves: staking is TEST IFC funded through the
// real ledger, and a vote or a proposal moves nothing.
// The start is built through the product's own doors, never injected: "I" sign up, verify and stake 100 TEST IFC; then a
// second TEST account (the proposer) stakes 1100, above the stack's TEST proposer rule (stake:1000, from
// tooling/profiles/test-owner-values/token.json), and opens one proposal now and one draft with a future opening time.
// So the space holds proposals in two states, and my stake is from before they were created. The space is shared with
// every other run, so each run's proposals carry a run nonce and the list is read through that search.
// Step 4's "a blank rule gives its own code" restarts the token lane with the rule unset
// (LOCAL_STACK_TOKEN_PROPOSER_RULE=off), reads the refusal, then restarts it with the TEST rule, in a try/finally.
// Step 9 mints one TEST epoch through svc-token's job door (the ledger's mint recipe, TEST IFC into the rewards engine)
// after `local-test-stack.mjs token-params` writes the labelled TEST emission settings into the blank columns, so the
// treasury holds a figure the test can compare with the ledger. Nothing on this stack buys back, distributes or burns IFC
// (the buyback and yield jobs are off), so those figures are the missing ones.
// Steps 6 and 7 are not built (MC-token-03: power fixed at creation and its history, approval, weighted and ranked
// ballots, the signed vote), so they fail at their first missing part, quickly (UNBUILT).
const J = 'J-more-catalogue-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };
const DAY = 86_400_000;

test.describe.configure({ mode: 'default' });

const space = (page) => page.getByRole('region', { name: 'Governance space' });
const proposals = (page) => tableIn(page, 'Proposals');
const search = (page) => page.getByRole('searchbox', { name: 'Search proposals' });
const trpcInput = (input) => `?input=${encodeURIComponent(JSON.stringify(input))}`;
const data = (res) => res.body?.result?.data;
const causeOf = (body) => body?.error?.data?.cause;

async function openGovernance(page, who = run.read().who) {
  await signIn(page, who);
  await page.goto('/token/governance');
  await expect(page.getByRole('heading', { name: 'Token governance', level: 1 })).toBeVisible();
}

async function listed(client, input) {
  const res = await client.get(`/api/token/trpc/listProposals${trpcInput({ limit: 50, ...input })}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return data(res);
}

async function home(client) {
  const res = await client.get('/api/token/trpc/governanceHome');
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return data(res);
}

/** A signed-up, verified TEST account with `stake` TEST IFC staked through svc-token. */
async function staker(page, prefix, funded, stake) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  expect(fund(who.email, 'IFC', funded).tx).toBeTruthy();
  const client = await api(who);
  const staked = await client.post('/api/token/trpc/stake', { amount: stake, tier: 'flex', stakeId: randomUUID() });
  expect(staked.status, JSON.stringify(staked.body).slice(0, 300)).toBe(200);
  expect(data(staked)).toMatchObject({ amount: stake, status: 'active' });
  return { who, client };
}

/** Restarts the token lane with the TEST proposer rule (`on`) or with it unset, as identity's restarts do (J-identity-08). */
function proposerRule(on) {
  const before = process.env.LOCAL_STACK_TOKEN_PROPOSER_RULE;
  if (on) delete process.env.LOCAL_STACK_TOKEN_PROPOSER_RULE;
  else process.env.LOCAL_STACK_TOKEN_PROPOSER_RULE = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'token');
  } finally {
    if (before === undefined) delete process.env.LOCAL_STACK_TOKEN_PROPOSER_RULE;
    else process.env.LOCAL_STACK_TOKEN_PROPOSER_RULE = before;
  }
}

/** A canonical decimal string as 18-decimal scaled bigint, so sums and differences never pass through a JS number. */
function units(value) {
  expect(value, `${value} is not a decimal string`).toMatch(/^-?\d+(\.\d{1,18})?$/);
  const [whole, frac = ''] = value.replace('-', '').split('.');
  const scaled = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0'));
  return value.startsWith('-') ? -scaled : scaled;
}

/** A house account's balance as the ledger itself holds it, through a signed service read. */
async function ledgerBalance(ctx, ownerId) {
  const raw = JSON.stringify({ ownerType: 'house', ownerId, assetId: 'IFC', kind: 'available' });
  const res = await fetch(`${ctx.url('ledger')}/trpc/balance`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ctx.contracts.serviceAuthHeadersForBody('svc-token', ctx.secrets.internal, raw) },
    body: raw,
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text).amount;
}

/** One TEST emission epoch through svc-token's signed job door; the ledger's mint recipe credits the rewards engine. */
async function mintTestEpoch(ctx) {
  const raw = JSON.stringify({});
  const res = await fetch(`${ctx.url('token')}/internal/emissions/mint-next`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ctx.contracts.serviceAuthHeadersForBody('svc-token', ctx.secrets.internal, raw) },
    body: raw,
  });
  const text = await res.text();
  expect(res.status, text.slice(0, 300)).toBe(200);
  return JSON.parse(text);
}

/** A `datetime-local` value `ms` from now, in this machine's zone, as the browser's field takes it. */
function localIn(ms) {
  const d = new Date(Date.now() + ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

test(`${J} starts: signed in; a governance space with proposals in two states; I hold a stake from before they were created`, async ({
  page,
}) => {
  const nonce = `T${Date.now().toString(36)}`;
  const me = await staker(page, 'gv', '150', '100');
  const author = await staker(page, 'gvp', '1200', '1100');
  const now = Date.now();
  const opened = await author.client.post('/api/token/trpc/createProposal', {
    kind: 'fee_param',
    body: {},
    handle: `${nonce}:open`,
    title: `TEST ${nonce} open vote`,
    bodyMd: 'TEST proposal for the governance journey.',
  });
  expect(opened.status, JSON.stringify(opened.body).slice(0, 300)).toBe(200);
  const drafted = await author.client.post('/api/token/trpc/createProposal', {
    kind: 'grant',
    body: {},
    handle: `${nonce}:draft`,
    title: `TEST ${nonce} future vote`,
    bodyMd: 'TEST proposal that opens later.',
    opensAt: new Date(now + 30 * DAY).toISOString(),
    closesAt: new Date(now + 37 * DAY).toISOString(),
  });
  expect(drafted.status, JSON.stringify(drafted.body).slice(0, 300)).toBe(200);
  expect(data(opened).status).toBe('open');
  expect(data(drafted).status).toBe('draft');
  // My stake started before either proposal was created.
  const stakes = await me.client.get(`/api/token/trpc/listStakes${trpcInput({ limit: 10 })}`);
  expect(stakes.status, JSON.stringify(stakes.body).slice(0, 300)).toBe(200);
  expect(data(stakes).length).toBeGreaterThan(0);
  for (const s of data(stakes)) expect(Date.parse(s.startedAt)).toBeLessThan(Date.parse(data(opened).createdAt));
  run.reset({ who: me.who, proposer: author.who, nonce, openId: data(opened).id, draftId: data(drafted).id });
});

test(`${J} #1 Opens /token/governance: The space card, follow, filters and an empty state when no proposals`, async ({ page }) => {
  const { nonce } = run.read();
  await openGovernance(page);
  await expect(space(page)).toBeVisible();
  await expect(space(page)).toContainText('IFC token holders');
  await expect(space(page).getByRole('button', { name: 'Follow', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Status' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Kind' })).toBeVisible();
  await expect(search(page)).toBeVisible();
  // No proposal in the space answers this run's empty search: the list says so and draws no rows.
  await search(page).fill(`${nonce}none`);
  await expect(page.getByText('No proposals match these filters')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Proposals', exact: true })).toHaveCount(0);
  expect(await listed(await api(run.read().who), { q: `${nonce}none` })).toEqual([]);
});

test(`${J} #2 Follows the space, twice: The follow persists; the second follow changes nothing`, async ({ page, browser }) => {
  const { who } = run.read();
  const client = await api(who);
  expect((await home(client)).following).toBe(false);
  await openGovernance(page);
  // A second session of mine (another device), opened before the first follow, still offers Follow: pressing it there
  // is the second follow.
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const stale = await other.newPage();
  await openGovernance(stale, who);
  await expect(space(stale).getByRole('button', { name: 'Follow', exact: true })).toBeVisible();

  await space(page).getByRole('button', { name: 'Follow', exact: true }).click();
  await expect(space(page).getByRole('button', { name: 'Following' })).toHaveAttribute('aria-pressed', 'true');
  const first = await home(client);
  expect(first.following).toBe(true);
  await page.reload();
  await expect(space(page).getByRole('button', { name: 'Following' })).toBeVisible();

  const answer = stale.waitForResponse((r) => r.url().includes('/api/token/trpc/followSpace'));
  await space(stale).getByRole('button', { name: 'Follow', exact: true }).click();
  const second = await answer;
  expect(second.status()).toBe(200);
  expect((await second.json()).result.data).toEqual({ spaceId: first.spaceId, following: true });
  await expect(space(stale).getByRole('button', { name: 'Following' })).toBeVisible();
  expect(await home(client)).toEqual(first);
  await other.close();
});

test(`${J} #3 Filters and searches the proposals: Only matches, with dates and counts`, async ({ page }) => {
  const { who, nonce, openId, draftId } = run.read();
  const client = await api(who);
  await openGovernance(page);
  await search(page).fill(nonce);
  const rows = bodyRows(proposals(page));
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId('proposals-count')).toHaveText(/^2 proposals shown/);

  for (const [label, status, id] of [
    ['Open', 'open', openId],
    ['Draft', 'draft', draftId],
  ]) {
    await page.getByRole('combobox', { name: 'Status' }).selectOption({ label });
    const truth = await listed(client, { status, q: nonce });
    expect(truth.map((p) => p.id)).toEqual([id]);
    await expect(rows).toHaveCount(1);
    await expect(page.getByTestId('proposals-count')).toHaveText(/^1 proposals shown/);
    const row = rows.first();
    await expect(row).toHaveAttribute('data-proposal-id', id);
    await expect(row).toContainText(truth[0].title);
    await expect(row).toContainText(label);
    const dates = row.getByTestId('proposal-voting-dates').locator('time');
    await expect(dates.nth(0)).toHaveAttribute('datetime', truth[0].opensAt);
    await expect(dates.nth(1)).toHaveAttribute('datetime', truth[0].closesAt);
    const c = truth[0].counts;
    await expect(row.getByTestId('proposal-votes')).toHaveText(
      `${c.votes} votes · ${c.for} for · ${c.against} against · ${c.abstain} abstain`,
    );
  }
  // The kind filter narrows the same way: the open proposal is a fee parameter, the draft a grant.
  await page.getByRole('combobox', { name: 'Status' }).selectOption({ label: 'All' });
  await page.getByRole('combobox', { name: 'Kind' }).selectOption({ label: 'Grant' });
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toHaveAttribute('data-proposal-id', draftId);
});

test(`${J} #4 Creates a proposal below the proposer rule: The panel says why before submit; submit is refused with the typed code; a blank rule gives its own code`, async ({
  page,
}) => {
  const { who, nonce } = run.read();
  const client = await api(who);
  const access = (await home(client)).proposal;
  expect(access).toEqual({ code: 'token.proposal_not_allowed', minStake: '1000' });
  await openGovernance(page);
  await page.getByRole('button', { name: 'New proposal' }).click();
  const form = page.getByRole('form', { name: 'New proposal' });
  await expect(form.getByRole('note')).toHaveText(
    `You need at least ${access.minStake} staked to propose. Your stake is below the proposer rule.`,
  );
  const title = `TEST ${nonce} below the rule`;
  await form.getByLabel('Kind').selectOption({ label: 'Grant' });
  await form.getByRole('textbox', { name: 'Title' }).fill(title);
  const answer = page.waitForResponse((r) => r.url().includes('/api/token/trpc/createProposal'));
  await form.getByRole('button', { name: 'Submit proposal' }).click();
  const refused = await answer;
  expect(refused.status()).toBe(403);
  expect(causeOf(await refused.json())).toEqual({ code: 'token.proposal_not_allowed' });
  await expect(form.getByRole('alert')).toHaveText('Refused: your stake is below the proposer rule. Nothing was saved.');
  expect(await listed(client, { q: title })).toEqual([]);
  // A blank rule gives its own code: the token lane restarts with the rule unset, and the same account's submit is refused
  // with token.proposer_rule_unset, not the stake refusal. Nothing is written. The TEST rule is back afterwards.
  const blankTitle = `TEST ${nonce} blank rule`;
  const before = await listed(client, { q: nonce });
  try {
    proposerRule(false);
    expect((await home(client)).proposal).toEqual({ code: 'token.proposer_rule_unset', minStake: null });
    await page.reload();
    await page.getByRole('button', { name: 'New proposal' }).click();
    await expect(form.getByRole('note')).toHaveText('The proposer rule is not set, so the token service refuses every new proposal.');
    await form.getByLabel('Kind').selectOption({ label: 'Grant' });
    await form.getByRole('textbox', { name: 'Title' }).fill(blankTitle);
    const blankAnswer = page.waitForResponse((r) => r.url().includes('/api/token/trpc/createProposal'));
    await form.getByRole('button', { name: 'Submit proposal' }).click();
    const blank = await blankAnswer;
    expect(blank.status()).toBe(412);
    expect(causeOf(await blank.json())).toEqual({ code: 'token.proposer_rule_unset' });
    await expect(form.getByRole('alert')).toHaveText('Refused: the proposer rule is not set. Nothing was saved.');
    expect(await listed(client, { q: nonce })).toEqual(before);
  } finally {
    proposerRule(true);
  }
  expect((await home(client)).proposal).toEqual(access);
});

test(`${J} #5 Creates a proposal with a future opening time: It stays draft and can be edited before voting`, async ({ page }) => {
  const { proposer, nonce } = run.read();
  const client = await api(proposer);
  await openGovernance(page, proposer);
  await page.getByRole('button', { name: 'New proposal' }).click();
  const form = page.getByRole('form', { name: 'New proposal' });
  await expect(form.getByRole('note')).toHaveText('You can open a proposal.');
  const title = `TEST ${nonce} later by form`;
  await form.getByLabel('Kind').selectOption({ label: 'Curriculum' });
  await form.getByRole('textbox', { name: 'Title' }).fill(title);
  await form.getByLabel('Voting opens').fill(localIn(3 * DAY));
  await form.getByLabel('Voting closes').fill(localIn(10 * DAY));
  await form.getByRole('button', { name: 'Submit proposal' }).click();
  await expect(form.getByRole('status')).toHaveText('Proposal saved.');
  const [created] = await listed(client, { q: title });
  expect(created).toMatchObject({ title, status: 'draft', revision: 1 });
  expect(Date.parse(created.opensAt)).toBeGreaterThan(Date.now());

  await search(page).fill(title);
  const row = proposals(page).getByRole('row', { name: new RegExp(title) });
  await expect(row).toContainText('Draft');
  await row.getByRole('button', { name: 'Edit' }).click();
  const edit = page.getByRole('form', { name: 'Edit proposal' });
  await edit.getByRole('textbox', { name: 'Title' }).fill(`${title} edited`);
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit.getByRole('status')).toHaveText('Changes saved.');
  const read = await client.get(`/api/token/trpc/getProposal${trpcInput({ proposalId: created.id })}`);
  expect(read.status).toBe(200);
  expect(data(read)).toMatchObject({ id: created.id, title: `${title} edited`, status: 'draft', revision: 2 });
});

test(`${J} #6 Opens a proposal and reads my voting power: Power fixed when the proposal was created; if I staked later it is zero and says so; history of power over time`, async ({
  page,
}) => {
  await openGovernance(page);
  await search(page).fill(run.read().nonce);
  await proposals(page)
    .getByRole('button', { name: /^Inspect proposal/ })
    .first()
    .click();
  const power = page.getByRole('region', { name: 'Your voting power' });
  await expect(power).toBeVisible(UNBUILT);
  await expect(power).toContainText(/Fixed at block \d+|Fixed on /);
  await expect(tableIn(power, 'Voting power over time')).toBeVisible();
});

test(`${J} #7 Casts a vote on an approval, weighted or ranked ballot: A ballot with bad weights is refused; the vote needs a signed message and a validation rule; if the wallet link is absent the typed unavailable reply shows`, async ({
  page,
}) => {
  await openGovernance(page);
  await search(page).fill(run.read().nonce);
  await proposals(page)
    .getByRole('button', { name: /^Inspect proposal/ })
    .first()
    .click();
  await page.getByRole('radio', { name: 'Weighted' }).click(UNBUILT);
  await page.getByRole('button', { name: /^Vote/ }).click();
  const ballot = page.getByRole('dialog');
  await ballot.getByRole('spinbutton').first().fill('150');
  await ballot.getByRole('button', { name: /^Cast/ }).click();
  await expect(ballot.getByRole('alert')).toContainText(/weights must add up to 100/i);
  await expect(ballot).toContainText(/signed message/i);
});

test(`${J} #8 Presses Delegate: The refusal naming the Protocol blocker; no row written`, async ({ page }) => {
  const { who, proposer } = run.read();
  const client = await api(who);
  const target = (await api(proposer)).userId;
  await openGovernance(page);
  const panel = page.getByRole('region', { name: 'Delegation' });
  await expect(panel.getByTestId('delegation-state')).toContainText('Delegation waits for the INTACHAIN launch');
  await panel.getByLabel('Delegate to (account id)').fill(target);
  const answer = page.waitForResponse((r) => r.url().includes('/api/token/trpc/delegate'));
  await panel.getByRole('button', { name: 'Delegate' }).click();
  const refused = await answer;
  expect(refused.status()).toBe(412);
  expect(causeOf(await refused.json())).toEqual({ code: 'token.delegation_unavailable', blocker: 'no_chain_service' });
  await expect(panel.getByRole('alert')).toHaveText(
    'Delegation waits for the INTACHAIN launch: the platform runs no chain service and no on-chain delegate registry. Nothing was saved.',
  );
  const after = await client.get('/api/token/trpc/delegation');
  expect(after.status).toBe(200);
  expect(data(after)).toEqual({ delegateeUserId: null, blocker: 'no_chain_service' });
});

test(`${J} #9 Opens the treasury panel: Each figure equals the token service read; missing figures say "not reported"; "none recorded" for burns, not zero`, async ({
  page,
}) => {
  const client = await api(run.read().who);
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  const treasuryRead = async () => {
    const res = await client.get('/api/token/trpc/treasury');
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return data(res);
  };
  // A TEST treasury through the ledger: the labelled TEST emission settings, then one epoch minted through the job door.
  tool('local-test-stack.mjs', 'token-params');
  const before = await treasuryRead();
  const engineBefore = await ledgerBalance(ctx, 'rewards-engine');
  await page.waitForTimeout(1_100); // the stack's TEST epoch is one second long
  const mint = await mintTestEpoch(ctx);
  expect(units(mint.minted) > 0n, `minted ${mint.minted}`).toBe(true);
  expect(units(await ledgerBalance(ctx, 'rewards-engine')) - units(engineBefore)).toBe(units(mint.minted));

  await openGovernance(page);
  const treasury = page.getByRole('region', { name: 'Treasury' });
  const view = await treasuryRead();
  // Minted: the service's figure grew by exactly what the ledger credited.
  expect(units(view.minted) - units(before.minted ?? '0')).toBe(units(mint.minted));
  await expect(treasury.getByTestId('treasury-minted')).toHaveText(view.minted);
  // Burned is the ledger's burn account, and nothing on this stack burns IFC: zero reads "none recorded", never "0".
  expect(view.burned).toBe(await ledgerBalance(ctx, 'burn'));
  expect(units(view.burned)).toBe(0n);
  await expect(treasury.getByTestId('treasury-burns')).toHaveText('none recorded');
  // Missing figures: no buyback has settled and no yield was paid on this stack, so the service reports none.
  expect(view).toMatchObject({ bought: null, toRewards: null, distributed: null, lastBuyback: null });
  for (const id of ['treasury-bought', 'treasury-to-rewards', 'treasury-distributed', 'treasury-last-buyback']) {
    await expect(treasury.getByTestId(id)).toHaveText('not reported');
  }
});
