import type { PayoutApproval } from '@intafaced/contracts';
import { describe, expect, it } from 'vitest';
import {
  approvalKpis,
  approvalsCsv,
  filterApprovals,
  hasApprovalFilter,
  parseApprovalQuery,
  sortApprovals,
  tookPart,
} from './approvals-model';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const hash = `sha256:${'a'.repeat(64)}`;
const row = (n: number, over: Partial<PayoutApproval> = {}): PayoutApproval => ({
  approvalId: `0000000${n}-0000-4000-8000-000000000000`,
  merchantId: `a000000${n}-0000-4000-8000-000000000001`,
  settlementId: `5000000${n}-0000-4000-8000-000000000000`,
  amount: '1200.5',
  assetCode: 'USDT',
  payloadHash: hash as PayoutApproval['payloadHash'],
  status: 'pending',
  makerUserId: OTHER,
  checkerUserId: OTHER,
  railId: 'crypto-native',
  destinationKind: 'crypto',
  destinationMasked: '0x0000…0f01',
  createdAt: '2026-10-15T09:00:00.000Z',
  decidedAt: null,
  expiresAt: '2026-10-15T21:00:00.000Z',
  ...over,
});
const names = new Map<string, string | null>([['a0000001-0000-4000-8000-000000000001', 'Acme Shop']]);

describe('approvals queue model', () => {
  it('reads filters from the URL and drops anything unknown', () => {
    expect(parseApprovalQuery({})).toEqual({ q: '', asset: '', sort: 'oldest', urgent: false });
    expect(parseApprovalQuery({ q: ' acme ', asset: 'usdt', sort: 'expiry', urgent: '1' })).toEqual({
      q: 'acme',
      asset: 'USDT',
      sort: 'expiry',
      urgent: true,
    });
    expect(parseApprovalQuery({ sort: 'DROP TABLE' }).sort).toBe('oldest');
    expect(hasApprovalFilter(parseApprovalQuery({}))).toBe(false);
    expect(hasApprovalFilter(parseApprovalQuery({ q: 'x' }))).toBe(true);
  });

  it('searches by merchant name, merchant id and approval id; filters by asset and urgency', () => {
    const rows = [
      row(1),
      row(2, { assetCode: 'EUR' }),
      row(3, { createdAt: '2026-10-15T08:00:00.000Z', expiresAt: '2026-10-15T12:30:00.000Z' }),
    ];
    const q = (o: Record<string, string>) => filterApprovals(rows, parseApprovalQuery(o), names, NOW).map((r) => r.approvalId.slice(0, 8));
    expect(q({ q: 'acme' })).toEqual(['00000001']);
    expect(q({ q: 'a0000002' })).toEqual(['00000002']);
    expect(q({ q: '00000003' })).toEqual(['00000003']);
    expect(q({ asset: 'EUR' })).toEqual(['00000002']);
    expect(q({ urgent: '1' })).toEqual(['00000003']);
  });

  it('sorts by age or by time left without mutating the input', () => {
    const rows = [
      row(1, { createdAt: '2026-10-15T10:00:00.000Z' }),
      row(2, { createdAt: '2026-10-15T07:00:00.000Z', expiresAt: '2026-10-15T20:00:00.000Z' }),
    ];
    expect(sortApprovals(rows, 'oldest').map((r) => r.approvalId.slice(0, 8))).toEqual(['00000002', '00000001']);
    expect(sortApprovals(rows, 'newest').map((r) => r.approvalId.slice(0, 8))).toEqual(['00000001', '00000002']);
    expect(sortApprovals(rows, 'expiry').map((r) => r.approvalId.slice(0, 8))).toEqual(['00000002', '00000001']);
    expect(rows[0]?.approvalId.slice(0, 8)).toBe('00000001');
  });

  it('counts waiting, oldest, running out of time, expired and the ones you took part in', () => {
    const rows = [
      row(1),
      row(2, { makerUserId: ME }),
      row(3, { checkerUserId: ME, createdAt: '2026-10-15T08:00:00.000Z', expiresAt: '2026-10-15T12:30:00.000Z' }),
      row(4, { createdAt: '2026-10-14T08:00:00.000Z', expiresAt: '2026-10-15T11:00:00.000Z' }),
    ];
    expect(approvalKpis(rows, NOW, ME)).toEqual({
      waiting: 4,
      oldestCreatedAt: '2026-10-14T08:00:00.000Z',
      expiringSoon: 1,
      expired: 1,
      involvingYou: 2,
    });
    expect(approvalKpis([], NOW, ME)).toEqual({ waiting: 0, oldestCreatedAt: null, expiringSoon: 0, expired: 0, involvingYou: 0 });
    expect(tookPart(rows[1]!, ME)).toBe(true);
    expect(tookPart(rows[0]!, ME)).toBe(false);
    expect(tookPart(rows[0]!, undefined)).toBe(false);
  });

  it('exports exactly the rows given, with generated-at and as-of, and neutralises spreadsheet formulas in names', () => {
    const csv = approvalsCsv(
      [row(1)],
      new Map([['a0000001-0000-4000-8000-000000000001', '=HYPERLINK("x")']]),
      NOW.toISOString(),
      '2026-10-15T11:59:00.000Z',
      'Filtered view.',
    );
    expect(csv).toContain('# Generated at 2026-10-15T12:00:00.000Z');
    expect(csv).toContain('# Data as of 2026-10-15T11:59:00.000Z');
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain('1200.5,USDT');
    expect(csv.split('\r\n').filter((l) => l && !l.startsWith('#'))).toHaveLength(2);
  });
});
