import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { EDGE, ORIGIN, api, journeyState } from './stack.mjs';
import { signIn, signUp, verify } from './desk.mjs';
import { PASSKEY_ORIGIN, addPasskey, virtualAuthenticator } from './identity-factors.mjs';

// J-developer-02, in the running app (docs/roadmap/journeys.json): make my first call in the sandbox. One test per step,
// titled "J-developer-02 #<n>", run in order. The developer is a verified TEST account with a passkey (an account mints
// keys only with a verified passkey, and the passkey gives each create its fresh step-up), on http://localhost:3210 for
// the passkey's relying party. The sandbox cap, the funding decision, the clock window and the reset cap are the stack's
// TEST developer terms.
// Steps that are written but not built yet fail at their first missing part, quickly (UNBUILT):
// - #1: the Quickstart section publishes no page in this build.
// - #2 to #8: there are no sandboxes: no sandbox list or create, no sandbox key or base URL, no sandbox funding, clock
//   check, sandbox host, simulated decline or reset.
const J = 'J-developer-02';
const run = journeyState(`${J}-${process.env.JOURNEY_RUN_ID ?? 'local'}`);
const UNBUILT = { timeout: 5_000 };

test.describe.configure({ mode: 'default' });
// An action on a part that never appears fails in 15 s, not at the test's time limit.
test.use({ actionTimeout: 15_000 });

function state(key) {
  const value = run.read()[key];
  if (!value) throw new Error(`${J}: an earlier step made no ${key}, so this step has nothing to act on`);
  return value;
}

/** A page on the passkey's origin with the virtual authenticator, signed in as the journey's developer. */
async function developerPage(browser) {
  const page = await (await browser.newContext({ baseURL: PASSKEY_ORIGIN })).newPage();
  await virtualAuthenticator(page);
  return page;
}

const sandboxes = (page) => page.getByRole('table', { name: 'Sandboxes' });

async function openSandboxes(page) {
  await page.goto('/uc/safe/api-keys?tab=sandbox');
  await expect(page.getByRole('heading', { name: 'Sandboxes' })).toBeVisible(UNBUILT);
}

test(`${J} #1 follows the trading quickstart: account, key, clock check, first call`, async ({ browser }) => {
  test.setTimeout(240_000);
  const page = await developerPage(browser);
  try {
    const dev = await signUp(page, 'jds');
    await verify(page, dev);
    await signIn(page, dev);
    await addPasskey(page);
    run.reset({ dev });

    await page.goto('/developers');
    await page.getByRole('link', { name: 'Quickstart' }).click();
    await expect(page.getByRole('heading', { name: 'Quickstart', level: 1 })).toBeVisible();
    const steps = page.getByRole('list', { name: 'Quickstart steps' });
    await expect(steps.getByRole('listitem')).toHaveText([/account/i, /key/i, /clock/i, /first call/i], UNBUILT);
  } finally {
    await page.context().close();
  }
});

test(`${J} #2 creates a named sandbox, then a second one (development, then CI)`, async ({ browser }) => {
  const page = await developerPage(browser);
  try {
    await signIn(page, state('dev'));
    await openSandboxes(page);
    for (const name of ['development', 'CI']) {
      await page.getByRole('button', { name: 'New sandbox' }).click();
      await page.getByRole('dialog').getByLabel('Sandbox name').fill(name);
      await page.getByRole('dialog').getByRole('button', { name: 'Create sandbox' }).click();
      await expect(sandboxes(page).getByRole('row', { name: new RegExp(`^${name}`) })).toBeVisible();
    }
    run.write({ sandbox: 'development' });
  } finally {
    await page.context().close();
  }
});

