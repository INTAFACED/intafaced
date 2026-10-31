import { expect, test } from './journey.mjs';
import path from 'node:path';
import { ADMIN, founderSignIn } from './admin.mjs';
import { ROOT, tool } from './stack.mjs';

// J-ops-console-01 #3: the module health board. Every platform module (packages/config MODULE_IDS) is its own row. A module
// with a source shows its volume, failures and oldest waiting item as svc-* read them; a module without one says "No source"
// with its blocker and shows no count. When one module's service cannot be read, only that row refuses: the test stops
// svc-p2p, reads the board again, and starts it again (`start --only p2p`, as J-agents-02 does).

const SOURCED = ['bank', 'p2p', 'market', 'mining-pool'];

/** The board on the page, after its heading shows. */
async function shown(page) {
  const b = page.getByTestId('health-board');
  await expect(b.getByRole('heading', { level: 1, name: 'Module health' })).toBeVisible();
  return b;
}

async function board(page) {
  await page.goto(`${ADMIN}/health`, { waitUntil: 'load' });
  return shown(page);
}

/** A module without a source: it names its blocker and code and shows no count. */
async function expectUnwired(b, module) {
  const row = b.getByTestId(`health-${module}`);
  await expect(row).toHaveAttribute('data-state', 'unwired');
  await expect(row).toContainText(/No source: \S/);
  await expect(row).toContainText('Code: ops.health_source_unwired');
  await expect(row.getByTestId('volume')).toHaveCount(0);
}

/** A read row: every figure cell is filled, and no "no source" or refusal text is on it. */
async function expectRead(b, module) {
  const row = b.getByTestId(`health-${module}`);
  await expect(row).toHaveAttribute('data-state', 'read');
  for (const cell of ['volume', 'failures', 'oldest']) await expect(row.getByTestId(cell)).not.toBeEmpty();
  await expect(row).not.toContainText('No source');
  await expect(row).not.toContainText('Could not read');
}

test('J-ops-console-01 #3 the module health board shows every module, read, refused on its own row, or no source with the blocker', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const { MODULE_IDS } = await import(path.join(ROOT, 'packages/config/dist/modules.js'));
  await founderSignIn(page, 'a');
  await page.goto(`${ADMIN}/`);
  await page.getByRole('link', { name: /^Module health/ }).click();
  await expect(page).toHaveURL(/\/health$/);
  let b = await shown(page);

  // Every module is a row, and there is no row for anything else.
  await expect(b.locator('tbody tr')).toHaveCount(MODULE_IDS.length);
  for (const module of MODULE_IDS) await expect(b.getByTestId(`health-${module}`)).toHaveCount(1);
  // Each module with a source is read, with its figures; each without one names its blocker and shows no count.
  for (const module of SOURCED) await expectRead(b, module);
  const unwired = MODULE_IDS.filter((m) => !SOURCED.includes(m));
  for (const module of unwired) await expectUnwired(b, module);

  // svc-p2p down: only the P2P row refuses, naming svc-p2p, with its code and no count; every other row keeps its state.
  tool('local-test-stack.mjs', 'stop', 'p2p');
  let failure = null;
  try {
    b = await board(page);
    const p2p = b.getByTestId('health-p2p');
    await expect(p2p).toHaveAttribute('data-state', 'refused');
    await expect(p2p).toContainText('Could not read svc-p2p');
    await expect(p2p).not.toContainText('This part was not read.');
    await expect(p2p).toContainText('ops.health_source_unavailable');
    await expect(p2p.getByTestId('volume')).toHaveCount(0);
    for (const module of SOURCED.filter((m) => m !== 'p2p')) await expectRead(b, module);
    for (const module of unwired) await expectUnwired(b, module);
    await expect(b.locator('tbody tr')).toHaveCount(MODULE_IDS.length);
  } catch (error) {
    failure = error;
  }
  // Bring svc-p2p back for the journeys after this one. A failure to restart is reported, but never in place of the
  // board's own failure above.
  try {
    tool('local-test-stack.mjs', 'start', '--only', 'p2p');
  } catch (restart) {
    failure ??= restart;
  }
  if (failure) throw failure;
  b = await board(page);
  await expectRead(b, 'p2p');
});
