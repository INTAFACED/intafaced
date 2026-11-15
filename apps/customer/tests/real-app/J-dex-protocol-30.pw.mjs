// World: book
import { test, expect } from './journey.mjs';
import { TOKEN_A, UNBUILT, fundOnTestChain, testChain } from './dex.mjs';
import { desk, founderPair, openDesk } from './protocol-desk.mjs';
import { bodyRows, tableIn } from './tables.mjs';
import { signIn, signUp } from './desk.mjs';
import { EDGE, ORIGIN } from './stack.mjs';
import { createPublicClient, createWalletClient, http } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

// J-dex-protocol-30, in the running app (docs/roadmap/journeys.json): screen the protocol: reports, labels, tiers,
// pools and disclosures. One test per step, titled "J-dex-protocol-30 #<n>", run in order on the founder console as the
// stack's two LOCAL TEST founders, who hold the compliance desk's roles on the stack (admin.mjs). No money moves.
// owner.decision for blank lists and criteria.
// Steps 3 and 11 (the screening label store and real-world token jurisdiction flags) wait for launch prep (owner decision
// 2026-10-27) and have no test. Step 10 (the region and sanctions list) has no test yet.
// #1's report is filed in the running app by a TEST customer, who then files the same report again and is refused; #4's
// subject is the TEST chain's TEST Token A; #7's two name tag requests are filed through the tab's form, and its proof is a
// real owner's signature on a contract deployed to the TEST chain; #9's checklist is opened through the tab's own form;
// each two-person step is asked by founder A and approved by founder B.
// Steps written but not built yet fail at their first missing part, quickly (UNBUILT): #6's blocklist
// (D-launch-listing-02) and #8's pool halts (D-launch-listing-07), whose subjects are TEST tokens and pools the stack will
// seed when those tabs are built.
const J = 'J-dex-protocol-30';
const founders = founderPair();
const SUSPECT = '0x00000000000000000000000000000000000ba5e0';
// This run's report and label, told apart from any earlier run's by the time they were written.
const RUN = Date.now().toString(36);
const NOTE = `LOCAL TEST ${J} phishing report ${RUN}`;
const LABEL_REASON = `LOCAL TEST ${J} phishing label ${RUN}`;
/** The customer who files #1's report, kept for the file's tests. */
let reporter = null;

/** The public address page's risk card. */
async function riskCard(page) {
  await page.goto(`/chain/address/${SUSPECT}`);
  const card = page.getByRole('region', { name: 'Address risk' });
  await expect(card).toBeVisible();
  return card;
}

test.describe.configure({ mode: 'default' });

/** Opens one tab of the Protocol trust desk. */
async function trust(page, tab) {
  await openDesk(page, '/protocol-ops', 'Protocol operations');
  await desk(page).getByRole('navigation', { name: 'Sections' }).getByRole('link', { name: 'Trust and safety' }).click(UNBUILT);
  await desk(page).getByRole('tab', { name: tab }).click();
  const panel = desk(page).getByRole('tabpanel', { name: tab });
  await expect(panel).toBeVisible();
  return panel;
}

/** A row of a named table in `panel`. */
const row = (panel, table, text) => bodyRows(panel.getByRole('table', { name: table })).filter({ hasText: text });

test(`${J} starts: a compliance officer signed in to the ops console`, async ({ browser }) => {
  test.setTimeout(120_000);
  const { a } = await founders(browser);
  await openDesk(a, '/protocol-ops', 'Protocol operations');
});

