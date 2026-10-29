import { useState } from 'react';
import { EmptyState } from '../../ui-kit';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { useMerchantAccess } from '../access/MerchantAccess';
import { Facts, Gate, HaltBanner, NotConfigured, PortalFailure, PortalLoading } from '../components';
import { useUnsavedForm } from '../useUnsavedForm';
import type { PortalApi } from '../api';
import { useNow, useUrlParam } from '../hooks';
import { activeHalts } from '../model';
import { DateTime } from '../ui/DateTime';
import { formatMoney } from '../ui/format';
import { MoneyText } from '../ui/MoneyText';
import { PortalReview } from '../ui/PortalReview';
import { uiCopy } from '../ui/copy';
import { SelectField } from '../components';
import { LinkButton, TestBanner, useTestMode } from './common';
import { mc } from './copy';
import { useMoneyReason } from '../access/MoneyAction';
import { describeDestination } from './destination';
import { PAYOUT_RETRY_ENABLED } from './payout-retry';
import {
  approvalsBySettlement,
  defaultDestination,
  destinationOfApproval,
  isApprovedToSend,
  payoutBlock,
  payoutHeadroom,
  splitPayable,
  type PayoutBlock,
} from './model';
import { settlementName } from './Settlements';
import { isDefaultDestination, type DestinationItem } from './schemas';
import type { Settlement } from '../schemas';
import type { ApiResult } from '../../../../shared/api';

/** What a payout submit answers: a request for approval, or money sent straight away. */
export type PayoutOutcome =
  | { route: 'approval'; id: string }
  | { route: 'sent'; id: string; status: string }
  /** The request was already used to send this payout: nothing is asked or sent again, the page points at the payout. */
  | { route: 'used'; id: string };

type T = ReturnType<typeof mc.useCopy>['t'];
type Refusal = { ok: false; reason: 'error'; code: string; message: string };
const localRefusal = (message: string): Refusal => ({ ok: false, reason: 'error', code: 'portal.local', message });

/**
 * Why the payout form cannot be sent yet, in the order a merchant would fix it, or null. A pause read that has not
 * answered (still loading, or failed) blocks like a pause: a payout is never started on an unknown.
 */
export function payoutProblem(
  t: T,
  input: {
    allowed: boolean;
    settlement: unknown;
    haltsRead: 'loading' | 'ready' | 'failed';
    block: PayoutBlock;
    dest: unknown;
    sending: boolean;
    maySend: boolean;
    /** Why this session cannot start or send a payout (`money-step.ts`), or null. Asking for approval carries the payout scope too. */
    stepReason?: string | null;
  },
): string | null {
  if (!input.allowed) return t('pnNotAllowed');
  if (input.stepReason) return input.stepReason;
  if (!input.settlement) return t('pnBlock_nothing');
  if (input.haltsRead === 'loading') return t('pnHaltsLoading');
  if (input.haltsRead === 'failed') return t('pnHaltsFailed');
  if (input.block) return t(`pnBlock_${input.block}` as 'pnBlock_paused');
  if (!input.dest) return t('pnPickDestination');
  // Only the account owner can send a payout (the payout page's rule); say who can instead of showing a form that fails.
  if (input.sending && !input.maySend) return t('pnOwnerSends');
  return null;
}

/**
 * Ask for approval, or send. Only a waiting request goes to the team and only an approved one is sent; an expired,
 * voided or rejected one is a refusal, and a used one points at the payout that already went, never a quiet "with your team".
 * `railId` stands for the destination because the service keeps one destination per network (merchant and rail).
 */
