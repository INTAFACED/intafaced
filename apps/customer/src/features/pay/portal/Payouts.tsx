import { formatAmount as fromScaled, parseAmount as toScaled } from '../../../shared/money';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Field } from '../../../shared/ui';
import { PayTime, PaySection } from '../components';
import {
  AsOf,
  BackLink,
  Chip,
  ComingSoon,
  Facts,
  Gate,
  HaltBanner,
  Kpi,
  KpiGrid,
  Money,
  MoneyLines,
  NotConfigured,
  PortalFailure,
  PortalLoading,
  ReadAt,
  SelectField,
  TestTag,
  Timeline,
} from './components';
import { ApprovalDecision, CancelRequest, payoutHref } from './Approvals';
import { settlementHref } from './Settlements';
import { portalCopy } from './copy';
import { buildCsv, downloadText } from './csv';
import { useReadAt, useUrlParam } from './hooks';
import {
  assetsIn,
  freshnessAt,
  isUuid,
  latestApproval,
  limitRows,
  matchesSearch,
  payoutRows,
  payoutState,
  payoutStates,
  shortId,
  type PayoutRow,
  type RoleLike,
} from './model';
import { portalRefusal } from './refusal';
import type { PortalApi } from './api';
import type { Approval, HaltStatus, MerchantRecord, Settlement, Usage } from './schemas';

