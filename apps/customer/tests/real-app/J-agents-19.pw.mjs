import { test, expect } from './journey.mjs';
import { UNBUILT, agentCard, agentsRun, openAgents, openNavigatorSession } from './agents.mjs';
import { connectWallet, dexRun } from './dex.mjs';
import { signIn } from './desk.mjs';

// J-agents-19, in the running app (docs/roadmap/journeys.json): let the Navigator act on-chain through a session key I
// can revoke. One test per step, titled "J-agents-19 #<n>", run in order on one verified TEST account with the TEST
// wallet connected on the test network (Base Sepolia, labelled TESTNET). No value moves through INTAFACED: the person
// signs the grant and the revoke in their own wallet, and the key is a ceiling, never consent, so every agent trade
// still asks. A mainnet grant shows the external-audit notice (audit.external); with no signer configured the rail
// notice (rail.crypto).
// What is built: connecting the TEST wallet on /wallet (J-dex-protocol-01) and the Navigator's catalogue card. Steps not
// built yet fail at their first missing part, quickly (UNBUILT):
// - the Navigator has no on-chain panel, grant, scope read or revoke (RC-agents-01);
// - #4: opening a Navigator session is refused for a standard account ("agents:execute").
const J = 'J-agents-19';
const agents = agentsRun(J);
// The wallet key lives in its own run file, so the agents run's account and the wallet's key never overwrite each other.
const wallet = dexRun(`${J}-wallet`);

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');
const onChain = (page) => main(page).getByRole('region', { name: 'On-chain access' });
const grant = (page) => onChain(page).getByRole('form', { name: 'Session key grant' });
const APPROVE = '0x095ea7b3';

/** Signs in, connects the run's TEST wallet and opens the Navigator's on-chain panel from its details. */
async function openOnChain(page) {
  await signIn(page, agents.account());
  await connectWallet(page, wallet);
  await openAgents(page, agents);
  await agentCard(page, 'Navigator').getByRole('button', { name: 'Details' }).click();
  await expect(onChain(page)).toBeVisible(UNBUILT);
}

test(`${J} starts: a verified TEST account with the TEST wallet connected on the test network`, async ({ page }) => {
  test.setTimeout(240_000);
  await agents.start(page, 'ag19', '10');
  wallet.start();
  await signIn(page, agents.account());
  await connectWallet(page, wallet);
});

test(`${J} #1 prepares a grant with the spend cap blank: a refusal naming the cap`, async ({ page }) => {
  await openOnChain(page);
  await grant(page).getByRole('button', { name: 'Prepare grant' }).click();
  await expect(grant(page).getByRole('alert')).toContainText('Spend cap');
});

test(`${J} #2 adds a target list that includes an approve selector: the grant is refused and nothing is built`, async ({ page }) => {
  await openOnChain(page);
  await grant(page)
    .getByRole('textbox', { name: /^Spend cap/ })
    .fill('1');
  await grant(page)
    .getByRole('textbox', { name: /^Allowed calls/ })
    .fill(APPROVE);
  await grant(page).getByRole('button', { name: 'Prepare grant' }).click();
  await expect(grant(page).getByRole('alert')).toContainText('A session key may not approve or permit tokens.');
  await expect(onChain(page).getByTestId('unsigned-call')).toHaveCount(0);
});

test(`${J} #3 prepares a valid test-network grant: scope, expiry and status read from the chain, labelled TESTNET, and the unsigned call`, async ({
  page,
}) => {
  await openOnChain(page);
  await grant(page)
    .getByRole('textbox', { name: /^Spend cap/ })
    .fill('1');
  await grant(page)
    .getByRole('textbox', { name: /^Allowed calls/ })
    .fill('');
  await grant(page).getByRole('combobox', { name: 'Expires' }).selectOption({ label: 'In 1 day' });
  await grant(page).getByRole('button', { name: 'Prepare grant' }).click();
  await expect(onChain(page).getByText('TESTNET')).toBeVisible();
  for (const term of ['Scope', 'Expiry', 'Status']) await expect(onChain(page).getByRole('term').filter({ hasText: term })).toBeVisible();
  await expect(onChain(page).getByTestId('unsigned-call')).toHaveText(/^0x[0-9a-f]+$/);
});

test(`${J} #4 asks the agent to trade with a live key: an approval request is still created; the key is a ceiling, not consent`, async ({
  page,
}) => {
  await openNavigatorSession(page, agents);
  const workspace = main(page).getByRole('region', { name: 'Session workspace' });
  await workspace.getByRole('textbox', { name: /^Ask the agent/ }).fill('TEST: swap 0.1 TEST Token A for TEST Token B on-chain');
  await workspace.getByRole('button', { name: 'Run' }).click();
  await expect(workspace.getByRole('region', { name: 'Approval request' })).toBeVisible();
  await expect(workspace).toContainText('A session key is a ceiling, not your consent.');
});

test(`${J} #5 revokes: the unsigned revoke call, and the binding reads revoking until the chain reads revoked`, async ({ page }) => {
  await openOnChain(page);
  await onChain(page).getByRole('button', { name: 'Revoke' }).click();
  await expect(onChain(page).getByTestId('unsigned-call')).toHaveText(/^0x[0-9a-f]+$/);
  await expect(onChain(page).getByTestId('binding-status')).toHaveText(/^(Revoking|Revoked)$/);
});