export async function submitPayout(input: {
  portal: PortalApi;
  merchantId: string;
  t: T;
  settlement: { id: string } | null;
  dest: { railId: string } | null;
  sending: boolean;
  maySend: boolean;
  /** Why this session cannot ask for approval or send, or null (both procedures carry the payout scope). */
  stepReason?: string | null;
}): Promise<ApiResult<PayoutOutcome>> {
  const { portal, merchantId, t, settlement, dest, sending, maySend, stepReason = null } = input;
  if (!settlement || !dest) return localRefusal(t('pnPickDestination'));
  if (stepReason) return localRefusal(stepReason);
  const send = async (): Promise<ApiResult<PayoutOutcome>> => {
    // A person who cannot send is told who can, rather than sent into a refusal.
    if (!maySend) return localRefusal(t('pnOwnerSends'));
    if (stepReason) return localRefusal(stepReason);
    const sent = await portal.sendPayout({ settlementId: settlement.id, railId: dest.railId });
    return sent.ok ? { ok: true, data: { route: 'sent', id: sent.data.id, status: sent.data.status } } : clearingWords(t, sent);
  };
  // Already approved for this destination: use that approval and send, do not ask again.
  if (sending) return send();
  const asked = await portal.requestPayoutApproval({ merchantId, settlementId: settlement.id, railId: dest.railId });
  if (asked.ok) {
    const status = asked.data.status;
    if (status === 'approved') return send();
    if (status === 'pending') return { ok: true, data: { route: 'approval', id: asked.data.settlementId } };
    // A used approval means the payout already went: say so and open it, never "Ask again".
    if (status === 'consumed') return { ok: true, data: { route: 'used', id: asked.data.settlementId } };
    return localRefusal(
      status === 'expired' ? t('pnAskExpired') : t('pnAskStatus', { status: t(`pnAskWord_${status}` as 'pnAskWord_voided') }),
    );
  }
  // Below the approval limit the service says no approval is needed; the same reviewed payout is then sent directly.
  if (asked.code !== 'pay.approval_not_required' && !asked.message.startsWith('pay.approval_not_required')) return clearingWords(t, asked);
  return send();
}

/**
 * RC-merchant-10: money the rail still holds is refused by the service as `pay.payout_clearing_pending`, with a sentence
 * written for the books. The page says it in plain words and keeps the code, so the refusal is the service's own.
 */
function clearingWords<R>(t: T, result: Extract<ApiResult<R>, { ok: false }>): ApiResult<R> {
  return result.code === 'pay.payout_clearing_pending' ? { ...result, message: t('rClearingPending') } : result;
}

