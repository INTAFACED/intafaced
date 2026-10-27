import { useRef, useState } from 'react';
import { Field } from '../../ui-kit';
import { useResource, type Resource } from '../../../../shared/resource';
import { parseAmount } from '../../../../shared/money';
import { PaySection } from '../../components';
import { useMerchantAccess } from '../access/MerchantAccess';
import { Facts, NotConfigured, PortalFailure, PortalLoading, UsageBar } from '../components';
import type { PortalApi } from '../api';
import { useReadAt } from '../hooks';
import { newRequestId } from '../model';
import { isNotLive } from '../refusal';
import { useUnsavedForm } from '../useUnsavedForm';
import { capKinds } from '../schemas';
import { DateTime } from '../ui/DateTime';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { MoneyText } from '../ui/MoneyText';
import { PortalReview } from '../ui/PortalReview';
import { NamedBlocker, TestBanner, useTestMode } from './common';
import { formatMoney } from '../ui/format';
import { mc } from './copy';
import { bpsPercent, closestToLimit, limitRows, type LimitRow } from './model';
import type { Cap, LimitOpen, LimitRequest, TierList, TierSummary } from './schemas';

type Words = ReturnType<typeof mc.useCopy>['t'];
const kindName = (t: Words, kind: string) => t(`limitKind_${kind}` as 'limitKind_daily_intake');

