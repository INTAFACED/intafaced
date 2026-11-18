// World: gates, restart
import { test, expect } from './journey.mjs';
import { restartWith as stackRestartWith, restartWithSetting as stackRestartWithSetting, tool } from './stack.mjs';
import { installTestWallet, TEST_WALLET } from './test-wallet.mjs';

// J-dex-protocol-01, in the running app (docs/roadmap/journeys.json): open the Web3 side, read the honest labels and
// connect a wallet. One test per step, titled "J-dex-protocol-01 #<n>". Every step is signed out: the Protocol rooms are
// public and read only. The stack runs svc-protocol on the app's network, Base Sepolia (84532), with no node published
// to it (tooling/scripts/local-stack-services/protocol.mjs), so every chain read refuses as unreachable. Where the stack
// runs its LOCAL TEST chain (tooling/scripts/local-test-chain.mjs) this journey closes that chain's gate before its first
// step and opens it again after its last, so svc-protocol sees no node, exactly as on a stack without one; the hooks
// run after a failed step too, so the next journey finds the gate open. The person's own
// browser wallet is the TEST wallet in test-wallet.mjs. No money moves in this journey.
// Step 9 signs an EIP-2612 permit for a TEST token that only the TEST wallet answers for (its stand-in for a node).
// Step 8: before a wallet's first signing action it accepts the representation (the stack's TEST text and version from
// tooling/profiles/test-owner-values/protocol.json), which svc-protocol stores with its version and time; a restart with
// `LOCAL_STACK_PROTOCOL_REPRESENTATION_VERSION=TEST-2` serves a newer TEST version, which asks again. Its blocked-region run
// plays a visitor from the TEST region AA (a user-assigned ISO code, no country): `LOCAL_STACK_TEST_REGION_SERVED=off` on a
// restart of svc-protocol and Edge gives AA a TEST business block and stamps every request from it, as J-wallet-09 #1 does;
// the sanctions list is never touched. Steps 6 and 7 restart svc-protocol once with `LOCAL_STACK_PROTOCOL_NETWORKS=published`,
// which serves a TEST network registry (tooling/scripts/local-stack-services/protocol-test-networks.json) in place of the
// owner's, unpublished one. Every restart is put back after the step, a failed one too.
const J = 'J-dex-protocol-01';
const SHORT = /^0x[0-9a-fA-F]{4}…[0-9a-fA-F]{4}$/;

// The gate is shared stack state: shut for this journey only. afterAll runs when the worker ends, after a failure too.
test.beforeAll(() => {
  tool('local-test-chain.mjs', 'gate', 'closed');
});
test.afterAll(() => {
  tool('local-test-chain.mjs', 'gate', 'open');
});

// A stack start refuses while the TEST chain's gate is shut, so each restart here opens it for the restart alone and shuts
// it again before the step reads anything: svc-protocol still sees no node.
function withGateOpenForRestart(restart) {
  tool('local-test-chain.mjs', 'gate', 'open');
  try {
    restart();
  } finally {
    tool('local-test-chain.mjs', 'gate', 'closed');
  }
}
const restartWith = (...args) => withGateOpenForRestart(() => stackRestartWith(...args));
const restartWithSetting = (...args) => withGateOpenForRestart(() => stackRestartWithSetting(...args));

const networkChip = (page) => page.locator('[data-chip="network"]');
const walletChip = (page) => page.locator('[data-chip="wallet"]');

