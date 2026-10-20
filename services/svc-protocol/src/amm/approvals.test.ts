import { decodeFunctionData, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { createEdgeContext } from '@intafaced/contracts';
import { erc20ApprovalAbi } from '../chain/abi.js';
import { createProtocolRouter, type ProtocolRouterDeps } from '../router.js';
import { buildApprove, buildRevoke, MAX_UINT256, planApproval } from './build.js';

const OWNER = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const SPENDER = '0x3333333333333333333333333333333333333333' as Address;
const ZERO = '0x0000000000000000000000000000000000000000';

const edgeContext = createEdgeContext({ secret: 'an-approvals-test-edge-secret-of-enough-length', serviceName: 'svc-protocol' });
const caller = (deps: ProtocolRouterDeps) =>
  createProtocolRouter(deps).createCaller(edgeContext({ headers: { 'x-intafaced-region': 'DE' }, id: 'req-approvals' })).amm;

function deps(chain: Record<string, unknown>): ProtocolRouterDeps {
  return {
    chain: { config: { chainId: 84532, factory: ZERO, implementation: ZERO }, ...chain },
    registry: {},
    relay: {},
    relayEnabled: () => true,
    ammFactoryAddress: () => ZERO,
    swapSlippageBps: () => null,
  } as unknown as ProtocolRouterDeps;
}
const decode = (data: `0x${string}`) => decodeFunctionData({ abi: erc20ApprovalAbi, data });
const allowance = (value: bigint, reverts = false, seen: string[] = []) => ({
  tokenAllowance: async () => ({ value, blockNumber: 77n }),
  directApproveReverts: async () => (seen.push('simulated'), reverts),
});

describe('approval plan', () => {
  const base = { token: TOKEN, spender: SPENDER, amount: 10n, unlimited: false, directChangeReverts: false };

  it('makes no call when the allowance already covers the amount', () => {
    expect(planApproval({ ...base, current: 10n })).toEqual({ needsApproval: false, resetFirst: false, calls: [] });
    expect(planApproval({ ...base, current: 50n }).calls).toEqual([]);
  });

  it('approves the exact amount, never more, unless unlimited is asked for', () => {
    const plan = planApproval({ ...base, current: 0n });
    expect(plan.calls).toHaveLength(1);
    expect(decode(plan.calls[0]!.data)).toMatchObject({ functionName: 'approve', args: [SPENDER, 10n] });
    const unlimited = planApproval({ ...base, current: 0n, unlimited: true });
    expect(decode(unlimited.calls[0]!.data).args).toEqual([SPENDER, MAX_UINT256]);
    expect(unlimited.calls[0]!.summary).toContain('UNLIMITED');
  });

  it('resets to zero first only when a non-zero allowance exists and the token refuses a direct change', () => {
    const reset = planApproval({ ...base, current: 5n, directChangeReverts: true });
    expect(reset.resetFirst).toBe(true);
    expect(reset.calls.map((c) => decode(c.data).args)).toEqual([
      [SPENDER, 0n],
      [SPENDER, 10n],
    ]);
    expect(planApproval({ ...base, current: 5n, directChangeReverts: false }).calls).toHaveLength(1);
    expect(planApproval({ ...base, current: 0n, directChangeReverts: true }).resetFirst).toBe(false);
  });

  it('builds a revoke as approve(spender, 0) and never moves native value', () => {
    const revoke = buildRevoke(TOKEN, SPENDER);
    expect(decode(revoke.data).args).toEqual([SPENDER, 0n]);
    expect(revoke.value).toBe('0');
    expect(buildApprove(TOKEN, SPENDER, 1n).value).toBe('0');
  });
});

describe('amm.checkApproval / buildApprove / buildRevoke', () => {
  const input = { owner: OWNER, token: TOKEN, spender: SPENDER, amount: '10' };

  it('allowance 0 needs one approve(spender, 10), and names the block it read', async () => {
    const out = await caller(deps(allowance(0n))).checkApproval(input);
    expect(out).toMatchObject({ needsApproval: true, resetFirst: false, current: '0', blockNumber: '77', unlimited: false });
    expect(out.calls).toHaveLength(1);
    expect(decode(out.calls[0]!.data as `0x${string}`).args).toEqual([SPENDER, 10n]);
  });

  it('allowance 50 needs nothing and does not simulate', async () => {
    const seen: string[] = [];
    const out = await caller(deps(allowance(50n, false, seen))).checkApproval(input);
    expect(out).toMatchObject({ needsApproval: false, calls: [], current: '50' });
    expect(seen).toEqual([]);
  });

  it('a reset-required token with allowance 5 gets the reset pair', async () => {
    const out = await caller(deps(allowance(5n, true))).checkApproval(input);
    expect(out.resetFirst).toBe(true);
    expect(out.calls.map((c) => decode(c.data as `0x${string}`).args)).toEqual([
      [SPENDER, 0n],
      [SPENDER, 10n],
    ]);
  });

  it('refuses zero and oversized amounts and zero targets, reading nothing', async () => {
    let read = false;
    const c = caller(deps({ tokenAllowance: async () => ((read = true), { value: 0n, blockNumber: 1n }) }));
    await expect(c.checkApproval({ ...input, amount: '0' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.checkApproval({ ...input, amount: (MAX_UINT256 + 1n).toString() })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.checkApproval({ ...input, spender: ZERO })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(c.buildApprove({ token: ZERO, spender: SPENDER, amount: '1' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(read).toBe(false);
  });

  it('builds exact approve, unlimited only by name, and revoke', async () => {
    const c = caller(deps({}));
    const exact = await c.buildApprove({ token: TOKEN, spender: SPENDER, amount: '10' });
    expect(decode(exact.data as `0x${string}`).args).toEqual([SPENDER, 10n]);
    const unlimited = await c.buildApprove({ token: TOKEN, spender: SPENDER, amount: '10', unlimited: true });
    expect(decode(unlimited.data as `0x${string}`).args).toEqual([SPENDER, MAX_UINT256]);
    const revoke = await c.buildRevoke({ token: TOKEN, spender: SPENDER });
    expect(decode(revoke.data as `0x${string}`).args).toEqual([SPENDER, 0n]);
  });

  it('turns a chain that cannot answer into a refusal, not a guess', async () => {
    const down = { tokenAllowance: async () => Promise.reject(new Error('boom')) };
    await expect(caller(deps(down)).checkApproval(input)).rejects.toBeTruthy();
  });
});
