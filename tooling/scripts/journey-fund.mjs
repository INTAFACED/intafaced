/**
 * TEST funding for the customer journeys (apps/customer/tests/journeys). It lives here, not in the app, so the customer
 * app never depends on packages/ledger-client: value still moves only through the ledger deposit recipe, and a change
 * to this file gets the money review that every file under tooling/scripts gets.
 *
 * It needs the packages built, which the journey boot (order-path-cx8-boot.mjs) does before any journey runs.
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** The ledger post body for a journey customer's TEST deposit. Business key, so a rerun adds nothing. */
export async function journeyDepositWire({ userId, assetId, amount }) {
  const { formatAmount, parseAmount, recipes } = await import(
    pathToFileURL(path.join(REPO, 'packages', 'ledger-client', 'dist', 'index.js')).href
  );
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
