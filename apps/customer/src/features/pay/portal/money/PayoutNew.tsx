import { useState } from 'react';
import { EmptyState } from '@intafaced/ui';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { useMerchantAccess } from '../access/MerchantAccess';
import { Facts, Gate, HaltBanner, NotConfigured, PortalFailure, PortalLoading } from '../components';
import { useUnsavedForm } from '../useUnsavedForm';
import type { PortalApi } from '../api';
import { useNow, useUrlParam } from '../hooks';
import { activeHalts } from '../model';
import { DateTime } from '../ui/DateTime';
import { MoneyText } from '../ui/MoneyText';
import { PortalReview } from '../ui/PortalReview';
import { uiCopy } from '../ui/copy';
import { SelectField } from '../components';
import { LinkButton, TestBanner, useTestMode } from './common';
import { mc } from './copy';
import { describeDestination } from './destination';
import { approvalsBySettlement, payoutBlock, payoutHeadroom, type PayoutBlock } from './model';
import { settlementName } from './Settlements';
import type { DestinationItem } from './schemas';
import type { Settlement } from '../schemas';

/** What a payout submit answers: a request for approval, or money sent straight away. */
export type PayoutOutcome = { route: 'approval'; id: string } | { route: 'sent'; id: string };

/**
 * `/pay/payouts/new`: choose a settlement and where it goes, check the limit, review, then ask. Below your approval
 * limit the payout is sent at once; above it, a second person has to approve.
 */
