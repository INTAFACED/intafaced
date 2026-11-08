import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem';
import { formatAmount, type Amount } from '@intafaced/ledger-client/money';
import type { UserVenueAccount, VenueIntent, VenueSigner } from '@intafaced/venue-contracts';

/**
 * The TEST venue's signed-action format: EIP-712, as a real venue's is, so the
 * customer's wallet signs exactly what it would sign for Hyperliquid (typed
 * data, `eth_signTypedData_v4`) and the simulator recovers the signer from the
 * signature bytes rather than trusting the wallet's word.
 *
 * The domain names the simulator and a chain id no live network uses, so a
 * signature made for it can never be replayed on a real venue.
 */
export const TEST_VENUE_CHAIN_ID = 1_337_000;

export const TEST_VENUE_DOMAIN = {
  name: 'INTAFACED TEST venue simulator',
  version: '1',
  chainId: TEST_VENUE_CHAIN_ID,
} as const;

export const TEST_VENUE_TYPES = {
  Action: [
    { name: 'venue', type: 'string' },
    { name: 'owner', type: 'string' },
    { name: 'subAccount', type: 'string' },
    { name: 'signer', type: 'string' },
    { name: 'signerRole', type: 'string' },
    { name: 'kind', type: 'string' },
    { name: 'payload', type: 'string' },
    { name: 'nonce', type: 'string' },
  ],
} as const;

export interface TestVenueTypedData {
  readonly domain: typeof TEST_VENUE_DOMAIN;
  readonly types: typeof TEST_VENUE_TYPES;
  readonly primaryType: 'Action';
  readonly message: {
    readonly venue: string;
    readonly owner: string;
    readonly subAccount: string;
    readonly signer: string;
    readonly signerRole: string;
    readonly kind: string;
    readonly payload: string;
    readonly nonce: string;
  };
}

/** Canonical JSON of an intent: sorted keys, every Amount as its decimal string. */
export function canonicalIntent(intent: VenueIntent): string {
  const plain = (value: unknown): unknown => {
    if (typeof value === 'bigint') return formatAmount(value as Amount);
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(plain);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = plain((value as Record<string, unknown>)[key]);
    return out;
  };
  return JSON.stringify(plain(intent));
}

export function buildTypedData(
  venueId: string,
  account: UserVenueAccount,
  signer: VenueSigner,
  intent: VenueIntent,
  nonce: string,
): TestVenueTypedData {
  return {
    domain: TEST_VENUE_DOMAIN,
    types: TEST_VENUE_TYPES,
    primaryType: 'Action',
    message: {
      venue: venueId,
      owner: account.owner.toLowerCase(),
      subAccount: account.subAccount ?? '',
      signer: signer.address.toLowerCase(),
      signerRole: signer.role,
      kind: intent.kind,
      payload: canonicalIntent(intent),
      nonce,
    },
  };
}

export function digestOf(typedData: TestVenueTypedData): Hex {
  return hashTypedData(typedData);
}

/** The address that really made `signature` over `typedData`, lowercase; `null` when the bytes don't parse. */
export async function recoverSigner(typedData: TestVenueTypedData, signature: string): Promise<string | null> {
  try {
    const address = await recoverTypedDataAddress({ ...typedData, signature: signature as Hex });
    return address.toLowerCase();
  } catch {
    return null;
  }
}