test(`${J} #1 opens the scam report queue: reports with the reporter hidden from the public; a duplicate by the same reporter is refused`, async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  // A TEST customer files a phishing report about the address, then files it again: the second is refused.
  reporter = await signUp(page, 'cx');
  await signIn(page, reporter);
  const file = async () => {
    const card = await riskCard(page);
    await card.getByRole('button', { name: 'Report this address' }).click();
    const dialog = page.getByRole('dialog', { name: 'Report this address' });
    await dialog.getByLabel('Reason').selectOption('phishing');
    await dialog.getByLabel('What happened (optional)').fill(NOTE);
    await dialog.getByRole('button', { name: 'Send report' }).click();
    return dialog;
  };
  await expect((await file()).getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Thank you. Your report was received.' })).toBeVisible();
  const again = await file();
  await expect(again.getByRole('alert')).toHaveText('You already reported this address. Your report is still open.');

  // The queue shows the one report, who filed it, and the refused duplicate.
  const { a } = await founders(browser);
  const reports = await trust(a, 'Scam reports');
  const report = row(reports, 'Reports', NOTE);
  await expect(report).toHaveCount(1);
  await expect(report).toContainText('Duplicate from the same reporter refused once');
  const reporterId = (await report.getByTestId('reporter').innerText()).trim();
  expect(reporterId).not.toBe('');

  // The public pages show a count, never who reported or what they wrote.
  await page.goto(`/dex/tokens/${SUSPECT}`);
  const count = page.getByRole('main').getByTestId('scam-reports');
  await expect(count).toHaveText(/^\d+ reports?$/);
  expect(Number((await count.innerText()).split(' ')[0])).toBeGreaterThanOrEqual(1);
  for (const hidden of [NOTE, reporterId, reporter.email, reporter.handle]) await expect(page.getByRole('main')).not.toContainText(hidden);
  const card = await riskCard(page);
  await expect(card).toContainText(/Reported \d+ times?\./);
  for (const hidden of [NOTE, reporterId, reporter.email]) await expect(card).not.toContainText(hidden);
});

test(`${J} #2 publishes a "phishing" label as the first reviewer: pending; public with its reason after the second`, async ({
  browser,
  page,
}) => {
  test.setTimeout(120_000);
  const { a, b } = await founders(browser);
  const reports = await trust(a, 'Scam reports');
  const report = row(reports, 'Reports', NOTE);
  await report.getByRole('button', { name: 'Publish label' }).click();
  await reports.getByLabel('Label').selectOption('phishing');
  await reports.getByLabel(/^Reason/).fill(LABEL_REASON);
  await reports.getByRole('button', { name: 'Ask a second reviewer' }).click();
  await expect(report).toContainText('Pending a second reviewer');
  // Pending is not public: the address page shows no label with this reason yet.
  await expect(await riskCard(page)).not.toContainText(LABEL_REASON);
  // The person who asked cannot be the second reviewer.
  await report.getByRole('button', { name: 'Approve label' }).click();
  await expect(reports.getByRole('alert')).toContainText('a different person must approve it');
  await expect(report).toContainText('Pending a second reviewer');

  const second = row(await trust(b, 'Scam reports'), 'Reports', NOTE);
  await second.getByRole('button', { name: 'Approve label' }).click();
  await expect(second).toContainText(`Public: phishing. Why: ${LABEL_REASON}`);
  // Public, with its reason, on the address page.
  const card = await riskCard(page);
  await expect(card).toContainText(`Phishing (phishing). Why: ${LABEL_REASON}`);
  await expect(card).toContainText('Risk: unsafe');
});

test(`${J} #4 sets a human "verified" tier on a token: pending until a second approver; then shown with date and reason; removal returns the prior tier with an audit row`, async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { a, b } = await founders(browser);
  // TEST Token A, told by its address: the stack also seeds a lookalike with the same name (seed-token-pages.ts).
  const TOKEN = TOKEN_A.address;
  const reason = `LOCAL TEST ${J} verified ${RUN}`;
  const removal = `LOCAL TEST ${J} tier removed ${RUN}`;
  const tiers = await trust(a, 'Token tiers');
  const token = row(tiers, 'Tokens', TOKEN);
  const prior = (await token.getByTestId('tier').innerText()).trim();
  expect(prior).not.toMatch(/pending/);
  await token.getByRole('button', { name: 'Set tier' }).click();
  await tiers.getByLabel('Tier').selectOption('verified');
  await tiers.getByLabel(/^Reason/).fill(reason);
  await tiers.getByRole('button', { name: 'Ask a second approver' }).click();
  // Pending: the tier in force is still the prior one, and the person who asked cannot approve it.
  await expect(token.getByTestId('tier')).toHaveText(`${prior} · verified pending`);
  await token.getByRole('button', { name: 'Approve tier' }).click();
  await expect(tiers.getByRole('alert')).toContainText('a different person must approve it');
  await expect(token.getByTestId('tier')).toHaveText(`${prior} · verified pending`);

  await row(await trust(b, 'Token tiers'), 'Tokens', TOKEN)
    .getByRole('button', { name: 'Approve tier' })
    .click();
  await a.reload();
  const again = await trust(a, 'Token tiers');
  const shown = row(again, 'Tokens', TOKEN);
  // In force, with the day it was approved and its reason.
  const day = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date());
  await expect(shown.getByTestId('tier')).toHaveText(`verified · since ${day}`);
  await expect(shown.getByTestId('tier-reason')).toHaveText(reason);
  await expect(
    row(again, 'Audit', TOKEN_A.name)
      .filter({ hasText: `Approved verified on ${day}` })
      .filter({ hasText: reason }),
  ).toHaveCount(1);

  await shown.getByRole('button', { name: 'Remove tier' }).click();
  await again.getByLabel(/^Reason/).fill(removal);
  await again.getByRole('button', { name: 'Remove the tier' }).click();
  await expect(shown.getByTestId('tier')).toHaveText(prior);
  await expect(row(again, 'Audit', TOKEN_A.name).filter({ hasText: 'Removed verified, back to' }).filter({ hasText: removal })).toHaveCount(
    1,
  );
});

