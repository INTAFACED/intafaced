import type { Sql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import { MemoryLedger, parseAmount, recipes } from '@intafaced/ledger-client';
import type { SpaceRecord } from '../spaces/space-service.js';
import { TransferService } from './transfer-service.js';

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const USER_C = '33333333-3333-4333-8333-333333333333';
const TRANSFER_ID = 'xfer-replay-1';

function space(id: string, userId: string): SpaceRecord {
  return {
    id,
    userId,
    assetId: 'USDT',
    kind: 'primary',
    name: id,
    goalTarget: null,
    lockedUntil: null,
    archivedAt: null,
  };
}

const SPACE_A = space('space-a', USER_A);
const SPACE_B = space('space-b', USER_B);
const SPACE_C = space('space-c', USER_C);

function service(ledger: MemoryLedger): TransferService {
  const byId = new Map([SPACE_A, SPACE_B, SPACE_C].map((row) => [row.id, row]));
  const resolve = async (spaceId: string) => {
    const row = byId.get(spaceId);
    if (!row) throw new Error(`missing space ${spaceId}`);
    return row;
  };
  const spaces = {
    resolveForDebit: resolve,
    resolveForCredit: resolve,
  };
  return new TransferService(undefined as unknown as Sql, ledger, spaces as never);
}

function manualTransfers(ledger: MemoryLedger) {
  return ledger.journal().filter((tx) => tx.reason === 'bank.transfer.manual');
}

async function fund(ledger: MemoryLedger): Promise<void> {
  await ledger.post(
    recipes.deposit({
      userId: USER_A,
      assetId: 'USDT',
      amount: parseAmount('100'),
      rail: 'test',
      railRef: 'fund-a',
    }),
  );
}

describe('TransferService.transfer replay', () => {
  it("refuses blank transfer ids and does not post", async () => {
    const ledger = new MemoryLedger();
    const post = vi.spyOn(ledger, 'post');
    const transfers = service(ledger);
    const body = {
      fromSpaceId: SPACE_A.id,
      toSpaceId: SPACE_B.id,
      amount: parseAmount('10'),
    };

    await expect(transfers.transfer({ ...body, transferId: '' })).rejects.toMatchObject({ code: 'bank.transfer_id_required' });
    await expect(transfers.transfer({ ...body, transferId: '   ' })).rejects.toMatchObject({ code: 'bank.transfer_id_required' });
    expect(post).not.toHaveBeenCalled();
  });

  it('posts a transfer of 10 once', async () => {
    const ledger = new MemoryLedger();
    await fund(ledger);
    const post = vi.spyOn(ledger, 'post');
    const transfers = service(ledger);

    const posted = await transfers.transfer({
      transferId: TRANSFER_ID,
      fromSpaceId: SPACE_A.id,
      toSpaceId: SPACE_B.id,
      amount: parseAmount('10'),
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toMatchObject({ idempotencyKey: `bank.transfer:${TRANSFER_ID}:0` });
    expect(posted.amount).toBe('10');
    expect(posted.occurrence).toBe(0);
    expect(manualTransfers(ledger)).toHaveLength(1);
  });

  it('replays the same id, spaces, and amount without a second transfer', async () => {
    const ledger = new MemoryLedger();
    await fund(ledger);
    const transfers = service(ledger);
    const input = {
      transferId: TRANSFER_ID,
      fromSpaceId: SPACE_A.id,
      toSpaceId: SPACE_B.id,
      amount: parseAmount('10'),
    };

    const first = await transfers.transfer(input);
    const second = await transfers.transfer({ ...input, amount: parseAmount('10') });

    expect(second.ledgerTxId).toBe(first.ledgerTxId);
    expect(second.amount).toBe('10');
    expect(manualTransfers(ledger)).toHaveLength(1);
  });

  it('refuses the same id when the amount changes and does not report 11', async () => {
    const ledger = new MemoryLedger();
    await fund(ledger);
    const transfers = service(ledger);
    await transfers.transfer({
      transferId: TRANSFER_ID,
      fromSpaceId: SPACE_A.id,
      toSpaceId: SPACE_B.id,
      amount: parseAmount('10'),
    });

    const outcome = await transfers
      .transfer({
        transferId: TRANSFER_ID,
        fromSpaceId: SPACE_A.id,
        toSpaceId: SPACE_B.id,
        amount: parseAmount('11'),
      })
      .then(
        (result) => result,
        (err: unknown) => err,
      );

    expect(outcome).toMatchObject({ code: 'bank.transfer_mismatch' });
    expect(outcome).not.toMatchObject({ amount: '11' });
    expect(manualTransfers(ledger)).toHaveLength(1);
  });

  it('refuses the same id and amount when the destination changes', async () => {
    const ledger = new MemoryLedger();
    await fund(ledger);
    const transfers = service(ledger);
    await transfers.transfer({
      transferId: TRANSFER_ID,
      fromSpaceId: SPACE_A.id,
      toSpaceId: SPACE_B.id,
      amount: parseAmount('10'),
    });

    await expect(
      transfers.transfer({
        transferId: TRANSFER_ID,
        fromSpaceId: SPACE_A.id,
        toSpaceId: SPACE_C.id,
        amount: parseAmount('10'),
      }),
    ).rejects.toMatchObject({ code: 'bank.transfer_mismatch' });
    expect(manualTransfers(ledger)).toHaveLength(1);
  });
});
