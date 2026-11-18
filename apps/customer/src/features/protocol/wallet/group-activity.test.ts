import { describe, expect, it } from 'vitest';
import { groupActivityRows, type GroupMemberRead } from './group-activity';

const token = { address: '0x00000000000000000000000000000000000000aa', symbol: 'TKA', decimals: 6 };
const row = (hash: string, timestamp: number, direction: 'in' | 'out', amount: string, status: 'success' | 'failed' = 'success') => ({
  chainId: 84532,
  hash,
  blockHeight: timestamp,
  index: 0,
  timestamp,
  from: '0x1',
  to: '0x2',
  status,
  revertReason: null,
  transfers: [{ token, amount, direction }],
});
const words = { sent: (w: string) => `${w} sent`, received: (w: string) => `${w} received`, call: 'Contract call' };

describe('groupActivityRows', () => {
  it('merges every wallet of the group, newest first, one row per transaction', () => {
    const reads: GroupMemberRead[] = [
      { address: '0xa', name: 'This wallet', rows: [row('0xAA', 10, 'out', '1000000')] },
      { address: '0xb', name: 'TEST second wallet', rows: [row('0xbb', 20, 'out', '2000000', 'failed')] },
    ];
    expect(groupActivityRows(reads, words)).toEqual([
      { hash: '0xbb', time: 20, wallets: ['TEST second wallet'], what: 'TEST second wallet sent 2 TKA', status: 'failed' },
      { hash: '0xaa', time: 10, wallets: ['This wallet'], what: 'This wallet sent 1 TKA', status: 'confirmed' },
    ]);
  });

  it('a transfer between two wallets of the group is one row naming both sides', () => {
    const reads: GroupMemberRead[] = [
      { address: '0xa', name: 'This wallet', rows: [row('0xcc', 5, 'out', '500000')] },
      { address: '0xb', name: 'Other', rows: [row('0xCC', 5, 'in', '500000')] },
    ];
    expect(groupActivityRows(reads, words)).toEqual([
      {
        hash: '0xcc',
        time: 5,
        wallets: ['This wallet', 'Other'],
        what: 'This wallet sent 0.5 TKA; Other received 0.5 TKA',
        status: 'confirmed',
      },
    ]);
  });

  it('no reads, no rows: nothing is made up', () => {
    expect(groupActivityRows([], words)).toEqual([]);
  });
});
