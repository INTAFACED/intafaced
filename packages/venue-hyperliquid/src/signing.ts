import { concat, encodeAbiParameters, hashTypedData, keccak256, recoverAddress, recoverTypedDataAddress, toHex, type Hex } from 'viem';
import { encodeMsgpack, type MsgpackValue } from './msgpack.js';

/**
 * Hyperliquid's two signing schemes, TESTNET ONLY.
 *
 * 1. L1 actions (order, cancelByCloid, updateLeverage): the "phantom agent".
 *    `connectionId = keccak256(msgpack(action) ‖ nonce:u64be ‖ vaultFlag
 *    [‖ vault:20 bytes] [‖ 0x00 ‖ expiresAfter:u64be])`, then the wallet signs
 *    EIP-712 `Agent { source, connectionId }` in the `Exchange` domain
 *    (chain id 1337). `source` is "b" on testnet ("a" is mainnet and is refused
 *    here).
 * 2. User-signed actions (withdraw3, usdSend, usdClassTransfer, approveAgent, approveBuilderFee): EIP-712
 *    `HyperliquidTransaction:<Name>` in the `HyperliquidSignTransaction`
 *    domain, whose chain id is `signatureChainId`; the message carries
 *    `hyperliquidChain: "Testnet"` ("Mainnet" is refused here).
 *
 * Mirrors `hyperliquid/utils/signing.py` in the official Python SDK; proven
 * against that SDK's own vectors in `signing.test.ts`.
 */

export const HL_TESTNET_API_URL = 'https://api.hyperliquid-testnet.xyz';
export const HL_TESTNET_SOURCE = 'b';
export const HL_TESTNET_CHAIN = 'Testnet';
/** The chain id the wallet signs user-signed actions under (Arbitrum Sepolia, 421614), as the SDK sets it. */
export const HL_SIGNATURE_CHAIN_ID = '0x66eee';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

/** Raised when anything would point a signature or a request at mainnet. This piece is testnet only. */
export class HyperliquidNetworkRefusedError extends Error {
  readonly code = 'mainnet_refused' as const;
  constructor(detail: string) {
    super(`refused: ${detail}. This adapter is fixed to the Hyperliquid testnet.`);
    this.name = 'HyperliquidNetworkRefusedError';
  }
}

/** Refuse any base URL but the testnet's. Trailing slashes are tolerated; nothing else is. */
export function assertTestnetUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (trimmed !== HL_TESTNET_API_URL) throw new HyperliquidNetworkRefusedError(`base URL ${baseUrl} is not ${HL_TESTNET_API_URL}`);
  return trimmed;
}

export function assertTestnetChain(chain: string): void {
  if (chain !== HL_TESTNET_CHAIN) throw new HyperliquidNetworkRefusedError(`hyperliquidChain "${chain}" is not "${HL_TESTNET_CHAIN}"`);
}

function addressBytes(address: string): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`not an address: ${address}`);
  return address.toLowerCase() as Hex;
}

function u64(value: bigint): Hex {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) throw new Error(`${value} does not fit u64`);
  return toHex(value, { size: 8 });
}

/** The SDK's `action_hash`: the L1 action's connection id. */
export function actionHash(action: MsgpackValue, vaultAddress: string | null, nonce: bigint, expiresAfter: bigint | null = null): Hex {
  const parts: Hex[] = [toHex(encodeMsgpack(action)), u64(nonce)];
  if (vaultAddress === null) parts.push('0x00');
  else parts.push('0x01', addressBytes(vaultAddress));
  if (expiresAfter !== null) parts.push('0x00', u64(expiresAfter));
  return keccak256(concat(parts));
}

export const L1_DOMAIN = { name: 'Exchange', version: '1', chainId: 1337, verifyingContract: ZERO_ADDRESS } as const;
export const L1_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
} as const;

export interface L1TypedData {
  readonly domain: typeof L1_DOMAIN;
  readonly types: typeof L1_TYPES;
  readonly primaryType: 'Agent';
  readonly message: { readonly source: string; readonly connectionId: Hex };
}

/** What the wallet signs for an L1 action on testnet. */
export function l1TypedData(connectionId: Hex, source: string = HL_TESTNET_SOURCE): L1TypedData {
  if (source !== HL_TESTNET_SOURCE) throw new HyperliquidNetworkRefusedError(`phantom agent source "${source}" is not the testnet's "b"`);
  return { domain: L1_DOMAIN, types: L1_TYPES, primaryType: 'Agent', message: { source, connectionId } };
}