/** Nothing can be started: say whether that is because requests are waiting for a second person, and link to them. */
export function NoPayable({ waitingN }: { waitingN: number }) {
  const { t } = mc.useCopy();
  return waitingN > 0 ? (
    <EmptyState title={t('pnWaitingTitle')} action={<LinkButton href="/pay/approvals?status=pending">{t('pnWaitingAction')}</LinkButton>}>
      {t(waitingN === 1 ? 'pnWaitingBodyOne' : 'pnWaitingBodyMany', { n: waitingN })}
    </EmptyState>
  ) : (
    <EmptyState title={t('pnNoneTitle')} action={<LinkButton href="/pay/settlements">{t('pnNoneAction')}</LinkButton>}>
      {t('pnNoneBody')}
    </EmptyState>
  );
}

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
  // Sending is the owner's; asking for approval follows the role's permission (`payout.request`).
  const sendReason = useMoneyReason('payout', 'send');
  const requestReason = useMoneyReason('payout', 'request');
  const [picked, setPicked] = useUrlParam('settlement', '');
  const [destPicked, setDest] = useState('');
  // A payout can be started from a finalised settlement ("posted"). Retrying a "failed" one is held (PAYOUT_RETRY_ENABLED).
  // A settlement still waiting on the rail ("pending") is listed too, tagged "still clearing": it is never hidden, and asking
  // for it gets the service's own refusal (`pay.payout_clearing_pending`), which names the clearing it would have spent.
  const ready = useResource(async (s) => {
    const [posted, failed, waitingOnRail] = await Promise.all([
      portal.settlementPage(merchantId, { status: 'posted' }, undefined, s),
      PAYOUT_RETRY_ENABLED ? portal.settlementPage(merchantId, { status: 'failed' }, undefined, s) : Promise.resolve(null),
      portal.settlementPage(merchantId, { status: 'pending' }, undefined, s),
    ]);
    if (!posted.ok) return posted;
    // A failed read only hides the retry or clearing rows; the ready ones still show.
    const retry = failed?.ok ? failed.data.items : [];
    const clearing = waitingOnRail.ok ? waitingOnRail.data.items : [];
    return { ok: true as const, data: { ...posted.data, items: [...posted.data.items, ...retry], clearing } };
  }, `money:payable:${merchantId}`);
  const destinations = useResource((s) => portal.destinationPage(merchantId, undefined, s), `money:destinations:${merchantId}`);
  const usage = useResource((s) => portal.usage(merchantId, s), `money:usage:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  // Every request, newest first: a settlement already approved is sent, not asked for again, and one waiting is left out.
  const requests = useResource(async (s) => {
    const read = await portal.approvalPage(merchantId, {}, undefined, s);
    return read.ok ? { ok: true as const, data: 'items' in read.data ? read.data.items : read.data } : read;
  }, `money:approvals-all:${merchantId}`);
  const [done, setDone] = useState<PayoutOutcome | null>(null);
  useUnsavedForm(Boolean(destPicked) && !done, t('mnUnsaved'));
  const reload = () => {
    ready.reload();
    destinations.reload();
    usage.reload();
    halts.reload();
    requests.reload();
  };
  if (done)
    return (
      <div className="stack">
        <p className="pp-callout" role="status">
          {done.route === 'approval'
            ? t('pnDoneApproval')
            : done.route === 'used'
              ? t('pnDoneUsed')
              : done.status === 'paid_out'
                ? t('pnDoneSent')
                : t('pnDoneCheck')}
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
          const waiting = requests.resource.status === 'ready' ? approvalsBySettlement(requests.resource.data) : null;
          const { payable, waitingN } = splitPayable(page.items, waiting);
          const offered = [...payable, ...page.clearing];
          const settlement: Settlement | null = offered.find((s) => s.id === picked) ?? null;
          const dests: DestinationItem[] | null = destinations.resource.status === 'ready' ? destinations.resource.data.items : null;
          // An approved settlement is already bound to one destination; otherwise the owner's default is chosen for them.
          const approved = settlement && isApprovedToSend(waiting?.get(settlement.id)) ? waiting!.get(settlement.id)! : null;
          const approvedDest = destinationOfApproval(dests, approved);
          const dest =
            dests?.find((d) => d.id === destPicked) ??
            approvedDest ??
            defaultDestination(dests) ??
            (dests && dests.length === 1 ? dests[0]! : null);
          // Sending uses the approval only when it is for this very destination; any other choice starts a new request.
          const sending = approved !== null && approvedDest !== null && dest?.id === approvedDest.id;
          const headroom = settlement && usage.resource.status === 'ready' ? payoutHeadroom(usage.resource.data, settlement.assetId) : null;
          // Until the pause read has answered, nothing can be sent: a payout is never started on an unknown.
          const haltsRead = halts.resource.status;
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
          // The account owner is the only person who can send a payout (same rule as the payout page); a role we could not read is left to the service.
          const maySend = access.status !== 'ready' || access.role === 'owner';
          const stepReason = sending ? sendReason : requestReason;
          const problem = payoutProblem(t, { allowed, settlement, haltsRead, block, dest, sending, maySend, stepReason });
          return (
            <>
              {offered.length === 0 ? (
                <NoPayable waitingN={waitingN} />
              ) : (
                <form data-testid="form-stack" className="form-stack pp-form" onSubmit={(e) => e.preventDefault()} noValidate>
                  <PaySection title={t('pnStep1')} description={t('pnStep1Body')}>
                    <SelectField
                      label={t('pnSettlement')}
                      value={settlement?.id ?? ''}
                      onChange={setPicked}
                      options={[
                        ['', t('pnChoose')],
                        ...offered.map(
                          (s) =>
                            [
                              s.id,
                              `${settlementName(t, locale, s)} · ${formatMoney(s.net, s.assetId)} ${s.assetId}${s.status === 'failed' ? ` · ${t('pnRetryTag')}` : ''}${s.status === 'pending' ? ` · ${t('payoutStillClearing')}` : ''}`,
                            ] as const,
                        ),
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
                          ...(dests ?? []).map(
                            (d) =>
                              [
                                d.id,
                                `${describeDestination(t, d.kind, d.destinationMasked, d.railId)}${isDefaultDestination(d) ? ` · ${t('dstDefaultYes')}` : ''}`,
                              ] as const,
                          ),
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
                          [t('pnApproval'), sending ? t('pnApprovedFor') : t('pnApprovalBody')],
                        ]}
                      />
                    ) : (
                      <p className="muted">{t('pnBlock_nothing')}</p>
                    )}
                    {approved && !sending && dest && (
                      <p className="pp-callout" role="note">
                        {t('pnApprovedOther')}
                      </p>
                    )}
                    {problem && (
                      <p className="pp-callout pp-callout--warn" role="note">
                        {problem}
                      </p>
                    )}
                    <PortalReview<PayoutOutcome>
                      stepUp="payout"
                      title={sending ? t('pnSend') : t('pnSubmit')}
                      variant="primary"
                      description={sending ? t('pnSendReviewBody') : t('pnReviewBody')}
                      disabled={problem !== null}
                      disabledReason={problem ?? undefined}
                      review={
                        settlement && dest ? (
                          <dl data-testid="pp-facts" className="pp-facts">
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
                              <dd>{sending ? t('pnApprovedFor') : t('pnApprovalBody')}</dd>
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
                      perform={() => submitPayout({ portal, merchantId, t, settlement, dest, sending, maySend, stepReason })}
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
