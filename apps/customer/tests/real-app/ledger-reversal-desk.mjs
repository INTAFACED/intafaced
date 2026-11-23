import { expect } from './journey.mjs';
import { ADMIN } from './admin.mjs';

// The founder console's reversal desk (OPS-ledger-desk-02) on /ledger?txId=<id>, as two founders drive it: the founder who
// holds the console's treasury credential (the stack's founder a) asks and runs, a different founder approves. Shared by
// J-ops-console-05, which proves the reversal itself, and J-ops-console-07 #9, which links a corrective reversal to an alert.

/** The console's ledger lookup opened on one transaction id; returns the transaction's view once the ledger answered it. */
export async function openTx(page, txId) {
  await page.goto(`${ADMIN}/ledger?txId=${encodeURIComponent(txId)}`, { waitUntil: 'load' });
  const view = page.getByTestId('ledger-lookup').getByTestId('ledger-lookup-transaction');
  await expect(view.getByTestId('ledger-lookup-tx-id')).toHaveText(txId.toLowerCase(), { timeout: 60_000 });
  return view;
}

/** The console's ledger lookup opened on one business key; returns the lookup once it shows a transaction or none. */
export async function openBusinessKey(page, key) {
  await page.goto(`${ADMIN}/ledger?businessKey=${encodeURIComponent(key)}`, { waitUntil: 'load' });
  const lookup = page.getByTestId('ledger-lookup');
  await expect(lookup.getByTestId('ledger-lookup-not-found').or(lookup.getByTestId('ledger-lookup-transaction'))).toBeVisible({
    timeout: 60_000,
  });
  return lookup;
}

/** A transaction's legs as the console's postings table shows them: [{ account, asset, direction, amount }]. */
export function legsOf(view) {
  return view
    .getByTestId('ledger-lookup-postings')
    .locator('tbody tr')
    .evaluateAll((rows) =>
      rows.map((r) => {
        const cells = [...r.cells].map((td) => td.textContent.trim());
        return { account: cells[1], asset: cells[2], direction: cells[3], amount: cells[4] };
      }),
    );
}

/** One reversal request's row on a transaction's reversal desk. */
export const requestRow = (desk, requestNo) => desk.locator(`[data-testid="reversal-request"][data-request-no="${requestNo}"]`);

/** The phrase the console asks for to propose, approve or run reversal request `requestNo`. */
export const reversePhrase = (requestNo) => `REVERSE REQUEST ${requestNo}`;

/**
 * Presses Reverse on `txId` with a reason and a case reference, on the founder's own console. Returns the desk and the
 * request number svc-ops answered with, once the desk says the request is stored.
 */
export async function askReversal(page, txId, { reason, caseRef }) {
  const desk = (await openTx(page, txId)).getByTestId('tx-reversal');
  const form = desk.getByTestId('tx-reverse');
  await form.getByLabel(/^Reason \(12 to 500/).fill(reason);
  await form.getByLabel('Case reference').fill(caseRef);
  await form.getByTestId('tx-reverse-submit').click();
  const asked = desk.getByTestId('reversal-asked');
  await expect(asked).toBeVisible({ timeout: 30_000 });
  return { desk, requestNo: await asked.getAttribute('data-request-no') };
}

/** The requester asks a different founder to approve request `requestNo` from its row; returns the packet to send them. */
export async function proposeReversal(desk, requestNo) {
  const row = requestRow(desk, requestNo);
  await row.getByLabel(/to confirm$/).fill(reversePhrase(requestNo));
  await row.getByRole('button', { name: 'Ask a second founder to approve the reversal' }).click();
  await expect(row.getByTestId('packet-made')).toBeVisible({ timeout: 60_000 });
  return (await row.getByLabel('Request packet').inputValue()).trim();
}

/** A different founder pastes the packet on their own console's view of the original and approves it. */
export async function approveReversal(page, txId, requestNo, packetText) {
  const row = requestRow((await openTx(page, txId)).getByTestId('tx-reversal'), requestNo);
  await row.getByLabel('Request packet').fill(packetText);
  await expect(row.getByTestId('packet-summary')).toContainText(`Reverse ledger transaction ${txId.toLowerCase()}`);
  await row.getByLabel(/to approve or run it$/).fill(reversePhrase(requestNo));
  await row.getByRole('button', { name: 'Approve this request' }).click();
  await expect(row.getByTestId('step-reply')).toContainText('Approved.', { timeout: 30_000 });
}

/**
 * The requester runs the approved packet from the request's row on a fresh view of the original, and waits until the row,
 * read again from svc-ops, says the ledger posted it. Returns the reversing transaction id the row names.
 */
export async function runReversal(page, txId, requestNo, packetText) {
  const row = requestRow((await openTx(page, txId)).getByTestId('tx-reversal'), requestNo);
  await row.getByLabel('Request packet').fill(packetText);
  await row.getByLabel(/to approve or run it$/).fill(reversePhrase(requestNo));
  await row.getByRole('button', { name: 'Run the approved request' }).click();
  await expect(row, `reversal request ${requestNo} is posted, as svc-ops stores it`).toHaveAttribute('data-state', 'posted', {
    timeout: 60_000,
  });
  const reversing = await row.getByTestId('reversal-reversing-tx').getAttribute('data-tx-id');
  expect(reversing, 'the posted request names its reversing transaction').toMatch(/^[0-9a-f-]{36}$/);
  return reversing;
}

/** The whole desk: `asker` (the treasury holder) asks and runs, `approver` approves. Returns the reversing transaction id. */
export async function reverseWithTwoFounders(asker, approver, txId, ask) {
  const { desk, requestNo } = await askReversal(asker, txId, ask);
  const packetText = await proposeReversal(desk, requestNo);
  await approveReversal(approver, txId, requestNo, packetText);
  return runReversal(asker, txId, requestNo, packetText);
}

/**
 * One approval step for a reversal packet sent straight to the console's own route, as the signed-in founder on `page`,
 * the way the workbench sends it. Used where the workbench itself holds the button (the requester approving their own).
 */
export async function reversalStep(page, packetText, step, confirm) {
  const packet = JSON.parse(Buffer.from(packetText.slice('ifa1.'.length), 'base64url').toString('utf8'));
  return page.evaluate(
    async ({ request, approvalId, operationId, step, confirm }) => {
      const session = await (await fetch('/api/session', { cache: 'no-store' })).json();
      const res = await fetch('/api/ledger-reversals/approve', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-intafaced-csrf': session.csrf },
        body: JSON.stringify({ step, request, confirm, approvalId, ...(step === 'execute' ? { operationId } : {}) }),
        cache: 'no-store',
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { request: packet.request, approvalId: packet.approvalId, operationId: packet.operationId, step, confirm },
  );
}
