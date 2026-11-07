/**
 * Positions: every copied position across the person's follows (CB-copy-10), each with its leader and its close action.
 * The close is the copy room's own: one confirm, one `copy.closeCopiedPosition`, sent through the account's write guard
 * so a lost reply locks writes instead of sending a second sell. Futures positions stay in the Futures room.
 */
import { useMemo, useState } from 'react';
import { Badge, Button, EmptyState, Table, fmtAmount, type TableColumn } from '../rooms/ui';
import { usePrivateRead } from '../rooms/read';
import { useSession } from '../rooms/ui';
import { createRoomApi as createCopyApi, type CopiedPosition } from '../copybots/api';
import { useWriteGuard } from '../copybots/guard';
import { RefusalNote } from '../copybots/parts';
import { ConfirmDialog, Gate } from '../execution/parts';
import { terminalCopy } from './copy';

export interface PositionRow {
  followId: string;
  leaderRef: string | null;
  position: CopiedPosition;
}

const STATE_WORD = { buying: 'Position Buying', open: 'Position Open', closing: 'Position Closing', closed: 'Position Closed' } as const;
const isZero = (amount: string) => /^0*(\.0*)?$/.test(amount);
const POSITIONS_INTERVAL_MS = 10_000;

export function usePositions() {
  const { api } = useSession();
  const copy = useMemo(() => createCopyApi(api), [api]);
  const load = usePrivateRead<PositionRow[]>(
    'terminal-positions',
    async (signal) => {
      const follows = await copy.follows(signal);
      if (!follows.ok) return follows;
      const reads = await Promise.all(follows.data.map(async (f) => ({ follow: f, read: await copy.copiedPositions(f.followId, signal) })));
      const failed = reads.find((r) => !r.read.ok);
      if (failed && !failed.read.ok) return failed.read;
      return {
        ok: true as const,
        data: reads.flatMap(({ follow, read }) =>
          read.ok
            ? read.data.positions
                .filter((p) => p.status !== 'closed')
                .map((position) => ({ followId: follow.followId, leaderRef: follow.leaderRef ?? null, position }))
            : [],
        ),
      };
    },
    POSITIONS_INTERVAL_MS,
  );
  return { load, copy };
}

export function PositionsTab() {
  const { t } = terminalCopy.useCopy();
  const { load, copy } = usePositions();
  const guard = useWriteGuard();
  const [closing, setClosing] = useState<PositionRow | null>(null);
  const [sent, setSent] = useState(false);

  const close = async (row: PositionRow) => {
    setSent(false);
    const ok = await guard.run(
      { kind: 'copy', id: `${row.followId}:${row.position.positionId}`, symbol: row.position.market, operation: 'close' },
      () => copy.closePosition(row.followId, row.position.positionId),
      () => undefined,
    );
    setClosing(null);
    setSent(ok);
  };

  const columns: TableColumn<PositionRow>[] = [
    {
      id: 'source',
      header: t('Source'),
      pin: 'start',
      value: (r) => `${t('Copied')} ${r.leaderRef ?? ''}`,
      cell: (r) => (
        <span className="flex items-center gap-2">
          <Badge variant="outline">{t('Copied')}</Badge>
          <span className="text-xs text-fg-2">{t('From {leader}', { leader: r.leaderRef ?? t('A leader') })}</span>
        </span>
      ),
    },
    { id: 'market', header: t('Market'), value: (r) => r.position.market },
    { id: 'bought', header: t('Bought'), numeric: true, value: (r) => r.position.bought, cell: (r) => fmtAmount(r.position.bought) },
    { id: 'open', header: t('Still open'), numeric: true, value: (r) => r.position.open, cell: (r) => fmtAmount(r.position.open) },
    { id: 'state', header: t('State'), value: (r) => t(STATE_WORD[r.position.status]) },
    {
      id: 'action',
      header: t('Action'),
      cell: (r) => {
        // A close still settling can be sent again: the service resends that same order, never a second sell.
        const off = guard.busy || guard.locked || (isZero(r.position.open) && r.position.status !== 'closing');
        return (
          <Button variant="secondary" size={28} disabled={off} onClick={() => setClosing(r)}>
            {t('Close')}
          </Button>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {guard.failure ? <RefusalNote failure={guard.failure} retry={() => guard.setFailure(null)} /> : null}
      {sent ? (
        <p role="status" className="m-0 text-sm text-fg">
          {t('Position closed')}
        </p>
      ) : null}
      <Gate load={load}>
        {(rows) => (
          <Table
            label={t('Positions')}
            density="dense"
            columns={columns}
            rows={rows}
            minWidth={760}
            getRowId={(r) => `${r.followId}:${r.position.positionId}`}
            emptyState={<EmptyState variant="empty" size="inline" title={t('No positions')} reason={t('No positions reason')} />}
          />
        )}
      </Gate>
      <p className="m-0 text-sm text-fg-2">
        {t('Futures positions note')}{' '}
        <a href="/trade/futures" className="underline">
          {t('Open Futures')}
        </a>
      </p>
      <ConfirmDialog
        open={closing !== null}
        title={t('Close this copied position?')}
        description={closing && isZero(closing.position.open) ? t('Close settling body') : t('Close body')}
        rows={
          closing
            ? [
                { label: t('Market'), value: closing.position.market },
                { label: t('Still open'), value: fmtAmount(closing.position.open) },
                { label: t('Leader'), value: closing.leaderRef ?? t('A leader'), mono: true },
              ]
            : []
        }
        confirmLabel={t('Close position')}
        busy={guard.busy}
        onConfirm={() => closing && void close(closing)}
        onCancel={() => setClosing(null)}
      />
    </div>
  );
}
