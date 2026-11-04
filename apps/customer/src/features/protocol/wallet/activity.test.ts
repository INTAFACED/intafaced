import { describe, expect, it } from 'vitest';
import { activityCsv, activityRows, isSpam, type ActivityRow } from './ActivityPanel';

const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const LISTED = '0x00000000000000000000000000000000000a11ce';
const DROP = '0x00000000000000000000000000000000000d7090';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const words = { sent: 'You sent', received: 'You received', call: 'Contract call' };
const row = (n: number, over: Partial<Parameters<typeof isSpam>[0]> = {}) => ({
  chainId: 84532,
  hash: hash(n),
  blockHeight: n,
  index: 0,
  timestamp: 1_000 + n,
  from: ME,
  to: OTHER,
  status: 'success' as const,
  revertReason: null,
  transfers: [],
  ...over,
});
const token = (address: string) => ({ address, symbol: address === LISTED ? 'TESTA' : 'TESTDROP', decimals: 6 });

describe('wallet activity rows (D-portfolio-wallet-03, RC-dex-protocol-01)', () => {
  const listed = new Set([LISTED]);

  it('calls spam only an unlisted token someone else sent this wallet unasked', () => {
    expect(isSpam(row(1, { from: OTHER, transfers: [{ token: token(DROP), amount: '1', direction: 'in' }] }), ME, listed)).toBe(true);
    // A listed token, a transfer this wallet sent, and a call with no transfer are never spam.
    expect(isSpam(row(2, { from: OTHER, transfers: [{ token: token(LISTED), amount: '1', direction: 'in' }] }), ME, listed)).toBe(false);
    expect(isSpam(row(3, { transfers: [{ token: token(DROP), amount: '1', direction: 'out' }] }), ME, listed)).toBe(false);
    expect(isSpam(row(4, { from: OTHER }), ME, listed)).toBe(false);
  });

  it('keeps a pending send, and marks it replaced only once its same-nonce replacement is seen', () => {
    const sent = [
      { hash: hash(9), sentAt: 2_000_000, kind: 'speedUp' as const, replaces: hash(8) },
      { hash: hash(8), sentAt: 1_999_000, kind: 'send' as const, label: '1 TEST Token A' },
    ];
    const pending = activityRows(
      [],
      sent,
      [
        { hash: hash(8), status: 'pending', replacingHash: null },
        { hash: hash(9), status: 'pending', replacingHash: null },
      ],
      ME,
      listed,
      words,
      2_000_500,
    );
    expect(pending.map((r) => r.status)).toEqual(['pending', 'pending']);
    const mined = activityRows([row(9)], sent, [{ hash: hash(8), status: 'unknown', replacingHash: null }], ME, listed, words, 2_001_000);
    expect(mined.find((r) => r.hash === hash(8))).toMatchObject({ status: 'replaced', replacedBy: hash(9) });
    expect(mined.find((r) => r.hash === hash(9))).toMatchObject({ status: 'confirmed', mine: true });
  });

  it('exports exactly the rows given, header first, every field quoted', () => {
    const rows: ActivityRow[] = [
      { hash: hash(1), time: 0, what: 'You sent 1 "A"', status: 'confirmed', replacedBy: null, mine: true, spam: false },
    ];
    expect(
      activityCsv(rows, () => 'Confirmed')
        .trim()
        .split('\n'),
    ).toEqual(['"Transaction","Time (UTC)","What","Status"', `"${hash(1)}","1970-01-01T00:00:00.000Z","You sent 1 ""A""","Confirmed"`]);
  });
});
