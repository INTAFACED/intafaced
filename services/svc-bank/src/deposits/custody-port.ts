/**
 * Custody port for customer deposit addresses.
 *
 * `null` from any method means custody is not connected. The service then
 * refuses `bank.deposit_custody_unset` and does not invent an asset, a
 * minimum, a confirmation count, or an address. svc-bank does not derive keys.
 */

import type { PayCustodyDepositRecord, PayCustodyDepositStatus } from '@intafaced/contracts';

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
  /** `null` when the network's confirmation count is blank: the row shows no target rather than an invented one. */
  confirmationsRequired: number | null;
}

/** One deposit record as custody keeps it (the pay record, W-deposit-05). */
export type CustodyDepositRecord = PayCustodyDepositRecord;

export interface CustodyDepositRecordsQuery {
  userId: string;
  assetId?: string;
  networkId?: string;
  statuses?: readonly PayCustodyDepositStatus[];
  txHash?: string;
  address?: string;
  offset: number;
  limit: number;
}

export interface CustodyDepositPort {
  /** `null` = catalogue not published. An empty array is a published empty list. */
  listAssets(): Promise<readonly DepositAsset[] | null>;
  /** `null` = custody will not issue an address. */
  address(input: { userId: string; assetId: string; networkId: string }): Promise<CustodyDepositAddress | null>;
  /** `null` = custody is not reporting incoming deposits. An empty array means none are incoming. */
  pending(userId: string): Promise<readonly CustodyPendingDeposit[] | null>;
  /** `null` = custody does not report deposit records. Absent on a port built before the record existed. */
  records?(query: CustodyDepositRecordsQuery): Promise<{ items: readonly CustodyDepositRecord[]; total: number } | null>;
}

export const unsetCustodyDepositPort: CustodyDepositPort = {
  listAssets: async () => null,
  address: async () => null,
  pending: async () => null,
};
