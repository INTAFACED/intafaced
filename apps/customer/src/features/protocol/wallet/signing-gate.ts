import type { ProtocolApi, RepresentationStatus } from '../api';
import { REGION_BLOCKED_CODE } from '../region';

/**
 * The representation gate every signing action passes first (D-developer-compliance-03), as Send runs it: it never fails
 * open. `ok` goes on to the wallet; `needed` shows the representation panel first; `refused` names why nothing is offered.
 */
export type SigningGate =
  | { kind: 'ok' }
  | { kind: 'needed'; address: string; status: RepresentationStatus }
  | { kind: 'refused'; key: 'permitRefused_region' | 'permitRefused_representation_unset' | 'permitRefused_representation_unavailable' };

export async function signingGate(api: ProtocolApi, address: string): Promise<SigningGate> {
  const representation = await api.representationStatus(address);
  if (!representation.ok)
    return {
      kind: 'refused',
      key:
        representation.code === REGION_BLOCKED_CODE
          ? 'permitRefused_region'
          : representation.code === 'compliance.representation_unset'
            ? 'permitRefused_representation_unset'
            : 'permitRefused_representation_unavailable',
    };
  return representation.data.accepted ? { kind: 'ok' } : { kind: 'needed', address, status: representation.data };
}
