import { test, expect } from '@playwright/test';
import { api, fund, journeyState, signOutBrowser, toUnits } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';

// J-pay-03, in the running app (docs/roadmap/journeys.json): pick my handle, let people find me, and receive a payment.
// One test per step, titled "J-pay-03 #<n>", run in order on two verified TEST accounts: R receives, F is the friend (a
// stranger to R, not in R's contacts) who holds TEST 100 USDT and pays. The handle rules and the lifetime change cap are
// the stack's TEST identity terms; balances are read through each person's own API.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #2: Receive has no way to change the handle.
// - #3: "Let people find me" is off and stored by no service ("Pay preferences are not stored by any service").
// - #4: Send has no QR scan or image upload, so a scanned code can't be checked; the copied link opens a prefilled Send.
// - #5: no setting for payments from people not in contacts, and no pending payment to accept or deny.
// - #6: no way to add an email or phone to receive by.
const J = 'J-pay-03';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function people() {
  const { receiver, friend } = run.read();
  if (!receiver || !friend) throw new Error(`${J} #1 made no accounts, so this step has no one to act as`);
  return { receiver, friend };
}

const receive = (page) => page.getByRole('region', { name: 'Pay' });
const usdt = async (who) => (await (await api(who)).balances()).USDT?.free ?? '0';

async function openReceive(page) {
  await page.goto('/pay/receive');
  await expect(receive(page).getByRole('tab', { name: 'Receive' })).toHaveAttribute('aria-selected', 'true');
}

/** The handle as Receive shows it now, without the @. */
async function shownHandle(page) {
  const text = await receive(page).getByRole('heading', { name: 'Your handle' }).locator('xpath=following-sibling::p[1]').innerText();
  return text.trim().replace(/^@/, '');
}

/** F types `handle` into Send's To and leaves the field. */
async function lookUp(page, handle) {
  await page.goto('/pay');
  const to = page.getByLabel('Handle');
  await to.fill(handle);
  await to.press('Tab');
}

test(`${J} #1 opens Receive: the handle with a Copy button and the toast "Copied"`, async ({ page, context }) => {
  test.setTimeout(240_000);
  const friend = await signUp(page, 'jpf');
  await verify(page, friend);
  expect(fund(friend.email, 'USDT', '100').tx).toBeTruthy();
  const receiver = await signUp(page, 'jpr');
  await verify(page, receiver);
  run.reset({ receiver, friend });

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page, receiver);
  await openReceive(page);
  expect(await shownHandle(page)).toBe(receiver.handle);
  await receive(page).getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(receiver.handle);
});

test(`${J} #2 changes the handle: a rule-breaking one gets the reason naming the rule; past the lifetime cap it refuses with the count`, async ({
  page,
}) => {
  const { receiver } = people();
  await signIn(page, receiver);
  await openReceive(page);
  await receive(page).getByRole('button', { name: 'Change handle' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Change your handle' });
  // Too short and with a space: the reason names the rule it breaks.
  await sheet.getByLabel('New handle').fill('a b');
  await sheet.getByRole('button', { name: 'Save handle' }).click();
  await expect(sheet.getByText(/letters, numbers/i)).toBeVisible();

  // Valid changes until the TEST lifetime cap; the next one names the count.
  let current = receiver.handle;
  for (let i = 0; i < 10; i++) {
    const next = `${receiver.handle}x${i}`;
    await sheet.getByLabel('New handle').fill(next);
    await sheet.getByRole('button', { name: 'Save handle' }).click();
    const capped = sheet.getByText(/You have changed your handle \d+ times, the most allowed/);
    if (await capped.isVisible().catch(() => false)) break;
    await expect(sheet).toBeHidden();
    current = next;
    await receive(page).getByRole('button', { name: 'Change handle' }).click();
  }
  await expect(sheet.getByText(/You have changed your handle \d+ times, the most allowed/)).toBeVisible();
  run.write({ receiver: { ...receiver, handle: current } });
  await page.keyboard.press('Escape');
  await openReceive(page);
  expect(await shownHandle(page)).toBe(current);
});

test(`${J} #3 turns discoverability off: handle search finds nothing for others, and a QR link still pays`, async ({ page }) => {
  const { receiver, friend } = people();
  await signIn(page, receiver);
  await page.goto('/pay/preferences');
  const findMe = page.getByRole('checkbox', { name: 'Let people find me by name, email or phone' });
  await expect(findMe).toBeEnabled(UNBUILT);
  await findMe.uncheck();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await openReceive(page);
  const link = (
    await receive(page)
      .getByText(/\/pay\/send\?to=/)
      .innerText()
  ).trim();
  await signOutBrowser(page.context());

  await signIn(page, friend);
  await lookUp(page, receiver.handle);
  await expect(page.getByText(`We couldn’t find @${receiver.handle}. Check the spelling.`)).toBeVisible();
  // The QR's link names the person directly, so it still opens a payable Send.
  await page.goto(new URL(link).pathname + new URL(link).search);
  await expect(page.getByText(`@${receiver.handle}`).first()).toBeVisible();
  await page.getByLabel('Amount to send').fill('1');
  await expect(page.getByTestId('pay-terms')).toHaveAttribute('data-terms', 'ok');
});

test(`${J} #4 shows the QR to a friend who scans it: Send prefilled with a payee preview; a tampered code refused; an image upload works`, async ({
  page,
}) => {
  const { receiver, friend } = people();
  await signIn(page, receiver);
  await openReceive(page);
  await expect(receive(page).getByRole('img', { name: 'QR code for your payment link' })).toBeVisible();
  const link = (
    await receive(page)
      .getByText(/\/pay\/send\?to=/)
      .innerText()
  ).trim();
  const code = await receive(page).getByRole('img', { name: 'QR code for your payment link' }).screenshot();
  await signOutBrowser(page.context());

  await signIn(page, friend);
  await page.goto('/pay/scan');
  // With the camera denied, the friend uploads a picture of the code instead.
  await page.getByLabel('Upload a picture of the code').setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: code }, UNBUILT);
  await expect(page).toHaveURL(/\/pay(\/send)?\?to=/);
  await expect(page.getByLabel('Handle')).toHaveValue(receiver.handle);
  await expect(page.getByRole('region', { name: 'Payee' })).toContainText(`@${receiver.handle}`);

  // A code whose payload was changed after it was made is refused, by its reference.
  await page.goto('/pay/scan');
  await page.getByLabel('Paste a code').fill(`${link}&sig=tampered`);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByText('Reference identity.qr_invalid')).toBeVisible();
});

