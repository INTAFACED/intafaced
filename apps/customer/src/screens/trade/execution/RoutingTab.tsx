/** Routing: which execution doors exist, and the three capabilities that are blocked, each with the service's own reason. */
import { StatusChip, Table, type Column } from '@intafaced/ui/lit/templates';
import { refusalSupportCode } from '../rooms/ui';
import { execCopy } from './copy';
import { useSpine, type Spine } from './data';
import { Freshness, Gate } from './parts';

type Door = Spine['doors'][number];
interface Capability {
  id: 'routing' | 'arbitrage' | 'making';
  blocker: string;
}

export function RoutingTab() {
  const { t } = execCopy.useCopy();
  const spine = useSpine();

  const doorColumns: Column<Door>[] = [
    { key: 'operation', label: t('Operation'), cell: (d) => d.kind },
    {
      key: 'source',
      label: t('How it runs'),
      cell: (d) => (d.callerSubmit ? t('Needs an authorised venue submit port') : t('Planning or observation only')),
    },
    { key: 'ref', label: t('Reference'), ltr: true, cell: (d) => d.module },
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
  const capColumns: Column<Capability>[] = [
    { key: 'name', label: t('Capability'), cell: (c) => t(`Capability ${c.id}`) },
    { key: 'state', label: t('Status'), cell: () => <StatusChip status="failed" label={t('Blocked')} /> },
    { key: 'why', label: t('Why'), cell: (c) => c.blocker },
  ];

  return (
    <div className="lt-body">
      <div className="lt-toolbar">
        {ready && spine.status === 'ready' ? <Freshness asOf={spine.asOf} /> : null}
        <a className="lt-button lt-button-secondary" href="/quant/studio">
          {t('Open Quant Studio')}
        </a>
      </div>
      <Table caption={t('Capabilities')} mode="pro" scroll columns={capColumns} rows={rows} rowKey={(c) => c.id} />
      {spine.status === 'refused' && spine.code === 'scope.denied' ? (
        <div className="lt-body">
          <p role="note" className="lt-hint">
            {t('Routing staff only')}
          </p>
          <span className="lt-ref">{refusalSupportCode(spine.code)}</span>
        </div>
      ) : (
        <Gate load={spine}>
          {(data) => (
            <Table
              caption={t('Execution doors')}
              mode="pro"
              scroll
              columns={doorColumns}
              rows={data.doors}
              rowKey={(d) => d.id}
              empty="Nothing to show"
            />
          )}
        </Gate>
      )}
    </div>
  );
}
