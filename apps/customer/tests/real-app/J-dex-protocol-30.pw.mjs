import { test, expect } from '@playwright/test';
import { UNBUILT } from './dex.mjs';
import { desk, founderPair, openDesk } from './protocol-desk.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-30, in the running app (docs/roadmap/journeys.json): screen the protocol: reports, labels, tiers,
// pools and disclosures. One test per step, titled "J-dex-protocol-30 #<n>", run in order on the founder console as the
// stack's two LOCAL TEST founders, who hold the compliance desk's roles on the stack (admin.mjs). No money moves.
// owner.decision for blank lists and criteria.
// Steps 3, 10 and 11 (the screening label store, the region and sanctions list, and real-world token jurisdiction flags)
// wait for launch prep (owner decision 2026-10-27) and have no test.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - the console has no Protocol trust desk (/protocol-ops/trust): no scam report queue or public labels
//   (D-developer-compliance-01), no token tiers, trust criteria or blocklist (D-launch-listing-02), no name tags
//   (D-launch-listing-01), no pool halt (D-launch-listing-07), no permissioned pool checklist (D-liquidity-07) and no
//   audit and disclosure room (D-developer-compliance-02);
// - #1's duplicate report and #4's to #8's subjects are TEST reports, tokens and pools the stack will seed when the
//   desk is built; each two-reviewer step is asked by founder A and approved by founder B.
const J = 'J-dex-protocol-30';
const founders = founderPair();

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
  const { a } = await founders(browser);
  const reports = await trust(a, 'Scam reports');
  const report = row(reports, 'Reports', 'TEST phishing report');
  await expect(report).toHaveCount(1);
  await expect(report).toContainText('Duplicate from the same reporter refused');
  // The public token page shows the report count, never who reported.
  await page.goto('/dex/tokens/0x00000000000000000000000000000000000ba5e0');
  await expect(page.getByRole('main').getByTestId('scam-reports')).toHaveText(/^\d+ reports?$/);
});

test(`${J} #2 publishes a "phishing" label as the first reviewer: pending; public with its reason after the second`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  const reports = await trust(a, 'Scam reports');
  const report = row(reports, 'Reports', 'TEST phishing report');
  await report.getByRole('button', { name: 'Publish label' }).click();
  await reports.getByLabel('Label').selectOption('phishing');
  await reports.getByLabel(/^Reason/).fill(`LOCAL TEST ${J} phishing label`);
  await reports.getByRole('button', { name: 'Ask a second reviewer' }).click();
  await expect(report).toContainText('Pending a second reviewer');
  const second = row(await trust(b, 'Scam reports'), 'Reports', 'TEST phishing report');
  await second.getByRole('button', { name: 'Approve label' }).click();
  await expect(second).toContainText('Public: phishing');
});

test(`${J} #4 sets a human "verified" tier on a token: pending until a second approver; then shown with date and reason; removal returns the prior tier with an audit row`, async ({
  browser,
}) => {
  const { a, b } = await founders(browser);
  const tiers = await trust(a, 'Token tiers');
  const token = row(tiers, 'Tokens', 'TEST Base');
  const prior = await token.getByTestId('tier').innerText();
  await token.getByRole('button', { name: 'Set tier' }).click();
  await tiers.getByLabel('Tier').selectOption('verified');
  await tiers.getByLabel(/^Reason/).fill(`LOCAL TEST ${J} verified`);
  await tiers.getByRole('button', { name: 'Ask a second approver' }).click();
  await expect(token.getByTestId('tier')).toHaveText(`${prior} · verified pending`);
  await row(await trust(b, 'Token tiers'), 'Tokens', 'TEST Base')
    .getByRole('button', { name: 'Approve tier' })
    .click();
  await a.reload();
  const shown = row(await trust(a, 'Token tiers'), 'Tokens', 'TEST Base');
  await expect(shown.getByTestId('tier')).toHaveText(/^verified · since \d{1,2} \w{3} \d{4}$/);
  await shown.getByRole('button', { name: 'Remove tier' }).click();
  await expect(shown.getByTestId('tier')).toHaveText(prior);
  await expect(row(tiers, 'Audit', 'TEST Base').filter({ hasText: 'Removed verified' })).toHaveCount(1);
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

test(`${J} #7 approves a public name tag: needs two approvers and a proof of ownership`, async ({ browser }) => {
  const { a } = await founders(browser);
  const tags = await trust(a, 'Name tags');
  const unproven = row(tags, 'Requests', 'TEST unproven tag');
  await unproven.getByRole('button', { name: 'Approve' }).click();
  await expect(tags.getByRole('alert')).toContainText('No proof of ownership');
  const proven = row(tags, 'Requests', 'TEST proven tag');
  await proven.getByRole('button', { name: 'Approve' }).click();
  await expect(proven).toContainText('1 of 2 approvals');
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
  const { a } = await founders(browser);
  const onboarding = await trust(a, 'Permissioned pools');
  const pending = row(onboarding, 'Onboarding', 'TEST permissioned pool');
  await expect(pending).toContainText('Checker address missing');
  await expect(pending.getByRole('button', { name: 'Approve' })).toBeDisabled();
});

test(`${J} #12 opens the audit and disclosure room: each product row says "External audit: not done" until the owner records a report; a blank policy shows its refusal`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const room = await trust(a, 'Audit and disclosures');
  const products = bodyRows(room.getByRole('table', { name: 'Products' }));
  await expect(products).not.toHaveCount(0);
  for (const product of await products.all()) await expect(product).toContainText('External audit: not done');
  await expect(room.getByRole('region', { name: 'Disclosure policy' })).toContainText('owner.decision');
});