test(`${J} #5 opens the trust criteria with the criteria blank: every token reads "unknown" and the desk shows the unset criteria`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const criteria = await trust(a, 'Trust criteria');
  await expect(criteria.getByRole('status')).toContainText('Trust criteria not set · owner.decision');
  const tokens = bodyRows(criteria.getByRole('table', { name: 'Tokens' }));
  await expect(tokens).not.toHaveCount(0);
  for (const token of await tokens.all()) await expect(token.getByTestId('trust')).toHaveText('unknown');
});

test(`${J} #6 adds a token to the blocklist: it is not routed and shows the badge; permissioned gating shows for tokens that need it`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const blocklist = await trust(a, 'Blocklist');
  await blocklist.getByLabel('Token address').fill('0x00000000000000000000000000000000000ba5e0');
  await blocklist.getByLabel(/^Reason/).fill(`LOCAL TEST ${J} blocklist`);
  await blocklist.getByRole('button', { name: 'Add to the blocklist' }).click();
  const blocked = row(blocklist, 'Blocked tokens', '0x00000000000000000000000000000000000ba5e0');
  await expect(blocked).toContainText('Not routed');
  await expect(blocked).toContainText('Blocked badge shown');
  await expect(row(blocklist, 'Permissioned tokens', 'TEST permissioned')).toContainText('Gated');
});

