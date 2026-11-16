import path from 'node:path';
import { expect } from './journey.mjs';
import { ROOT, mailedLines, restartWithSetting } from './stack.mjs';
import { nextCode } from './identity-factors.mjs';
import { responseAfterNavigation } from './navigation.mjs';

// The withdrawal address book's shared steps, for J-wallet-04.pw.mjs and J-wallet-04-approval.pw.mjs: the TEST addresses,
// the add form's fields, the bank's own book read on a reload, the mailed approval links, a svc-bank TEST setting, and
// signing in and confirming with the account's authenticator app. Each journey file keeps its own run state.

export const ADDRESS = '0x52908400098527886E0F7030069857D2E4169EE7';
// A second, unrelated checksummed address for #5's approval from another device.
export const DEVICE_ADDRESS = '0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe';

export const totpLib = () => import(path.join(ROOT, 'services/svc-identity/dist/auth/totp.js'));

/**
 * The account steps over one journey file's run state (`journeyState`): `account()` reads the TEST account `maker`
 * made, `signInWithCode` signs in with the password and the next authenticator code, and `confirmItsMe` answers the
 * "Confirm it's you" dialog; both keep the code's step so no code is used twice.
 */
export function accountSteps(run, J, maker) {
  function account() {
    const state = run.read();
    if (!state.account) throw new Error(`${J} ${maker} made no account, so this step has no one to act as`);
    return state;
  }

  /** Signs in with the password and the next authenticator code, and keeps the step so no code is used twice. */
  async function signInWithCode(page) {
    const state = account();
    const { totp } = await totpLib();
    const { code, step } = await nextCode(totp, state.secret, state.step);
    run.reset({ ...state, step });
    await page.goto('/login');
    await page.fill('input[name=totp]', code);
    await page.fill('input[name=identifier]', state.account.email);
    await page.fill('input[name=password]', state.account.password);
    await page.getByRole('button', { name: /^sign in$/i }).click();
    await expect(page).not.toHaveURL(/\/login/);
  }

  /** Answers the "Confirm it's you" dialog with the next authenticator code. */
  async function confirmItsMe(page) {
    const state = account();
    const { totp } = await totpLib();
    const dialog = page.getByRole('dialog', { name: 'Confirm it’s you' });
    await expect(dialog).toBeVisible();
    const { code, step } = await nextCode(totp, state.secret, state.step);
    run.reset({ ...state, step });
    await dialog.getByLabel('Authenticator code or recovery code').fill(code);
    await dialog.getByRole('button', { name: 'Confirm' }).click();
  }

  return { account, signInWithCode, confirmItsMe };
}

export const addForm = (page) => page.getByRole('form', { name: 'Add an address' });
/** A field of the add form by its own label (each hint sits inside the label, so a plain label match is ambiguous). */
export const field = (page, name) =>
  addForm(page)
    .locator('label[data-testid="field"]', { has: page.locator('span', { hasText: new RegExp(`^${name}$`) }) })
    .locator('input, select');
export const savedRows = (page) => page.locator('tbody tr', { hasText: 'Crypto wallet' });

/**
 * Runs `fn` with svc-bank restarted on one TEST setting (`LOCAL_STACK_BANK_<NAME>`, tooling/scripts/local-stack-services/
 * bank.mjs) set to `value`, and restarts it on the stack's TEST value after, even when `fn` fails.
 */
export async function withBankSetting(key, value, fn) {
  restartWithSetting('bank', key, value);
  try {
    return await fn();
  } finally {
    restartWithSetting('bank', key, null);
  }
}

/** Reloads the page and returns the bank's own row for `label` from the address-book read that load makes. */
export async function bankRowOnReload(page, label) {
  return (await bankBookOnReload(page)).find((row) => row.label === label) ?? null;
}

/** Reloads the page and returns the bank's own rows from the address-book read that load makes. */
export async function bankBookOnReload(page) {
  // Only the read the reloaded page makes counts. A rename makes the old page read the book again just before the
  // reload, and when that read was the one matched the reload dropped its body ("No resource with given identifier
  // found", #7457). So the match starts once the reload has committed and the body is read as soon as it arrives
  // (navigation.mjs), and the read must have started after the reload's own document request did (both times from the
  // browser's clock).
  const { res, doc } = await responseAfterNavigation(
    page,
    (res) => res.request().method() === 'GET' && /\/api\/bank\/trpc\/ramps\.destinations\.list/.test(res.url()),
  );
  expect(doc, 'the reload loaded a new document').toBeTruthy();
  expect(res.startedAt, "the address-book read is the reloaded page's own").toBeGreaterThanOrEqual(doc.request().timing().startTime);
  expect(res.status).toBe(200);
  const rows = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      if (typeof value.destinationId === 'string' && typeof value.ref === 'string') rows.push(value);
      else Object.values(value).forEach(walk);
    }
  };
  walk(res.body);
  return rows;
}

/** The approval links mailed to this person so far, oldest first, from the stack's LOCAL-TEST outbox. */
export const approvalLinks = (email) =>
  mailedLines(email, 'withdraw-address-approval').map((line) => {
    const link = /link=(approveAddress\?token=\S+)/.exec(line)?.[1];
    if (!link) throw new Error(`an approval mail with no link: ${line}`);
    return `/${link}`;
  });

/** The next approval link mailed to `email` once more than `seen` have been. The relay sends right after the request commits. */
export async function nextApprovalLink(email, seen) {
  await expect.poll(() => approvalLinks(email).length, { timeout: 20_000 }).toBeGreaterThan(seen);
  return approvalLinks(email).at(-1);
}
