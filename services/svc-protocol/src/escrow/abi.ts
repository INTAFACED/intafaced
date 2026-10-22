/** Minimal SovereignEscrow ABI for building calldata only (from contracts/out/SovereignEscrow.json). */
export const sovereignEscrowAbi = [
  {
    type: 'function',
    name: 'dispute',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'dealId',
        type: 'uint256',
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'lock',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'dealId',
        type: 'uint256',
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'open',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'buyer',
        type: 'address',
      },
      {
        name: 'token',
        type: 'address',
      },
      {
        name: 'amount',
        type: 'uint128',
      },
      {
        name: 'arbiter',
        type: 'address',
      },
      {
        name: 'feeRecipient',
        type: 'address',
      },
      {
        name: 'feeBps',
        type: 'uint16',
      },
      {
        name: 'disputeWindow',
        type: 'uint32',
      },
      {
        name: 'timeoutDisposition',
        type: 'uint8',
      },
    ],
    outputs: [
      {
        name: 'dealId',
        type: 'uint256',
      },
    ],
  },
  {
    type: 'function',
    name: 'refund',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'dealId',
        type: 'uint256',
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'dealId',
        type: 'uint256',
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'settleTimeout',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'dealId',
        type: 'uint256',
      },
    ],
    outputs: [],
  },
] as const;
