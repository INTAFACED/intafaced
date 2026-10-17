/**
 * Custody port for customer deposit addresses.
 *
 * `null` from any method means custody is not connected. The service then
 * refuses `bank.deposit_custody_unset` and does not invent an asset, a
 * minimum, a confirmation count, or an address. svc-bank does not derive keys.
 */

export interface DepositNetwork {
  id: string;
  label: string;
  minimumDeposit: string;
  confirmationsRequired: number;
  estimatedArrivalMinutes: number;
}

export interface DepositAsset {
  assetId: string;
  networks: readonly DepositNetwork[];
}

export interface CustodyDepositAddress {
  address: string;
  memo?: string | null;
  qrPayload?: string | null;
}

export interface CustodyPendingDeposit {
  id: string;
  assetId: string;
  networkId: string;
  amount: string;
  confirmations: number;
  confirmationsRequired: number;
}

export interface CustodyDepositPort {
  /** `null` = catalogue not published. An empty array is a published empty list. */
  listAssets(): Promise<readonly DepositAsset[] | null>;
  /** `null` = custody will not issue an address. */
  address(input: { userId: string; assetId: string; networkId: string }): Promise<CustodyDepositAddress | null>;
  /** `null` = custody is not reporting incoming deposits. An empty array means none are incoming. */
  pending(userId: string): Promise<readonly CustodyPendingDeposit[] | null>;
}

export const unsetCustodyDepositPort: CustodyDepositPort = {
  listAssets: async () => null,
  address: async () => null,
  pending: async () => null,
};