/** `/pay/limits`: your tier, how much of each limit is used and when it resets, and how to ask for more. */
export function Limits({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const test = useTestMode();
  const control = useResource((s) => portal.control(merchantId, s), `money:control:${merchantId}`);
  const usage = useResource((s) => portal.usage(merchantId, s), `money:usage:${merchantId}`);
  const tiers = useResource((s) => portal.tiersList(merchantId, s), `money:tiers:${merchantId}`);
  const open = useResource((s) => portal.limitOpen(merchantId, s), `money:limit-open:${merchantId}`);
  const readAt = useReadAt(usage.resource.status === 'ready', usage.resource);
  const reload = () => {
    control.reload();
    usage.reload();
    tiers.reload();
    open.reload();
  };
  if (control.resource.status === 'loading' || usage.resource.status === 'loading') return <PortalLoading rows={4} />;
  if (control.resource.status === 'failed' && usage.resource.status === 'failed')
    return <PortalFailure result={control.resource.failure} retry={reload} />;
  const profile = control.resource.status === 'ready' ? control.resource.data : null;
  const use = usage.resource.status === 'ready' ? usage.resource.data : null;
  const rows = limitRows(use, profile);
  const configured = rows.filter((r) => r.configured);
  const close = closestToLimit(rows);
  const nextReset = rows
    .map((r) => r.resetsAt)
    .filter((x): x is string => x !== null)
    .sort()[0];
  const tierData = tiers.resource.status === 'ready' ? tiers.resource.data : null;
  const tierName = tierData?.status === 'configured' ? (tierData.tiers.find((x) => x.id === tierData.ownTierId)?.name ?? null) : null;
  return (
    <div className="stack">
      <TestBanner />
      <Freshness asOf={use?.asOf ?? readAt} />
      <KpiStrip
        label={t('limitsKpiTitle')}
        tiles={[
          {
            label: t('colTier'),
            period: t('mnPeriodNow'),
            href: '/pay/pricing',
            value: tierName ?? <NotConfigured>{t('tierNotAssigned')}</NotConfigured>,
          },
          {
            label: t('kpiLimitsSet'),
            period: t('mnPeriodNow'),
            href: '/pay/limits',
            value: `${configured.length} / ${capKinds.length}`,
            note: t('kpiLimitsSetNote'),
          },
          {
            label: t('kpiClosest'),
            period: t('mnPeriodNow'),
            href: '/pay/limits',
            value: close ? `${Math.round(close.pct!)}%` : '—',
            note: close ? kindName(t, close.kind) : t('kpiClosestNone'),
            tone: close && close.pct! >= 100 ? 'attention' : undefined,
          },
          {
            label: t('kpiNextReset'),
            period: t('mnPeriodNow'),
            href: '/pay/limits',
            value: nextReset ? <DateTime value={nextReset} /> : '—',
          },
        ]}
      />

      <PaySection title={t('usageTitle')} description={t('usageBody')}>
        {usage.resource.status === 'failed' && <PortalFailure result={usage.resource.failure} retry={reload} />}
        {control.resource.status === 'failed' && <PortalFailure result={control.resource.failure} retry={reload} />}
        {configured.length === 0 && use !== null && (
          <div className="pp-callout pp-callout--warn" role="note">
            <NotConfigured /> {t('limitsNotConfiguredBody')}
          </div>
        )}
        <ul className="pp-limits" aria-label={t('usageTitle')}>
          {rows.map((row, i) => (
            <LimitItem key={`${row.kind}:${row.assetCode ?? ''}:${i}`} row={row} test={test} />
          ))}
        </ul>
        <p className="muted pp-note">{t('usageHow')}</p>
      </PaySection>

      <TierLadder tiers={tiers.resource} retry={tiers.reload} test={test} />

      <RequestIncrease
        portal={portal}
        merchantId={merchantId}
        rows={configured}
        open={open.resource}
        tiers={tiers.resource}
        reload={reload}
        test={test}
      />
    </div>
  );
}

/** The tiers INTAFACED shows merchants, each with its limits and reserve. The merchant's own tier is marked. */
export function TierLadder({ tiers, retry, test }: { tiers: Resource<TierList>; retry: () => void; test: boolean }) {
  const { t } = mc.useCopy();
  return (
    <PaySection title={t('tierLadderTitle')} description={t('tierLadderBody')}>
      {tiers.status === 'loading' ? (
        <PortalLoading rows={2} />
      ) : tiers.status === 'failed' ? (
        isNotLive(tiers.failure) ? (
          <NamedBlocker title={t('tierLadderTitle')} why="reasonLists" needs="merchantControl.tiers.list">
            {t('tierLadderNone')}
          </NamedBlocker>
        ) : (
          <PortalFailure result={tiers.failure} retry={retry} />
        )
      ) : tiers.data.status === 'not_configured' ? (
        <p className="muted">{t('tierLadderNone')}</p>
      ) : (
        <>
          <ul className="pp-limits" aria-label={t('tierLadderTitle')}>
            {tiers.data.tiers.map((tier) => (
              <TierItem key={tier.id} tier={tier} yours={tier.id === tiers.data.ownTierId} test={test} />
            ))}
          </ul>
          {tiers.data.ownTierId === null && <p className="muted pp-note">{t('tierLadderNoneYours')}</p>}
          {tiers.data.tiers.length === 1 && tiers.data.ownTierId !== null && <p className="muted pp-note">{t('tierLadderOne')}</p>}
        </>
      )}
    </PaySection>
  );
}

function TierItem({ tier, yours, test }: { tier: TierSummary; yours: boolean; test: boolean }) {
  const { t } = mc.useCopy();
  const caps = capKinds.flatMap((kind) => tier.caps.filter((c) => c.kind === kind));
  return (
    <li className="pp-limit">
      <div className="pp-limit-head">
        <h3>{tier.name}</h3>
        {yours && <strong>{t('tierLadderYours')}</strong>}
      </div>
      <Facts
        items={[
          [
            t('tierLadderCaps'),
            caps.length === 0 ? (
              <span className="muted">{t('tierLadderNoCaps')}</span>
            ) : (
              <span className="pp-stack">
                {caps.map((cap) => (
                  <span key={`${cap.kind}:${'assetCode' in cap ? cap.assetCode : ''}`}>
                    {kindName(t, cap.kind)}:{' '}
                    {'assetCode' in cap ? <MoneyText value={cap.limit} asset={cap.assetCode} test={test} /> : String(cap.limit)}
                  </span>
                ))}
              </span>
            ),
          ],
          [
            t('tierLadderReserve'),
            tier.reserve && tier.reserve.rollingReserveBps !== null ? (
              <>
                {bpsPercent(tier.reserve.rollingReserveBps)}
                {tier.reserve.holdDays !== null && tier.reserve.holdDays !== undefined
                  ? ` · ${t('balReserveDays', { days: tier.reserve.holdDays })}`
                  : ''}
              </>
            ) : (
              <span className="muted">{t('tierLadderNoReserve')}</span>
            ),
          ],
        ]}
      />
    </li>
  );
}

function LimitItem({ row, test }: { row: LimitRow; test: boolean }) {
  const { t } = mc.useCopy();
  const kind = kindName(t, row.kind);
  const countCap = row.kind === 'beneficiaries_per_day';
  return (
    <li className="pp-limit">
      <div className="pp-limit-head">
        <h3>{row.assetCode ? `${kind} (${row.assetCode})` : kind}</h3>
      </div>
      <p className="muted pp-note">{t(`limitKindBody_${row.kind}` as 'limitKindBody_daily_intake')}</p>
      {!row.configured || row.limit === null ? (
        <p>
          <NotConfigured />
        </p>
      ) : (
        <>
          {row.pct !== null && <UsageBar pct={row.pct} label={kind} />}
          <Facts
            items={[
              [t('capLimit'), countCap ? row.limit : <MoneyText value={row.limit} asset={row.assetCode ?? ''} test={test} />],
              ...(row.used !== null
                ? ([
                    [t('capUsed'), countCap ? row.used : <MoneyText value={row.used} asset={row.assetCode ?? ''} test={test} />],
                    [
                      t('capRemaining'),
                      row.remaining === null ? (
                        '—'
                      ) : countCap ? (
                        row.remaining
                      ) : (
                        <MoneyText value={row.remaining} asset={row.assetCode ?? ''} test={test} />
                      ),
                    ],
                    [t('capResets'), row.resetsAt ? <DateTime value={row.resetsAt} /> : '—'],
                  ] as const)
                : ([[t('capUsed'), <span className="muted">{t('capNoUsage')}</span>]] as const)),
            ]}
          />
        </>
      )}
    </li>
  );
}

const keyOf = (r: Pick<LimitRow, 'kind' | 'assetCode'>) => `${r.kind}:${r.assetCode ?? ''}`;

/** Caps the merchant typed, checked against what they have now. An ask only counts if it is more than today's limit. */
export function askCaps(
  rows: readonly LimitRow[],
  typed: Record<string, string>,
): { caps: Cap[]; problem: 'none' | 'format' | 'notMore' | null } {
  const caps: Cap[] = [];
  let problem: 'format' | 'notMore' | null = null;
  for (const row of rows) {
    const text = (typed[keyOf(row)] ?? '').trim();
    if (!text || row.limit === null) continue;
    if (row.kind === 'beneficiaries_per_day') {
      if (!/^[1-9]\d{0,6}$/.test(text)) problem ??= 'format';
      else if (Number(text) <= Number(row.limit)) problem ??= 'notMore';
      else caps.push({ kind: 'beneficiaries_per_day', limit: Number(text) });
      continue;
    }
    if (!/^(0|[1-9]\d{0,29})(\.\d{1,18})?$/.test(text) || !/[1-9]/.test(text)) problem ??= 'format';
    else if (parseAmount(text) <= parseAmount(row.limit)) problem ??= 'notMore';
    else caps.push({ kind: row.kind, assetCode: row.assetCode ?? '', limit: text });
  }
  return { caps, problem: problem ?? (caps.length === 0 ? 'none' : null) };
}

function RequestIncrease({
  portal,
  merchantId,
  rows,
  open,
  tiers,
  reload,
  test,
}: {
  portal: PortalApi;
  merchantId: string;
  rows: readonly LimitRow[];
  open: Resource<LimitOpen>;
  tiers: Resource<TierList>;
  reload: () => void;
  test: boolean;
}) {
  const { t } = mc.useCopy();
  const { access } = useMerchantAccess();
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const requestId = useRef(newRequestId());
  const [sent, setSent] = useState(false);
  const dirty = !sent && (reason.trim() !== '' || Object.values(typed).some((v) => v.trim() !== ''));
  useUnsavedForm(dirty, t('mnUnsaved'));
  const mayAsk = access.status === 'ready' && ['owner', 'admin', 'finance'].includes(access.role) && access.sessionInteractive !== false;
  const check = askCaps(rows, typed);
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
  const why = !mayAsk
    ? t('lrNotAllowed')
    : check.problem === 'none'
      ? t('lrNone')
      : check.problem === 'format'
        ? t('lrFormat')
        : check.problem === 'notMore'
          ? t('lrNotMore')
          : !reasonOk
            ? t('reasonNeeded')
            : null;
  return (
    <PaySection title={t('lrTitle')} description={t('lrBody')}>
      <span id="request" />
      {open.status === 'loading' ? (
        <PortalLoading rows={2} />
      ) : open.status === 'failed' ? (
        isNotLive(open.failure) ? (
          <NamedBlocker title={t('lrTitle')} why="reasonActions" needs="merchantControl.limits.open">
            {t('lrBlocked')}
          </NamedBlocker>
        ) : (
          <PortalFailure result={open.failure} retry={reload} />
        )
      ) : open.data.status === 'pending' ? (
        <Pending request={open.data.request} portal={portal} merchantId={merchantId} reload={reload} mayAsk={mayAsk} test={test} />
      ) : (
        <form data-testid="form-stack" className="form-stack pp-form" noValidate onSubmit={(e) => e.preventDefault()}>
          {tiers.status === 'ready' && tiers.data.status === 'not_configured' && <p className="muted pp-note">{t('lrNoTier')}</p>}
          {rows.length === 0 ? (
            <p className="muted">{t('lrNoLimits')}</p>
          ) : (
            rows.map((row) => (
              <Field
                key={keyOf(row)}
                label={`${row.assetCode ? `${kindName(t, row.kind)} (${row.assetCode})` : kindName(t, row.kind)} — ${t('lrNow', { limit: row.assetCode && row.limit ? `${formatMoney(row.limit, row.assetCode)} ${row.assetCode}` : (row.limit ?? '') })}`}
                inputMode="decimal"
                value={typed[keyOf(row)] ?? ''}
                onChange={(e) => setTyped({ ...typed, [keyOf(row)]: e.target.value })}
                hint={t('lrNewHint')}
              />
            ))
          )}
          <label className="field">
            <span>{t('lrReason')} *</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} rows={3} />
            <small>{t('hDecisionReason')}</small>
          </label>
          <PortalReview
            title={t('lrSubmit')}
            variant="primary"
            description={t('lrReviewBody')}
            disabled={why !== null}
            disabledReason={why ?? undefined}
            review={
              <dl data-testid="pp-facts" className="pp-facts">
                {check.caps.map((cap) => {
                  const row = rows.find(
                    (r) => keyOf(r) === (cap.kind === 'beneficiaries_per_day' ? `${cap.kind}:` : `${cap.kind}:${cap.assetCode}`),
                  );
                  return (
                    <div key={cap.kind + ('assetCode' in cap ? cap.assetCode : '')}>
                      <dt>{kindName(t, cap.kind)}</dt>
                      <dd>
                        {'assetCode' in cap ? (
                          <>
                            <MoneyText value={row?.limit ?? '0'} asset={cap.assetCode} test={test} /> →{' '}
                            <MoneyText value={cap.limit} asset={cap.assetCode} test={test} />
                          </>
                        ) : (
                          `${row?.limit ?? ''} → ${cap.limit}`
                        )}
                      </dd>
                    </div>
                  );
                })}
                <div>
                  <dt>{t('lrReason')}</dt>
                  <dd>{reason.trim()}</dd>
                </div>
              </dl>
            }
            perform={() =>
              portal.limitRequestIncrease({ merchantId, requestId: requestId.current, caps: check.caps, reason: reason.trim() })
            }
            onConfirmed={() => {
              setSent(true);
              setTyped({});
              setReason('');
              requestId.current = newRequestId();
              reload();
            }}
          />
          {sent && (
            <p className="pp-callout" role="status">
              {t('lrSent')}
            </p>
          )}
        </form>
      )}
    </PaySection>
  );
}

