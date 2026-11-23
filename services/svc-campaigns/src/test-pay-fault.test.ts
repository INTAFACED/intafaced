import { describe, expect, it } from 'vitest';
import { PayFaults, REVERT_GAS, payFaultInputSchema, withPayFaults } from './test-pay-fault.js';

/** A recording TEST chain: every transfer it was asked to broadcast, and with which gas. */
function recording() {
  const sent: { to: string; units: bigint; gas: bigint | null }[] = [];
  const chain = {
    head: async () => 1n,
    holds: async () => 10n,
    receipt: async () => true,
    find: async () => [],
    send: async (_from: string, to: string, units: bigint) => {
      sent.push({ to, units, gas: null });
      return `0x${sent.length}`;
    },
    sendWithGas: async (_from: string, to: string, units: bigint, gas: bigint) => {
      sent.push({ to, units, gas });
      return `0x${sent.length}`;
    },
  };
  return { chain, sent };
}

describe('TEST pay faults (J-campaigns-19 #1 #2)', () => {
  it('applies each fault once, to the next send of that reward only', async () => {
    const { chain, sent } = recording();
    const faults = new PayFaults();
    const faulty = withPayFaults(chain, faults);
    faults.set('k:lost', 'lost_after_broadcast');
    faults.set('k:none', 'unanswered');
    faults.set('k:revert', 'revert');
    // Broadcast, then the answer is lost.
    await expect(faulty.send('0xus', '0xa', 5n, { rewardKey: 'k:lost' })).rejects.toThrow(/after the chain took it/);
    expect(sent).toEqual([{ to: '0xa', units: 5n, gas: null }]);
    // Nothing reaches the chain.
    await expect(faulty.send('0xus', '0xb', 5n, { rewardKey: 'k:none' })).rejects.toThrow(/nothing reached the chain/);
    expect(sent).toHaveLength(1);
    // Mined with too little gas, so the chain reverts it.
    expect(await faulty.send('0xus', '0xc', 5n, { rewardKey: 'k:revert' })).toBe('0x2');
    expect(sent[1]).toEqual({ to: '0xc', units: 5n, gas: REVERT_GAS });
    // Each was used once: the next sends go straight through, and so does any other reward's or an unnamed one.
    for (const key of ['k:lost', 'k:none', 'k:revert', 'k:other']) await faulty.send('0xus', '0xd', 1n, { rewardKey: key });
    await faulty.send('0xus', '0xd', 1n);
    expect(sent.slice(2).every((s) => s.gas === null && s.to === '0xd')).toBe(true);
    expect(sent).toHaveLength(7);
  });

  it('takes only a known fault for a named reward', () => {
    expect(payFaultInputSchema.safeParse({ rewardKey: 'k', fault: 'revert' }).success).toBe(true);
    expect(payFaultInputSchema.safeParse({ rewardKey: 'k', fault: 'drop_everything' }).success).toBe(false);
    expect(payFaultInputSchema.safeParse({ rewardKey: '', fault: 'revert' }).success).toBe(false);
    expect(payFaultInputSchema.safeParse({ rewardKey: 'k', fault: 'revert', extra: 1 }).success).toBe(false);
  });
});