test(`${J} #3 creates a sandbox key: shown once with the sandbox base URL; only sandbox-safe scopes, a trade scope refused`, async ({
  browser,
}) => {
  const page = await developerPage(browser);
  try {
    await signIn(page, state('dev'));
    await openSandboxes(page);
    await sandboxes(page)
      .getByRole('row', { name: /^development/ })
      .getByRole('button', { name: 'New key' })
      .click();
    const sheet = page.getByRole('dialog', { name: 'New sandbox key' });
    await sheet.getByLabel('Key name').fill('sbx-1');
    // A live trade scope isn't sandbox-safe: refused, naming why.
    await sheet.getByLabel('trade:write').check();
    await sheet.getByRole('button', { name: 'Create with a passkey' }).click();
    await expect(sheet.getByText('A sandbox key can’t trade on the live book.')).toBeVisible();
    await sheet.getByLabel('trade:write').uncheck();
    await sheet.getByLabel('sandbox:trade').check();
    await sheet.getByRole('button', { name: 'Create with a passkey' }).click();
    const key = (await page.getByTestId('api-keys__key').locator('code').textContent())?.trim();
    const secret = (await page.getByTestId('api-keys__secret').locator('code').textContent())?.trim();
    expect(key).toMatch(/^ifc_sbx_/);
    const base = (await page.getByTestId('api-keys__sandbox-base').innerText()).trim();
    expect(base).toMatch(/^https?:\/\//);
    run.write({ key, secret, base });
  } finally {
    await page.context().close();
  }
});

test(`${J} #4 presses Fund while the owner's funding decision is unset: a typed refusal naming it; nothing written`, async ({
  browser,
}) => {
  const page = await developerPage(browser);
  try {
    const dev = state('dev');
    await signIn(page, dev);
    await openSandboxes(page);
    // The stack leaves the funding decision unset for the CI sandbox's asset (EUR), and sets a TEST one for USDT.
    const row = sandboxes(page).getByRole('row', { name: /^CI/ });
    await row.getByRole('button', { name: 'Fund' }).click();
    await page.getByRole('dialog').getByLabel('Asset').selectOption('EUR');
    await page.getByRole('dialog').getByRole('button', { name: 'Add test funds' }).click();
    await expect(page.getByText(/Sandbox funding is not set by the platform/)).toBeVisible();
    await expect(row).toContainText(/Balance\s*0/);
  } finally {
    await page.context().close();
  }
});

test(`${J} #5 funds the sandbox once the decision is set: the sandbox balance rises, labelled TEST; the live book untouched`, async ({
  browser,
}) => {
  const page = await developerPage(browser);
  try {
    const dev = state('dev');
    await signIn(page, dev);
    const live = await (await api(dev)).balances();
    await openSandboxes(page);
    const row = sandboxes(page).getByRole('row', { name: /^development/ });
    await row.getByRole('button', { name: 'Fund' }).click();
    await page.getByRole('dialog').getByLabel('Asset').selectOption('USDT');
    await page.getByRole('dialog').getByRole('button', { name: 'Add test funds' }).click();
    await expect(row).toContainText(/TEST/);
    await expect(row).not.toContainText(/Balance\s*0\b/);
    expect(await (await api(dev)).balances()).toEqual(live);
  } finally {
    await page.context().close();
  }
});

test(`${J} #6 runs the clock check: the offset against the server, passing inside the owner's window`, async ({ browser }) => {
  const page = await developerPage(browser);
  try {
    await signIn(page, state('dev'));
    await openSandboxes(page);
    await page.getByRole('button', { name: 'Check my clock' }).click();
    await expect(page.getByRole('status', { name: 'Clock check' })).toHaveText(/Offset -?\d+ ms\. Within the [\d,]+ ms window\./);
  } finally {
    await page.context().close();
  }
});

/** Sends GET /api/v1/account/balance to `host`, signed with the key's secret over timestamp, method and path. */
async function signedCall(host, key, secret) {
  const path = '/api/v1/account/balance';
  const timestamp = String(Date.now());
  const signature = createHmac('sha256', secret).update(`${timestamp}GET${path}`).digest('hex');
  const res = await fetch(`${host}${path}`, {
    headers: { origin: ORIGIN, 'IFC-KEY': key, 'IFC-TIMESTAMP': timestamp, 'IFC-SIGNATURE': signature },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test(`${J} #7 sends the first signed call: success in the sandbox; the same key at the live host refused as the wrong environment`, async () => {
  const key = state('key');
  const secret = state('secret');
  const sandbox = await signedCall(state('base'), key, secret);
  expect(sandbox.status, JSON.stringify(sandbox.body).slice(0, 300)).toBe(200);
  expect(sandbox.body.balances.USDT).toBeTruthy();
  const live = await signedCall(EDGE, key, secret);
  expect(live.status).toBe(403);
  expect(JSON.stringify(live.body)).toContain('environment_mismatch');
});

test(`${J} #8 triggers a simulated decline and resets the balance: the payment ends declined; reset works until the daily cap`, async ({
  browser,
}) => {
  const page = await developerPage(browser);
  try {
    await signIn(page, state('dev'));
    await openSandboxes(page);
    const row = sandboxes(page).getByRole('row', { name: /^development/ });
    await row.getByRole('button', { name: 'Simulate' }).click();
    const sheet = page.getByRole('dialog', { name: 'Simulate a payment' });
    await sheet.getByLabel('Outcome').selectOption('Declined');
    await sheet.getByRole('button', { name: 'Run' }).click();
    await expect(sheet.getByText('Declined')).toBeVisible();
    await page.keyboard.press('Escape');
    for (let i = 0; i < 20; i++) {
      await row.getByRole('button', { name: 'Reset balance' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Reset' }).click();
      if (await page.getByText(/You can reset again tomorrow/).count()) break;
    }
    await expect(page.getByText(/You can reset again tomorrow/)).toBeVisible();
  } finally {
    await page.context().close();
  }
});
