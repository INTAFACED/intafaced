import { parseAbi } from 'viem';

/**
 * The order vault's interface (services/svc-protocol/contracts/orders/OrderVault.sol), written here as viem
 * human-readable ABI because a service never reads another service's files (boundary gate). svc-protocol's on-chain
 * test exercises the deployed bytecode; this process only reads it and builds calls for the person's wallet.
 */
const ORDER_TUPLE =
  '(address maker, address base, address quote, bool isBuy, bool above, uint256 amountIn, uint256 triggerWad, uint256 trailBps, uint256 minOut, uint256 expiry, uint256 nonce, uint256 version, bytes32 link, bytes32 parent, bool outputToVault)';

export const ORDER_VAULT_ABI = parseAbi([
  'function deposit(address token, uint256 amount)',
  'function withdraw(address token, uint256 amount)',
  'function credit(address maker, address token) view returns (uint256)',
  'function uncredited(address token) view returns (uint256)',
  'function sweepUncredited(address token, address to, uint256 amount)',
  'function cancel(uint256 nonce)',
  'function raiseVersion(uint256 nonce, uint256 version)',
  'function cancelled(bytes32 orderId) view returns (bool)',
  'function filled(bytes32 group) view returns (uint256)',
  'function boughtOut(bytes32 orderId) view returns (uint256)',
  'function watermark(bytes32 orderHash) view returns (uint256)',
  'function orderId(address maker, uint256 nonce) pure returns (bytes32)',
  'function price(address base, address quote) view returns (uint256)',
  `function remaining(${ORDER_TUPLE} order) view returns (uint256)`,
  `function triggerOf(${ORDER_TUPLE} order) view returns (uint256)`,
  `function hashOrder(${ORDER_TUPLE} o) view returns (bytes32)`,
  `function poke(${ORDER_TUPLE} order) returns (uint256)`,
  `function fill(${ORDER_TUPLE} order, bytes signature, uint256 take, address pool) returns (uint256)`,
  'event Deposited(address indexed maker, address indexed token, uint256 amount)',
  'event Withdrawn(address indexed maker, address indexed token, uint256 amount)',
  'event Filled(bytes32 indexed orderId, address indexed maker, uint256 amountIn, uint256 amountOut, uint256 priceWad)',
  'event Swept(address indexed token, address indexed to, uint256 amount)',
  'error BadAmount()',
  'error InsufficientCredit()',
  'error OrderExpired()',
  'error OrderCancelled()',
  'error StaleVersion()',
  'error BadSignature()',
  'error Overfill()',
  'error TriggerNotReached()',
  'error BelowMinOut()',
  'error BadPool()',
  'error NotSweeper()',
  'error NothingToSweep()',
  'error NotTrailing()',
  'error TransferFailed()',
  'error Reentered()',
  // The fail-closed oracle's own refusals, which the vault's price read passes through.
  'error Stale()',
  'error Disagreement()',
  'error MissingReport()',
]);

export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

export const POOL_ABI = parseAbi([
  'function token0() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function feeBps() view returns (uint16)',
]);

/** The EIP-712 order the maker signs; the field order is the contract's ORDER_TYPEHASH. */
export const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'base', type: 'address' },
    { name: 'quote', type: 'address' },
    { name: 'isBuy', type: 'bool' },
    { name: 'above', type: 'bool' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'triggerWad', type: 'uint256' },
    { name: 'trailBps', type: 'uint256' },
    { name: 'minOut', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'version', type: 'uint256' },
    { name: 'link', type: 'bytes32' },
    { name: 'parent', type: 'bytes32' },
    { name: 'outputToVault', type: 'bool' },
  ],
} as const;
export const ORDER_DOMAIN_NAME = 'INTAFACED Order Vault';
export const ORDER_DOMAIN_VERSION = '1';
