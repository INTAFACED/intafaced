import { createL1ActionHash, signUserSignedAction } from '@nktkas/hyperliquid/signing';
import {
  ApproveAgentTypes,
  ApproveBuilderFeeTypes,
  SendAssetTypes,
  SpotSendTypes,
  UsdClassTransferTypes,
  UsdSendTypes,
  Withdraw3Types,
} from '@nktkas/hyperliquid/api/exchange';
import type { Hex } from 'viem';
import type { HlTypedData, L1TypedData, UserSignedTypedData } from './signing.js';

/**
 * Two independent builds of every signed action, compared before anything reaches the customer's wallet and again
 * before submit (project-state #1789, the owner's B1 condition on #1906 A2).
 *
 * The adapter builds each action with its own msgpack and hashing, which is proven against the Hyperliquid Python SDK's
 * vectors. `@nktkas/hyperliquid`, pinned exactly, builds the same action a second time. An L1 action (order, cancel,
 * leverage) is signed as a phantom-agent hash, so the wallet shows only that hash and never the order: a poisoned
 * release of either side could change an order and no wallet would show it. A user-signed action (withdraw, approvals)
 * is shown decoded by the wallet, and is compared here too. Any disagreement refuses, typed, and nothing is signed.
 */
export class SigningCrossCheckError extends Error {
  readonly code = 'signing_cross_check_failed' as const;
  constructor(detail: string) {
    super(`refused: the two signing builds disagree (${detail}); nothing was signed or sent`);
    this.name = 'SigningCrossCheckError';
  }
}

/** The library's own EIP-712 types for each user-signed action the adapter builds. */
const LIBRARY_TYPES: Readonly<Record<string, Record<string, readonly { name: string; type: string }[]>>> = {
  'HyperliquidTransaction:Withdraw': Withdraw3Types,
  'HyperliquidTransaction:UsdSend': UsdSendTypes,
  'HyperliquidTransaction:SpotSend': SpotSendTypes,
  'HyperliquidTransaction:SendAsset': SendAssetTypes,
  'HyperliquidTransaction:UsdClassTransfer': UsdClassTransferTypes,
  'HyperliquidTransaction:ApproveAgent': ApproveAgentTypes,
  'HyperliquidTransaction:ApproveBuilderFee': ApproveBuilderFeeTypes,
};

// A well-formed placeholder the capturing wallet answers with: the library parses it, nothing ever submits it.
const PLACEHOLDER_SIGNATURE = `0x${'11'.repeat(64)}1b` as const;

export interface CrossCheckInput {
  readonly action: Record<string, unknown>;
  readonly vaultAddress: string | null;
  readonly nonce: string;
  readonly typedData: HlTypedData;
}

export async function assertSigningAgrees(built: CrossCheckInput): Promise<void> {
  if (built.typedData.primaryType === 'Agent') {
    const ours = (built.typedData as L1TypedData).message.connectionId.toLowerCase();
    const theirs = createL1ActionHash({
      action: built.action,
      nonce: Number(built.nonce),
      ...(built.vaultAddress ? { vaultAddress: built.vaultAddress as Hex } : {}),
    }).toLowerCase();
    if (ours !== theirs) throw new SigningCrossCheckError(`L1 action hash ${ours} against ${theirs}`);
    return;
  }

  const user = built.typedData as UserSignedTypedData;
  const libraryTypes = LIBRARY_TYPES[user.primaryType];
  if (!libraryTypes) throw new SigningCrossCheckError(`no library type for ${user.primaryType}`);
  const ourFields = JSON.stringify(user.types[user.primaryType]);
  const theirFields = JSON.stringify(libraryTypes[user.primaryType]);
  if (ourFields !== theirFields) throw new SigningCrossCheckError(`${user.primaryType} fields ${ourFields} against ${theirFields}`);

  // The library builds the typed data inside its signer, so a wallet that only records what it was asked to sign
  // captures it. No key is involved. The two are compared field by field: viem's own hasher refuses a type name with a
  // colon, and hashing the capture with our encoder would not be a second opinion.
  type Captured = { domain: unknown; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
  const box: { captured: Captured | null } = { captured: null };
  await signUserSignedAction({
    wallet: {
      address: '0x0000000000000000000000000000000000000001',
      signTypedData: async (params: unknown) => {
        box.captured = params as Captured;
        return PLACEHOLDER_SIGNATURE;
      },
    },
    action: built.action as { signatureChainId: `0x${string}` },
    types: libraryTypes,
  });
  const got = box.captured;
  if (!got) throw new SigningCrossCheckError(`the library built no typed data for ${user.primaryType}`);
  // The same value however each side types it: a uint64 as a bigint (ours) or a number (the library's), an address in
  // any letter case.
  const plain = (v: unknown) =>
    JSON.stringify(v, (_k, x) =>
      typeof x === 'bigint' || typeof x === 'number' ? String(x) : typeof x === 'string' ? x.toLowerCase() : x,
    );
  if (got.primaryType !== user.primaryType) throw new SigningCrossCheckError(`primary type ${user.primaryType} against ${got.primaryType}`);
  if (plain(got.domain) !== plain(user.domain)) throw new SigningCrossCheckError(`${user.primaryType} domain differs`);
  if (plain(got.types[user.primaryType]) !== plain(user.types[user.primaryType]))
    throw new SigningCrossCheckError(`${user.primaryType} signed fields differ`);
  for (const field of user.types[user.primaryType] ?? []) {
    if (plain(got.message[field.name]) !== plain(user.message[field.name])) {
      throw new SigningCrossCheckError(`${user.primaryType} field ${field.name} differs`);
    }
  }
}
