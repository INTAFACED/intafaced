/**
 * The contract surface this service speaks to, hand-written from
 * `contracts/*.sol`.
 *
 * Hand-written, and kept that way — though the reason has changed. It was
 * "there is no Solidity compiler in this toolchain yet", which was literally
 * true until `scripts/compile-contracts.mjs` landed. Now these stay
 * hand-written because they are the surface this service CHOSE to speak to,
 * which is deliberately a subset of what the contracts expose, and
 * `artifacts.test.ts` checks every entry below against the compiled ABI — so
 * drift is a build failure rather than something a reviewer must catch by eye.
 *
 * Note what is absent, and stays absent: there is no function on any ABI here
 * that this service could call to move a user's funds, because there is no such
 * function on any of these contracts.
 */

export const SESSION_SPEC_COMPONENTS = [
  { name: 'key', type: 'address' },
  { name: 'validAfter', type: 'uint48' },
  { name: 'validUntil', type: 'uint48' },
  { name: 'spendLimitWei', type: 'uint128' },
  { name: 'targets', type: 'address[]' },
  { name: 'selectors', type: 'bytes4[]' },
] as const;

export const accountFactoryAbi = [
  {
    type: 'function',
    name: 'implementation',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'getAddress',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'userSalt', type: 'bytes32' },
    ],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'isDeployed',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'userSalt', type: 'bytes32' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'createAccount',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'userSalt', type: 'bytes32' },
    ],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'event',
    name: 'AccountCreated',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'userSalt', type: 'bytes32', indexed: true },
    ],
  },
] as const;

export const smartAccountAbi = [
  { type: 'function', name: 'owner', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'entryPoint', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'sessionEpoch', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  {
    type: 'function',
    name: 'getSession',
    stateMutability: 'view',
    inputs: [{ name: 'sessionKey', type: 'address' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'specHash', type: 'bytes32' },
          { name: 'validAfter', type: 'uint48' },
          { name: 'validUntil', type: 'uint48' },
          { name: 'spentWei', type: 'uint128' },
          { name: 'epoch', type: 'uint64' },
          { name: 'revoked', type: 'bool' },
        ],
      },
    ],
  },
  {
    type: 'function',
    name: 'isSessionLive',
    stateMutability: 'view',
    inputs: [{ name: 'sessionKey', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'grantSession',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'spec', type: 'tuple', components: SESSION_SPEC_COMPONENTS }],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeSession',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'sessionKey', type: 'address' }],
    outputs: [],
  },
  { type: 'function', name: 'bumpSessionEpoch', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'executeWithSession',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spec', type: 'tuple', components: SESSION_SPEC_COMPONENTS },
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    outputs: [{ type: 'bytes' }],
  },
  {
    type: 'event',
    name: 'SessionGranted',
    inputs: [
      { name: 'sessionKey', type: 'address', indexed: true },
      { name: 'specHash', type: 'bytes32', indexed: false },
      { name: 'validAfter', type: 'uint48', indexed: false },
      { name: 'validUntil', type: 'uint48', indexed: false },
      { name: 'spendLimitWei', type: 'uint128', indexed: false },
      { name: 'targets', type: 'address[]', indexed: false },
      { name: 'selectors', type: 'bytes4[]', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'SessionRevoked',
    inputs: [
      { name: 'sessionKey', type: 'address', indexed: true },
      { name: 'revokedBy', type: 'address', indexed: true },
    ],
  },
] as const;

/**
 * `TokenFactory.TokenParams` — the struct, as a tuple.
 *
 * Field ORDER is load-bearing twice over: it is the ABI encoding of a call
 * argument, and the same order appears in `SovereignToken`'s constructor, which
 * is what `launch/address.ts` encodes to build the init code. Reordering here
 * without reordering the Solidity produces a call that decodes into the wrong
 * fields and an address that is confidently wrong. `artifacts.test.ts` compares
 * the canonical tuple signature, so a swap of the two `string`s — the one case
 * that would still encode — is caught by the on-chain cross-check instead.
 */
export const TOKEN_PARAMS_COMPONENTS = [
  { name: 'name', type: 'string' },
  { name: 'symbol', type: 'string' },
  { name: 'decimals', type: 'uint8' },
  { name: 'totalSupply', type: 'uint256' },
  { name: 'recipient', type: 'address' },
] as const;

export const tokenFactoryAbi = [
  {
    type: 'function',
    name: 'getAddress',
    stateMutability: 'view',
    inputs: [
      { name: 'creator', type: 'address' },
      { name: 'userSalt', type: 'bytes32' },
      { name: 'params', type: 'tuple', components: TOKEN_PARAMS_COMPONENTS },
    ],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'function',
    name: 'isDeployed',
    stateMutability: 'view',
    inputs: [
      { name: 'creator', type: 'address' },
      { name: 'userSalt', type: 'bytes32' },
      { name: 'params', type: 'tuple', components: TOKEN_PARAMS_COMPONENTS },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'initCode',
    stateMutability: 'pure',
    inputs: [{ name: 'params', type: 'tuple', components: TOKEN_PARAMS_COMPONENTS }],
    outputs: [{ type: 'bytes' }],
  },
  /** Provenance for §35 deployer reputation. `0x0` means "not from this factory". */
  {
    type: 'function',
    name: 'creatorOf',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'address' }],
  },
  { type: 'function', name: 'MAX_DECIMALS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'createToken',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'userSalt', type: 'bytes32' },
      { name: 'params', type: 'tuple', components: TOKEN_PARAMS_COMPONENTS },
    ],
    outputs: [{ type: 'address' }],
  },
  {
    type: 'event',
    name: 'TokenCreated',
    inputs: [
      { name: 'token', type: 'address', indexed: true },
      { name: 'creator', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: true },
      { name: 'name', type: 'string', indexed: false },
      { name: 'symbol', type: 'string', indexed: false },
      { name: 'decimals', type: 'uint8', indexed: false },
      { name: 'totalSupply', type: 'uint256', indexed: false },
    ],
  },
] as const;

/**
 * The READ surface of a launched token. Reads only, on purpose.
 *
 * `transfer`, `approve` and `transferFrom` are absent and must stay absent.
 * Not because they would fail — this service holds no key, so it could not
 * originate any of them — but because their presence on an ABI this service
 * imports is the shape a custody bug takes on the way in. `custody-scan`
 * watches the ledger surface; this is the same instinct applied to the chain.
 *
 * `decimals` is `uint8`: decoding it as `uint256` would still work today and
 * break the moment a token returns something else in the high bytes, which is
 * exactly the class of silent corruption `artifacts.test.ts` exists to catch.
 */
export const erc20ReadAbi = [
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'initialHolder', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/**
 * The two ERC-20 members an approval flow touches. `approve` is encoded here and never sent by this service: the
 * owner signs it. `allowance` is read at a pinned block so the answer says which block it describes.
 */
export const erc20ApprovalAbi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
] as const;

/** ERC-20 `Approval(owner, spender, value)`: read to find which spenders an owner has approved, never as the amount. */
export const erc20ApprovalEvent = {
  type: 'event',
  name: 'Approval',
  inputs: [
    { name: 'owner', type: 'address', indexed: true },
    { name: 'spender', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const;