test(`${J} #1 /dex signed out shows the Web3 shell, the testnet chip, the Not INTACHAIN pill and the nav, never "Parked"`, async ({
  page,
}) => {
  await page.goto('/dex');
  await expect(page.locator('[data-shell="web3"]')).toBeVisible();
  await expect(networkChip(page)).toHaveText('Base Sepolia test network · Testnet only');
  await expect(page.locator('[data-chip="label"]')).toHaveText('Not INTACHAIN · not audited');
  await expect(walletChip(page)).toHaveText('No wallet connected');
  await expect(page.getByRole('link', { name: 'Log in', exact: true })).toBeVisible();
  const nav = page.locator('header nav[data-testid="tb-nav"] a');
  await expect(nav).toHaveText(['Swap', 'Pools', 'Positions', 'Wallet', 'Explorer', 'Protocol']);
  await expect(page.locator('main h1')).toHaveText('DEX');
  const body = page.locator('body');
  await expect(body).not.toContainText(/parked/i);
  await expect(body).not.toContainText(/INTACHAIN mainnet/i);
});

test(`${J} #2 a block with no data keeps its layout and names the indexer; a malformed id and an unclaimed path answer not found`, async ({
  page,
}) => {
  await page.goto('/chain/blocks/123');
  await expect(page.locator('main h1')).toHaveText('Block 123');
  await expect(page.locator('main [data-blocker="indexer"]')).toBeVisible();
  // The indexer reads blocks now; with this journey's node gated off it names why this one could not be read.
  await expect(page.locator('main')).toContainText('This block could not be read: indexer.chain_unreachable');
  // The full layout: the block's details panel with its retry, and its transactions table with every header and the
  // sentence saying when its rows come.
  await expect(page.getByRole('heading', { name: 'Block details', exact: true })).toBeVisible();
  const details = page.locator('main section', { has: page.getByRole('heading', { name: 'Block details', exact: true }) });
  await expect(details.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  const txs = page.getByRole('region', { name: 'Transactions in this block', exact: true }).getByRole('table');
  await expect(txs.getByRole('columnheader')).toHaveText(['Hash', 'From', 'To', 'Status']);
  await expect(txs).toContainText('Its transactions are listed once the block can be read.');

  await page.goto('/chain/blocks/abc');
  const malformed = page.locator('main [data-code="protocol.not_found"]');
  await expect(malformed).toBeVisible();
  // The empty state draws its mark before the sentence.
  await expect(malformed).toHaveText(/(^|\W)That id is not a valid .+ on this network, so nothing is looked up\.$/);
  await expect(page.locator('main')).toContainText('Not found on this network');
  await expect(page.locator('main [data-blocker]')).toHaveCount(0);

  await page.goto('/dex/nothing-here');
  const unclaimed = page.locator('main [data-code="protocol.not_found"]');
  await expect(unclaimed).toHaveText(/(^|\W)There is no page at this address on this network\.$/);
  await expect(page.locator('main h1')).toHaveText('Not found on this network');
  await expect(page.locator('main').getByRole('button', { name: 'Back to DEX', exact: true })).toBeVisible();
});

test(`${J} #3 Swap while the node is unreachable lists its blockers in order, chain unreachable first as a crypto network notice`, async ({
  page,
}) => {
  await page.goto('/dex');
  const swap = page.locator('main [data-action="swap"]');
  const button = swap.getByRole('button', { name: 'Swap', exact: true });
  await expect(button).toBeDisabled();
  // The disabled Swap names its first blocker: its title is the chain-unreachable sentence, and the one notice beside it
  // (drawn only for the first blocker) is the crypto network notice.
  await expect(button).toHaveAttribute('title', /^The chain is unreachable/);
  const firstReason = swap.locator(':scope > .protocol-actions__reason');
  await expect(firstReason).toHaveCount(1);
  await expect(firstReason).toHaveAttribute('data-not-connected', 'rail.crypto');
  // The notice's own words: what Swap needs, and that it is off here, with its code.
  await expect(firstReason).toHaveText('Swap needs a live network node or custody signer. It is switched off in this build. rail.crypto');
  await swap.locator('summary', { hasText: 'All blockers' }).click();
  const listed = swap.locator('ol > li');
  await expect(listed.first()).toContainText('The chain is unreachable');
  // The venue and finality checks wait on the indexer. Not answering, the list says so once (no reply, or still checking
  // while the room asks again); answering with the node gated off, it names both: no live venue, height behind unknown.
  const order = await listed.evaluateAll((items) => items.map((item) => item.getAttribute('data-blocker')));
  expect(order[0]).toBe('chain_unreachable');
  const indexerSaid = order.slice(1, -3);
  expect([['source_no_reply'], ['source_checking'], ['venue_not_live', 'behind_unknown']]).toContainEqual(indexerSaid);
  expect(order.slice(-3)).toEqual(['no_execution_path', 'not_audited', 'network_label']);
  await expect(listed.last()).toHaveText('Base Sepolia test network. Testnet only.');
  await expect(swap).not.toContainText(/INTACHAIN mainnet/i);
});

test(`${J} #4 Connect wallet lists the browser wallet by its own name; connecting shows the address and the wallet chip`, async ({
  page,
}) => {
  const wallet = await installTestWallet(page, { chainId: 84532 });
  // A second browser wallet announces itself beside the TEST wallet; each is offered by its own name.
  await page.addInitScript(() => {
    const provider = {
      request: async () => Promise.reject(Object.assign(new Error('TEST Other Wallet stays unconnected'), { code: 4001 })),
      on() {},
      removeListener() {},
    };
    const info = { uuid: '00000000-0000-4000-8000-0000000000b2', name: 'TEST Other Wallet', rdns: 'test.intafaced.other', icon: '' };
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });
  await page.goto('/wallet');
  await expect(page.getByRole('button', { name: `Connect ${TEST_WALLET.name}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect TEST Other Wallet', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}`, exact: true }).click();
  await expect(page.locator('[data-wallet-address]')).toHaveText(wallet.address);
  await expect(page.locator('[data-wallet-network="ok"]')).toHaveText('Base Sepolia test network. Testnet only.');
  await expect(walletChip(page)).toHaveText(`${TEST_WALLET.name} · ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`);
  expect((await walletChip(page).textContent()).split(' · ')[1]).toMatch(SHORT);
});

test(`${J} #5 a wallet switched to Ethereum mainnet reads "Wrong network" with a switch request; switching back restores the label`, async ({
  page,
}) => {
  const wallet = await installTestWallet(page, { chainId: 84532 });
  const short = `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`;
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}`, exact: true }).click();
  await expect(walletChip(page)).toHaveText(`${TEST_WALLET.name} · ${short}`);

  await wallet.setChain(1);
  await expect(walletChip(page)).toHaveText(`Wrong network · ${short}`);
  await expect(page.locator('[data-wallet-network="chain_mismatch"]')).toHaveText(
    'This wallet is on another network. Switch it to Base Sepolia test network to continue.',
  );
  await page.getByRole('button', { name: 'Switch network', exact: true }).click();
  await expect(walletChip(page)).toHaveText(`${TEST_WALLET.name} · ${short}`);
  await expect(page.locator('[data-wallet-network="ok"]')).toHaveText('Base Sepolia test network. Testnet only.');
  await expect(page.getByRole('button', { name: 'Switch network', exact: true })).toHaveCount(0);
  await expect(networkChip(page)).toHaveText('Base Sepolia test network · Testnet only');
});

/** The TEST network registry the stack serves with `LOCAL_STACK_PROTOCOL_NETWORKS=published` (protocol-test-networks.json). */
const PUBLISHED = {
  chainId: '0x14a34',
  chainName: 'Base Sepolia test network',
  nativeCurrency: { name: 'TEST Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: ['https://base-sepolia-rpc.test.invalid'],
  blockExplorerUrls: ['https://sepolia.basescan.org'],
};
const FAUCET = { name: 'TEST faucet, a stand-in for a published one', url: 'https://base-sepolia-faucet.test.invalid' };
/** The router the owner's Base Sepolia deployment records (services/svc-protocol/deployments/base-sepolia.json). */
const ROUTER = { address: '0x8d28045bbe8a1aed986751257c5711524a7ec73f', version: 'v1' };

/** Runs `body` while svc-protocol serves the TEST published network registry, then puts the owner's registry back. */
async function withPublishedNetworks(body) {
  restartWithSetting('protocol', 'LOCAL_STACK_PROTOCOL_NETWORKS', 'published');
  try {
    await body();
  } finally {
    restartWithSetting('protocol', 'LOCAL_STACK_PROTOCOL_NETWORKS', null);
  }
}

const networkCard = (page) => page.locator('main section').filter({ has: page.getByRole('heading', { name: 'Network', exact: true }) });
const fact = (page, label) =>
  networkCard(page)
    .locator('dl div')
    .filter({ has: page.locator('dt', { hasText: new RegExp(`^${label.replace(/[()]/g, '\\$&')}$`) }) })
    .locator('dd');

test(`${J} #6 the network card shows the name and chain id, "RPC: Not published" and Add to wallet disabled with its blocker; once published, Add to wallet adds exactly those values`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  const wallet = await installTestWallet(page, { chainId: 84532 });
  await page.goto('/chain');
  const card = networkCard(page);
  await expect(fact(page, 'Name')).toHaveText('Base Sepolia test network');
  await expect(fact(page, 'Chain id')).toHaveText('84532');
  await expect(fact(page, 'RPC address')).toHaveText('Not published');
  // A wallet is installed, so the only thing keeping the button off is the unpublished network entry.
  await expect(card.getByRole('button', { name: 'Add to wallet', exact: true })).toBeDisabled();
  await expect(card).toContainText(
    'Blocked: the owner has not published this network name, RPC address and currency (protocol.network_params_unset)',
  );
  expect(wallet.added).toHaveLength(0);

  // Once published (the stack's TEST registry), the card shows the published values and the button adds exactly them.
  await withPublishedNetworks(async () => {
    await page.goto('/chain');
    await expect(fact(page, 'Name')).toHaveText(PUBLISHED.chainName);
    await expect(fact(page, 'Chain id')).toHaveText('84532');
    await expect(fact(page, 'RPC address')).toHaveText(PUBLISHED.rpcUrls[0]);
    await expect(fact(page, 'Native currency (decimals)')).toHaveText('ETH (18)');
    const add = card.getByRole('button', { name: 'Add to wallet', exact: true });
    await expect(add).toBeEnabled();
    await expect(card).not.toContainText('protocol.network_params_unset');
    await add.click();
    await expect(card.getByRole('status')).toHaveText('The wallet accepted the network.');
    expect(wallet.added).toEqual([[PUBLISHED]]);
  });
});

test(`${J} #7 faucets for the test network and the supported chains and routers are listed honestly, and fast confirmations read "Not confirmed"`, async ({
  page,
}) => {
  test.setTimeout(300_000);
  // While the owner has published no faucet, the list says so instead of inventing one.
  await page.goto('/chain');
  await expect(page.getByRole('heading', { name: 'Faucets', exact: true })).toBeVisible();
  await expect(page.locator('main [data-list="faucets"]')).toHaveText('None listed.');

  await withPublishedNetworks(async () => {
    await page.goto('/chain');
    await expect(page.getByRole('heading', { name: 'Faucets', exact: true })).toBeVisible();
    await expect(page.locator('main')).toContainText('Third-party faucets only. This platform holds no key to send test funds.');
    // The test network's published faucet, as a link to its own address.
    const faucet = page.locator('main').getByRole('link', { name: FAUCET.name, exact: true });
    await expect(faucet).toHaveAttribute('href', FAUCET.url);
    await expect(page.locator('main [data-list="faucets"]')).toHaveCount(0);

    await page.goto('/dex/venue');
    const table = page.getByRole('region', { name: 'Supported networks', exact: true }).getByRole('table');
    const row = (chain) => table.locator('tr').filter({ hasText: chain });
    // Each supported chain, and the router recorded for it with its version.
    const base = row('Base Sepolia test network (84532)');
    await expect(base).toHaveCount(1);
    await expect(base).toContainText(ROUTER.address);
    await expect(base).toContainText(ROUTER.version);
    await expect(row('Local test chain (31337)')).toHaveCount(1);
    // The configured chain is probed; with no node the probe cannot tell, so it is not confirmed. 31337 is not probed at all,
    // so its unknown chain id reads as not confirmed too.
    await expect(base.locator('[data-fast]')).toHaveText('Not confirmed');
    await expect(base.locator('[data-fast]')).toHaveAttribute('data-probed', 'true');
    const local = row('Local test chain (31337)').locator('[data-fast]');
    await expect(local).toHaveText('Not confirmed');
    await expect(local).toHaveAttribute('data-probed', 'false');
    await expect(table).not.toContainText(/INTACHAIN/);
  });
});

// A TEST token only the TEST wallet knows. Its address is fixed so the sheet can be checked line by line.
const TEST_TOKEN = { address: '0x00000000000000000000000000000000000a11ce', name: 'TEST Token', version: '1', decimals: 6, nonce: 3 };
const SPENDER = '0x000000000000000000000000000000000000beef';

const fillPermit = async (form) => {
  await form.getByLabel('Token contract').fill(TEST_TOKEN.address);
  await form.getByLabel('Spender').fill(SPENDER);
  await form.getByLabel('Amount (whole tokens)').fill('25.5');
  await form.getByLabel('Expires in (minutes)').fill('30');
};

/** The representation panel a fresh wallet sees on its first signing action: tick, sign the message on the sheet. */
async function acceptRepresentation(page) {
  const panel = page.locator('[data-panel="representation"]');
  await expect(panel).toHaveAttribute('data-version', 'TEST-1');
  await panel.getByLabel('I have read this and it is true for me.').check();
  await panel.getByRole('button', { name: 'Accept and sign', exact: true }).click();
  const sheet = page.locator('[data-sheet="sign"]');
  await expect(sheet).toContainText('TEST representation');
  await sheet.getByRole('button', { name: 'Continue in wallet', exact: true }).click();
}

/** What svc-protocol reports for this wallet's representation, through Edge. */
const representationStatus = (page, address) =>
  page.evaluate(async (who) => {
    const input = encodeURIComponent(JSON.stringify({ address: who }));
    const res = await fetch(`/api/protocol/trpc/representation.status?input=${input}`);
    return (await res.json()).result.data;
  }, address);

test(`${J} #8 from a blocked region every Protocol read refuses with the notice and no signing action is offered; otherwise the representation is accepted once, stored with its version and time, and a new version asks again`, async ({
  page,
}) => {
  test.setTimeout(480_000);
  // The blocked-region run: a visitor from the TEST region AA, which svc-protocol does not serve.
  const regionPage = await page.context().newPage();
  restartWith('protocol', 'LOCAL_STACK_TEST_REGION_SERVED', false);
  restartWith('edge', 'LOCAL_STACK_TEST_REGION_SERVED', false);
  try {
    const blocked = await installTestWallet(regionPage, { chainId: 84532, tokens: [TEST_TOKEN] });
    await regionPage.goto('/wallet');
    const notice = regionPage.locator('[data-notice="region"]');
    await expect(notice).toHaveText('This service is not available in your region.', { timeout: 20_000 });
    await expect(notice).toHaveAttribute('data-code', 'denied.region_blocked');
    // Every Protocol read the rooms make refuses for this region, each with the same typed refusal.
    const reads = await regionPage.evaluate(async (address) => {
      const call = async (proc, input) => {
        const q = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
        const res = await fetch(`/api/protocol/trpc/${proc}${q}`);
        const body = await res.json();
        return { proc, status: res.status, code: body.error?.data?.intafacedCode ?? null, data: body.result?.data ?? null };
      };
      return Promise.all([
        call('chainStatus'),
        call('blockers'),
        call('gasPrice'),
        call('capabilities', { chainId: 84532 }),
        call('representation.status', { address }),
      ]);
    }, blocked.address);
    for (const read of reads) expect(read, read.proc).toMatchObject({ status: 403, code: 'denied.region_blocked', data: null });
    // No signing action is offered: no permit form, no representation to accept, and the wallet is never asked.
    await regionPage.getByRole('button', { name: 'Approvals', exact: true }).click();
    await expect(regionPage.locator('main')).toContainText('no signing action is offered');
    await expect(regionPage.locator('[data-form="permit"]')).toHaveCount(0);
    await expect(regionPage.getByRole('button', { name: 'Review and sign', exact: true })).toHaveCount(0);
    await expect(regionPage.locator('[data-panel="representation"]')).toHaveCount(0);
    expect(blocked.requests).toHaveLength(0);
  } finally {
    await regionPage.close();
    restartWith('edge', 'LOCAL_STACK_TEST_REGION_SERVED', true);
    restartWith('protocol', 'LOCAL_STACK_TEST_REGION_SERVED', true);
  }

  // The allowed-region run.
  const wallet = await installTestWallet(page, { chainId: 84532, tokens: [TEST_TOKEN] });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}`, exact: true }).click();
  await expect(page.locator('[data-wallet-address]')).toHaveText(wallet.address);
  await page.getByRole('button', { name: 'Approvals', exact: true }).click();
  const form = page.locator('[data-form="permit"]');
  await fillPermit(form);
  await form.getByRole('button', { name: 'Review and sign', exact: true }).click();

  // No sheet and no wallet prompt for the action until the representation is accepted.
  const panel = page.locator('[data-panel="representation"]');
  await expect(panel.locator('[data-representation-text]')).toContainText('TEST representation');
  await expect(panel.getByRole('button', { name: 'Accept and sign', exact: true })).toBeDisabled();
  expect(wallet.requests).toHaveLength(0);
  const before = Date.now();
  await acceptRepresentation(page);
  // Recorded: the action continues to its own sheet, and the service reports this version accepted, with a time.
  await expect(page.locator('[data-sheet="sign"] dt', { hasText: /^Token$/ })).toBeVisible();
  const status = await representationStatus(page, wallet.address);
  expect(status).toMatchObject({ version: 'TEST-1', accepted: true });
  expect(Date.parse(status.acceptedAt)).toBeGreaterThanOrEqual(before - 5_000);
  await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Cancel', exact: true }).click();

  // Once per version: the next signing action from this wallet goes straight to its sheet.
  await form.getByRole('button', { name: 'Review and sign', exact: true }).click();
  await expect(page.locator('[data-sheet="sign"] dt', { hasText: /^Token$/ })).toBeVisible();
  await expect(panel).toHaveCount(0);
  expect(wallet.requests.filter((r) => r.method === 'personal_sign')).toHaveLength(1);
  await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Cancel', exact: true }).click();

  // A new version asks again: the stack serves TEST-2, and the same wallet's next signing action needs it accepted first.
  restartWithSetting('protocol', 'LOCAL_STACK_PROTOCOL_REPRESENTATION_VERSION', 'TEST-2');
  try {
    expect(await representationStatus(page, wallet.address)).toMatchObject({ version: 'TEST-2', accepted: false });
    await form.getByRole('button', { name: 'Review and sign', exact: true }).click();
    await expect(panel).toHaveAttribute('data-version', 'TEST-2');
    await expect(page.locator('[data-sheet="sign"]')).toHaveCount(0);
    await panel.getByLabel('I have read this and it is true for me.').check();
    await panel.getByRole('button', { name: 'Accept and sign', exact: true }).click();
    await page.locator('[data-sheet="sign"]').getByRole('button', { name: 'Continue in wallet', exact: true }).click();
    await expect(page.locator('[data-sheet="sign"] dt', { hasText: /^Token$/ })).toBeVisible();
    expect(wallet.requests.filter((r) => r.method === 'personal_sign')).toHaveLength(2);
    const again = await representationStatus(page, wallet.address);
    expect(again).toMatchObject({ version: 'TEST-2', accepted: true });
    expect(Date.parse(again.acceptedAt)).toBeGreaterThan(Date.parse(status.acceptedAt));
  } finally {
    restartWithSetting('protocol', 'LOCAL_STACK_PROTOCOL_REPRESENTATION_VERSION', null);
  }
});

test(`${J} #9 a typed-data request shows token, amount, spender and expiry before the wallet asks; a rejection reads "Rejected" and keeps the form`, async ({
  page,
}) => {
  const wallet = await installTestWallet(page, { chainId: 84532, tokens: [TEST_TOKEN] });
  await page.goto('/wallet');
  await page.getByRole('button', { name: `Connect ${TEST_WALLET.name}`, exact: true }).click();
  await expect(page.locator('[data-wallet-address]')).toHaveText(wallet.address);
  await page.getByRole('button', { name: 'Approvals', exact: true }).click();

  const form = page.locator('[data-form="permit"]');
  await fillPermit(form);
  const before = Math.floor(Date.now() / 1000);
  await form.getByRole('button', { name: 'Review and sign', exact: true }).click();
  await acceptRepresentation(page);

  // The sheet comes first: only the representation has reached the wallet so far.
  const sheet = page.locator('[data-sheet="sign"]');
  await expect(sheet.locator('dt', { hasText: /^Token$/ })).toBeVisible();
  expect(wallet.requests.map((r) => r.method)).toEqual(['personal_sign']);
  const fact = (label) => sheet.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');
  await expect(fact('Token')).toHaveText(TEST_TOKEN.address);
  await expect(fact('Spender')).toHaveText(SPENDER);
  await expect(fact('Amount')).toHaveText('25500000');
  const expiry = Number(await fact('Expires').textContent());
  expect(expiry).toBeGreaterThanOrEqual(before + 30 * 60);
  expect(expiry).toBeLessThanOrEqual(before + 30 * 60 + 120);

  wallet.rejectNext();
  await sheet.getByRole('button', { name: 'Continue in wallet', exact: true }).click();
  await expect(page.locator('[data-permit-result="rejected"]')).toHaveText('Rejected. Nothing was signed. Your details are kept below.');
  expect(wallet.requests.map((r) => r.method)).toEqual(['personal_sign', 'eth_signTypedData_v4']);
  await expect(form.getByLabel('Token contract')).toHaveValue(TEST_TOKEN.address);
  await expect(form.getByLabel('Spender')).toHaveValue(SPENDER);
  await expect(form.getByLabel('Amount (whole tokens)')).toHaveValue('25.5');
  await expect(form.getByLabel('Expires in (minutes)')).toHaveValue('30');

  // The same form signs on the next try, and the signature stays on the page.
  await form.getByRole('button', { name: 'Review and sign', exact: true }).click();
  await sheet.getByRole('button', { name: 'Continue in wallet', exact: true }).click();
  await expect(page.locator('[data-permit-signature]')).toHaveText(/^0x[0-9a-f]{130}$/);
  // Accepted once: the second signing action does not ask for the representation again.
  await expect(page.locator('[data-panel="representation"]')).toHaveCount(0);
  const signed = JSON.parse(wallet.requests[2].params[1]);
  expect(signed.primaryType).toBe('Permit');
  expect(signed.domain).toEqual({ name: 'TEST Token', version: '1', chainId: 84532, verifyingContract: TEST_TOKEN.address });
  expect(signed.message).toMatchObject({ owner: wallet.address, spender: SPENDER, value: '25500000', nonce: '3' });
  // The spender needs the exact signed values with the signature, so the page shows them.
  await expect(page.locator('[data-permit-signed]')).toContainText(`"deadline": "${signed.message.deadline}"`);
});
