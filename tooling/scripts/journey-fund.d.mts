/** Types for journey-fund.mjs, which the customer journeys (TypeScript) import. */
export function journeyDepositWire(input: { userId: string; assetId: string; amount: string }): Promise<Record<string, unknown>>;