/** `/pay/payouts`: money leaving your balance for your payout destination, with where each one is in approval. */
export function Payouts({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const [state, setState] = useUrlParam('state', '');
  const [asset, setAsset] = useUrlParam('asset', '');
  const [q, setQ] = useUrlParam('q', '');
  const settlements = useResource((s) => portal.settlements(merchantId, '', 200, s), `portal:payouts-settlements:${merchantId}`);
  const approvals = useResource((s) => portal.approvals(merchantId, '', s), `portal:payouts-approvals:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:halts:${merchantId}`);
  const loadedAt = useReadAt(settlements.resource.status === 'ready', settlements.resource);
  return (
    <PayoutsView
      settlements={settlements.resource}
      approvals={approvals.resource}
      halts={halts.resource}
      loadedAt={loadedAt}
      state={state}
      setState={setState}
      asset={asset}
      setAsset={setAsset}
      q={q}
      setQ={setQ}
      retry={() => {
        settlements.reload();
        approvals.reload();
        halts.reload();
      }}
    />
  );
}

export function PayoutsView({
  settlements,
  approvals,
  halts,
  loadedAt,
  state,
  setState,
  asset,
  setAsset,
  q,
  setQ,
  retry,
}: {
  settlements: Resource<Settlement[]>;
  approvals: Resource<Approval[]>;
  halts: Resource<HaltStatus>;
  loadedAt: string | null;
  state: string;
  setState: (value: string) => void;
  asset: string;
  setAsset: (value: string) => void;
  q: string;
  setQ: (value: string) => void;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  // A payout's approval state comes from a second read. If that read fails the payouts still show, with a note, rather than being hidden.
  const approvalList = approvals.status === 'ready' ? approvals.data : [];
  const all: PayoutRow[] = settlements.status === 'ready' ? payoutRows(settlements.data, approvalList) : [];
  const rows = all.filter(
    (r) =>
      (!state || r.state === state) &&
      (!asset || r.assetId === asset) &&
      matchesSearch([r.settlementId, r.window, r.payoutRef, r.payoutMethod], q),
  );
  const paid = all.filter((r) => r.state === 'paid_out');
  const waiting = all.filter((r) => r.state === 'awaiting_approval');
  const failed = all.filter((r) => r.state === 'failed');
  const clear = () => {
    setState('');
    setAsset('');
    setQ('');
  };
  const exportCsv = () =>
    downloadText(
      'payouts.csv',
      buildCsv(
        ['payout_id', 'window', 'asset', 'amount', 'state', 'payout_method', 'transaction_reference'],
        rows.map((r) => [r.settlementId, r.window, r.assetId, r.amount, r.state, r.payoutMethod ?? '', r.payoutRef ?? '']),
        { generatedAt: new Date().toISOString(), asOf: loadedAt ?? '' },
      ),
    );
  return (
    <div className="stack">
      <HaltBanner resource={halts} scopes={['payout']} />
      <PaySection title={t('payoutsKpiTitle')} description={t('payoutsKpiBody')}>
        {settlements.status === 'loading' ? (
          <PortalLoading rows={2} />
        ) : settlements.status === 'failed' ? (
          <PortalFailure result={settlements.failure} retry={retry} />
        ) : (
          <>
            <ReadAt at={loadedAt} />
            <KpiGrid label={t('payoutsKpiTitle')}>
              <Kpi label={t('kpiPaidOut')} value={paid.length} note={t('kpiPaidOutNote')} href="/pay/payouts?state=paid_out" />
              <Kpi
                label={t('kpiInApproval')}
                value={approvals.status === 'ready' ? waiting.length : '—'}
                note={approvals.status === 'ready' ? undefined : t('kpiApprovalUnknown')}
                tone={waiting.length > 0 ? 'attention' : undefined}
                href="/pay/approvals"
              />
              <Kpi
                label={t('kpiFailedPayouts')}
                value={failed.length}
                tone={failed.length > 0 ? 'attention' : undefined}
                href="/pay/payouts?state=failed"
              />
              <Kpi label={t('kpiInTransit')} value="—" note={t('kpiInTransitSoon')} />
              <Kpi
                label={t('kpiPaidOutAmount')}
                value={<MoneyLines items={sumByAsset(paid)} />}
                note={t('kpiLoadedNote', { count: all.length })}
              />
            </KpiGrid>
          </>
        )}
      </PaySection>

      <PaySection title={t('payoutsTitle')} description={t('payoutsBody')}>
        <div className="pp-filter-row" role="search" aria-label={t('payoutsFilters')}>
          <SelectField
            label={t('filterState')}
            value={state}
            onChange={setState}
            options={[['', t('filterAll')], ...payoutStates.map((s) => [s, t(`chipPayout_${s}` as 'chipPayout_ready')] as const)]}
          />
          <SelectField
            label={t('filterAsset')}
            value={asset}
            onChange={setAsset}
            options={[['', t('filterAll')], ...assetsIn(all.map((r) => ({ assetId: r.assetId }))).map((a) => [a, a] as const)]}
          />
          <Field
            label={t('searchPayouts')}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={200}
            hint={t('searchPayoutsHint')}
          />
          <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>
            {t('downloadCsv')}
          </Button>
        </div>
        <p className="muted pp-note">{t('payoutsDestinationSoon')}</p>
        {approvals.status === 'failed' && (
          <div className="pp-callout" role="status">
            {t('payoutsApprovalsUnavailable')}
          </div>
        )}
        {settlements.status === 'ready' &&
          (all.length === 0 ? (
            <EmptyState
              title={t('payoutsEmptyTitle')}
              action={
                <a className="text-link" href="/pay/settlements">
                  {t('seeSettlements')}
                </a>
              }
            >
              {t('payoutsEmptyBody')}
            </EmptyState>
          ) : rows.length === 0 ? (
            <EmptyState
              title={t('payoutsNoMatchTitle')}
              action={
                <Button variant="secondary" onClick={clear}>
                  {t('clearFilters')}
                </Button>
              }
            >
              {t('payoutsNoMatchBody', { count: all.length })}
            </EmptyState>
          ) : (
            <>
              <DataTable
                label={t('payoutsTitle')}
                headers={[t('colPayout'), t('colAsset'), t('colAmount'), t('colStatus'), t('colTransaction'), t('colMethod')]}
              >
                {rows.map((r) => (
                  <tr key={r.settlementId}>
                    <th scope="row">
                      <a className="text-link" href={payoutHref(r.settlementId)} aria-label={t('openPayoutAria', { window: r.window })}>
                        {r.window}
                      </a>
                      <small className="pay-cell-note pp-mono">{shortId(r.settlementId)}</small>
                    </th>
                    <td>{r.assetId}</td>
                    <td>
                      <Money value={r.amount} asset={r.assetId} />
                    </td>
                    <td>
                      <Chip kind="payout" value={r.state} />
                      {r.state === 'awaiting_approval' && <small className="pay-cell-note">{t('waitingFromRoles')}</small>}
                      {r.state === 'failed' && <small className="pay-cell-note">{t('failedNextStep')}</small>}
                    </td>
                    <td className="pp-mono">{r.payoutRef ?? <span className="muted">{t('notPaidYet')}</span>}</td>
                    <td>{r.payoutMethod ?? '—'}</td>
                  </tr>
                ))}
              </DataTable>
              <div className="pp-more">
                <p className="muted" role="status">
                  {rows.length === all.length
                    ? t('rowsAll', { count: all.length })
                    : t('payoutsNarrowed', { shown: rows.length, loaded: all.length })}
                </p>
                {settlements.data.length >= 200 && (
                  <a className="text-link" href="/pay/exports">
                    {t('olderInExports', { max: 200 })}
                  </a>
                )}
              </div>
            </>
          ))}
      </PaySection>
    </div>
  );
}

/** Per-asset totals of the payouts shown, by exact integer arithmetic. Two assets are never added together. */
function sumByAsset(rows: readonly PayoutRow[]) {
  const by = new Map<string, bigint>();
  for (const r of rows) by.set(r.assetId, (by.get(r.assetId) ?? 0n) + toScaled(r.amount));
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([assetCode, v]) => ({ assetCode, amount: fromScaled(v) }));
}
// ---- detail ---------------------------------------------------------------------------------------------

export function PayoutDetailPage({
  portal,
  merchantId,
  payoutId,
  role,
  merchant,
}: {
  portal: PortalApi;
  merchantId: string;
  payoutId: string;
  role: RoleLike;
  merchant: MerchantRecord | null;
}) {
  const valid = isUuid(payoutId);
  const settlement = useResource(
    (s) => (valid ? portal.settlement(payoutId, s) : Promise.resolve(portalRefusal('rPayoutNotFound'))),
    `portal:payout:${payoutId}`,
  );
  const approvals = useResource((s) => portal.approvals(merchantId, '', s), `portal:payout-approvals:${merchantId}`);
  const usage = useResource((s) => portal.usage(merchantId, s), `portal:usage:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:halts:${merchantId}`);
  const loadedAt = useReadAt(approvals.resource.status === 'ready', approvals.resource);
  return (
    <PayoutDetailView
      portal={portal}
      settlement={settlement.resource}
      approvals={approvals.resource}
      usage={usage.resource}
      halts={halts.resource}
      me={portal.userId}
      role={role}
      now={loadedAt ? Date.parse(loadedAt) : Date.now()}
      testValues={merchant === null || merchant.kybStatus !== 'approved'}
      reload={() => {
        settlement.reload();
        approvals.reload();
        usage.reload();
        halts.reload();
      }}
    />
  );
}

export function PayoutDetailView({
  portal,
  settlement,
  approvals,
  usage,
  halts,
  me,
  role,
  now,
  testValues,
  reload,
}: {
  portal: PortalApi;
  settlement: Resource<Settlement>;
  approvals: Resource<Approval[]>;
  usage: Resource<Usage>;
  halts: Resource<HaltStatus>;
  me: string | null;
  role: RoleLike;
  now: number;
  testValues: boolean;
  reload: () => void;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <div className="stack">
      <BackLink href="/pay/payouts">{t('backToPayouts')}</BackLink>
      <HaltBanner resource={halts} scopes={['payout']} />
      <Gate resource={settlement} retry={reload} rows={5}>
        {(s) => {
          const trail = (approvals.status === 'ready' ? approvals.data : [])
            .filter((a) => a.settlementId === s.id)
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
          const latest = approvals.status === 'ready' ? latestApproval(approvals.data, s.id) : null;
          const state = payoutState(s, latest);
          const events = trail.flatMap((a) => approvalEvents(a, t));
          return (
            <>
              {latest?.status === 'voided' && (
                <p className="pp-callout pp-callout--warn" role="alert">
                  {t('voidBanner')}
                </p>
              )}
              <PaySection title={t('keyFacts')} description={t('payoutFactsBody')}>
                <Facts
                  items={[
                    [t('colPayout'), <span className="pp-mono pp-copy">{s.id}</span>],
                    [t('colStatus'), <Chip kind="payout" value={state} />],
                    [t('colAmount'), <Money value={s.net} asset={s.assetId} />],
                    [t('colWindow'), s.window],
                    [t('payoutMethod'), s.payoutMethod ?? <span className="muted">{t('notPaidYet')}</span>],
                    [
                      t('colTransaction'),
                      s.payoutRef ? (
                        <span className="pp-mono pp-copy">{s.payoutRef}</span>
                      ) : (
                        <span className="muted">{t('notPaidYet')}</span>
                      ),
                    ],
                    [
                      t('colSettlement'),
                      <a className="text-link" href={settlementHref(s.id)}>
                        {t('openStatement')}
                      </a>,
                    ],
                  ]}
                />
                {state === 'failed' && (
                  <p className="pp-callout pp-callout--warn" role="alert">
                    {t('payoutFailedBody')}{' '}
                    <a className="text-link" href="/pay/notifications">
                      {t('navNotifications')}
                    </a>
                  </p>
                )}
                {state === 'not_ready' && <p className="pp-callout">{t('payoutNotReadyBody')}</p>}
              </PaySection>

              <PaySection title={t('payoutTimelineTitle')} description={t('payoutTimelineBody')}>
                {approvals.status === 'loading' ? (
                  <PortalLoading rows={3} />
                ) : approvals.status === 'failed' ? (
                  <PortalFailure result={approvals.failure} retry={reload} />
                ) : events.length === 0 ? (
                  <p className="muted">{t('noApprovalYet')}</p>
                ) : (
                  <Timeline label={t('payoutTimelineTitle')} items={events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))} />
                )}
              </PaySection>

              <PaySection title={t('trailTitle')} description={t('trailBody')}>
                {approvals.status === 'ready' && trail.length > 0 ? (
                  <DataTable
                    label={t('trailTitle')}
                    headers={[
                      t('colStatus'),
                      t('requestedBy'),
                      t('decidedBy'),
                      t('colRequested'),
                      t('colDecided'),
                      t('colExpires'),
                      t('fingerprint'),
                    ]}
                  >
                    {trail.map((a) => (
                      <tr key={a.approvalId}>
                        <th scope="row">
                          <Chip kind="approval" value={a.status} />
                        </th>
                        <td className="pp-mono">{a.makerUserId === me ? t('you') : a.makerUserId}</td>
                        <td className="pp-mono">{a.checkerUserId ? (a.checkerUserId === me ? t('you') : a.checkerUserId) : '—'}</td>
                        <td>
                          <PayTime value={a.createdAt} />
                        </td>
                        <td>{a.decidedAt ? <PayTime value={a.decidedAt} /> : '—'}</td>
                        <td>
                          <PayTime value={a.expiresAt} />
                        </td>
                        <td className="pp-mono" title={a.payloadHash}>
                          {a.payloadHash.slice(0, 19)}…
                        </td>
                      </tr>
                    ))}
                  </DataTable>
                ) : approvals.status === 'ready' ? (
                  <p className="muted">{t('noApprovalYet')}</p>
                ) : null}
                {latest?.status === 'pending' && (
                  <>
                    <h3 className="pp-sub">{t('decideTitle')}</h3>
                    <ApprovalDecision portal={portal} approval={latest} me={me} role={role} now={now} onDone={reload} />
                    <h3 className="pp-sub">{t('cancelTitle')}</h3>
                    <CancelRequest portal={portal} approval={latest} me={me} onDone={reload} />
                  </>
                )}
              </PaySection>

              <PaySection title={t('capTitle')} description={t('capBody')}>
                <PayoutCap usage={usage} assetId={s.assetId} testValues={testValues} now={now} retry={reload} />
              </PaySection>

              <ComingSoon title={t('screeningSoonTitle')}>{t('screeningSoonBody')}</ComingSoon>
            </>
          );
        }}
      </Gate>
    </div>
  );
}

