// World: stack, restart
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from './journey.mjs';
import { ROOT, journeyState, mailedCodes, nextMailedCode } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { addAuthenticator, nextCode } from './identity-factors.mjs';
import {
  ADDRESS,
  DEVICE_ADDRESS,
  accountSteps,
  addForm,
  approvalLinks,
  bankRowOnReload,
  field,
  nextApprovalLink,
  savedRows,
  totpLib,
  withBankSetting,
} from './withdraw-addresses.mjs';

// J-wallet-04 #5, in the running app (docs/roadmap/journeys.json), apart from the rest of J-wallet-04.pw.mjs so the two
// run in separate shards. W-withdraw-09: a new address waits for approval by an emailed link (the stack's LOCAL-TEST
// outbox) or from another signed-in device, an expired link needs a new one, and the cooling-off starts at approval.
// It runs on its own verified TEST account with an authenticator app, made by the setup test below, because saving and
// removing an address each ask for a fresh confirmation; its book starts empty and it removes what it saved. Every
// journey browser presents the stack's one TEST device key, so "another device" is a browser with its cookies cleared,
// authorised by the mailed device code, as J-identity-02 #5 does. The owner's cooling-off left blank is svc-bank
// restarted on that one TEST setting (LOCAL_STACK_BANK_OFFRAMP_COOLING) and put back after.
const J = 'J-wallet-04';
const run = journeyState(`${J}-approval-${process.env.JOURNEY_RUN_ID ?? 'local'}`);

test.describe.configure({ mode: 'default' });

const { account, signInWithCode, confirmItsMe } = accountSteps(run, J, 'starts (approval)');

test(`${J} starts (approval): a verified TEST account with an authenticator app and an empty address book`, async ({ page }) => {
  test.setTimeout(180_000);
  const who = await signUp(page, 'wb');
  await verify(page, who);
  await signIn(page, who);
  const { totp } = await totpLib();
  const { secret, step } = await addAuthenticator(page, totp);
  run.reset({ account: who, secret, step });
  await page.goto('/uc/withdraw/address');
  await expect(page.getByText('You have no saved withdrawal addresses.')).toBeVisible();
});

