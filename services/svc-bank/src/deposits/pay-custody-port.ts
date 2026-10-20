import type { PayCustodyDepositPort } from '@intafaced/contracts';
import type { CustodyDepositPort, DepositAsset } from './custody-port.js';

/**
 * The real `CustodyDepositPort` (W-deposit-01): every answer comes from svc-pay over the signed seam in
 * `@intafaced/contracts`. svc-bank derives no key and reads none of svc-pay's tables.
 *
 * `null` means custody is not answering, and the deposit service turns it into `bank.deposit_custody_unset`: a pay that is
 * unreachable, a refused pair and a reply that did not parse all look the same to the customer, and none of them invents an
 * asset, a minimum, a confirmation count or an address. `pending` stays `null` until the deposit record lands (W-deposit-05):
 * there is nothing true to report as incoming yet, and an empty list would say "connected, nothing incoming".
 */
export function createPayCustodyDepositPort(pay: PayCustodyDepositPort): CustodyDepositPort {
  return {
    async listAssets() {
      const answer = await pay.catalogue();
      if (answer.state !== 'ok') return null;
      const byAsset = new Map<string, DepositAsset>();
      for (const entry of answer.catalogue.entries) {
        const asset = byAsset.get(entry.assetId) ?? { assetId: entry.assetId, networks: [] };
        asset.networks = [
          ...asset.networks,
          {
            id: entry.networkId,
            label: entry.label,
            minimumDeposit: entry.minimumDeposit,
            confirmationsRequired: entry.confirmationsRequired,
            estimatedArrivalMinutes: entry.estimatedArrivalMinutes,
          },
        ];
        byAsset.set(entry.assetId, asset);
      }
      return [...byAsset.values()];
    },

    async address(input) {
      const answer = await pay.address(input);
      if (answer.state !== 'issued') return null;
      return { address: answer.address.address, memo: answer.address.memo, qrPayload: answer.address.qrPayload };
    },

    async pending() {
      return null;
    },
  };
}
