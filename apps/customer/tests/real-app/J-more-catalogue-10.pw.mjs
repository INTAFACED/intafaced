import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { ADMIN, assertAdminUp, founderCode, founderSignIn } from './admin.mjs';
import { api, fund, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { tableIn } from './tables.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';
import { installTestWallet, testWalletKey } from './test-wallet.mjs';

// J-more-catalogue-10, in the running app (docs/roadmap/journeys.json): set governance rules and roles. One test per step,
// titled "J-more-catalogue-10 #<n>", run in order. Founders A and B work the governance panel in the admin app at
// /more-ops/token, each on their own console: A asks, B pastes the packet and approves the same request, A runs it.
// Nothing is written to a table directly. The proposer and the moderator are TEST customer accounts; the proposer stakes
// TEST IFC through the real ledger, above the stack's TEST proposer rule (stake:1000), and signs its vote with a TEST
// wallet linked through Security, as J-more-catalogue-09 #7 does. No value moves.
// The settings are one record for the whole stack. The start reads them and, when an earlier run on this stack left them
// set, clears them through the same two-founder door, so #1 reads them unset.
// A role change also needs the running founder's own fresh step-up: founder A types a fresh authenticator code on the Run
// step, the console spends it at identity for exactly that account, role and revision, and svc-token checks it before the
// two-founder approval is spent (#6).
const J = 'J-more-catalogue-10';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const trpcInput = (input) => `?input=${encodeURIComponent(JSON.stringify(input))}`;
const data = (res) => res.body?.result?.data;
const causeOf = (body) => body?.error?.data?.cause;

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

const desk = (page, heading) => page.getByTestId('control-desk').filter({ hasText: heading });
const SETTINGS = 'Change the voting delay and period';
const ROLE = 'Change a governance role';

async function openPanel(page) {
  await page.goto(`${ADMIN}/more-ops/token`);
  await expect(page.getByRole('heading', { name: 'Token governance', level: 1 })).toBeVisible();
}

/** A asks with the form filled by `fill`; returns A's desk and the packet. */
async function ask(a, { heading, fill, label, phrase }) {
  await openPanel(a);
  await fill(a);
  const deskA = desk(a, heading);
  await deskA.getByLabel(/to confirm$/).fill(phrase);
  await deskA.getByRole('button', { name: label }).click();
  await expect(deskA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return { deskA, packet: (await deskA.getByLabel('Request packet').inputValue()).trim() };
}

/** B pastes the packet, reads `summary` and approves it. */
async function approveAsB(b, { heading, packet, phrase, summary }) {
  await openPanel(b);
  const deskB = desk(b, heading);
  await deskB.getByLabel('Request packet').fill(packet);
  await expect(deskB.getByTestId('packet-summary')).toContainText(summary);
  await deskB.getByLabel(/to approve or run it$/).fill(phrase);
  await deskB.getByRole('button', { name: 'Approve this request' }).click();
  await expect(deskB.getByTestId('step-reply')).toContainText('Approved.', { timeout: 60_000 });
}

/** A runs the approved request, with a fresh step-up code when `stepUp`; returns A's step reply. */
async function runAsA(deskA, phrase, stepUp) {
  await deskA.getByLabel(/to approve or run it$/).fill(phrase);
  if (stepUp) await deskA.getByLabel('Your authenticator code, to run it').fill(await founderCode('a'));
  await deskA.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = deskA.getByTestId('step-reply');
  await expect(reply).toBeVisible({ timeout: 60_000 });
  return reply;
}

/** One two-founder request on the panel: A asks, B reads `summary` and approves, A runs it. Returns A's step reply. */
async function twoFounders({ a, b }, { heading, fill, label, phrase, summary, stepUp = false }) {
  const { deskA, packet } = await ask(a, { heading, fill, label, phrase });
  await approveAsB(b, { heading, packet, phrase, summary });
  return runAsA(deskA, phrase, stepUp);
}

const fillSettings = (delayHours, periodHours) => async (page) => {
  await page.getByRole('textbox', { name: /^Voting delay/ }).fill(delayHours);
  await page.getByRole('textbox', { name: /^Voting period/ }).fill(periodHours);
};

function settingsStep(pages, delayHours, periodHours, summary) {
  return twoFounders(pages, {
    heading: SETTINGS,
    fill: fillSettings(delayHours, periodHours),
    label: 'Ask a second founder to approve these settings',
    phrase: 'GOVERNANCE SETTINGS',
    summary,
  });
}

const roleRequest = (userId, role) => ({
  heading: ROLE,
  fill: async (page) => {
    await page.getByRole('textbox', { name: /^Account id/ }).fill(userId);
    await page.getByRole('combobox', { name: /^Role\b/ }).selectOption(role);
  },
  label: 'Ask a second founder to approve this role change',
  phrase: `ROLE ${userId.slice(0, 8)} ${role.toUpperCase()}`,
  summary: `Give account ${userId} the governance role ${role}`,
});

/** A role change by two founders, run by A with A's fresh step-up. */
function roleStep(pages, userId, role) {
  return twoFounders(pages, { ...roleRequest(userId, role), stepUp: true });
}

/** The founder console's own step call, as the desk sends it, for a step the desk holds back from this founder. */
async function consoleStep(page, packetText, step, confirm) {
  const packet = JSON.parse(Buffer.from(packetText.slice('ifa1.'.length), 'base64url').toString('utf8'));
  return page.evaluate(
    async ({ request, approvalId, step, confirm }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch('/api/more-ops/token-governance', {
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

/** A signed-up, verified TEST account, with `stake` TEST IFC staked through svc-token when given. */
async function member(page, prefix, stake = null) {
  const who = await signUp(page, prefix);
  await verify(page, who);
  const client = await api(who);
  if (stake) {
    expect(fund(who.email, 'IFC', String(Number(stake) + 100)).tx).toBeTruthy();
    const staked = await client.post('/api/token/trpc/stake', { amount: stake, tier: 'flex', stakeId: randomUUID() });
    expect(staked.status, JSON.stringify(staked.body).slice(0, 300)).toBe(200);
  }
  return { who, userId: client.userId };
}

async function getProposal(client, proposalId) {
  const res = await client.get(`/api/token/trpc/getProposal${trpcInput({ proposalId })}`);
  expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(200);
  return data(res);
}

/** The governance room, searched for this run's proposals. */
async function openRoom(page, who, nonce) {
  await signIn(page, who);
  await page.goto('/token/governance');
  await expect(page.getByRole('heading', { name: 'Token governance', level: 1 })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search proposals' }).fill(nonce);
}

async function cancelFromRoom(page, title, reason) {
  const row = tableIn(page, 'Proposals').getByRole('row', { name: new RegExp(title) });
  await row.getByRole('button', { name: `Cancel ${title}` }).click();
  const form = page.getByRole('form', { name: `Cancel ${title}` });
  await expect(form.getByRole('note')).toHaveText(
    'Only a governance moderator, admin or controller can cancel a proposal. Its votes stay, and no vote is taken after it.',
  );
  await form.getByLabel('Reason for cancelling').fill(reason);
  const answer = page.waitForResponse((r) => r.url().includes('/api/token/trpc/governance.cancel'));
  await form.getByRole('button', { name: 'Cancel this proposal' }).click();
  const res = await answer;
  return { form, row, status: res.status(), body: await res.json() };
}

test(`${J} starts: signed in to the admin app at /more-ops/token with step-up done`, async ({ browser }) => {
  test.setTimeout(240_000);
  const pages = await founders(browser);
  await openPanel(pages.a);
  // The settings are one record for the stack: an earlier run's figures are cleared through the founders' own door.
  const delay = pages.a.getByTestId('voting-delay');
  const period = pages.a.getByTestId('voting-period');
  if ((await delay.textContent()) !== 'delay not set' || (await period.textContent()) !== 'period not set') {
    const reply = await settingsStep(pages, '', '', 'Set the governance voting delay to not set and the voting period to not set');
    await expect(reply).toContainText('The governance settings are stored');
    await openPanel(pages.a);
  }
  run.reset({ nonce: `T${Date.now().toString(36)}`, founderA: pages.ida.userId, founderB: pages.idb.userId });
});

test(`${J} #1 Opens the governance panel with nothing set: "delay not set" and "period not set"; a proposal with neither time is refused`, async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { nonce } = started('nonce');
  const { a } = await founders(browser);
  await openPanel(a);
  await expect(a.getByTestId('voting-delay')).toHaveText('delay not set');
  await expect(a.getByTestId('voting-period')).toHaveText('period not set');
  await expect(a.getByRole('note').filter({ hasText: 'token.proposal_window_unset' })).toBeVisible();

  const author = await member(page, 'gva', '1100');
  const client = await api(author.who);
  const title = `TEST ${nonce} no window`;
  const refused = await client.post('/api/token/trpc/createProposal', { kind: 'grant', body: {}, handle: `${nonce}:nowin`, title });
  expect(refused.status, JSON.stringify(refused.body).slice(0, 300)).toBe(412);
  expect(causeOf(refused.body)).toEqual({ code: 'token.proposal_window_unset' });
  // In the governance room the same submit says why, and nothing is stored.
  await openRoom(page, author.who, nonce);
  await page.getByRole('button', { name: 'New proposal' }).click();
  const form = page.getByRole('form', { name: 'New proposal' });
  await form.getByLabel('Kind').selectOption({ label: 'Grant' });
  await form.getByRole('textbox', { name: 'Title' }).fill(title);
  await form.getByRole('button', { name: 'Submit proposal' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'Refused: the governance voting delay or period is not set, so give the opening and closing times. Nothing was saved.',
  );
  const listed = await client.get(`/api/token/trpc/listProposals${trpcInput({ limit: 50, q: nonce })}`);
  expect(data(listed)).toEqual([]);
  run.write({ author: author.who, authorId: author.userId });
});

test(`${J} #2 Writes settings alone: Refused for lack of a second approver`, async ({ browser }) => {
  test.setTimeout(240_000);
  started('nonce');
  const { a } = await founders(browser);
  const { deskA, packet } = await ask(a, {
    heading: SETTINGS,
    fill: fillSettings('0', '24'),
    label: 'Ask a second founder to approve these settings',
    phrase: 'GOVERNANCE SETTINGS',
  });
  // The desk holds approval back from the founder who asked; the approval service refuses the same step sent anyway.
  await deskA.getByLabel(/to approve or run it$/).fill('GOVERNANCE SETTINGS');
  await expect(deskA.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
  const alone = await consoleStep(a, packet, 'approve', 'GOVERNANCE SETTINGS');
  expect(alone.body.ok, JSON.stringify(alone)).toBe(false);
  expect(alone.body.refusal?.code, JSON.stringify(alone)).toBe('action_approval.same_person');
  // Running it with no second approval is refused too, and the settings are still unset.
  await deskA.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(deskA.getByTestId('step-reply')).toHaveAttribute('data-tone', /danger|warn/, { timeout: 60_000 });
  await openPanel(a);
  await expect(a.getByTestId('voting-delay')).toHaveText('delay not set');
  await expect(a.getByTestId('voting-period')).toHaveText('period not set');
});

test(`${J} #3 A distinct second founder confirms: The settings are stored with an audit row`, async ({ browser }) => {
  test.setTimeout(240_000);
  const { founderA, founderB } = started('nonce', 'founderA', 'founderB');
  const pages = await founders(browser);
  // The audit rows already written (the start may have cleared an earlier run's figures), read on the panel itself.
  await openPanel(pages.a);
  const before = await pages.a.getByTestId('settings-move').count();
  const reply = await settingsStep(
    pages,
    '0',
    '24',
    'Set the governance voting delay to 0 hours (no delay) and the voting period to 1 day (24 hours)',
  );
  await expect(reply).toContainText('The governance settings are stored at revision');
  await openPanel(pages.a);
  await expect(pages.a.getByTestId('voting-delay')).toHaveText('0 hours (no delay)');
  await expect(pages.a.getByTestId('voting-period')).toHaveText('1 day (24 hours)');
  const moves = pages.a.getByTestId('settings-move');
  await expect(moves).toHaveCount(before + 1);
  const last = moves.last();
  await expect(last).toContainText('0 hours (no delay)');
  await expect(last).toContainText('1 day (24 hours)');
  await expect(last.locator('td').nth(3)).toHaveText(founderA);
  await expect(last.locator('td').nth(4)).toHaveText(founderB);
});

test(`${J} #4 A moderator cancels an open proposal with a reason: Status cancelled, reason shown, votes kept, further votes refused`, async ({
  browser,
  page,
}) => {
  test.setTimeout(300_000);
  const { nonce, author } = started('nonce', 'author');
  const pages = await founders(browser);
  const moderator = await member(page, 'gvm');
  await expect(await roleStep(pages, moderator.userId, 'moderator')).toContainText(`Account ${moderator.userId} is moderator`);
  await openPanel(pages.a);
  await expect(pages.a.locator(`tr[data-role-user="${moderator.userId}"]`).getByTestId('role')).toHaveText('Moderator');

  // The proposer opens a proposal with no time of its own: the founders' settings open it now for one day.
  const client = await api(author);
  const title = `TEST ${nonce} to cancel`;
  const created = await client.post('/api/token/trpc/createProposal', { kind: 'grant', body: {}, handle: `${nonce}:cancel`, title });
  expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(200);
  const proposal = data(created);
  expect(proposal.status).toBe('open');
  expect(Date.parse(proposal.closesAt) - Date.parse(proposal.opensAt)).toBe(86_400_000);

  // The proposer links a TEST wallet through Security and casts one signed vote.
  const walletPage = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(walletPage);
  const walletKey = testWalletKey();
  const wallet = await installTestWallet(walletPage, { chainId: 1, privateKey: walletKey });
  await signIn(walletPage, author);
  await addPasskey(walletPage);
  const methods = walletPage.getByTestId('security__signin-methods');
  const walletsRow = methods.getByRole('listitem', { name: 'Wallets', exact: true });
  await walletsRow.getByRole('button', { name: 'Link a wallet' }).click();
  await methods.getByRole('form', { name: 'Confirm it is you' }).getByRole('button', { name: 'Confirm with a passkey' }).click();
  await expect(walletsRow.getByTitle(wallet.address)).toBeVisible();
  const account = privateKeyToAccount(walletKey);
  const signedCast = async (vote) => {
    const msg = await client.get(`/api/token/trpc/voteMessage${trpcInput(vote)}`);
    expect(msg.status, JSON.stringify(msg.body).slice(0, 300)).toBe(200);
    return client.post('/api/token/trpc/castVote', { ...vote, signature: await account.signMessage({ message: data(msg).message }) });
  };
  const vote = await signedCast({ proposalId: proposal.id, choice: 'for' });
  expect(vote.status, JSON.stringify(vote.body).slice(0, 300)).toBe(200);
  expect((await getProposal(client, proposal.id)).counts.votes).toBe(1);

  // The moderator cancels it in the governance room with a reason.
  const reason = `TEST ${nonce} duplicate of an earlier grant proposal`;
  await openRoom(page, moderator.who, nonce);
  const done = await cancelFromRoom(page, title, reason);
  expect(done.status, JSON.stringify(done.body).slice(0, 300)).toBe(200);
  await expect(done.form.getByRole('status')).toHaveText('Proposal cancelled.');
  await expect(done.row).toContainText('Cancelled');
  await expect(done.row.getByTestId('proposal-cancel-reason')).toHaveText(`Cancelled: ${reason}`);
  await expect(done.row.getByTestId('proposal-votes')).toContainText('1');

  const read = await getProposal(client, proposal.id);
  expect(read).toMatchObject({ status: 'cancelled', cancel: { reason }, counts: { votes: 1, for: 1 } });
  const again = await signedCast({ proposalId: proposal.id, choice: 'against' });
  expect(again.status).toBe(400);
  expect(causeOf(again.body)).toEqual({ code: 'token.proposal_not_open' });
  expect((await getProposal(client, proposal.id)).counts).toMatchObject({ votes: 1, for: 1, against: 0 });
  run.write({ cancelledId: proposal.id, reason, moderatorId: moderator.userId });
});

test(`${J} #5 An author tries to cancel another author's proposal: A typed permission refusal`, async ({ browser, page }) => {
  test.setTimeout(300_000);
  const { nonce, author } = started('nonce', 'author');
  const pages = await founders(browser);
  const other = await member(page, 'gvo', '1100');
  await expect(await roleStep(pages, other.userId, 'author')).toContainText(`Account ${other.userId} is author`);

  const client = await api(author);
  const title = `TEST ${nonce} not yours`;
  const created = await client.post('/api/token/trpc/createProposal', { kind: 'listing', body: {}, handle: `${nonce}:notyours`, title });
  expect(created.status, JSON.stringify(created.body).slice(0, 300)).toBe(200);
  const proposalId = data(created).id;

  await openRoom(page, other.who, nonce);
  const refused = await cancelFromRoom(page, title, `TEST ${nonce} I would rather this did not run`);
  expect(refused.status).toBe(403);
  expect(causeOf(refused.body)).toEqual({ code: 'token.permission_denied' });
  await expect(refused.form.getByRole('alert')).toHaveText(
    'Refused: your governance role does not allow cancelling proposals. Nothing was changed.',
  );
  expect(await getProposal(client, proposalId)).toMatchObject({ status: 'open', cancel: null });
});

test(`${J} #6 Changes a role without a fresh step-up: Refused until step-up is done`, async ({ browser, page }) => {
  test.setTimeout(300_000);
  const pages = await founders(browser);
  const target = await member(page, 'gvs');
  const request = roleRequest(target.userId, 'author');
  const { deskA, packet } = await ask(pages.a, request);
  await approveAsB(pages.b, { ...request, packet });

  // Run without a code: svc-token refuses before the two-founder approval is spent, and the role is not written.
  const refused = await runAsA(deskA, request.phrase, false);
  await expect(refused).toContainText('Your fresh authenticator code is needed to run this');
  await expect(refused).toContainText('Nothing was changed.');
  const roleRow = async () => {
    await openPanel(pages.b);
    return pages.b.locator(`tr[data-role-user="${target.userId}"]`);
  };
  await expect(await roleRow()).toHaveCount(0);

  // The same approved request, run again with A's fresh code: identity spends the code for exactly this change and the
  // role is written once.
  const done = await runAsA(deskA, request.phrase, true);
  await expect(done).toContainText(`Account ${target.userId} is author`);
  await expect((await roleRow()).getByTestId('role')).toHaveText('Author');
});

test(`${J} ends: voting delay and period are set by two founders, a moderator cancelled an open proposal with a reason`, async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { author, cancelledId, reason, founderA, founderB } = started('author', 'cancelledId', 'reason', 'founderA', 'founderB');
  const { a } = await founders(browser);
  await openPanel(a);
  await expect(a.getByTestId('voting-delay')).toHaveText('0 hours (no delay)');
  await expect(a.getByTestId('voting-period')).toHaveText('1 day (24 hours)');
  const last = a.getByTestId('settings-move').last();
  await expect(last.locator('td').nth(3)).toHaveText(founderA);
  await expect(last.locator('td').nth(4)).toHaveText(founderB);
  const client = await api(author);
  expect(await getProposal(client, cancelledId)).toMatchObject({ status: 'cancelled', cancel: { reason } });
});
