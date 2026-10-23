/** Types for journey-fund.mjs, which the customer journeys (TypeScript) import. */
export function journeyDepositWire(input: { userId: string; assetId: string; amount: string }): Promise<Record<string, unknown>>;

export function fundJourneyCustomer(input: {
  ledgerUrl: string;
  internalSecret: string;
  userId: string;
  assetId: string;
  amount: string;
  fetchImpl?: typeof fetch;
}): Promise<unknown>;