test(`${J} #7 approves a public name tag: needs two approvers and a proof of ownership`, async ({ browser, page }) => {
  test.setTimeout(180_000);
  const { a, b } = await founders(browser);
  // A token contract on the TEST chain whose owner() is a fresh key, and that owner signs the one-time ownership
  // challenge, as a token's owner does in the running app (J-dex-protocol-09 #11): the proof is stored.
  const chain = testChain();
  expect(chain.chain, 'the stack runs no TEST chain, so no contract can name an owner').toBe('running');
  const viemChain = {
    id: chain.chainId,
    name: 'LOCAL TEST chain',
    nativeCurrency: { name: 'TEST ETH', symbol: 'TESTETH', decimals: 18 },
    rpcUrls: { default: { http: [chain.gateUrl] } },
  };
  const reader = createPublicClient({ chain: viemChain, transport: http(chain.gateUrl) });
  const owner = privateKeyToAccount(generatePrivateKey());
  const deployer = privateKeyToAccount(generatePrivateKey());
  fundOnTestChain(deployer.address);
  const deploy = await createWalletClient({ account: deployer, chain: viemChain, transport: http(chain.gateUrl) }).sendTransaction({
    data: ownedDeploy(owner.address),
  });
  const proven = (await reader.waitForTransactionReceipt({ hash: deploy })).contractAddress.toLowerCase();
  const call = async (procedure, input) => {
    const res = await fetch(`${EDGE}/api/protocol/trpc/listing.${procedure}`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body.result.data;
  };
  const challenge = await call('ownershipChallenge', { token: proven });
  const proof = await call('verifyOwnership', {
    nonce: challenge.nonce,
    signature: await owner.signMessage({ message: challenge.message }),
  });
  expect(proof.signer.toLowerCase()).toBe(owner.address.toLowerCase());
  // A second address no one has proven.
  const unproven = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  const UNPROVEN_TAG = `TEST unproven tag ${RUN}`;
  const PROVEN_TAG = `TEST proven tag ${RUN}`;
  const TAG_REASON = `LOCAL TEST ${J} name tag ${RUN}`;

  const tags = await trust(a, 'Name tags');
  for (const [address, tag] of [
    [unproven, UNPROVEN_TAG],
    [proven, PROVEN_TAG],
  ]) {
    await tags.getByLabel('Address', { exact: true }).fill(address);
    await tags.getByLabel('Name tag', { exact: true }).fill(tag);
    await tags.getByLabel('Why', { exact: true }).fill(TAG_REASON);
    await tags.getByRole('button', { name: 'Request the name tag' }).click();
    await expect(row(tags, 'Requests', tag)).toBeVisible();
  }
  // No proof of ownership: neither founder can approve it, and it stays at no approvals.
  const unprovenRow = row(tags, 'Requests', UNPROVEN_TAG);
  await expect(unprovenRow.getByTestId('name-tag-state')).toHaveText('0 of 2 approvals · No proof of ownership');
  await unprovenRow.getByRole('button', { name: 'Approve' }).click();
  await expect(tags.getByRole('alert')).toContainText('No proof of ownership');
  const tagsB = await trust(b, 'Name tags');
  const unprovenB = row(tagsB, 'Requests', UNPROVEN_TAG);
  await unprovenB.getByRole('button', { name: 'Approve' }).click();
  await expect(tagsB.getByRole('alert')).toContainText('No proof of ownership');
  await expect(unprovenB.getByTestId('name-tag-state')).toHaveText('0 of 2 approvals · No proof of ownership');

  // With the proof: one approval leaves it pending, the same person cannot give the second, a different person makes it public.
  const provenRow = row(tags, 'Requests', PROVEN_TAG);
  await expect(provenRow.getByTestId('name-tag-state')).toContainText(`0 of 2 approvals · Ownership proven by ${proof.signer}`);
  await provenRow.getByRole('button', { name: 'Approve' }).click();
  await expect(provenRow.getByTestId('name-tag-state')).toContainText('1 of 2 approvals');
  await provenRow.getByRole('button', { name: 'Approve' }).click();
  await expect(tags.getByRole('alert')).toContainText('a different person must give the second approval');
  await expect(provenRow.getByTestId('name-tag-state')).toContainText('1 of 2 approvals');
  // Not public yet: the address page shows no name tag.
  await page.goto(`/chain/address/${proven}`);
  const card = page.getByRole('region', { name: 'Address risk' });
  await expect(card).toBeVisible();
  await expect(card).not.toContainText(PROVEN_TAG);
  await b.reload();
  const provenB = row(await trust(b, 'Name tags'), 'Requests', PROVEN_TAG);
  await provenB.getByRole('button', { name: 'Approve' }).click();
  await expect(provenB.getByTestId('name-tag-state')).toContainText(`Public · Ownership proven by ${proof.signer}`);
  await expect(provenB.getByRole('button', { name: 'Approve' })).toHaveCount(0);
  // Public: the address page names it, with its reason.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Address risk' })).toContainText(`${PROVEN_TAG} (name). Why: ${TAG_REASON}`);
  await page.goto(`/chain/address/${unproven}`);
  await expect(page.getByRole('region', { name: 'Address risk' })).not.toContainText(UNPROVEN_TAG);
});

test(`${J} #8 halts a pool: routing excludes it, the page shows the badge and remove liquidity still works; one approver leaves it pending`, async ({
  browser,
  page,
}) => {
  const { a, b } = await founders(browser);
  const pools = await trust(a, 'Pool halts');
  const pool = row(pools, 'Pools', 'TEST halt pool');
  await pool.getByRole('button', { name: 'Halt' }).click();
  await expect(pool).toContainText('Pending a second approver');
  await row(await trust(b, 'Pool halts'), 'Pools', 'TEST halt pool')
    .getByRole('button', { name: 'Approve halt' })
    .click();
  await a.reload();
  await expect(row(await trust(a, 'Pool halts'), 'Pools', 'TEST halt pool')).toContainText('Halted · not routed');
  // The customer's pool page shows the badge and keeps Remove liquidity.
  await page.goto('/dex/pools');
  const shown = bodyRows(tableIn(page.getByRole('main'), 'Pools')).filter({ hasText: 'TEST halt pool' });
  await expect(shown).toContainText('Halted');
  await expect(shown.getByRole('button', { name: 'Remove liquidity' })).toBeVisible();
});

test(`${J} #9 opens the permissioned pool onboarding checklist: a checklist missing the checker address cannot be approved`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  const POOL = `LOCAL TEST permissioned pool ${RUN}`;
  const onboarding = await trust(a, 'Permissioned pools');
  // Every item but the checker address is filled in.
  for (const [label, value] of [
    ['Pool name', POOL],
    ['Legal entity', 'LOCAL TEST Issuer Ltd'],
    ['Token contract', '0x00000000000000000000000000000000000a11ce'],
    ['Wrapper address', '0x000000000000000000000000000000000000a7a9'],
    ['Routing registration', 'LOCAL TEST registry entry'],
  ])
    await onboarding.getByLabel(label, { exact: true }).fill(value);
  await onboarding.getByRole('button', { name: 'Open the checklist' }).click();
  const pending = row(onboarding, 'Onboarding', POOL);
  await expect(pending).toContainText('Checker address missing');
  // Neither the opener nor a second person can approve it: svc-protocol refuses by name, and it stays open.
  const refusal = 'This checklist cannot be approved while it is missing: checker address. Nothing was approved.';
  await onboarding.getByLabel('Approval reason').fill(`LOCAL TEST ${J} approval`);
  await pending.getByRole('button', { name: 'Approve' }).click();
  await expect(onboarding.getByRole('alert')).toHaveText(refusal);
  await expect(pending).toContainText('Checker address missing');
  const second = await trust(b, 'Permissioned pools');
  await second.getByLabel('Approval reason').fill(`LOCAL TEST ${J} approval`);
  const seen = row(second, 'Onboarding', POOL);
  await expect(seen).toContainText('Checker address missing');
  await seen.getByRole('button', { name: 'Approve' }).click();
  await expect(second.getByRole('alert')).toHaveText(refusal);
  await b.reload();
  const after = row(await trust(b, 'Permissioned pools'), 'Onboarding', POOL);
  await expect(after).toContainText('Checker address missing');
  await expect(after).not.toContainText('Approved');
});

