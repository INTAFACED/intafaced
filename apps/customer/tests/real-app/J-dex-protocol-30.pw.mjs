// World: book, gates
import { existsSync, readFileSync } from 'node:fs';
import { test, expect } from './journey.mjs';
import { createPublicClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainRecordPath, GATE_URL } from '../../../../tooling/scripts/local-test-chain.mjs';
import { ADMIN } from './admin.mjs';
import { TOKEN_A, TOKEN_B, UNBUILT, connectWallet, dexRun } from './dex.mjs';
import { desk, founderPair, openDesk, twoFounder } from './protocol-desk.mjs';
import { bodyRows } from './tables.mjs';
import { testWalletKey } from './test-wallet.mjs';

// J-dex-protocol-30, in the running app (docs/roadmap/journeys.json): screen the protocol for compliance: reports, labels,
// tiers, regions and disclosures. Independent tests (OWNER 212), written from the step's own words. One test per step,
// titled "J-dex-protocol-30 #<n>", run in order on the founder console as the stack's two LOCAL TEST founders (the
// compliance officer and the second reviewer), with a TEST wallet as the public person where a step has one.
// Steps 3, 10 and 11 wait for launch prep (owner decision 2026-10-27) and have no test.
//
// Every write on the console is the console's own two-founder request (protocol-desk.mjs `twoFounder`): founder A asks,
// founder B approves the packet, A runs it. A step that changes something other journeys read puts it back before it
// ends (#6 unblocks its token, #8 restores its pool, #12 removes its TEST audit record).
//
// Names the builder implements: the console's "Trust and safety" desk at /protocol-ops/trust (heading level 1), one tab
// per area: "Scam reports", "Token tiers", "Trust criteria", "Blocklist", "Name tags", "Permissioned pools", "Audit and
// disclosures"; each write a form with the console's request packet. On the customer side: the token page
// /dex/tokens/<address> with button "Report a scam", test ids "scam-reports", "token-label", "token-tier", "trust" and
// "token-badge"; the address page /chain/address/<address> with button "Request a name tag" and test id "name-tag"; the
// pool page /dex/pools/<address> with test id "pool-badge" and button "Remove liquidity".
const J = 'J-dex-protocol-30';
const founders = founderPair();
const base = dexRun(J);
// The public person's wallet reads the TEST chain; it sends nothing.
const person = {
  ...base,
  onChain: true,
};

test.describe.configure({ mode: 'default' });

const TOKEN_THIN = { address: '0x00000000000000000000000000000000000071a0', name: 'TEST Thin' };
const chain = createPublicClient({ transport: http(GATE_URL) });
const factoryAbi = parseAbi(['function getPool(address, address, uint16) view returns (address)']);
const runTag = () => base.run.read().tag;

/** The seeded shallow TEST A/B pool (1.00%): never the best route, so hiding it changes no other journey's quote. */
async function shallowPool() {
  expect(existsSync(chainRecordPath()), 'this stack runs a TEST chain (LOCAL_STACK_ANVIL_BIN)').toBe(true);
  const { factory } = JSON.parse(readFileSync(chainRecordPath(), 'utf8'));
  return chain.readContract({ address: factory, abi: factoryAbi, functionName: 'getPool', args: [TOKEN_A.address, TOKEN_B.address, 100] });
}

/** Opens one tab of the console's Trust and safety desk; returns its panel. */
async function trust(page, tab) {
  await openDesk(page, '/protocol-ops/trust', 'Trust and safety', UNBUILT);
  await desk(page).getByRole('tab', { name: tab }).click();
  const panel = desk(page).getByRole('tabpanel', { name: tab });
  await expect(panel).toBeVisible();
  return panel;
}

/** The typed confirmation the console asks for on `form`, read from its own label. */
async function phraseOf(form) {
  // The console writes it as: Type <code>PHRASE</code> to confirm.
  const code = form
    .locator('label')
    .filter({ hasText: /to confirm$/ })
    .locator('code')
    .first();
  return (await code.innerText()).trim();
}