test(`${J} #5 sets how to treat payments from people not in contacts: a stranger's payment waits, and can be accepted or denied`, async ({
  page,
}) => {
  const { receiver, friend } = people();
  await signIn(page, receiver);
  await page.goto('/pay/preferences');
  const choice = page.getByRole('radiogroup', { name: 'Payments from people not in your contacts' });
  await choice.getByRole('radio', { name: 'Hold for me to accept' }).check(UNBUILT);
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await signOutBrowser(page.context());

  const before = { receiver: await usdt(receiver), friend: await usdt(friend) };
  await signIn(page, friend);
  await lookUp(page, receiver.handle);
  await page.getByLabel('Amount to send').fill('5');
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').click();
  await expect(page.getByText(/waiting for @\S+ to accept/i)).toBeVisible();
  expect(await usdt(receiver)).toBe(before.receiver);
  await signOutBrowser(page.context());

  await signIn(page, receiver);
  await page.goto('/pay');
  const pending = page.getByRole('region', { name: 'Waiting for you' });
  await pending.getByRole('button', { name: 'Accept' }).first().click();
  await expect.poll(() => usdt(receiver)).toBe(String(Number(before.receiver) + 5));
  expect(toUnits(before.friend) - toUnits(await usdt(friend))).toBe(toUnits('5'));
  // Back to accepting straight away, which #6 starts from.
  await page.goto('/pay/preferences');
  await choice.getByRole('radio', { name: 'Accept straight away' }).check();
  await page.getByRole('button', { name: 'Save preferences' }).click();
});

test(`${J} #6 adds an email to receive by: a payment sent to that email lands in the balance`, async ({ page }) => {
  const { receiver, friend } = people();
  await signIn(page, receiver);
  await openReceive(page);
  await receive(page).getByRole('button', { name: 'Add an email or phone' }).click(UNBUILT);
  const sheet = page.getByRole('dialog', { name: 'Receive by email or phone' });
  await sheet.getByLabel('Email').fill(receiver.email);
  await sheet.getByRole('button', { name: 'Add' }).click();
  // The stack mails a TEST code to its outbox; the notice says so when the email vendor is off.
  await expect(sheet.getByText(/We sent a code|Email isn’t connected/)).toBeVisible();
  await signOutBrowser(page.context());

  const before = await usdt(receiver);
  await signIn(page, friend);
  await page.goto('/pay');
  await page.getByLabel('Handle').fill(receiver.email);
  await page.getByLabel('Handle').press('Tab');
  await page.getByLabel('Amount to send').fill('2');
  await page.getByTestId('pay-review').click();
  await page.getByTestId('pay-send').click();
  await expect(page.getByTestId('pay-receipt')).toBeVisible();
  expect(toUnits(await usdt(receiver)) - toUnits(before)).toBe(toUnits('2'));
});
