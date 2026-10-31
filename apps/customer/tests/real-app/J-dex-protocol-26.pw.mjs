import { test, expect } from './journey.mjs';
import { TOKEN_A, UNBUILT, connectWallet, dexRun, oneAmount, seededWallet, walletSection } from './dex.mjs';
import { bodyRows, tableIn } from './tables.mjs';

// J-dex-protocol-26, in the running app (docs/roadmap/journeys.json): hold a crew vault, set up inheritance and name
// recovery guardians. One test per step, titled "J-dex-protocol-26 #<n>", run in order with one TEST wallet holding
// TEST Token A, a crew of three TEST addresses and the person's own smart account. Funds sit in contracts the members
// sign; share payouts always sum to the balance; nothing posts to the ledger. audit.external for mainnet; rail.crypto
// while the node is absent.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - the wallet room has no Crew vault, Legacy vault or Recovery section (RC-dex-protocol-11, -12, -15); its Safety
//   section shows only "No safety notices". The legacy vault and user-elected recovery are proven on chain in
//   services/svc-protocol (legacy-vault.onchain.test.ts, user-elected-recovery.onchain.test.ts), but no room opens them;
// - the stack has no TEST chain or clock control, so #2, #3, #5, #6 and #8 open TEST vaults of the stack in the state the
//   step names (spends with one and two approvals, a started succession, a passed window, a pending rotation) as the
//   stack's seeded TEST wallet (dex.mjs), their member, owner or heir; the stack will seed them when the rooms are built.
const J = 'J-dex-protocol-26';
const dex = dexRun(J);
const CREW = [
  { address: '0x52908400098527886E0F7030069857D2E4169EE7', bps: '5000' },
  { address: '0x0000000000000000000000000000000000000a01', bps: '3000' },
  { address: '0x0000000000000000000000000000000000000a02', bps: '2000' },
];

test.describe.configure({ mode: 'default' });

const main = (page) => page.getByRole('main');

/** Opens one wallet section with the run's wallet (or `as`) connected. */
async function openSection(page, name, as = dex) {
  const wallet = await connectWallet(page, as, { tokens: [TOKEN_A] });
  await walletSection(page, name);
  return wallet;
}

/** Signs whatever the open sheet asks for. */
async function sign(page) {
  await page.getByRole('dialog', { name: 'Check before you sign' }).getByRole('button', { name: 'Continue in wallet' }).click();
}

/** The crew vault form filled with `crew`, as basis points, and a threshold. */
async function crewForm(page, crew, threshold) {
  await main(page).getByRole('button', { name: 'New crew vault' }).click(UNBUILT);
  const form = main(page).getByRole('form', { name: 'New crew vault' });
  for (const [i, member] of crew.entries()) {
    const row = form.getByRole('group', { name: `Member ${i + 1}` });
    await row.getByRole('textbox', { name: /^Address/ }).fill(member.address);
    await row.getByRole('textbox', { name: /^Share \(basis points\)/ }).fill(member.bps);
  }
  await form.getByRole('spinbutton', { name: /^Approvals needed/ }).fill(threshold);
  return form;
}

/** A TEST vault of the stack in the named state, in the given section, opened as the stack's seeded TEST wallet. */
async function seeded(page, section, name) {
  await openSection(page, section, seededWallet);
  const vault = main(page).getByRole('region', { name });
  await expect(vault).toBeVisible(UNBUILT);
  return vault;
}

test(`${J} starts: a connected TEST wallet, a crew of three and a smart account the person owns`, async ({ page }) => {
  dex.start();
  await connectWallet(page, dex, { tokens: [TOKEN_A] });
});

test(`${J} #1 creates a crew vault with shares of 5000, 3000 and 2000 and a threshold of 2: shares and threshold shown; shares not summing to 10000 refused`, async ({
  page,
}) => {
  const wallet = await openSection(page, 'Crew vault');
  const bad = await crewForm(page, [...CREW.slice(0, 2), { ...CREW[2], bps: '1999' }], '2');
  await bad.getByRole('button', { name: 'Review' }).click();
  await expect(bad.getByRole('alert')).toContainText('Shares must add up to 10000; these add up to 9999');
  expect(wallet.sends).toHaveLength(0);
  await page.reload();
  await walletSection(page, 'Crew vault');
  const form = await crewForm(page, CREW, '2');
  await form.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  const vault = main(page).getByRole('region', { name: 'Your crew vault' });
  const members = tableIn(vault, 'Members');
  for (const member of CREW) await expect(bodyRows(members).filter({ hasText: member.address })).toContainText(member.bps);
  await expect(vault.getByTestId('crew-threshold')).toHaveText('2 of 3 approvals to spend');
});

test(`${J} #2 proposes a spend and two members approve: execute pays it; a second execute refused; one approval alone refused`, async ({
  page,
}) => {
  const vault = await seeded(page, 'Crew vault', 'TEST crew vault');
  const spends = tableIn(vault, 'Spends');
  // Two TEST spends of the seeded vault, named so a row keeps its name when its state changes.
  const short = bodyRows(spends).filter({ hasText: 'TEST spend with one approval' });
  await short.getByRole('button', { name: 'Execute' }).click();
  await expect(vault.getByRole('alert')).toContainText('Short of the threshold: 1 of 2 approvals');
  const ready = bodyRows(spends).filter({ hasText: 'TEST spend with two approvals' });
  await ready.getByRole('button', { name: 'Execute' }).click();
  await sign(page);
  await expect(ready).toContainText('Paid', { timeout: 60_000 });
  await expect(ready.getByRole('button', { name: 'Execute' })).toHaveCount(0);
});