export type Eip712Field = { readonly name: string; readonly type: string };

export const USER_SIGNED_TYPES = {
  'HyperliquidTransaction:Withdraw': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'time', type: 'uint64' },
  ],
  'HyperliquidTransaction:UsdSend': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'destination', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'time', type: 'uint64' },
  ],
  /**
   * The SDK's `USD_CLASS_TRANSFER_SIGN_TYPES` (`hyperliquid/utils/signing.py`). The SDK's tests at the pinned commit
   * hold no vector for it, so `signing.test.ts` proves its digest against an independent EIP-712 encoding instead.
   */
  'HyperliquidTransaction:UsdClassTransfer': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'toPerp', type: 'bool' },
    { name: 'nonce', type: 'uint64' },
  ],
  'HyperliquidTransaction:ApproveAgent': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'agentAddress', type: 'address' },
    { name: 'agentName', type: 'string' },
    { name: 'nonce', type: 'uint64' },
  ],
  'HyperliquidTransaction:ApproveBuilderFee': [
    { name: 'hyperliquidChain', type: 'string' },
    { name: 'maxFeeRate', type: 'string' },
    { name: 'builder', type: 'address' },
    { name: 'nonce', type: 'uint64' },
  ],
} as const satisfies Record<string, readonly Eip712Field[]>;

export type UserSignedPrimaryType = keyof typeof USER_SIGNED_TYPES;

export interface UserSignedTypedData {
  readonly domain: {
    readonly name: 'HyperliquidSignTransaction';
    readonly version: '1';
    readonly chainId: number;
    readonly verifyingContract: typeof ZERO_ADDRESS;
  };
  readonly types: { readonly [primaryType: string]: readonly Eip712Field[] };
  readonly primaryType: string;
  /** Typed fields only; `uint64` fields as bigint, `bool` fields as boolean. */
  readonly message: Readonly<Record<string, string | bigint | boolean>>;
}

/** The SDK's `user_signed_payload`. `message` must carry `hyperliquidChain`, which must be "Testnet". */
export function userSignedTypedData(
  primaryType: string,
  types: readonly Eip712Field[],
  message: Readonly<Record<string, string | bigint | boolean>>,
  signatureChainId: string = HL_SIGNATURE_CHAIN_ID,
): UserSignedTypedData {
  assertTestnetChain(String(message.hyperliquidChain));
  const typed: Record<string, string | bigint | boolean> = {};
  for (const field of types) {
    const value = message[field.name];
    if (value === undefined) throw new Error(`${primaryType}: missing field ${field.name}`);
    typed[field.name] = value;
  }
  return {
    domain: {
      name: 'HyperliquidSignTransaction',
      version: '1',
      chainId: Number.parseInt(signatureChainId, 16),
      verifyingContract: ZERO_ADDRESS,
    },
    types: { [primaryType]: types },
    primaryType,
    message: typed,
  };
}

export type HlTypedData = L1TypedData | UserSignedTypedData;

/**
 * The SDK's `usd_transfer`: move perpetual-account USDC to another address on the TESTNET. `amount` is the
 * venue's decimal string; `time` is the nonce. Returns the wire action and what the wallet signs.
 */
export function usdSendAction(
  destination: string,
  amount: string,
  nonce: bigint,
): { readonly action: Record<string, MsgpackValue>; readonly typedData: UserSignedTypedData } {
  const to = addressBytes(destination);
  if (!/^\d+(\.\d+)?$/.test(amount) || /^0+(\.0+)?$/.test(amount)) throw new Error(`usdSend: ${amount} is not a positive decimal`);
  const typedData = userSignedTypedData('HyperliquidTransaction:UsdSend', USER_SIGNED_TYPES['HyperliquidTransaction:UsdSend'], {
    hyperliquidChain: HL_TESTNET_CHAIN,
    destination: to,
    amount,
    time: nonce,
  });
  const action: Record<string, MsgpackValue> = {
    type: 'usdSend',
    signatureChainId: HL_SIGNATURE_CHAIN_ID,
    hyperliquidChain: HL_TESTNET_CHAIN,
    destination: to,
    amount,
    time: Number(nonce),
  };
  return { action, typedData };
}

/**
 * The SDK's `usd_class_transfer`: move USDC between this account's spot and perpetual balances on the TESTNET
 * (`toPerp: true` is spot to perp). `amount` is the venue's decimal string; `nonce` is the action's nonce. Returns the
 * wire action and what the wallet signs. The SDK appends " subaccount:<address>" to the amount for a vault; that form
 * is not offered here.
 */
