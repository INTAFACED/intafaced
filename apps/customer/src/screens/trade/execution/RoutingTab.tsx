/** Routing: which execution doors exist, and the three capabilities that are blocked, each with the service's own reason. */
import { Badge, Button, Table, refusalSupportCode, type TableColumn } from '../rooms/ui';
import { Freshness } from '../rooms/RoomNotices';
import { execCopy } from './copy';
import { useSpine, type Spine } from './data';
import { Gate } from './parts';

type Door = Spine['doors'][number];
interface Capability {
  id: 'routing' | 'arbitrage' | 'making';
  blocker: string;
}

export function RoutingTab() {
  const { t } = execCopy.useCopy();
  const spine = useSpine();

  const doorColumns: TableColumn<Door>[] = [
    { id: 'operation', header: t('Operation'), pin: 'start', value: (d) => d.kind },
    {
      id: 'source',
      header: t('How it runs'),
      cell: (d) => (d.callerSubmit ? t('Needs an authorised venue submit port') : t('Planning or observation only')),
    },
    { id: 'ref', header: t('Reference'), cell: (d) => <span className="text-xs text-fg-2 font-mono">{d.module}</span> },
  ];

  const ready = spine.status === 'ready' ? spine.data : null;
  const why = ready
    ? [ready.houseInternalRefuse ? t('House one book') : null, ready.externalOnly ? t('External needs port') : null].filter(
        (x): x is string => x !== null,
      )
    : [];
  // The three rows never depend on the read: when the details are not readable the blocker is the same fixed sentence.
  const reason = ready ? (why.length > 0 ? why.join(' ') : t('No blocker reported')) : t('Routing static blocker');
  const rows: Capability[] = [
    { id: 'routing', blocker: reason },
    { id: 'arbitrage', blocker: `${reason} ${t('Arbitrage extra')}` },
    { id: 'making', blocker: `${reason} ${t('Making extra')}` },
  ];
  const capColumns: TableColumn<Capability>[] = [
    { id: 'name', header: t('Capability'), pin: 'start', value: (c) => t(`Capability ${c.id}`) },
    { id: 'state', header: t('Status'), cell: () => <Badge tone="warn">{t('Blocked')}</Badge> },
    { id: 'why', header: t('Why'), cell: (c) => <span className="whitespace-normal">{c.blocker}</span>, value: (c) => c.blocker },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {ready && spine.status === 'ready' ? <Freshness asOf={spine.asOf} /> : null}
        <Button variant="secondary" size={32} nativeButton={false} render={<a href="/quant/studio" />}>
          {t('Open Quant Studio')}
        </Button>
      </div>
      <Table label={t('Capabilities')} density="dense" columns={capColumns} rows={rows} minWidth={720} getRowId={(c) => c.id} />
      {spine.status === 'refused' && spine.code === 'scope.denied' ? (
        <div className="flex flex-col gap-1">
          <p role="note" className="m-0 text-sm text-fg-2">
            {t('Routing staff only')}
          </p>
          <span className="text-xs text-fg-2">{refusalSupportCode(spine.code)}</span>
        </div>
      ) : (
        <Gate load={spine}>
          {(data) => (
            <Table
              label={t('Execution doors')}
              density="dense"
              columns={doorColumns}
              rows={data.doors}
              minWidth={720}
              getRowId={(d) => d.id}
            />
          )}
        </Gate>
      )}
    </div>
  );
}
