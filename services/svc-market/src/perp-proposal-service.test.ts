import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { PerpProposalService } from './perp-proposal-service.js';
import type { VendorService } from './vendor-service.js';

const USER = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';

const noDatabase = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`proposal reached the database (.${String(property)}) before refusing`);
    },
    apply() {
      throw new Error('proposal reached the database before refusing');
    },
  },
) as Sql;

function vendors(listed = true): VendorService {
  return {
    listingEligibility: vi.fn(async () =>
      listed
        ? { vendorId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', listed: true }
        : { vendorId: null, listed: false, code: 'market.vendor_not_found', reason: 'Apply as a vendor first.' },
    ),
  } as unknown as VendorService;
}

type MemorySql = Sql & { proposalEventCount: () => number };

function memorySql(): MemorySql {
  let proposal: Record<string, unknown> | null = null;
  let proposalEvents = 0;
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.join('?');
    if (query.includes('INSERT INTO market.perp_proposals')) {
      if (proposal) return [];
      proposal = {
        id: values[0],
        proposer_id: values[1],
        symbol: values[2],
        settle: values[3],
        oracle_source: values[4],
        leverage_cap: `${values[5]}00000000000000000`,
        status: 'proposed',
        created_at: new Date('2026-08-23T12:00:00.000Z'),
        updated_at: new Date('2026-08-23T12:00:00.000Z'),
      };
      return [proposal];
    }
    if (query.includes('FROM market.perp_proposals')) return proposal ? [proposal] : [];
    if (query.includes('INSERT INTO market.perp_proposal_status_events')) {
      proposalEvents += 1;
      return [];
    }
    throw new Error(`unexpected query: ${query}`);
  }) as Sql;
  (sql as unknown as { begin: (options: string, run: (tx: Sql) => Promise<unknown>) => Promise<unknown> }).begin = async (_options, run) =>
    run(sql);
  (sql as MemorySql).proposalEventCount = () => proposalEvents;
  return sql as MemorySql;
}

const complete = {
  clientProposalId: PROPOSAL,
  proposerId: USER,
  symbol: 'fixture-perp',
  settle: 'fixture-settlement-asset',
  oracleSource: 'fixture-owner-oracle',
  leverageCap: '2.5',
};

describe('perpetual market proposals', () => {
  it('refuses missing oracle before eligibility or SQL', async () => {
    const vendorService = vendors();
    await expect(new PerpProposalService(noDatabase, vendorService).propose({ ...complete, oracleSource: '' })).rejects.toMatchObject({
      code: 'market.oracle_source_unset',
    });
    expect(vendorService.listingEligibility).not.toHaveBeenCalled();
  });

  it('refuses a caller who is not currently listed before SQL', async () => {
    await expect(new PerpProposalService(noDatabase, vendors(false)).propose(complete)).rejects.toMatchObject({
      code: 'market.vendor_not_found',
    });
  });

  it('records a complete fixture as proposed and never orderable', async () => {
    await expect(new PerpProposalService(memorySql(), vendors()).propose(complete)).resolves.toMatchObject({
      id: PROPOSAL,
      symbol: 'fixture-perp',
      leverageCap: '2.5',
      status: 'proposed',
      orderable: false,
    });
  });

  it('returns an identical retry and refuses idempotency drift', async () => {
    const sql = memorySql();
    const service = new PerpProposalService(sql, vendors());
    const first = await service.propose(complete);
    await expect(service.propose(complete)).resolves.toEqual(first);
    expect(sql.proposalEventCount()).toBe(1);
    await expect(service.propose({ ...complete, oracleSource: 'different-owner-oracle' })).rejects.toMatchObject({
      code: 'market.perp_proposal_conflict',
    });
  });
});