function Pending({
  request,
  portal,
  merchantId,
  reload,
  mayAsk,
  test,
}: {
  request: LimitRequest;
  portal: PortalApi;
  merchantId: string;
  reload: () => void;
  mayAsk: boolean;
  test: boolean;
}) {
  const { t } = mc.useCopy();
  const [why, setWhy] = useState('');
  const caps = Array.isArray(request.caps) ? request.caps : null;
  const ok = why.trim().length >= 3 && why.trim().length <= 500;
  return (
    <div data-testid="form-stack" className="form-stack">
      <p className="pp-callout" role="status">
        {t('lrOpen')} <DateTime value={request.createdAt} />
      </p>
      {caps ? (
        <dl data-testid="pp-facts" className="pp-facts">
          {caps.map((cap) => (
            <div key={cap.kind + ('assetCode' in cap ? cap.assetCode : '')}>
              <dt>{kindName(t, cap.kind)}</dt>
              <dd>{'assetCode' in cap ? <MoneyText value={cap.limit} asset={cap.assetCode} test={test} /> : cap.limit}</dd>
            </div>
          ))}
          <div>
            <dt>{t('lrReason')}</dt>
            <dd>{request.reason}</dd>
          </div>
        </dl>
      ) : (
        <p className="muted">{t('lrUnreadable')}</p>
      )}
      <label className="field">
        <span>{t('lrWithdrawReason')} *</span>
        <textarea value={why} onChange={(e) => setWhy(e.target.value)} maxLength={500} rows={2} disabled={!mayAsk} />
        <small>{t('hDecisionReason')}</small>
      </label>
      <PortalReview
        title={t('lrWithdraw')}
        description={t('lrWithdrawBody')}
        disabled={!mayAsk || !ok}
        disabledReason={!mayAsk ? t('lrNotAllowed') : !ok ? t('reasonNeeded') : undefined}
        review={
          <dl data-testid="pp-facts" className="pp-facts">
            <div>
              <dt>{t('lrWithdrawReason')}</dt>
              <dd>{why.trim()}</dd>
            </div>
          </dl>
        }
        perform={() => portal.limitWithdraw({ merchantId, requestId: request.requestId, reason: why.trim() })}
        onConfirmed={reload}
      />
    </div>
  );
}