/** Founder A fills `fill(form)` on tab `tab`, asks, and founder B approves; returns A's reply. `stopAfterAsk` asks only. */
async function request({ a, b, tab, form: formName, fill, summary, stopAfterAsk = false }) {
  const formA = (await trust(a, tab)).getByRole('form', { name: formName });
  await fill(formA);
  const phrase = await phraseOf(formA);
  await formA.getByLabel(/^Type .+ to confirm$/).fill(phrase);
  if (stopAfterAsk) {
    await formA.getByRole('button', { name: 'Ask a second reviewer' }).click();
    await expect(formA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
    return { formA, phrase };
  }
  const formB = (await trust(b, tab)).getByRole('form', { name: formName });
  return twoFounder({ formA, formB, ask: 'Ask a second reviewer', phrase, summary });
}

const tokenPage = async (page, address) => {
  await page.goto(`/dex/tokens/${address}`);
  await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toBeVisible();
  return page.getByRole('main');
};

test(`${J} starts: a compliance officer signed in to the ops console`, async ({ browser }) => {
  test.setTimeout(120_000);
  base.run.reset({ walletKey: testWalletKey(), tag: Date.now().toString(36) });
  const { a, b } = await founders(browser);
  await openDesk(a, '/protocol-ops', 'Protocol operations');
  await openDesk(b, '/protocol-ops', 'Protocol operations');
  await openDesk(a, '/protocol-ops/trust', 'Trust and safety', UNBUILT);
});

test(`${J} #1 opens the scam report queue: reports with the reporter hidden from the public; a duplicate by the same reporter is refused`, async ({
  browser,
  page,
}) => {
  const { a } = await founders(browser);
  await trust(a, 'Scam reports');
  // The public person reports TEST Thin from its token page, then tries again.
  await connectWallet(page, person);
  const reporter = privateKeyToAccount(person.key()).address;
  const detail = `LOCAL TEST ${J} report ${runTag()}`;
  for (const attempt of [1, 2]) {
    const main = await tokenPage(page, TOKEN_THIN.address);
    await main.getByRole('button', { name: 'Report a scam' }).click();
    const form = page.getByRole('form', { name: 'Report a scam' });
    await form.getByLabel('Kind').selectOption('phishing');
    await form.getByLabel(/^What happened/).fill(detail);
    await form.getByRole('button', { name: 'Send report' }).click();
    const sign = page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' });
    if (await sign.isVisible()) await sign.click();
    if (attempt === 1) await expect(form.getByRole('status')).toContainText(/report (?:was )?sent/i);
    else await expect(form.getByRole('alert')).toContainText(/already reported/i);
  }
  // The queue holds the one report, with its reporter for the officer.
  const queue = await trust(a, 'Scam reports');
  const rows = bodyRows(queue.getByRole('table', { name: 'Reports' })).filter({ hasText: detail });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(new RegExp(reporter.slice(2, 10), 'i'));
  // The public page counts reports and never names who made them.
  const main = await tokenPage(page, TOKEN_THIN.address);
  await expect(main.getByTestId('scam-reports')).toHaveText(/^\d+ reports?$/);
  await expect(main).not.toContainText(new RegExp(reporter.slice(2, 10), 'i'));
});

test(`${J} #2 decides to publish a "phishing" label as the first reviewer: the label is pending; after the second reviewer it is public with its reason`, async ({
  browser,
  page,
}) => {
  const { a, b } = await founders(browser);
  await trust(a, 'Scam reports');
  const reason = `LOCAL TEST ${J} phishing ${runTag()}`;
  const fill = async (form) => {
    await form.getByLabel('Token address').fill(TOKEN_THIN.address);
    await form.getByLabel('Label').selectOption('phishing');
    await form.getByLabel(/^Reason/).fill(reason);
  };
  const { formA, phrase } = await request({ a, b, tab: 'Scam reports', form: 'Publish a label', fill, stopAfterAsk: true });
  // One reviewer: pending, and not public.
  const queue = await trust(a, 'Scam reports');
  await expect(bodyRows(queue.getByRole('table', { name: 'Labels' })).filter({ hasText: reason })).toContainText(/pending/i);
  await expect((await tokenPage(page, TOKEN_THIN.address)).getByTestId('token-label')).toHaveCount(0);
  // The second reviewer approves; A runs it: public with its reason.
  const formB = (await trust(b, 'Scam reports')).getByRole('form', { name: 'Publish a label' });
  await twoFounder({ formA, formB, ask: null, phrase, summary: TOKEN_THIN.address });
  const label = (await tokenPage(page, TOKEN_THIN.address)).getByTestId('token-label');
  await expect(label).toContainText(/phishing/i);
  await expect(label).toContainText(reason);
});

test(`${J} #4 sets a human "verified" tier on a token: pending until a second approver; then shown with date and reason; removal returns to the prior tier with an audit row`, async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { a, b } = await founders(browser);
  const tiers = await trust(a, 'Token tiers');
  const rowOf = (panel) => bodyRows(panel.getByRole('table', { name: 'Tokens' })).filter({ hasText: TOKEN_B.address });
  const prior = (await rowOf(tiers).getByTestId('tier').innerText()).trim();
  const reason = `LOCAL TEST ${J} verified ${runTag()}`;
  const fill = async (form) => {
    await form.getByLabel('Token address').fill(TOKEN_B.address);
    await form.getByLabel('Tier').selectOption('verified');
    await form.getByLabel(/^Reason/).fill(reason);
  };
  const { formA, phrase } = await request({ a, b, tab: 'Token tiers', form: 'Set a tier', fill, stopAfterAsk: true });
  await expect(rowOf(await trust(a, 'Token tiers'))).toContainText(/verified.*pending|pending.*verified/i);
  await expect((await tokenPage(page, TOKEN_B.address)).getByTestId('token-tier')).toHaveText(prior);
  const formB = (await trust(b, 'Token tiers')).getByRole('form', { name: 'Set a tier' });
  await twoFounder({ formA, formB, ask: null, phrase, summary: TOKEN_B.address });
  // Shown with its date and reason, in the console and to the public.
  const shown = (await tokenPage(page, TOKEN_B.address)).getByTestId('token-tier');
  await expect(shown).toContainText(/verified/i);
  await expect(shown).toContainText(/\d{1,2} \w{3} \d{4}/);
  await expect(shown).toContainText(reason);
  // Removal: back to the prior tier, with an audit row.
  await request({
    a,
    b,
    tab: 'Token tiers',
    form: 'Remove a tier',
    fill: async (form) => {
      await form.getByLabel('Token address').fill(TOKEN_B.address);
      await form.getByLabel(/^Reason/).fill(`${reason} removed`);
    },
    summary: TOKEN_B.address,
  });
  const after = await trust(a, 'Token tiers');
  await expect(rowOf(after).getByTestId('tier')).toHaveText(prior);
  await expect((await tokenPage(page, TOKEN_B.address)).getByTestId('token-tier')).toHaveText(prior);
  const audit = bodyRows((await trust(a, 'Token tiers')).getByRole('table', { name: 'Audit' })).filter({ hasText: TOKEN_B.address });
  await expect(audit.filter({ hasText: /removed/i }).filter({ hasText: /verified/i })).toHaveCount(1);
});