export function PayoutNew({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const now = useNow();
  const { access, can } = useMerchantAccess();
  const [picked, setPicked] = useUrlParam('settlement', '');
  const [destPicked, setDest] = useState('');
  const ready = useResource((s) => portal.settlementPage(merchantId, { status: 'posted' }, undefined, s), `money:payable:${merchantId}`);
  const destinations = useResource((s) => portal.destinationPage(merchantId, undefined, s), `money:destinations:${merchantId}`);
  const usage = useResource((s) => portal.usage(merchantId, s), `money:usage:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  const pending = useResource(
    (s) => portal.approvalPage(merchantId, { status: 'pending' }, undefined, s),
    `money:approvals-pending:${merchantId}`,
  );
  const [done, setDone] = useState<PayoutOutcome | null>(null);
  useUnsavedForm(Boolean(destPicked) && !done, t('mnUnsaved'));
  const reload = () => {
    ready.reload();
    destinations.reload();
    usage.reload();
    halts.reload();
    pending.reload();
  };
  if (done)
    return (
      <div className="stack">
        <p className="pp-callout" role="status">
          {done.route === 'approval' ? t('pnDoneApproval') : t('pnDoneSent')}
        </p>
        <div className="pp-actions">
          <LinkButton variant="primary" href={`/pay/payouts/${encodeURIComponent(picked || done.id)}`}>
            {t('pnOpenPayout')}
          </LinkButton>
          <LinkButton href="/pay/payouts">{t('pnAllPayouts')}</LinkButton>
        </div>
      </div>
    );
  return (
    <div className="stack">
      <HaltBanner resource={halts.resource} scopes={['payout']} />
      <TestBanner />
      <Gate resource={ready.resource} retry={reload} rows={3}>
        {(page) => {
          const waiting =
            pending.resource.status === 'ready'
              ? approvalsBySettlement('items' in pending.resource.data ? pending.resource.data.items : pending.resource.data)
              : null;
          const payable = page.items.filter((s) => !(waiting?.get(s.id)?.status === 'pending'));
          const settlement: Settlement | null = payable.find((s) => s.id === picked) ?? null;
          const dests: DestinationItem[] | null = destinations.resource.status === 'ready' ? destinations.resource.data.items : null;
          const dest = dests?.find((d) => d.id === destPicked) ?? (dests && dests.length === 1 ? dests[0]! : null);
          const headroom = settlement && usage.resource.status === 'ready' ? payoutHeadroom(usage.resource.data, settlement.assetId) : null;
          const paused =
            halts.resource.status === 'ready'
              ? (() => {
                  const h = activeHalts(halts.resource.data, ['payout']);
                  return h.unreadable || h.halts.length > 0;
                })()
              : false;
          const block: PayoutBlock = payoutBlock({
            settlement,
            paused,
            kybApproved: access.status === 'ready' && access.kybStatus !== null ? access.kybStatus === 'approved' : null,
            destinationCount: dests ? dests.length : null,
            remaining: headroom?.remaining ?? null,
          });
          const allowed = can('payout.request');
          const problem = !allowed
            ? t('pnNotAllowed')
            : !settlement
              ? t('pnBlock_nothing')
              : block
                ? t(`pnBlock_${block}` as 'pnBlock_paused')
                : !dest
                  ? t('pnPickDestination')
                  : null;
          return (
            <>
              {payable.length === 0 ? (
                <EmptyState title={t('pnNoneTitle')} action={<LinkButton href="/pay/settlements">{t('pnNoneAction')}</LinkButton>}>
                  {t('pnNoneBody')}
                </EmptyState>
              ) : (
                <form className="form-stack pp-form" onSubmit={(e) => e.preventDefault()} noValidate>
                  <PaySection title={t('pnStep1')} description={t('pnStep1Body')}>
                    <SelectField
                      label={t('pnSettlement')}
                      value={settlement?.id ?? ''}
                      onChange={setPicked}
                      options={[
                        ['', t('pnChoose')],
                        ...payable.map((s) => [s.id, `${settlementName(t, locale, s)} · ${s.net} ${s.assetId}`] as const),
                      ]}
                    />
                  </PaySection>
                  <PaySection title={t('pnStep2')} description={t('pnStep2Body')}>
                    {destinations.resource.status === 'loading' ? (
                      <PortalLoading rows={1} />
                    ) : destinations.resource.status === 'failed' ? (
                      <PortalFailure result={destinations.resource.failure} retry={destinations.reload} />
                    ) : dests && dests.length === 0 ? (
                      <EmptyState
                        title={t('pnNoDestTitle')}
                        action={<LinkButton href="/pay/payouts/destinations">{t('pnNoDestAction')}</LinkButton>}
                      >
                        {t('pnNoDestBody')}
                      </EmptyState>
                    ) : (
                      <SelectField
                        label={t('pnDestination')}
                        value={dest?.id ?? ''}
                        onChange={setDest}
                        options={[
                          ['', t('pnChoose')],
                          ...(dests ?? []).map((d) => [d.id, describeDestination(t, d.kind, d.destinationMasked, d.railId)] as const),
                        ]}
                      />
                    )}
                  </PaySection>
                  <PaySection title={t('pnStep3')} description={t('pnStep3Body')}>
                    {settlement ? (
                      <Facts
                        items={[
                          [t('colAmount'), <MoneyText value={settlement.net} asset={settlement.assetId} test={test} />],
                          [
                            t('pnLimit'),
                            headroom ? (
                              headroom.remaining !== null ? (
                                <>
                                  <MoneyText value={headroom.remaining} asset={settlement.assetId} test={test} /> {t('pnLimitLeft')}
                                </>
                              ) : (
                                <MoneyText value={headroom.limit} asset={settlement.assetId} test={test} />
                              )
                            ) : (
                              <NotConfigured>{t('pnLimitNone')}</NotConfigured>
                            ),
                          ],
                          [t('pnApproval'), t('pnApprovalBody')],
                        ]}
                      />
                    ) : (
                      <p className="muted">{t('pnBlock_nothing')}</p>
                    )}
                    {problem && (
                      <p className="pp-callout pp-callout--warn" role="note">
                        {problem}
                      </p>
                    )}
                    <PortalReview<PayoutOutcome>
                      title={t('pnSubmit')}
                      variant="primary"
                      description={t('pnReviewBody')}
                      disabled={problem !== null}
                      disabledReason={problem ?? undefined}
                      review={
                        settlement && dest ? (
                          <dl className="pp-facts">
                            <div>
                              <dt>{t('colAmount')}</dt>
                              <dd>
                                <MoneyText value={settlement.net} asset={settlement.assetId} test={test} />
                              </dd>
                            </div>
                            <div>
                              <dt>{t('apvTo')}</dt>
                              <dd>{describeDestination(t, dest.kind, dest.destinationMasked, dest.railId)}</dd>
                            </div>
                            <div>
                              <dt>{t('pnLimit')}</dt>
                              <dd>
                                {headroom?.remaining != null ? (
                                  <>
                                    <MoneyText value={headroom.remaining} asset={settlement.assetId} test={test} /> {t('pnLimitLeft')}
                                  </>
                                ) : (
                                  t('pnLimitNone')
                                )}
                              </dd>
                            </div>
                            <div>
                              <dt>{t('pnApproval')}</dt>
                              <dd>{t('pnApprovalBody')}</dd>
                            </div>
                            <div>
                              <dt>{t('pnAsOf')}</dt>
                              <dd>
                                <DateTime value={new Date(now).toISOString()} />
                              </dd>
                            </div>
                          </dl>
                        ) : undefined
                      }
                      perform={async () => {
                        if (!settlement || !dest)
                          return { ok: false as const, reason: 'error' as const, code: 'portal.local', message: t('pnPickDestination') };
                        const asked = await portal.requestPayoutApproval({ merchantId, settlementId: settlement.id, railId: dest.railId });
                        if (asked.ok) return { ok: true as const, data: { route: 'approval' as const, id: asked.data.settlementId } };
                        // Below the approval limit the service says no approval is needed; the same reviewed payout is then sent directly.
                        if (asked.code !== 'pay.approval_not_required' && !asked.message.startsWith('pay.approval_not_required'))
                          return asked;
                        const sent = await portal.sendPayout({ settlementId: settlement.id, railId: dest.railId });
                        return sent.ok ? { ok: true as const, data: { route: 'sent' as const, id: sent.data.id } } : sent;
                      }}
                      onConfirmed={setDone}
                    />
                  </PaySection>
                </form>
              )}
            </>
          );
        }}
      </Gate>
    </div>
  );
}
