/**
 * TEST funding for the customer journeys (apps/customer/tests/journeys). It lives here, not in the app, so the customer
 * app never depends on packages/ledger-client and never posts to the ledger itself: value still moves only through the
 * ledger deposit recipe, and a change to this file gets the money review that every file under tooling/scripts gets.
 * Its tests run with the app's (apps/customer/tests/journeys/fund.test.ts).
 *
 * It loads ledger-client and contracts from their built dist, so build them first; the Order-path CX-8 workflow does.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));
const fromRepo = (...parts) => import(pathToFileURL(path.join(REPO, ...parts)).href);

/** The ledger post body for a journey customer's TEST deposit. Business key, so a rerun adds nothing. */
export async function journeyDepositWire({ userId, assetId, amount }) {
  const { formatAmount, parseAmount, recipes } = await fromRepo('packages', 'ledger-client', 'dist', 'index.js');
  const request = recipes.deposit({
    userId,
    assetId,
    amount: parseAmount(amount),
    rail: 'journey-test',
    railRef: `journey:${assetId}:${userId}`,
  });
  return {
    ...request,
    entries: request.entries.map((e) => ({ ...e, amount: typeof e.amount === 'bigint' ? formatAmount(e.amount) : e.amount })),
  };
}

/** Put TEST funds on a journey customer's account: the deposit above, posted to the journey stack's ledger as svc-trade. */
export async function fundJourneyCustomer({ ledgerUrl, internalSecret, userId, assetId, amount, fetchImpl = fetch }) {
  const { serviceAuthHeadersForBody } = await fromRepo('packages', 'contracts', 'dist', 'index.js');
  const raw = JSON.stringify(await journeyDepositWire({ userId, assetId, amount }));
  const response = await fetchImpl(`${ledgerUrl}/trpc/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...serviceAuthHeadersForBody('svc-trade', internalSecret, raw) },
    body: raw,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ledger /trpc/post ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}