test(`${J} #5 opens the trust criteria with the criteria blank: every token reads "unknown" and the founder desk shows the unset criteria`, async ({
  browser,
  page,
}) => {
  const { a } = await founders(browser);
  const criteria = await trust(a, 'Trust criteria');
  await expect(criteria.getByRole('status')).toContainText(/not set/i);
  await expect(criteria.getByRole('status')).toContainText('owner.decision');
  const tokens = bodyRows(criteria.getByRole('table', { name: 'Tokens' }));
  await expect(tokens).not.toHaveCount(0);
  for (const token of await tokens.all()) await expect(token.getByTestId('trust')).toHaveText('unknown');
  for (const address of [TOKEN_A.address, TOKEN_B.address])
    await expect((await tokenPage(page, address)).getByTestId('trust')).toHaveText('unknown');
});

test(`${J} #6 adds a token to the blocklist: it is not routed and shows the badge; permissioned gating is shown for tokens that need it`, async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { a, b } = await founders(browser);
  await trust(a, 'Blocklist');
  const reason = `LOCAL TEST ${J} blocklist ${runTag()}`;
  try {
    await request({
      a,
      b,
      tab: 'Blocklist',
      form: 'Add to the blocklist',
      fill: async (form) => {
        await form.getByLabel('Token address').fill(TOKEN_THIN.address);
        await form.getByLabel(/^Reason/).fill(reason);
      },
      summary: TOKEN_THIN.address,
    });
    // Not routed: the swap form refuses to quote into it, and its page shows the badge.
    const main = await tokenPage(page, TOKEN_THIN.address);
    await expect(main.getByTestId('token-badge')).toContainText(/blocked/i);
    await page.goto('/dex');
    const swap = page.getByRole('form', { name: 'Swap' });
    await swap.getByRole('combobox', { name: 'You pay' }).selectOption({ label: 'TEST Token A' });
    await swap.getByRole('combobox', { name: 'You receive' }).selectOption({ label: 'TEST Thin' });
    await swap.getByRole('textbox', { name: /^Amount you pay/ }).fill('1');
    await expect(swap.getByRole('alert')).toContainText(/not routed|blocked/i);
    // Permissioned gating, on the tokens that need it.
    const gated = bodyRows((await trust(a, 'Blocklist')).getByRole('table', { name: 'Permissioned tokens' }));
    await expect(gated).not.toHaveCount(0);
    for (const row of await gated.all()) await expect(row).toContainText(/gated/i);
  } finally {
    try {
      await request({
        a,
        b,
        tab: 'Blocklist',
        form: 'Remove from the blocklist',
        fill: async (form) => {
          await form.getByLabel('Token address').fill(TOKEN_THIN.address);
          await form.getByLabel(/^Reason/).fill(`${reason} lifted`);
        },
        summary: TOKEN_THIN.address,
      });
    } catch {
      /* nothing was blocked: the desk is not built yet */
    }
  }
});

