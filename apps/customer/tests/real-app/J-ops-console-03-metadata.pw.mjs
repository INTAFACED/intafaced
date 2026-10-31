import { expect, test } from './journey.mjs';
import { randomBytes } from 'node:crypto';
import { ADMIN, founderSignIn } from './admin.mjs';
import { unconfirmedAccount } from './p2p.mjs';
import { fund } from './stack.mjs';

// J-ops-console-03 #6-#7 (OPS-ledger-desk-01): metadata on a ledger account. A fresh TEST customer is funded once through
// the real ledger (XAG, a TEST amount) so they have an account to label. On Ledger ops, founder A finds it by address,
// sets a key with a reason, and asks to delete it: alone, the delete does not run; founder B approves the exact request
// on their own console; A runs it, and the history shows the value before and after with both founders named.
// Then, with the posting freeze on (two founders, as the freeze desk does it), the account still reads, a set and an
// approved delete are refused `ledger.frozen` with nothing changed, and after the unfreeze the same approval deletes.

const ASSET = 'XAG';
const tag = randomBytes(3).toString('hex');
const state = { a: null, b: null, account: null, userId: null };

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  const who = await unconfirmedAccount('jmeta');
  const out = fund(who.email, ASSET, '1', `meta-${tag}`);
  expect(out.tx, out.out).toBeTruthy();
  state.userId = /\(([0-9a-f-]{36})\)/.exec(out.out)?.[1] ?? null;
  expect(state.userId).toBeTruthy();
});

async function founders(browser) {
  if (!state.a) {
    state.a = await (await browser.newContext()).newPage();
    await founderSignIn(state.a, 'a');
  }
  if (!state.b) {
    state.b = await (await browser.newContext()).newPage();
    await founderSignIn(state.b, 'b');
  }
  return state;
}

/** Ledger ops on `page`, the customer's XAG account found by address, its metadata panel open. */
async function openMetadata(page) {
  await page.goto(`${ADMIN}/ledger`, { waitUntil: 'load' });
  const accounts = page.getByTestId('ledger-desk-accounts');
  await expect(accounts).toBeVisible({ timeout: 60_000 });
  await accounts.getByLabel('Address prefix').fill(`user:${state.userId}`);
  const answered = page.waitForResponse((res) => res.url().includes('/api/ledger-desk/accounts'));
  await accounts.getByRole('button', { name: 'Search accounts' }).click();
  const body = await (await answered).json();
  const mine = body.page.accounts.find((row) => row.ownerId === state.userId && row.assetId === ASSET);
  expect(mine, JSON.stringify(body)).toBeTruthy();
  state.account = mine.accountId;
  await accounts.locator(`tr[data-account="${mine.accountId}"]`).getByRole('button', { name: 'Metadata' }).click();
  const panel = accounts.getByTestId('ledger-metadata');
  await expect(panel.getByTestId('ledger-metadata-address')).toContainText(`user:${state.userId}`, { timeout: 60_000 });
  return panel;
}

async function setKey(panel, key, value, reason) {
  const form = panel.getByTestId('ledger-metadata-set');
  await form.getByLabel('Key').fill(key);
  await form.getByLabel('Value').fill(value);
  await form.getByLabel(/^Why/).fill(reason);
  await form.getByRole('button', { name: 'Set key' }).click();
}

