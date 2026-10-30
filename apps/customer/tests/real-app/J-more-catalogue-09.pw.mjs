import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { api, fund, journeyState, tool } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { tableIn, bodyRows } from './tables.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { privateKeyToAccount } from 'viem/accounts';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';

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
// Step 6 reads voting power fixed when each proposal was created, through a second TEST account that stakes only
// afterwards, and creates the approval, weighted and ranked proposals step 7 votes on. Step 7's "a validation rule"
// restarts the token lane with who may vote unset (LOCAL_STACK_TOKEN_VOTE_RULE=off), reads the refusal, then restarts it
// with the TEST rule (power:0). Every vote is signed: a TEST browser wallet signs the token service's message for the
// ballot and identity checks the signer, first with no wallet linked (the typed unavailable reply), then after the wallet
// is linked through Security.
const J = 'J-more-catalogue-09';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
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

/** Restarts the token lane with one TEST rule on, or with it unset (`off`), as identity's restarts do (J-identity-08). */
function restartTokenWith(variable, on) {
  const before = process.env[variable];
  if (on) delete process.env[variable];
  else process.env[variable] = 'off';
  try {
    tool('local-test-stack.mjs', 'restart', 'token');
  } finally {
    if (before === undefined) delete process.env[variable];
    else process.env[variable] = before;
  }
}
const proposerRule = (on) => restartTokenWith('LOCAL_STACK_TOKEN_PROPOSER_RULE', on);
const voteRule = (on) => restartTokenWith('LOCAL_STACK_TOKEN_VOTE_RULE', on);

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
  const { who, nonce } = run.read();
  const client = await api(who);
  // The space card draws what the token service's governance read says: not followed yet, so the press is Follow.
  const read = await home(client);
  expect(read).toMatchObject({ spaceId: expect.any(String), following: false });
  await openGovernance(page);
  await expect(space(page)).toBeVisible();
  await expect(space(page)).toContainText('IFC token holders');
  const follow = space(page).getByRole('button', { name: 'Follow', exact: true });
  await expect(follow).toBeVisible();
  await expect(follow).toHaveAttribute('aria-pressed', String(read.following));
  await expect(page.getByRole('combobox', { name: 'Status' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Kind' })).toBeVisible();
  await expect(search(page)).toBeVisible();
  // The space starts with proposals (this journey's start state), so the list draws rows that equal the service read.
  await search(page).fill(nonce);
  await expect(bodyRows(proposals(page))).toHaveCount((await listed(client, { q: nonce })).length);
  // When no proposal answers, the list says so and draws no rows; the service read is empty too.
  await search(page).fill(`${nonce}none`);
  await expect(page.getByText('No proposals match these filters')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Proposals', exact: true })).toHaveCount(0);
  expect(await listed(client, { q: `${nonce}none` })).toEqual([]);
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
  browser,
}) => {
  const { who, proposer, nonce, openId } = run.read();
  const client = await api(who);
  const author = await api(proposer);
  const powerOf = async (c, proposalId) => {
    const res = await c.get(`/api/token/trpc/votingPower.ofProposal${trpcInput({ proposalId })}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return data(res);
  };
  const opened = await client.get(`/api/token/trpc/getProposal${trpcInput({ proposalId: openId })}`);
  expect(opened.status).toBe(200);

  // Power fixed when the proposal was created: I staked 100 before it, then stake 50 more now. The power stays 100.
  const more = await client.post('/api/token/trpc/stake', { amount: '50', tier: 'flex', stakeId: randomUUID() });
  expect(more.status, JSON.stringify(more.body).slice(0, 300)).toBe(200);
  const mine = await powerOf(client, openId);
  expect(mine).toMatchObject({ proposalId: openId, power: '100', reason: null, takenAt: data(opened).createdAt });

  await openGovernance(page);
  await search(page).fill(nonce);
  await proposals(page)
    .getByRole('row', { name: new RegExp(`TEST ${nonce} open vote`) })
    .getByRole('button', { name: /^Inspect proposal/ })
    .click();
  const power = page.getByRole('region', { name: 'Your voting power' });
  await expect(power).toContainText('Voting power on this proposal100');
  const fixed = new Date(mine.takenAt).toISOString().replace('T', ' · ').replace('Z', ' UTC');
  await expect(power.getByTestId('voting-power-basis')).toHaveText(
    `Fixed on ${fixed}, when the proposal was created. Stake you add or remove later does not change it.`,
  );

  // If I staked later it is zero and says so: a second TEST account stakes only after the proposal exists.
  const laterPage = await browser.newPage();
  try {
    const later = await staker(laterPage, 'gvl', '60', '50');
    const none = await powerOf(later.client, openId);
    expect(none).toMatchObject({ proposalId: openId, power: '0', reason: 'no_stake_at_creation', takenAt: null });
    await openGovernance(laterPage, later.who);
    await search(laterPage).fill(nonce);
    await proposals(laterPage)
      .getByRole('row', { name: new RegExp(`TEST ${nonce} open vote`) })
      .getByRole('button', { name: /^Inspect proposal/ })
      .click();
    const zero = laterPage.getByRole('region', { name: 'Your voting power' });
    await expect(zero).toContainText('Voting power on this proposal0');
    await expect(zero.getByTestId('voting-power-basis')).toHaveText(
      'Zero: you had no active stake when this proposal was created. Stake added later does not count on it.',
    );
  } finally {
    await laterPage.close();
  }

  // History of power over time: the multi-choice proposals of step 7 are created now, after my extra 50, so they fix 150.
  const made = {};
  for (const [type, choices] of [
    ['approval', ['TEST red', 'TEST green', 'TEST blue']],
    ['weighted', ['TEST alpha', 'TEST beta']],
    ['ranked_choice', ['TEST first', 'TEST second', 'TEST third']],
  ]) {
    const res = await author.post('/api/token/trpc/createProposal', {
      kind: 'fee_param',
      body: {},
      handle: `${nonce}:${type}`,
      title: `TEST ${nonce} ${type} ballot`,
      bodyMd: 'TEST multi-choice proposal for the governance journey.',
      votingType: type,
      choices,
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    expect(data(res)).toMatchObject({ votingType: type, choices, status: 'open' });
    made[type] = data(res).id;
    expect(await powerOf(client, made[type])).toMatchObject({ power: '150', reason: null });
  }
  run.write({ ballots: made });

  const history = await client.get(`/api/token/trpc/votingPower.history${trpcInput({ limit: 20 })}`);
  expect(history.status).toBe(200);
  const rows = data(history);
  const byId = Object.fromEntries(rows.map((row) => [row.proposalId, row.power]));
  expect(byId[openId]).toBe('100');
  for (const id of Object.values(made)) expect(byId[id]).toBe('150');
  for (let i = 1; i < rows.length; i++) expect(Date.parse(rows[i - 1].takenAt)).toBeGreaterThanOrEqual(Date.parse(rows[i].takenAt));

  await page.getByRole('button', { name: 'Refresh original proposal' }).click();
  const table = tableIn(power, 'Voting power over time');
  await expect(bodyRows(table)).toHaveCount(rows.length);
  for (const [i, row] of rows.entries()) {
    const at = new Date(row.takenAt).toISOString().replace('T', ' · ').replace('Z', ' UTC');
    await expect(bodyRows(table).nth(i)).toHaveText(`${row.title ?? 'Untitled proposal'}${at}${row.power}`);
  }

  // A history read with no page size is refused with its own code, never a default page.
  const blank = await client.get(`/api/token/trpc/votingPower.history${trpcInput({})}`);
  expect(blank.status).toBe(412);
  expect(causeOf(blank.body)).toEqual({ code: 'token.history_list_limit_unset' });
});

test(`${J} #7 Casts a vote on an approval, weighted or ranked ballot: A ballot with bad weights is refused; the vote needs a signed message and a validation rule; if the wallet link is absent the typed unavailable reply shows`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { who, nonce, ballots } = run.read();
  // A TEST wallet stands in for the person's own (test-wallet.mjs), and a virtual passkey confirms linking it. Nothing
  // reaches a chain. Passkeys belong to the relying party `localhost`, so this page runs on PASSKEY_ORIGIN.
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  const walletKey = testWalletKey();
  const wallet = await installTestWallet(page, { chainId: 1, privateKey: walletKey });
  const client = await api(who);
  const detail = async (proposalId) => {
    const res = await client.get(`/api/token/trpc/getProposal${trpcInput({ proposalId })}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return data(res);
  };
  const messageFor = async (vote) => {
    const res = await client.get(`/api/token/trpc/voteMessage${trpcInput(vote)}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return data(res).message;
  };
  const openBallot = async (type) => {
    await openGovernance(page);
    await search(page).fill(nonce);
    await proposals(page)
      .getByRole('row', { name: new RegExp(`TEST ${nonce} ${type} ballot`) })
      .getByRole('button', { name: /^Inspect proposal/ })
      .click();
    return page.getByRole('form', { name: 'Your ballot' });
  };
  const castFrom = async (form) => {
    const answer = page.waitForResponse((r) => r.url().includes('/api/token/trpc/castVote'));
    await form.getByRole('button', { name: 'Sign with wallet and cast' }).click();
    const res = await answer;
    return { status: res.status(), body: await res.json(), sent: res.request().postDataJSON() };
  };
  const split = (alpha, beta) => ({
    kind: 'split',
    parts: [
      { choice: 0, bps: alpha * 100 },
      { choice: 1, bps: beta * 100 },
    ],
  });
  const signs = () => wallet.requests.filter((request) => request.method === 'personal_sign').length;

  // The vote needs a signed message: the token service says every vote is signed and that it can check one.
  const power = await client.get(`/api/token/trpc/votingPower.ofProposal${trpcInput({ proposalId: ballots.weighted })}`);
  expect(power.status).toBe(200);
  expect(data(power).signing).toEqual({ required: true, available: true, code: null });

  // A vote with no signature is refused with its own code, and no vote row is written.
  const unsigned = await client.post('/api/token/trpc/castVote', { proposalId: ballots.weighted, ballot: split(60, 40) });
  expect(unsigned.status).toBe(400);
  expect(causeOf(unsigned.body)).toEqual({ code: 'token.vote_signature_required' });
  expect((await detail(ballots.weighted)).choiceTally).toMatchObject({ voterCount: 0, totals: ['0', '0'] });

  // If the wallet link is absent the typed unavailable reply shows: my wallet signs the service's message for this
  // ballot, but no wallet is linked to my account, so the vote is refused with token.signed_vote_unavailable.
  let ballot = await openBallot('weighted');
  await ballot.getByLabel('Weight for TEST alpha (%)').fill('60');
  await ballot.getByLabel('Weight for TEST beta (%)').fill('40');
  await expect(ballot.getByTestId('ballot-sum')).toHaveText('Your weights add up to 100.');
  const absent = await castFrom(ballot);
  expect(signs()).toBe(1);
  expect(absent.sent).toEqual({
    proposalId: ballots.weighted,
    ballot: split(60, 40),
    signature: expect.stringMatching(/^0x[0-9a-f]{130}$/),
  });
  expect(absent.status).toBe(412);
  expect(causeOf(absent.body)).toEqual({ code: 'token.signed_vote_unavailable' });
  await expect(ballot.getByRole('alert')).toHaveText(
    'Refused: signed votes are unavailable: no wallet is linked to your account, or it cannot be checked. Nothing was saved.',
  );
  // The message signed names this proposal, me and this ballot, and is the service's own text for it.
  const message = await messageFor({ proposalId: ballots.weighted, ballot: split(60, 40) });
  await expect(ballot.getByRole('region', { name: 'Message to sign' }).locator('pre')).toHaveText(message);
  expect(JSON.parse(message)).toEqual({
    purpose: 'INTAFACED governance vote',
    origin: 'svc-token',
    proposalId: ballots.weighted,
    userId: client.userId,
    ballot: split(60, 40),
  });
  expect((await detail(ballots.weighted)).choiceTally).toMatchObject({ voterCount: 0, totals: ['0', '0'] });

  // I link this wallet through Security: its own signature, then a confirmation with my passkey.
  await addPasskey(page);
  const methods = page.getByTestId('security__signin-methods');
  const walletsRow = methods.getByRole('listitem', { name: 'Wallets', exact: true });
  await walletsRow.getByRole('button', { name: 'Link a wallet' }).click();
  await methods.getByRole('form', { name: 'Confirm it is you' }).getByRole('button', { name: 'Confirm with a passkey' }).click();
  await expect(walletsRow.getByTitle(wallet.address)).toBeVisible();
  run.write({ walletKey });

  // A ballot with bad weights is refused: 60 and 50 add up to 110, the panel says so, and the service refuses it.
  ballot = await openBallot('weighted');
  await ballot.getByLabel('Weight for TEST alpha (%)').fill('60');
  await ballot.getByLabel('Weight for TEST beta (%)').fill('50');
  await expect(ballot.getByTestId('ballot-sum')).toHaveText(
    'Your weights add up to 110. The weights must add up to 100, or the service refuses the ballot.',
  );
  const bad = await castFrom(ballot);
  expect(bad.sent.ballot).toEqual(split(60, 50));
  expect(bad.status).toBe(400);
  expect(causeOf(bad.body)).toEqual({ code: 'token.ballot_invalid' });
  await expect(ballot.getByRole('alert')).toHaveText('Refused: the ballot does not fit this proposal. Nothing was saved.');
  expect((await detail(ballots.weighted)).choiceTally).toMatchObject({ voterCount: 0, totals: ['0', '0'] });

  // The vote needs a validation rule: with who may vote unset, the panel says so and the cast is refused with its code.
  voteRule(false);
  try {
    ballot = await openBallot('weighted');
    await expect(page.getByRole('region', { name: 'Your voting power' })).toContainText(
      'Who may voteWho may vote is not set, so the token service refuses every vote.',
    );
    await ballot.getByLabel('Weight for TEST alpha (%)').fill('60');
    await ballot.getByLabel('Weight for TEST beta (%)').fill('40');
    const unset = await castFrom(ballot);
    expect(unset.status).toBe(412);
    expect(causeOf(unset.body)).toEqual({ code: 'token.vote_rule_unset' });
    await expect(ballot.getByRole('alert')).toHaveText('Refused: who may vote is not set. Nothing was saved.');
    expect((await detail(ballots.weighted)).choiceTally).toMatchObject({ voterCount: 0 });
  } finally {
    voteRule(true);
  }

  // With the TEST rule (power:0) the same ballot is recorded at the power fixed when the proposal was created.
  ballot = await openBallot('weighted');
  await expect(page.getByRole('region', { name: 'Your voting power' })).toContainText(
    'Who may voteAccounts with at least 0 voting power on the proposal.',
  );
  await ballot.getByLabel('Weight for TEST alpha (%)').fill('60');
  await ballot.getByLabel('Weight for TEST beta (%)').fill('40');
  const weighted = await castFrom(ballot);
  expect(weighted.status, JSON.stringify(weighted.body).slice(0, 300)).toBe(200);
  expect(weighted.body.result.data).toMatchObject({ weight: '150', choice: null, signedBy: wallet.address });
  await expect(ballot.getByRole('status').filter({ hasText: 'Ballot recorded' })).toHaveText('Ballot recorded with 150 voting power.');
  expect((await detail(ballots.weighted)).choiceTally).toMatchObject({ voterCount: 1, totals: ['90', '60'], ranking: [0, 1] });

  // Approval: I approve two of three choices; each gets my whole power.
  ballot = await openBallot('approval');
  await ballot.getByRole('checkbox', { name: 'TEST red' }).check();
  await ballot.getByRole('checkbox', { name: 'TEST blue' }).check();
  const approval = await castFrom(ballot);
  expect(approval.status, JSON.stringify(approval.body).slice(0, 300)).toBe(200);
  expect(approval.body.result.data).toMatchObject({ weight: '150', ballot: { kind: 'pick', choices: [0, 2] }, signedBy: wallet.address });
  expect((await detail(ballots.approval)).choiceTally).toMatchObject({ voterCount: 1, totals: ['150', '0', '150'] });

  // Ranked: second first, then third; the first round counts my power for my first preference.
  ballot = await openBallot('ranked_choice');
  await ballot.getByLabel('Rank for TEST second').fill('1');
  await ballot.getByLabel('Rank for TEST third').fill('2');
  const ranked = await castFrom(ballot);
  expect(ranked.status, JSON.stringify(ranked.body).slice(0, 300)).toBe(200);
  expect(ranked.body.result.data).toMatchObject({ weight: '150', ballot: { kind: 'pick', choices: [1, 2] }, signedBy: wallet.address });
  const rankedTally = (await detail(ballots.ranked_choice)).choiceTally;
  expect(rankedTally).toMatchObject({ voterCount: 1, totals: ['0', '150', '0'] });
  expect(rankedTally.rounds[0]).toEqual(['0', '150', '0']);
  expect(rankedTally.ranking).toEqual([1, 0, 2]);
  const tally = page.getByRole('region', { name: 'Choice tally', exact: true }).first();
  const rows = bodyRows(tableIn(tally, 'Choice tally'));
  await expect(rows).toHaveText(['TEST first02', 'TEST second1501', 'TEST third03']);
  await expect(tally).toContainText('Voters1');
  await expect(tally).toContainText('Instant-runoff rounds: 1');
});

test(`${J} #8 Presses Delegate: The refusal naming the Protocol blocker; no row written`, async ({ page }) => {
  const { who, proposer, openId } = run.read();
  const client = await api(who);
  const delegatee = await api(proposer);
  const target = delegatee.userId;
  // What a delegation would change: each side's voting power on a proposal, and each side's power history.
  const state = async () => {
    const read = async (c, path, input) => {
      const res = await c.get(`/api/token/trpc/${path}${trpcInput(input)}`);
      expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
      return data(res);
    };
    return {
      mine: await read(client, 'votingPower.ofProposal', { proposalId: openId }),
      theirs: await read(delegatee, 'votingPower.ofProposal', { proposalId: openId }),
      myHistory: await read(client, 'votingPower.history', { limit: 50 }),
      theirHistory: await read(delegatee, 'votingPower.history', { limit: 50 }),
    };
  };
  const before = await state();
  expect(before.mine.power).toBe('100');
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
  expect(await state()).toEqual(before);
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
  run.write({ treasury: view });
});

test(`${J} ends: my vote is recorded once with its power fixed at proposal creation; delegation shows its blocker and the treasury view shows only what the token service reports`, async ({
  browser,
}) => {
  // The re-cast, two concurrent casts, the delegation refusal and the treasury reconcile run in one test.
  test.setTimeout(180_000);
  const { who, proposer, nonce, openId, ballots, walletKey, treasury: treasuryAt9 } = run.read();
  if (!walletKey || !ballots) throw new Error(`${J} #7 linked no wallet, so the end has no signed vote to cast`);
  if (!treasuryAt9) throw new Error(`${J} #9 recorded no treasury read, so the end has nothing to reconcile`);
  const client = await api(who);
  const account = privateKeyToAccount(walletKey);
  const read = async (path, input) => {
    const res = await client.get(`/api/token/trpc/${path}${input === undefined ? '' : trpcInput(input)}`);
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
    return data(res);
  };
  // A vote signed by my linked TEST wallet over the service's own message for it.
  const signedCast = async (vote) => {
    const { message } = await read('voteMessage', vote);
    const signature = await account.signMessage({ message });
    return client.post('/api/token/trpc/castVote', { ...vote, signature });
  };

  // Power fixed at proposal creation: on the open proposal it is the 100 I had staked when it was created, though
  // 150 is staked now.
  const proposal = await read('getProposal', { proposalId: openId });
  const power = await read('votingPower.ofProposal', { proposalId: openId });
  expect(power).toMatchObject({ power: '100', reason: null, takenAt: proposal.createdAt });
  const stakes = await read('listStakes', { limit: 10 });
  expect(stakes.reduce((sum, s) => sum + units(s.amount), 0n)).toBe(units('150'));
  expect(proposal.tally).toMatchObject({ voterCount: 0, totalWeight: '0' });

  // Recorded once: the same signed vote sent twice at once is recorded once, at that fixed power; the other is refused.
  const vote = { proposalId: openId, choice: 'for' };
  const both = await Promise.all([signedCast(vote), signedCast(vote)]);
  const recorded = both.filter((r) => r.status === 200);
  const refused = both.filter((r) => r.status !== 200);
  expect(recorded, JSON.stringify(both.map((r) => r.body)).slice(0, 600)).toHaveLength(1);
  expect(recorded[0].body.result.data).toMatchObject({
    proposalId: openId,
    weight: '100',
    choice: 'for',
    signedBy: account.address.toLowerCase(),
  });
  expect(refused).toHaveLength(1);
  expect(refused[0].status).toBe(403);
  expect(causeOf(refused[0].body)).toEqual({ code: 'token.already_voted' });
  const once = (await read('getProposal', { proposalId: openId })).tally;
  expect(once).toEqual({ forWeight: '100', againstWeight: '0', abstainWeight: '0', totalWeight: '100', voterCount: 1 });
  // A second vote with another choice is refused too, and the tally is unchanged.
  const changed = await signedCast({ proposalId: openId, choice: 'against' });
  expect(changed.status).toBe(403);
  expect(causeOf(changed.body)).toEqual({ code: 'token.already_voted' });
  expect((await read('getProposal', { proposalId: openId })).tally).toEqual(once);

  // In the app: the open proposal shows my one vote, and my power on it is the 100 fixed at its creation, not the
  // 150 staked now.
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await installTestWallet(page, { chainId: 1, privateKey: walletKey });
  const counts = (await read('getProposal', { proposalId: openId })).counts;
  expect(counts).toEqual({ votes: 1, for: 1, against: 0, abstain: 0 });
  await openGovernance(page);
  await search(page).fill(nonce);
  const openRow = proposals(page).getByRole('row', { name: new RegExp(`TEST ${nonce} open vote`) });
  await expect(openRow.getByTestId('proposal-votes')).toHaveText('1 votes · 1 for · 0 against · 0 abstain');
  await openRow.getByRole('button', { name: /^Inspect proposal/ }).click();
  const powerPanel = page.getByRole('region', { name: 'Your voting power' });
  // Not followed by a digit, so 1000 cannot pass for 100.
  await expect(powerPanel).toContainText(/Voting power on this proposal100(?!\d)/);
  const fixed = new Date(power.takenAt).toISOString().replace('T', ' · ').replace('Z', ' UTC');
  await expect(powerPanel.getByTestId('voting-power-basis')).toHaveText(
    `Fixed on ${fixed}, when the proposal was created. Stake you add or remove later does not change it.`,
  );

  // In the app: casting my weighted ballot from #7 again is refused, and the tally still counts my one vote at 150,
  // the power fixed when that proposal was created.
  const weightedBefore = (await read('getProposal', { proposalId: ballots.weighted })).choiceTally;
  expect(weightedBefore).toMatchObject({ voterCount: 1, totals: ['90', '60'] });
  expect(await read('votingPower.ofProposal', { proposalId: ballots.weighted })).toMatchObject({ power: '150' });
  await openGovernance(page);
  await search(page).fill(nonce);
  await proposals(page)
    .getByRole('row', { name: new RegExp(`TEST ${nonce} weighted ballot`) })
    .getByRole('button', { name: /^Inspect proposal/ })
    .click();
  const ballot = page.getByRole('form', { name: 'Your ballot' });
  await ballot.getByLabel('Weight for TEST alpha (%)').fill('50');
  await ballot.getByLabel('Weight for TEST beta (%)').fill('50');
  const answer = page.waitForResponse((r) => r.url().includes('/api/token/trpc/castVote'));
  await ballot.getByRole('button', { name: 'Sign with wallet and cast' }).click();
  const again = await answer;
  expect(again.status()).toBe(403);
  expect(causeOf(await again.json())).toEqual({ code: 'token.already_voted' });
  await expect(ballot.getByRole('alert')).toHaveText('Refused: you already voted on this proposal. Nothing was changed.');
  expect((await read('getProposal', { proposalId: ballots.weighted })).choiceTally).toEqual(weightedBefore);
  const tally = page.getByRole('region', { name: 'Choice tally', exact: true }).first();
  await expect(bodyRows(tableIn(tally, 'Choice tally'))).toHaveText(['TEST alpha901', 'TEST beta602']);
  await expect(tally).toContainText('Voters1');

  // Delegation shows its blocker: the service's answer, the panel's full words for it, and a press refused by its
  // code with nothing changed.
  const blockerWords = 'Delegation waits for the INTACHAIN launch: the platform runs no chain service and no on-chain delegate registry.';
  const delegationState = async () => ({
    delegation: await read('delegation'),
    power: await read('votingPower.ofProposal', { proposalId: openId }),
    history: await read('votingPower.history', { limit: 50 }),
  });
  const beforeDelegate = await delegationState();
  expect(beforeDelegate.delegation).toEqual({ delegateeUserId: null, blocker: 'no_chain_service' });
  await openGovernance(page);
  const delegationPanel = page.getByRole('region', { name: 'Delegation' });
  await expect(delegationPanel.getByTestId('delegation-state')).toHaveText(`You have no delegate. ${blockerWords}`);
  await delegationPanel.getByLabel('Delegate to (account id)').fill((await api(proposer)).userId);
  const delegated = page.waitForResponse((r) => r.url().includes('/api/token/trpc/delegate'));
  await delegationPanel.getByRole('button', { name: 'Delegate' }).click();
  const delegateAnswer = await delegated;
  expect(delegateAnswer.status()).toBe(412);
  expect(causeOf(await delegateAnswer.json())).toEqual({ code: 'token.delegation_unavailable', blocker: 'no_chain_service' });
  await expect(delegationPanel.getByRole('alert')).toHaveText(`${blockerWords} Nothing was saved.`);
  expect(await delegationState()).toEqual(beforeDelegate);

  // The treasury view shows only what the token service reports: exactly its six figures, each once. Minted is the
  // figure #9 reconciled with the ledger's mint, burns are the ledger's burn account, and each missing one says
  // "not reported".
  const view = await read('treasury');
  expect(view).toEqual(treasuryAt9);
  expect(view.minted).not.toBeNull();
  expect(view).toMatchObject({ bought: null, toRewards: null, distributed: null, lastBuyback: null });
  const gates = await import('../../../../tooling/scripts/local-test-gates.mjs');
  const ctx = await gates.makeContext({ log: () => {} });
  expect(view.burned).toBe(await ledgerBalance(ctx, 'burn'));
  const treasury = page.getByRole('region', { name: 'Treasury' });
  const shown = await treasury.locator('[data-testid^="treasury-"]').evaluateAll((els) => els.map((el) => el.dataset.testid));
  expect(shown.sort()).toEqual(
    ['treasury-bought', 'treasury-burns', 'treasury-distributed', 'treasury-last-buyback', 'treasury-minted', 'treasury-to-rewards'].sort(),
  );
  await expect(treasury.getByTestId('treasury-minted')).toHaveText(view.minted);
  await expect(treasury.getByTestId('treasury-burns')).toHaveText(units(view.burned) === 0n ? 'none recorded' : view.burned);
  for (const id of ['treasury-bought', 'treasury-to-rewards', 'treasury-distributed', 'treasury-last-buyback']) {
    await expect(treasury.getByTestId(id)).toHaveText('not reported');
  }
});