test(`${J} #5 a new address waits for approval by an emailed link (an expired one needs a new one) or from another signed-in device, never the one that saved it`, async ({
  page,
  browser,
}) => {
  test.setTimeout(900_000);
  const { account: who } = account();
  await signInWithCode(page);
  await page.goto('/uc/withdraw/address');
  const form = addForm(page);
  await field(page, 'Label').fill('TEST new wallet');
  await field(page, 'Asset').selectOption('USDT');
  await field(page, 'Network').selectOption('ethereum');
  await field(page, 'Address').fill(ADDRESS);
  await form.getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST new wallet was saved to your address book. Approve it before it can be used.')).toBeVisible();

  // Saved, not approved: no cooling-off yet, and the bank sends nothing to it.
  const row = savedRows(page).filter({ hasText: 'TEST new wallet' });
  await expect(row).toContainText('Waiting for approval');
  await expect(row.locator('td').nth(5)).toHaveText('Starts once approved');
  await row.getByRole('button', { name: 'Withdraw to this address' }).click();
  const use = page.getByTestId('address-use');
  await expect(use.getByRole('alert')).toHaveText(
    'TEST new wallet is waiting for your approval, so nothing can be sent to it. Approve it on another device where you are signed in, or ask for an approval link by email and open it; its cooling-off starts when you approve it.',
  );

  // Ask for a link: the page says it was asked for and until when it works, never that it arrived.
  const before = approvalLinks(who.email).length;
  await use.getByRole('button', { name: 'Email me an approval link' }).click();
  await expect(use.getByTestId('address-approval-mail').getByRole('status')).toContainText(
    'We asked for an approval link to be sent to the email address on your account. It works until',
  );
  const first = await nextApprovalLink(who.email, before);

  // The link runs out (a LOCAL TEST fixture moves its times back): approving with it is refused, and nothing changes.
  const expired = spawnSync(
    process.execPath,
    [path.join(ROOT, 'tooling/scripts/local-test-stack.mjs'), 'expire-address-approvals', who.email],
    { encoding: 'utf8' },
  );
  expect(expired.status, expired.stderr).toBe(0);
  expect(expired.stdout).toContain('1 open address approval link(s)');
  await page.goto(first);
  await expect(page).toHaveURL(/\/approveAddress$/);
  const approve = page.getByTestId('approve-address');
  await approve.getByRole('button', { name: 'Approve' }).click();
  await confirmItsMe(page);
  await expect(approve.getByRole('alert')).toHaveText('This link has run out. Open Addresses and ask for a new one.');
  await expect(page.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();

  // A new link, opened in another browser that is not signed in: sign in first, then approve with it.
  await page.goto('/uc/withdraw/address');
  await savedRows(page).filter({ hasText: 'TEST new wallet' }).getByRole('button', { name: 'Withdraw to this address' }).click();
  await page.getByTestId('address-use').getByRole('button', { name: 'Email me an approval link' }).click();
  await expect(page.getByTestId('address-approval-mail').getByRole('status')).toContainText('We asked for an approval link');
  const second = await nextApprovalLink(who.email, before + 1);
  expect(second).not.toBe(first);

  const other = await browser.newContext();
  try {
    const away = await other.newPage();
    await away.goto(second);
    await away.getByRole('link', { name: 'Sign in' }).last().click();
    await expect(away).toHaveURL(/\/login\?redirect=/);
    const state = account();
    const { totp } = await totpLib();
    const { code, step } = await nextCode(totp, state.secret, state.step);
    run.reset({ ...state, step });
    await away.fill('input[name=totp]', code);
    await away.fill('input[name=identifier]', who.email);
    await away.fill('input[name=password]', who.password);
    await away.getByRole('button', { name: /^sign in$/i }).click();
    // Back on the approval page, with the token already out of the address bar.
    await expect(away).toHaveURL(/\/approveAddress$/);
    const there = away.getByTestId('approve-address');
    await there.getByRole('button', { name: 'Approve' }).click();
    await confirmItsMe(away);
    await expect(away.getByRole('heading', { name: 'Address approved' })).toBeVisible();
    const done = (await there.getByRole('status').textContent()) ?? '';
    const ends = /from (.+), when its cooling-off ends\.$/.exec(done)?.[1];
    expect(ends, done).toBeTruthy();

    // The book now says cooling off, ending when the approval page said, and the bank refuses to send until then.
    await page.reload();
    const approved = savedRows(page).filter({ hasText: 'TEST new wallet' });
    await expect(approved).toContainText('Cooling off');
    await expect(approved.locator('td').nth(5)).toHaveText(`Ends ${ends}`);
    await approved.getByRole('button', { name: 'Withdraw to this address' }).click();
    await expect(page.getByTestId('address-use').getByRole('alert')).toHaveText(
      `TEST new wallet is a new address. Money can be sent to it from ${ends}, when its cooling-off ends.`,
    );
  } finally {
    await other.close();
  }

  // The owner's cooling-off left blank (the stack restarted without it): the bank sends nothing to the approved address,
  // and says the window is not published rather than inventing one. Back on the TEST value, it names its end again.
  await withBankSetting('LOCAL_STACK_BANK_OFFRAMP_COOLING', 'off', async () => {
    await page.goto('/uc/withdraw/address');
    const held = await bankRowOnReload(page, 'TEST new wallet');
    expect([held.coolingOffEndsAt, held.coolingBlocker]).toEqual([null, 'bank.offramp_cooling_unset']);
    const unset = savedRows(page).filter({ hasText: 'TEST new wallet' });
    await expect(unset.locator('td').nth(5)).toHaveText('No cooling-off period is published');
    const readiness = page.waitForResponse((res) => /\/api\/bank\/trpc\/ramps\.destinations\.readiness/.test(res.url()), {
      timeout: 30_000,
    });
    await unset.getByRole('button', { name: 'Withdraw to this address' }).click();
    expect(JSON.stringify(await (await readiness).json())).toContain('"cooling_unset"');
    await expect(page.getByTestId('address-use').getByRole('alert')).toHaveText(
      'The bank has published no cooling-off period, so nothing can be sent to TEST new wallet.',
    );
  });
  await page.goto('/uc/withdraw/address');
  await savedRows(page).filter({ hasText: 'TEST new wallet' }).getByRole('button', { name: 'Withdraw to this address' }).click();
  await expect(page.getByTestId('address-use').getByRole('alert')).toContainText(
    'TEST new wallet is a new address. Money can be sent to it from',
  );

  // From another device. A second address saved in this browser cannot be approved in this browser.
  await page.goto('/uc/withdraw/address');
  await field(page, 'Label').fill('TEST device wallet');
  await field(page, 'Asset').selectOption('USDT');
  await field(page, 'Network').selectOption('ethereum');
  await field(page, 'Address').fill(DEVICE_ADDRESS);
  await addForm(page).getByRole('button', { name: 'Save address' }).click();
  await confirmItsMe(page);
  await expect(page.getByText('TEST device wallet was saved to your address book. Approve it before it can be used.')).toBeVisible();
  await savedRows(page).filter({ hasText: 'TEST device wallet' }).getByRole('button', { name: 'Withdraw to this address' }).click();
  const here = page.getByTestId('address-approve-here');
  await here.getByRole('button', { name: 'Approve on this device' }).click();
  await confirmItsMe(page);
  await expect(here.getByRole('alert')).toHaveText(
    'This address was saved on this device, so it cannot be approved here. Approve it on another device where you are signed in, or by the emailed link.',
  );
  await page.reload();
  await expect(savedRows(page).filter({ hasText: 'TEST device wallet' })).toContainText('Waiting for approval');

  // A browser this account never used: its cookies cleared, signed in, and authorised by the mailed device code.
  const device = await browser.newContext();
  try {
    await device.clearCookies();
    const away = await device.newPage();
    const seen = mailedCodes(who.email, 'new-device-code').length;
    const state = account();
    const { totp } = await totpLib();
    const { code, step } = await nextCode(totp, state.secret, state.step);
    run.reset({ ...state, step });
    await away.goto('/login');
    await away.fill('input[name=totp]', code);
    await away.fill('input[name=identifier]', who.email);
    await away.fill('input[name=password]', who.password);
    await away.getByRole('button', { name: /^sign in$/i }).click();
    // With the owner's new-device check on, the browser is authorised by the mailed code; with it off (the stack's
    // value until J-identity-02 #5 turns it on), identity trusts the browser as it signs in. Either way it is its own device.
    const authorise = away.getByRole('heading', { name: 'Authorise this device' });
    await Promise.race([
      away.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 10_000 }),
      authorise.waitFor({ timeout: 10_000 }),
    ]);
    if (await authorise.isVisible()) {
      await away.getByLabel('Device code from the email').fill(await nextMailedCode(who.email, seen, 20_000, 'new-device-code'));
      await away.getByRole('button', { name: 'Approve this device' }).click();
    }
    await expect(away).not.toHaveURL(/\/login/, { timeout: 10_000 });

    // There, the waiting address is approved after a fresh confirmation, and its cooling-off starts then.
    await away.goto('/uc/withdraw/address');
    const waiting = savedRows(away).filter({ hasText: 'TEST device wallet' });
    await expect(waiting).toContainText('Waiting for approval');
    await waiting.getByRole('button', { name: 'Withdraw to this address' }).click();
    await away.getByTestId('address-approve-here').getByRole('button', { name: 'Approve on this device' }).click();
    await confirmItsMe(away);
    const approvedHere = away.getByTestId('address-approve-here').getByRole('status');
    await expect(approvedHere).toContainText('TEST device wallet is approved. Money can be sent to it from');
    const text = (await approvedHere.textContent()) ?? '';
    const from = /from (.+), when its cooling-off ends\.$/.exec(text)?.[1];
    expect(from, text).toBeTruthy();

    // The browser that saved it sees it cooling off, ending when the other device said.
    await page.reload();
    const cooling = savedRows(page).filter({ hasText: 'TEST device wallet' });
    await expect(cooling).toContainText('Cooling off');
    await expect(cooling.locator('td').nth(5)).toHaveText(`Ends ${from}`);
  } finally {
    await device.close();
  }

  // Leave the book as #6 expects it: both entries removed again.
  for (const label of ['TEST new wallet', 'TEST device wallet']) {
    await savedRows(page).filter({ hasText: label }).getByRole('button', { name: 'Remove' }).click();
    await confirmItsMe(page);
    await expect(page.getByText(`${label} was removed from your address book.`)).toBeVisible();
  }
});