test(`${J} #3 a member exits: payouts in any order sum to the balance`, async ({ page }) => {
  const vault = await seeded(page, 'Crew vault', 'TEST crew vault');
  const balance = oneAmount(await vault.getByTestId('crew-balance').innerText());
  await vault.getByRole('button', { name: 'Exit the vault' }).click();
  await sign(page);
  // Every member's payout, whoever exits first, adds up to the balance exactly.
  const payouts = tableIn(vault, 'Payouts');
  await expect(bodyRows(payouts)).toHaveCount(CREW.length, { timeout: 60_000 });
  let sum = 0n;
  for (const text of await bodyRows(payouts).getByTestId('payout-amount').allInnerTexts()) sum += oneAmount(text);
  expect(sum).toBe(balance);
});

test(`${J} #4 creates a legacy vault with heirs, a 30-day inactivity delay (TEST) and a challenge window: the timer, heirs and stages; a zero delay refused`, async ({
  page,
}) => {
  await openSection(page, 'Legacy vault');
  await main(page).getByRole('button', { name: 'New legacy vault' }).click(UNBUILT);
  const form = main(page).getByRole('form', { name: 'New legacy vault' });
  await form.getByRole('textbox', { name: /^Heir address/ }).fill(CREW[0].address);
  await form.getByRole('spinbutton', { name: /^Inactivity delay \(days\)/ }).fill('0');
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(form.getByRole('alert')).toContainText('The inactivity delay must be more than 0');
  await form.getByRole('spinbutton', { name: /^Inactivity delay \(days\)/ }).fill('30');
  await form.getByRole('spinbutton', { name: /^Challenge window \(days\)/ }).fill('7');
  await form.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  const vault = main(page).getByRole('region', { name: 'Your legacy vault' });
  await expect(vault.getByTestId('legacy-timer')).toHaveText(/^Passes to your heirs after 30 days without a check-in/, {
    timeout: 60_000,
  });
  await expect(bodyRows(tableIn(vault, 'Heirs'))).toHaveCount(1);
  await expect(bodyRows(tableIn(vault, 'Release stages'))).not.toHaveCount(0);
});

test(`${J} #5 checks in: the timer resets; a check-in inside the challenge window aborts a started succession`, async ({ page }) => {
  const vault = await seeded(page, 'Legacy vault', 'TEST legacy vault in succession');
  await expect(vault).toContainText('Succession started');
  await vault.getByRole('button', { name: 'Check in' }).click();
  await sign(page);
  await expect(vault).toContainText('Succession aborted: you checked in', { timeout: 60_000 });
  await expect(vault.getByTestId('legacy-timer')).toHaveText(/^Passes to your heirs after 30 days without a check-in/);
});

test(`${J} #6 an heir claims after the window: the first stage releases, the remainder after the stage delay`, async ({ page }) => {
  const vault = await seeded(page, 'Legacy vault', 'TEST legacy vault for an heir');
  await vault.getByRole('button', { name: 'Claim stage 1' }).click();
  await sign(page);
  const stages = tableIn(vault, 'Release stages');
  await expect(bodyRows(stages).filter({ hasText: 'Stage 1' })).toContainText('Released', { timeout: 60_000 });
  await expect(bodyRows(stages).filter({ hasText: 'Stage 2' })).toContainText(/Releases after \d+ days/);
  await expect(vault.getByRole('button', { name: 'Claim stage 2' })).toBeDisabled();
});

test(`${J} #7 picks three recovery guardians and a threshold of 2: guardians are not heirs and claim no funds; a threshold above the count refused`, async ({
  page,
}) => {
  await openSection(page, 'Recovery');
  await main(page).getByRole('button', { name: 'Choose guardians' }).click(UNBUILT);
  const form = main(page).getByRole('form', { name: 'Recovery guardians' });
  for (const [i, member] of CREW.entries()) await form.getByRole('textbox', { name: `Guardian ${i + 1}` }).fill(member.address);
  await form.getByRole('spinbutton', { name: /^Guardians needed/ }).fill('4');
  await form.getByRole('button', { name: 'Review' }).click();
  await expect(form.getByRole('alert')).toContainText('You need at most 3 guardians to agree');
  await form.getByRole('spinbutton', { name: /^Guardians needed/ }).fill('2');
  await expect(form.getByRole('note')).toContainText(
    'Guardians can only replace your account owner. They are not heirs and cannot take funds.',
  );
  await form.getByRole('button', { name: 'Review' }).click();
  await sign(page);
  await expect(bodyRows(tableIn(main(page), 'Guardians'))).toHaveCount(3, { timeout: 60_000 });
});

test(`${J} #8 two guardians propose a new owner and the owner cancels inside the delay: execution refused before the delay; cancel clears it; a delay of 0 refused`, async ({
  page,
}) => {
  const recovery = await seeded(page, 'Recovery', 'TEST pending rotation');
  await recovery.getByRole('button', { name: 'Execute rotation' }).click();
  await expect(recovery.getByRole('alert')).toContainText(/^Too early: the rotation can run after/);
  await recovery.getByRole('button', { name: 'Cancel rotation' }).click();
  await sign(page);
  await expect(recovery).toContainText('No rotation pending', { timeout: 60_000 });
  const delay = main(page).getByRole('form', { name: 'Recovery delay' });
  await delay.getByRole('spinbutton', { name: /^Delay \(days\)/ }).fill('0');
  await delay.getByRole('button', { name: 'Review' }).click();
  await expect(delay.getByRole('alert')).toContainText('The delay must be more than 0');
});