/** Founder A asks to delete `key`; answers the request packet A's console made. */
async function askDelete(panel, key) {
  await panel.getByRole('button', { name: `Delete ${key}` }).click();
  const desk = panel.getByTestId('ledger-metadata-delete');
  await desk.getByLabel(/^Why \(recorded with the delete/).fill(`LOCAL TEST J-ops-console-03 delete ${tag}`);
  await desk.getByLabel(/to confirm$/).fill(`DELETE KEY ${key}`);
  await desk.getByRole('button', { name: 'Ask a second founder to approve the delete' }).click();
  await expect(desk.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return { desk, packet: (await desk.getByLabel('Request packet').inputValue()).trim() };
}

/** Founder B opens the same key's delete desk on their own console, reads the packet and approves it. */
async function approveOnB(key, packet) {
  const panel = await openMetadata(state.b);
  await panel.getByRole('button', { name: `Delete ${key}` }).click();
  const desk = panel.getByTestId('ledger-metadata-delete');
  await desk.getByLabel('Request packet').fill(packet);
  await expect(desk.getByTestId('packet-summary')).toContainText(`Delete the metadata key "${key}"`);
  await desk.getByLabel(/to approve or run it$/).fill(`DELETE KEY ${key}`);
  await desk.getByRole('button', { name: 'Approve this request' }).click();
  await expect(desk.getByTestId('step-reply')).toContainText('Approved.', { timeout: 30_000 });
}

async function run(desk, key) {
  await desk.getByLabel(/to approve or run it$/).fill(`DELETE KEY ${key}`);
  await desk.getByRole('button', { name: 'Run the approved request' }).click();
  const reply = desk.getByTestId('step-reply');
  await expect(reply).toBeVisible({ timeout: 60_000 });
  return reply;
}

/** One step of a two-founder posting freeze or unfreeze, as the signed-in founder in `page` (the console's own CSRF header). */
const freezeStep = (page, body) =>
  page.evaluate(async (payload) => {
    const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
    const res = await fetch('/api/ledger-freeze', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }, body);

const decode = (text) => JSON.parse(Buffer.from(text.slice('ifa1.'.length), 'base64url').toString('utf8'));

const readFreeze = (page) => page.evaluate(async () => (await fetch('/api/ledger-freeze', { cache: 'no-store' })).json());

/** A asks, B approves, A runs: the posting freeze on (`frozen`) or off. */
async function setPostingFreeze(frozen) {
  const record = await readFreeze(state.a);
  expect(record.ok, JSON.stringify(record)).toBe(true);
  if (record.state.frozen === frozen) return;
  const version = record.state.version;
  const request = frozen
    ? { kind: 'ledger.freeze', reason: `LOCAL TEST J-ops-console-03 #7 ${tag}`, version }
    : { kind: 'ledger.unfreeze', version };
  const confirm = frozen ? 'FREEZE LEDGER' : 'UNFREEZE LEDGER';
  const proposed = await freezeStep(state.a, { step: 'propose', request, confirm });
  expect(proposed.body.ok, JSON.stringify(proposed.body)).toBe(true);
  const packet = decode(proposed.body.packet);
  const approved = await freezeStep(state.b, { step: 'approve', request, confirm, approvalId: packet.approvalId });
  expect(approved.body.ok, JSON.stringify(approved.body)).toBe(true);
  const ran = await freezeStep(state.a, {
    step: 'execute',
    request,
    confirm,
    approvalId: packet.approvalId,
    operationId: packet.operationId,
  });
  expect(ran.body.ok, JSON.stringify(ran.body)).toBe(true);
  expect((await readFreeze(state.a)).state.frozen).toBe(frozen);
}

test('J-ops-console-03 #6 deleting a metadata key needs a second approver, and the audit entry carries before and after', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  await founders(browser);
  const key = `desk.note-${tag}`;
  const value = `LOCAL TEST note ${tag}`;
  const panel = await openMetadata(state.a);
  await expect(panel.getByTestId('ledger-metadata-empty')).toBeVisible();

  await setKey(panel, key, value, `LOCAL TEST J-ops-console-03 set ${tag}`);
  await expect(panel.getByTestId('ledger-metadata-saved')).toContainText(`Set ${key}`, { timeout: 60_000 });
  await expect(panel.getByTestId('ledger-metadata-entries').locator(`tr[data-key="${key}"]`)).toContainText(value, { timeout: 30_000 });

  const { desk, packet } = await askDelete(panel, key);
  // Alone: A cannot approve their own request, and running it before anyone approved changes nothing.
  await expect(desk.getByRole('button', { name: 'Approve this request' })).toBeDisabled();
  const alone = await run(desk, key);
  await expect(alone).toContainText('action_approval.not_approved');
  await expect(alone).toHaveAttribute('data-tone', 'danger');
  await expect(panel.getByTestId('ledger-metadata-entries').locator(`tr[data-key="${key}"]`)).toContainText(value);

  await approveOnB(key, packet);
  const reply = await run(desk, key);
  await expect(reply).toContainText(`Deleted ${key}`);
  await expect(reply).toContainText(`it was "${value}"`);

  // The history: the delete with the value before and none after, asked by A and approved by B; the set beneath it.
  await expect(panel.getByTestId('ledger-metadata-entries').locator(`tr[data-key="${key}"]`)).toHaveCount(0, { timeout: 30_000 });
  const history = panel.getByTestId('ledger-metadata-history');
  const deleted = history.locator(`tr[data-action="delete"][data-key="${key}"]`);
  await expect(deleted).toHaveCount(1);
  const cells = (await deleted.locator('td').allInnerTexts()).map((t) => t.trim());
  expect(cells.slice(1, 5)).toEqual([key, 'Deleted', value, '—']);
  expect(cells[6]).not.toBe('Not needed');
  expect(cells[6]).not.toBe(cells[5]);
  await expect(history.locator(`tr[data-action="set"][data-key="${key}"]`)).toContainText(value);
});

test('J-ops-console-03 #7 with the posting freeze on, reads work and the metadata write refuses ledger.frozen', async ({ browser }) => {
  test.setTimeout(420_000);
  await founders(browser);
  const key = `desk.frozen-${tag}`;
  const value = `LOCAL TEST kept ${tag}`;
  let panel = await openMetadata(state.a);
  await setKey(panel, key, value, `LOCAL TEST J-ops-console-03 set ${tag}`);
  await expect(panel.getByTestId('ledger-metadata-saved')).toBeVisible({ timeout: 60_000 });
  // A delete approved before the freeze, to run while it is on.
  const { packet } = await askDelete(panel, key);
  await approveOnB(key, packet);

  await setPostingFreeze(true);
  try {
    // Reads work: the account and its key still show, with the freeze named.
    panel = await openMetadata(state.a);
    await expect(panel.getByTestId('ledger-metadata-frozen')).toBeVisible();
    await expect(panel.getByTestId('ledger-metadata-entries').locator(`tr[data-key="${key}"]`)).toContainText(value);

    // A set is refused by the ledger with ledger.frozen, and nothing changed.
    await setKey(panel, key, `LOCAL TEST changed ${tag}`, `LOCAL TEST J-ops-console-03 frozen set ${tag}`);
    const refused = panel.getByTestId('ledger-metadata-set-refused');
    await expect(refused).toContainText('The ledger is frozen', { timeout: 60_000 });
    await expect(refused).toContainText('ledger.frozen');

    // The approved delete is refused the same way, and its approval is not used.
    await panel.getByRole('button', { name: `Delete ${key}` }).click();
    const desk = panel.getByTestId('ledger-metadata-delete');
    await desk.getByLabel('Request packet').fill(packet);
    const frozenRun = await run(desk, key);
    await expect(frozenRun).toContainText('The ledger is frozen');
    await expect(frozenRun).toContainText('ledger.frozen');
    await panel.getByRole('button', { name: 'Read again' }).click();
    await expect(panel.getByTestId('ledger-metadata-entries').locator(`tr[data-key="${key}"]`)).toContainText(value, { timeout: 30_000 });
  } finally {
    await setPostingFreeze(false);
  }

  // After the unfreeze the same approval deletes the key.
  panel = await openMetadata(state.a);
  await panel.getByRole('button', { name: `Delete ${key}` }).click();
  const desk = panel.getByTestId('ledger-metadata-delete');
  await desk.getByLabel('Request packet').fill(packet);
  const after = await run(desk, key);
  await expect(after).toContainText(`Deleted ${key}`);
});