test(`${J} #12 opens the audit and disclosure room: each product row says "External audit: not done" until the owner records a report; a blank policy shows its refusal`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const room = await trust(a, 'Audit and disclosures');
  const products = bodyRows(room.getByRole('table', { name: 'Products' }));
  await expect(products).not.toHaveCount(0);
  // No external report is recorded on the stack: every row says so, and none shows a date, a scope or a report link.
  for (const product of await products.all()) {
    await expect(product.getByTestId('external-audit')).toHaveText('External audit: not done');
    await expect(product.getByRole('link')).toHaveCount(0);
  }
  // The owner has set no disclosure policy and no terms: each shows its typed refusal, and no text is offered as in force.
  for (const [region, refusal] of [
    ['Disclosure policy', 'Disclosure policy not set · owner.decision'],
    ['Terms', 'Terms not set · owner.decision'],
  ]) {
    const shown = room.getByRole('region', { name: region });
    await expect(shown.getByRole('status')).toHaveText(refusal);
    await expect(shown).toHaveAttribute('data-code', 'owner.decision');
  }
});

/**
 * A contract whose `owner()` (and any other call) answers `owner`: just enough for a contract that names its owner (as in
 * J-dex-protocol-09 #11). Runtime: PUSH32 owner, MSTORE at 0, RETURN 32 bytes; the init code copies it and returns it.
 */
const ownedDeploy = (owner) => `0x6029600c60003960296000f37f${owner.slice(2).toLowerCase().padStart(64, '0')}60005260206000f3`;