export function usdClassTransferAction(
  amount: string,
  toPerp: boolean,
  nonce: bigint,
): { readonly action: Record<string, MsgpackValue>; readonly typedData: UserSignedTypedData } {
  if (!/^\d+(\.\d+)?$/.test(amount) || /^0+(\.0+)?$/.test(amount)) throw new Error(`usdClassTransfer: ${amount} is not a positive decimal`);
  const typedData = userSignedTypedData(
    'HyperliquidTransaction:UsdClassTransfer',
    USER_SIGNED_TYPES['HyperliquidTransaction:UsdClassTransfer'],
    { hyperliquidChain: HL_TESTNET_CHAIN, amount, toPerp, nonce },
  );
  const action: Record<string, MsgpackValue> = {
    type: 'usdClassTransfer',
    signatureChainId: HL_SIGNATURE_CHAIN_ID,
    hyperliquidChain: HL_TESTNET_CHAIN,
    amount,
    toPerp,
    nonce: Number(nonce),
  };
  return { action, typedData };
}

const EIP712_DOMAIN_TYPE = 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)';

function encodeField(type: string, value: string | bigint | number | boolean): { type: string; value: unknown } {
  switch (type) {
    case 'bool':
      if (typeof value !== 'boolean') throw new Error(`EIP-712 bool field holds ${typeof value}, not a boolean`);
      return { type: 'bool', value };
    case 'string':
      return { type: 'bytes32', value: keccak256(toHex(String(value))) };
    case 'uint64':
    case 'uint256':
      return { type: 'uint256', value: BigInt(value) };
    case 'address':
      return { type: 'address', value: addressBytes(String(value)) };
    case 'bytes32':
      return { type: 'bytes32', value };
    default:
      throw new Error(`EIP-712 field type ${type} is not used by these actions`);
  }
}

/**
 * EIP-712 digest for a flat struct, written out: `keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`.
 * viem refuses a struct name with a colon (`HyperliquidTransaction:Withdraw`), which the venue and every wallet
 * accept, so user-signed actions are hashed here. Checked against the SDK vectors and against viem on the L1 struct.
 */
export function flatTypedDataDigest(
  domain: { name: string; version: string; chainId: number; verifyingContract: string },
  primaryType: string,
  fields: readonly Eip712Field[],
  message: Readonly<Record<string, string | bigint | number | boolean>>,
): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        keccak256(toHex(EIP712_DOMAIN_TYPE)),
        keccak256(toHex(domain.name)),
        keccak256(toHex(domain.version)),
        BigInt(domain.chainId),
        addressBytes(domain.verifyingContract),
      ],
    ),
  );
  const typeString = `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(',')})`;
  const encoded = fields.map((f) => {
    const value = message[f.name];
    if (value === undefined) throw new Error(`${primaryType}: missing field ${f.name}`);
    return encodeField(f.type, value);
  });
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, ...encoded.map((e) => ({ type: e.type }))],
      [keccak256(toHex(typeString)), ...encoded.map((e) => e.value)],
    ),
  );
  return keccak256(concat(['0x1901', domainSeparator, structHash]));
}

export function typedDataDigest(typed: HlTypedData): Hex {
  if (typed.primaryType === 'Agent') return hashTypedData(typed as L1TypedData);
  const user = typed as UserSignedTypedData;
  const fields = user.types[user.primaryType];
  if (!fields) throw new Error(`typed data has no type for ${user.primaryType}`);
  return flatTypedDataDigest(user.domain, user.primaryType, fields, user.message);
}

/** The address that made `signature` over `typed`, lowercase; `null` when the bytes don't recover. */
export async function recoverTypedDataSigner(typed: HlTypedData, signature: string): Promise<string | null> {
  try {
    if (typed.primaryType === 'Agent') {
      return (await recoverTypedDataAddress({ ...(typed as L1TypedData), signature: signature as Hex })).toLowerCase();
    }
    return (await recoverAddress({ hash: typedDataDigest(typed), signature: signature as Hex })).toLowerCase();
  } catch {
    return null;
  }
}

/** Hyperliquid's wire signature: `{ r, s, v }` from a 65-byte hex signature. */
export function splitSignature(signature: string): { r: Hex; s: Hex; v: number } {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('a signature must be 65 bytes of hex');
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  let v = Number.parseInt(signature.slice(130, 132), 16);
  if (v < 27) v += 27;
  return { r, s, v };
}