test(`${J} #7 approves a public name tag: needs two approvers and a proof of ownership`, async ({ browser, page }) => {
  test.setTimeout(240_000);
  const { a, b } = await founders(browser);
  await trust(a, 'Name tags');
  const own = privateKeyToAccount(person.key()).address;
  const tag = `TEST tag ${runTag()}`;
  // The person asks for a tag on their own address and proves it with their wallet.
  await connectWallet(page, person);
  await page.goto(`/chain/address/${own}`);
  await page.getByRole('main').getByRole('button', { name: 'Request a name tag' }).click();
  const ask = page.getByRole('form', { name: 'Request a name tag' });
  await ask.getByLabel('Name tag').fill(tag);
  await ask.getByRole('button', { name: 'Prove and send' }).click();
  await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(ask.getByRole('status')).toContainText(/sent/i);
  // A tag with no proof of ownership cannot be approved.
  const unproven = await trust(a, 'Name tags');
  const form = unproven.getByRole('form', { name: 'Approve a name tag' });
  await form.getByLabel('Address').fill('0x000000000000000000000000000000000000dEaD');
  await form.getByLabel('Name tag').fill(`${tag} unproven`);
  await form.getByRole('button', { name: 'Ask a second reviewer' }).click();
  await expect(form.getByRole('alert')).toContainText(/proof of ownership/i);
  // The proven one: one approver leaves it off the public page; the second makes it public.
  const { formA, phrase } = await request({
    a,
    b,
    tab: 'Name tags',
    form: 'Approve a name tag',
    fill: async (f) => {
      await f.getByLabel('Address').fill(own);
      await f.getByLabel('Name tag').fill(tag);
    },
    stopAfterAsk: true,
  });
  await page.goto(`/chain/address/${own}`);
  await expect(page.getByRole('main').getByTestId('name-tag')).toHaveCount(0);
  const formB = (await trust(b, 'Name tags')).getByRole('form', { name: 'Approve a name tag' });
  await twoFounder({ formA, formB, ask: null, phrase, summary: own });
  await page.goto(`/chain/address/${own}`);
  await expect(page.getByRole('main').getByTestId('name-tag')).toHaveText(tag);
});