type T = ReturnType<typeof portalCopy.useCopy>['t'];
function approvalEvents(a: Approval, t: T) {
  const out: Array<{ at: string; title: string; detail?: string }> = [
    { at: a.createdAt, title: t('evRequested'), detail: t('byActor', { actor: a.makerUserId }) },
  ];
  if (a.status === 'approved' || a.status === 'consumed')
    out.push({
      at: a.decidedAt ?? a.createdAt,
      title: t('evApproved'),
      ...(a.checkerUserId ? { detail: t('byActor', { actor: a.checkerUserId }) } : {}),
    });
  if (a.status === 'rejected')
    out.push({
      at: a.decidedAt ?? a.createdAt,
      title: t('evRejected'),
      ...(a.checkerUserId ? { detail: t('byActor', { actor: a.checkerUserId }) } : {}),
    });
  if (a.status === 'voided') out.push({ at: a.decidedAt ?? a.expiresAt, title: t('evVoided') });
  if (a.status === 'expired') out.push({ at: a.expiresAt, title: t('evExpired') });
  return out;
}

function PayoutCap({
  usage,
  assetId,
  testValues,
  now,
  retry,
}: {
  usage: Resource<Usage>;
  assetId: string;
  testValues: boolean;
  now: number;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  if (usage.status === 'loading') return <PortalLoading rows={2} />;
  if (usage.status === 'failed') return <PortalFailure result={usage.failure} retry={retry} />;
  const rows = limitRows(usage.data, null).filter((r) => r.kind === 'daily_payout' && (r.assetCode === assetId || !r.configured));
  const row = rows[0];
  return (
    <>
      <AsOf freshness={freshnessAt(usage.data.asOf, now)} />
      {!row || !row.configured ? (
        <p>
          <NotConfigured /> {t('capNotConfigured')}
        </p>
      ) : (
        <Facts
          items={[
            [
              t('capDailyPayout'),
              <>
                {row.limit && <Money value={row.limit} asset={assetId} />} {testValues && <TestTag />}
              </>,
            ],
            [t('capUsed'), row.used ? <Money value={row.used} asset={assetId} /> : '—'],
            [t('capRemaining'), row.remaining ? <Money value={row.remaining} asset={assetId} /> : '—'],
            [t('capResets'), row.resetsAt ? <PayTime value={row.resetsAt} /> : '—'],
          ]}
        />
      )}
    </>
  );
}
