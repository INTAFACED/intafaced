import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseAbi } from 'viem';
import { protocolEscrowBuildInputSchema } from '@intafaced/contracts';
import { buildEscrowCall, escrowStatus, readDeal, SOVEREIGN_ESCROW_ABI, type EscrowChain, type EscrowSetting } from './sovereign.js';

const ESCROW = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x000000000000000000000000000000000000d011';
const BUYER = '0x2222222222222222222222222222222222222222';
const SELLER = '0x3333333333333333333333333333333333333333';
const ZERO = '0x0000000000000000000000000000000000000000';
const sepolia: EscrowSetting = { chainId: 84532, escrow: ESCROW, mainnet: false };

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return 'no refusal';
};

describe('sovereign P2P escrow builders (RC-p2p-01)', () => {
  it('builds lock(7) against the configured escrow with value 0', () => {
    const call = buildEscrowCall(sepolia, { action: 'lock', dealId: '7' });
    expect(call.to.toLowerCase()).toBe(ESCROW);
    expect(call.value).toBe('0');
    const decoded = decodeFunctionData({ abi: SOVEREIGN_ESCROW_ABI, data: call.data as `0x${string}` });
    expect(decoded).toMatchObject({ functionName: 'lock', args: [7n] });
  });

  it('opens with no arbiter and no fee, the dispute window and the agreed timeout', () => {
    const call = buildEscrowCall(sepolia, {
      action: 'open',
      buyer: BUYER,
      token: TOKEN,
      amount: '25000000',
      disputeWindowSeconds: 300,
      timeout: 'refund_seller',
    });
    const decoded = decodeFunctionData({ abi: SOVEREIGN_ESCROW_ABI, data: call.data as `0x${string}` });
    expect(decoded.functionName).toBe('open');
    expect(decoded.args?.map(String)).toEqual([
      BUYER,
      '0x000000000000000000000000000000000000d011',
      '25000000',
      ZERO,
      ZERO,
      '0',
      '300',
      '0',
    ]);
  });

  it('approves only the escrow as spender', () => {
    const call = buildEscrowCall(sepolia, { action: 'approve', token: TOKEN, amount: '5' });
    expect(call.to.toLowerCase()).toBe(TOKEN);
    const decoded = decodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), data: call.data as `0x${string}` });
    expect(decoded.args?.map((a) => String(a).toLowerCase())).toEqual([ESCROW, '5']);
  });

  it('refuses every builder with protocol.escrow_not_deployed when the chain has no escrow', () => {
    for (const escrow of [null, ZERO] as const) {
      const setting = { ...sepolia, escrow };
      for (const action of ['lock', 'release', 'refund', 'dispute', 'settleTimeout'] as const)
        expect(codeOf(() => buildEscrowCall(setting, { action, dealId: '1' }))).toBe('protocol.escrow_not_deployed');
      expect(escrowStatus(setting).testnet).toMatchObject({ deployed: false, blocker: 'protocol.escrow_not_deployed', escrow: null });
    }
  });

  it('refuses audit.external on a mainnet chain, and status always says mainnet is off and audited is false', () => {
    const mainnet = { ...sepolia, chainId: 8453, mainnet: true };
    expect(codeOf(() => buildEscrowCall(mainnet, { action: 'release', dealId: '1' }))).toBe('audit.external');
    expect(codeOf(() => escrowStatus(mainnet))).toBe('audit.external');
    const status = escrowStatus(sepolia);
    expect(status).toMatchObject({
      testnet: { chainId: 84532, label: 'Base Sepolia testnet, not INTACHAIN', deployed: true, blocker: null },
      mainnet: { available: false, blocker: 'audit.external' },
      audited: false,
    });
  });

  it('refuses an amount with a decimal point or past uint128', () => {
    expect(protocolEscrowBuildInputSchema.safeParse({ action: 'approve', token: TOKEN, amount: '1.5' }).success).toBe(false);
    expect(codeOf(() => buildEscrowCall(sepolia, { action: 'approve', token: TOKEN, amount: (1n << 128n).toString() }))).toBe(
      'protocol.escrow_amount_invalid',
    );
  });
});

describe('protocol.escrow.deal read', () => {
  const chainWith = (status: number, held: bigint, opened = true): EscrowChain =>
    ({
      getBlock: async () => ({ number: 10n, timestamp: 1_000n }),
      readContract: async () => [SELLER, BUYER, TOKEN, held, ZERO, ZERO, 0, 300, status === 3 ? 1_300n : 0n, status, 0],
      getLogs: async () => (opened ? [{ args: { amount: 25_000_000n } }] : []),
    }) as unknown as EscrowChain;

  it('reads a locked deal with the amount it was opened for', async () => {
    const deal = await readDeal(chainWith(2, 25_000_000n), sepolia, '7');
    expect(deal).toMatchObject({
      dealId: '7',
      state: 'locked',
      amount: '25000000',
      held: '25000000',
      arbiter: null,
      timeout: 'refund_seller',
    });
  });

  it('keeps the opened amount after release, when the contract holds nothing', async () => {
    const deal = await readDeal(chainWith(4, 0n), sepolia, '7');
    expect(deal).toMatchObject({ state: 'released', amount: '25000000', held: '0' });
  });

  it('refuses protocol.escrow_deal_not_found for a deal the contract never opened', async () => {
    await expect(readDeal(chainWith(0, 0n, false), sepolia, '99')).rejects.toMatchObject({ code: 'protocol.escrow_deal_not_found' });
  });
});