test(`${J} #8 halts a pool: routing excludes it, the page shows the badge and remove liquidity still works; one approver leaves it pending`, async ({
  browser,
  page,
}) => {
  test.setTimeout(240_000);
  const { a, b } = await founders(browser);
  const pool = await shallowPool();
  const form = async (p) => {
    await p.goto(`${ADMIN}/protocol-ops/listing`);
    const region = desk(p).getByRole('region', { name: 'Pool and market control' });
    await expect(region).toBeVisible({ timeout: 30_000 });
    return region;
  };
  const move = async (label, reason) => {
    const formA = await form(a);
    await formA.getByLabel('What to do').selectOption({ label });
    await formA.getByLabel('Chain id').fill('84532');
    await formA.getByLabel('Pool address').fill(pool);
    const code = formA.getByLabel('Reason code');
    if (await code.isVisible()) await code.selectOption({ index: 1 });
    const reasonBox = formA.getByLabel(/^Reason: what the second founder reads/);
    if (await reasonBox.isVisible()) await reasonBox.fill(reason);
    const phrase = await phraseOf(formA);
    await formA.getByLabel(/^Type .+ to confirm$/).fill(phrase);
    return { formA, phrase };
  };
  const routes = async () => {
    await page.goto('/dex');
    const swap = page.getByRole('form', { name: 'Swap' });
    await swap.getByRole('combobox', { name: 'You pay' }).selectOption({ label: 'TEST Token A' }, UNBUILT);
    await swap.getByRole('combobox', { name: 'You receive' }).selectOption({ label: 'TEST Token B' });
    await swap.getByRole('textbox', { name: /^Amount you pay/ }).fill('10');
    await swap.getByRole('button', { name: 'Route options' }).click();
    return page.getByRole('region', { name: 'Routes' }).getByRole('table');
  };
  let halted = false;
  try {
    const { formA, phrase } = await move('Hide a pool', `LOCAL TEST ${J} halt ${runTag()}`);
    await formA.getByRole('button', { name: 'Ask a second founder to approve this' }).click();
    await expect(formA.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
    halted = true;
    // One approver: still routed and no badge.
    await expect((await routes()).getByRole('row').filter({ hasText: new RegExp(pool.slice(2, 10), 'i') })).not.toContainText(
      /halted|hidden|excluded/i,
    );
    await page.goto(`/dex/pools/${pool}`);
    await expect(page.getByRole('main').getByTestId('pool-badge')).toHaveCount(0);
    await twoFounder({ formA, formB: await form(b), ask: null, phrase, summary: pool });
    // Halted: out of routing, the badge on its page, and Remove liquidity still there and enabled.
    await expect((await routes()).getByRole('row').filter({ hasText: new RegExp(pool.slice(2, 10), 'i') })).toHaveCount(0);
    await page.goto(`/dex/pools/${pool}`);
    await expect(page.getByRole('main').getByTestId('pool-badge')).toContainText(/halted|hidden by intafaced/i);
    await expect(page.getByRole('main').getByRole('button', { name: 'Remove liquidity' })).toBeEnabled();
  } finally {
    if (halted) {
      try {
        const { formA, phrase } = await move('Restore a pool', `LOCAL TEST ${J} restore ${runTag()}`);
        await twoFounder({ formA, formB: await form(b), ask: 'Ask a second founder to approve this', phrase, summary: pool });
      } catch {
        /* the halt never took effect */
      }
    }
  }
});

test(`${J} #9 opens the permissioned pool onboarding checklist: a checklist missing the checker address cannot be approved`, async ({
  browser,
}) => {
  const { a } = await founders(browser);
  const onboarding = await trust(a, 'Permissioned pools');
  const checklist = onboarding.getByRole('form', { name: 'Onboarding checklist' });
  await checklist.getByLabel('Pool address').fill(await shallowPool());
  await checklist.getByLabel('Checker address').fill('');
  await expect(checklist.getByRole('button', { name: 'Ask a second reviewer' })).toBeDisabled();
  await expect(checklist).toContainText(/checker address/i);
  await expect(checklist.getByTestId('packet-made')).toHaveCount(0);
});

test(`${J} #12 opens the audit and disclosure room: each product row says "External audit: not done" until the owner records a report (date, scope, link); a blank policy or terms shows its refusal`, async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const { a, b } = await founders(browser);
  const room = await trust(a, 'Audit and disclosures');
  const products = bodyRows(room.getByRole('table', { name: 'Products' }));
  await expect(products).not.toHaveCount(0);
  for (const product of await products.all()) await expect(product).toContainText('External audit: not done');
  const product = (await products.first().getByRole('cell').first().innerText()).trim();
  // Blank policy and blank terms each show their refusal.
  for (const name of ['Disclosure policy', 'Terms']) {
    const region = room.getByRole('region', { name });
    await expect(region.getByRole('alert')).toContainText('owner.decision');
  }
  // The owner records a TEST report: the row shows its date, scope and link instead.
  const link = `https://example.invalid/local-test-audit-${runTag()}`;
  let recorded = false;
  try {
    await request({
      a,
      b,
      tab: 'Audit and disclosures',
      form: 'Record an audit report',
      fill: async (form) => {
        await form.getByLabel('Product').selectOption({ label: product });
        await form.getByLabel('Date').fill('2026-11-01');
        await form.getByLabel('Scope').fill(`LOCAL TEST ${J} scope`);
        await form.getByLabel('Link').fill(link);
      },
      summary: product,
    });
    recorded = true;
    const row = bodyRows((await trust(a, 'Audit and disclosures')).getByRole('table', { name: 'Products' })).filter({ hasText: product });
    await expect(row).not.toContainText('External audit: not done');
    await expect(row).toContainText(/1 Nov 2026|2026-11-01/);
    await expect(row).toContainText(`LOCAL TEST ${J} scope`);
    await expect(row.getByRole('link')).toHaveAttribute('href', link);
  } finally {
    if (recorded)
      await request({
        a,
        b,
        tab: 'Audit and disclosures',
        form: 'Remove an audit report',
        fill: async (form) => form.getByLabel('Product').selectOption({ label: product }),
        summary: product,
      });
  }
});
