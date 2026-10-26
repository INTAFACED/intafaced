import { portalAmount } from './portal/presentation';
import { payCopy, PayCopy, payRefusal } from './copy';
import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { displayAmount } from '../../shared/money';
import { Button, DataTable } from '@intafaced/ui';
import { Field } from './ui-kit';
import type { ApiResult } from '../../shared/api';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from './pay-api';
import { PayDetails, PayNotice, PayPagination, PaySection, PayState, ReviewedAction, Status, PayTime } from './components';
import { MerchantPayments } from './MerchantPayments';
import { MerchantBilling } from './MerchantBilling';
import { MerchantNetwork, MerchantPermissions, MerchantDeveloper } from './MerchantNetwork';
import * as s from './schemas';
import { LayoutFrame } from './portal/home-layout/Frame';
import { Redirect } from './portal/chrome/PortalNotFound';
import { addressOf } from './portal/payments/checkout-address';
import { moneyReason } from './portal/access/money-step';
import './portal/portal.css';

/** Legacy room lookup. The shared portal frame owns navigation for every merchant route. */
export const businessRooms = [
  ['/pay/merchant', 'overview'],
  ['/pay/money', 'balance'],
  ['/pay/links', 'paymentLinks'],
  ['/pay/checkout', 'checkout'],
  ['/pay/payments', 'payments'],
  ['/pay/customers', 'customers'],
  ['/pay/payouts', 'payouts'],
  ['/pay/settlements', 'settlements'],
  ['/pay/disputes', 'disputes'],
  ['/pay/invoices', 'invoices'],
  ['/pay/subscriptions', 'subscriptions'],
  ['/pay/reports', 'reports'],
  ['/pay/network', 'network'],
  ['/pay/permissions', 'permissions'],
  ['/pay/developer', 'developerTestMode'],
] as const;
const rooms = businessRooms;
export function BusinessPay({ path, authority }: { path: string; authority: PayBusinessAuthority | null }) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  const current = path.split('?')[0];
  const room = rooms.find(([route]) => route === current)?.[1] ?? 'merchantDesk';
  const merchant = useResource((signal) => pay.merchant(signal), `pay:merchant:${userId}:${authority?.companyId ?? 'unavailable'}`);
  return (
    <LayoutFrame here={current ?? '/pay/merchant'} title={<PayCopy k={room} />} purpose={authority?.companyName}>
      <PayState resource={merchant.resource} retry={merchant.reload}>
        {(record) => (
          <div className="stack">
            <div className="pay-business-content">
              {current === '/pay/money' ? (
                <MerchantBalance pay={pay} />
              ) : current === '/pay/links' ? (
                <MerchantLinks pay={pay} />
              ) : current === '/pay/payments' || current === '/pay/disputes' || current === '/pay/reports' ? (
                <MerchantPayments
                  pay={pay}
                  room={current === '/pay/disputes' ? 'disputes' : current === '/pay/reports' ? 'reports' : 'payments'}
                />
              ) : current === '/pay/settlements' || current === '/pay/payouts' ? (
                <MerchantSettlements pay={pay} payouts={current === '/pay/payouts'} feeBps={record.feeBps} />
              ) : current === '/pay/subscriptions' || current === '/pay/invoices' ? (
                <MerchantBilling pay={pay} invoices={current === '/pay/invoices'} />
              ) : current === '/pay/network' ? (
                <MerchantNetwork pay={pay} />
              ) : current === '/pay/permissions' ? (
                <MerchantPermissions pay={pay} />
              ) : current === '/pay/developer' ? (
                <MerchantDeveloper pay={pay} />
              ) : current === '/pay/customers' ? (
                <PayNotice title={payCopy.t('customerDirectoryIsUnavailable')}>
                  <PayCopy k="paymentsAcceptAnOpaqueCustomerReferenceBut" />
                </PayNotice>
              ) : (
                <Redirect to="/pay" />
              )}
            </div>
          </div>
        )}
      </PayState>
      {merchant.resource.status === 'failed' && (
        <div className="pay-return-links">
          <a className="text-link" href="/pay">
            <PayCopy k="returnToPersonalPay" />
          </a>
          <a className="text-link" href="/identbusiness">
            <PayCopy k="openBusinessVerification" />
          </a>
        </div>
      )}
    </LayoutFrame>
  );
}
export async function validatedMutation<I, O>(
  pay: BusinessPayApi,
  procedure: string,
  input: unknown,
  schema: z.ZodType<I>,
  output: z.ZodType<O>,
  scope: 'pay:write' | 'pay:refund' | 'pay:payout',
  operation: string,
): Promise<ApiResult<O>> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) return payRefusal('invalidInput', { reason: 'error' });
  return pay.mutate(procedure, parsed.data, output, scope, operation);
}
export const railHealthSchema = z.array(
  z.object({
    id: z.string(),
    capabilities: z.array(z.string()),
    mode: z.enum(['live', 'sandbox', 'absent']),
    usable: z.boolean(),
    healthy: z.boolean(),
    latencyMs: z.number(),
    reason: z.string().optional(),
  }),
);
function MerchantBalance({ pay }: { pay: BusinessPayApi }) {
  const { hideBalances } = usePreferences();
  const [assetDraft, setAssetDraft] = useState('');
  const [asset, setAsset] = useState('');
  const balance = useResource(
    (signal) =>
      asset
        ? pay.query('merchant.balances', { merchantId: pay.authority!.merchantId, assetId: asset }, s.balanceSchema, signal)
        : Promise.resolve(payRefusal('chooseTheAssetToReadItsLedger', { reason: 'not_supported' })),
    `pay:balance:${pay.authority!.merchantId}:${asset}`,
  );
  return (
    <div className="stack">
      <PaySection title={payCopy.t('merchantLedgerBalance')} description={payCopy.t('clearingAndAvailableAreReadProjectionsOf')}>
        <form
          data-testid="pay-filters"
          className="pay-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setAsset(assetDraft.trim());
          }}
        >
          <Field
            label={payCopy.t('asset')}
            value={assetDraft}
            onChange={(event) => setAssetDraft(event.target.value.toUpperCase())}
            required
            maxLength={16}
          />
          <Button type="submit" variant="secondary">
            <PayCopy k="readBalance" />
          </Button>
        </form>
        {asset && (
          <PayState resource={balance.resource} retry={balance.reload}>
            {(data) => (
              <div className="pay-balance-grid">
                <div>
                  <p className="muted">
                    <PayCopy k="available" /> {asset}
                  </p>
                  <strong className="pay-value numeric">{hideBalances ? payCopy.t('hidden') : portalAmount(data.available, asset)}</strong>
                </div>
                <div>
                  <p className="muted">
                    <PayCopy k="clearing" /> {asset}
                  </p>
                  <strong className="pay-value numeric">{hideBalances ? payCopy.t('hidden') : portalAmount(data.clearing, asset)}</strong>
                </div>
              </div>
            )}
          </PayState>
        )}
      </PaySection>
      <a className="pay-destination" href="/pay/settlements">
        <span>
          <PayCopy k="settlementRecords" />
          <small>
            <PayCopy k="grossFeesNetAndPayoutStatus" />
          </small>
        </span>
        <span>→</span>
      </a>
      <PayNotice title={payCopy.t('personalBalancesStayOnMoney')}>
        <PayCopy k="theMerchantProjectionIsNotReplacedWith" />
      </PayNotice>
    </div>
  );
}
function MerchantLinks({ pay }: { pay: BusinessPayApi }) {
  const merchantId = pay.authority!.merchantId;
  const [limit, setLimit] = useState(50);
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('');
  const [profileId, setProfileId] = useState('');
  const [expires, setExpires] = useState('');
  const [created, setCreated] = useState<z.infer<typeof s.newLinkSchema> | null>(null);
  const links = useResource(
    (signal) =>
      pay
        .query(
          'merchant.listLinks',
          { merchantId, limit },
          z.object({ items: z.array(s.linkSchema), nextCursor: z.string().nullable() }),
          signal,
        )
        .then((result) => s.listed(result)),
    `pay:links:${merchantId}:${limit}`,
  );
  const input = {
    merchantId,
    label,
    ...(amount ? { amount } : {}),
    ...(currency ? { currency } : {}),
    ...(profileId ? { profileId } : {}),
    ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
  };
  return (
    <div className="stack">
      <PaySection title={payCopy.t('createAPaymentLink')} description={payCopy.t('blankAmountAllowsThePayerToChoose')}>
        <div className="form-stack pay-form">
          <Field label={payCopy.t('linkLabel')} value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={120} />
          <div className="form-row">
            <Field
              label={payCopy.t('fixedAmountOptional')}
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Field
              label={payCopy.t('assetOptional')}
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              maxLength={16}
            />
          </div>
          <Field label={payCopy.t('profileIdOptional')} value={profileId} onChange={(event) => setProfileId(event.target.value)} />
          <Field
            label={payCopy.t('expiryOptional')}
            type="datetime-local"
            value={expires}
            onChange={(event) => setExpires(event.target.value)}
          />
          <ReviewedAction
            title={payCopy.t('createPaymentLink')}
            variant="primary"
            description={payCopy.t('theLinkIsAShareablePaymentCapability')}
            review={
              <PayDetails
                values={[
                  [payCopy.t('label'), label],
                  [payCopy.t('amount'), amount ? `${amount} ${currency}` : payCopy.t('payerChooses')],
                  [payCopy.t('expiry'), expires || payCopy.t('serviceDefault')],
                ]}
              />
            }
            perform={() =>
              validatedMutation(
                pay,
                'merchant.createLink',
                input,
                z.object({
                  merchantId: s.id,
                  label: z.string().min(1).max(120),
                  amount: s.positiveAmount.optional(),
                  currency: s.asset.optional(),
                  profileId: s.id.optional(),
                  expiresAt: z.string().datetime({ offset: true }).optional(),
                }),
                s.newLinkSchema,
                'pay:write',
                'link-create',
              )
            }
            disabled={
              !label.trim() || Boolean(pay.access('pay:write')) || Boolean(pay.guard.status(`${pay.authority!.userId}:link-create`))
            }
            onConfirmed={(data) => {
              setCreated(data);
              links.reload();
            }}
          />
          {created && (
            <PayNotice title={payCopy.t('newPaymentLink')}>
              {/* The same page every merchant screen hands a payer: the service's own address, else the one built from the token. */}
              <a className="text-link pay-secret" href={addressOf(created) ?? undefined}>
                {addressOf(created)}
              </a>
              <span className="pay-cell-note">
                <PayCopy k="expires" /> <PayTime value={created.expiresAt} />
                <PayCopy k="copyTheLinkBeforeLeavingThisPage" />
              </span>
            </PayNotice>
          )}
        </div>
      </PaySection>
      <PaySection
        title={payCopy.t('yourPaymentLinks')}
        action={
          <Button variant="secondary" onClick={links.reload}>
            <PayCopy k="refreshLinks" />
          </Button>
        }
      >
        <PayState resource={links.resource} retry={links.reload} empty={payCopy.t('noPaymentLinksReturned')}>
          {(rows) => (
            <>
              <DataTable
                headers={[payCopy.t('label'), payCopy.t('amount'), payCopy.t('uses'), payCopy.t('expiresState'), '']}
                label={payCopy.t('paymentLinks')}
              >
                {rows.map((link) => (
                  <tr key={link.id}>
                    <td>
                      {link.label}
                      <small className="pay-cell-note">{link.prefix}</small>
                    </td>
                    <td className="numeric">
                      {link.amount === null
                        ? payCopy.t('payerChooses')
                        : `${portalAmount(link.amount, link.currency ?? '')} ${link.currency ?? payCopy.t('assetChosenByPayer')}`}
                    </td>
                    <td>
                      {link.uses} / {link.maxUses ?? payCopy.t('unbounded')}
                    </td>
                    <td>
                      {link.expiresAt ? <PayTime value={link.expiresAt} /> : payCopy.t('notSupplied')}
                      <small className="pay-cell-note">{link.active ? payCopy.t('active') : payCopy.t('deactivated')}</small>
                    </td>
                    <td>
                      {link.active && (
                        <ReviewedAction
                          title={payCopy.t('deactivate')}
                          description={payCopy.t('preventNewPaymentsThroughThisLinkThe')}
                          perform={() =>
                            pay.mutate(
                              'merchant.deactivateLink',
                              { merchantId, linkId: link.id },
                              z.object({ deactivated: z.boolean() }),
                              'pay:write',
                              `link:${link.id}`,
                            )
                          }
                          onConfirmed={links.reload}
                          disabled={Boolean(pay.access('pay:write'))}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </PayState>
      </PaySection>
    </div>
  );
}
function MerchantSettlements({ pay, payouts, feeBps }: { pay: BusinessPayApi; payouts: boolean; feeBps: number | null }) {
  const merchantId = pay.authority!.merchantId;
  const [limit, setLimit] = useState(50);
  const [asset, setAsset] = useState('');
  const [window, setWindow] = useState('');
  const [selected, setSelected] = useState('');
  const [rail, setRail] = useState('');
  const [reason, setReason] = useState('');
  const records = useResource(
    (signal) =>
      pay
        .query(
          'settlement.list',
          { merchantId, limit },
          z.object({ items: z.array(s.settlementSchema), nextCursor: z.string().nullable() }),
          signal,
        )
        .then((result) => s.listed(result)),
    `pay:settlements:${merchantId}:${limit}`,
  );
  const details = useResource(
    (signal) =>
      selected
        ? pay.query('settlement.get', { settlementId: selected }, s.settlementSchema, signal)
        : Promise.resolve(payRefusal('openASettlementRecord', { reason: 'not_supported' })),
    `pay:settlement:${merchantId}:${selected}`,
  );
  const rails = useResource((signal) => pay.query('railHealth', undefined, railHealthSchema, signal), `pay:payout-rails:${merchantId}`);
  function refresh() {
    records.reload();
    details.reload();
  }
  return (
    <div className="stack">
      {!payouts && (
        <PaySection title={payCopy.t('createASettlementWindow')} description={payCopy.t('theServiceFreezesEligiblePaymentsAndComputes')}>
          <div className="form-stack pay-form">
            <Field
              label={payCopy.t('settlementWindow')}
              value={window}
              onChange={(event) => setWindow(event.target.value)}
              hint={payCopy.t('useYourActualBusinessWindowIdentifierNo')}
            />
            <Field
              label={payCopy.t('settlementAsset')}
              value={asset}
              onChange={(event) => setAsset(event.target.value.toUpperCase())}
              maxLength={16}
            />
            {feeBps === null && (
              <PayNotice title={payCopy.t('merchantFeeIsNotPublished')}>
                <PayCopy k="creatingASettlementIsUnavailableUntilThe" />
              </PayNotice>
            )}
            <ReviewedAction
              title={payCopy.t('createSettlement')}
              description={payCopy.t('freezeEligiblePaymentsIntoTheNamedWindow')}
              review={
                <PayDetails
                  values={[
                    [payCopy.t('window'), window],
                    [payCopy.t('asset'), asset],
                    [payCopy.t('publishedFee'), feeBps === null ? payCopy.t('absent') : payCopy.t('basisPoints', { feeBps: feeBps })],
                  ]}
                />
              }
              perform={() =>
                validatedMutation(
                  pay,
                  'settlement.run',
                  { merchantId, window, assetId: asset },
                  z.object({ merchantId: s.id, window: z.string().min(1), assetId: s.asset }),
                  s.settlementSchema,
                  'pay:write',
                  `settlement-window:${window}:${asset}`,
                )
              }
              onConfirmed={(data) => {
                setSelected(data.id);
                refresh();
              }}
              disabled={!window || !asset || feeBps === null || Boolean(pay.access('pay:write'))}
            />
          </div>
        </PaySection>
      )}
      <PaySection
        title={payouts ? payCopy.t('payoutRecords') : payCopy.t('settlementRecords')}
        action={
          <Button variant="secondary" onClick={refresh}>
            <PayCopy k="refreshRecords" />
          </Button>
        }
      >
        <PayState resource={records.resource} retry={records.reload} empty={payCopy.t('noSettlementsReturned')}>
          {(rows) => (
            <>
              <DataTable
                label={payCopy.t('settlements')}
                headers={[payCopy.t('windowAsset'), payCopy.t('gross'), payCopy.t('fees'), payCopy.t('net'), payCopy.t('status'), '']}
              >
                {rows.map((record) => (
                  <tr key={record.id}>
                    <td>
                      {record.window}
                      <small className="pay-cell-note">{record.assetId}</small>
                    </td>
                    <td className="numeric">{portalAmount(record.gross, record.assetId)}</td>
                    <td className="numeric">{portalAmount(record.fees, record.assetId)}</td>
                    <td className="numeric">{portalAmount(record.net, record.assetId)}</td>
                    <td>
                      <Status value={record.status} />
                    </td>
                    <td>
                      <Button variant="ghost" onClick={() => setSelected(record.id)}>
                        <PayCopy k="open" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </DataTable>
              <PayPagination count={rows.length} limit={limit} setLimit={setLimit} />
            </>
          )}
        </PayState>
      </PaySection>
      {selected && (
        <PaySection title={payCopy.t('settlementDetails')}>
          <PayState resource={details.resource} retry={details.reload}>
            {(record) => (
              <div className="form-stack">
                <PayDetails
                  values={[
                    [payCopy.t('settlement'), record.id],
                    [payCopy.t('netAmount'), `${displayAmount(record.net)} ${record.assetId}`],
                    [payCopy.t('status'), record.status],
                    [payCopy.t('payoutReference'), record.payoutRef ?? payCopy.t('notConfirmed')],
                  ]}
                />
                {record.status === 'pending' && (
                  <>
                    <Field
                      label={payCopy.t('whyReleaseThisPendingWindow')}
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    />
                    <ReviewedAction
                      title={payCopy.t('releasePendingWindow')}
                      description={payCopy.t('unfreezePendingPaymentsSoTheyCanEnter')}
                      review={<p>{reason}</p>}
                      perform={() =>
                        pay.mutate(
                          'settlement.release',
                          { settlementId: record.id, reason },
                          s.settlementSchema,
                          'pay:write',
                          `settlement:${record.id}`,
                        )
                      }
                      disabled={!reason.trim() || Boolean(pay.access('pay:write'))}
                      onConfirmed={refresh}
                    />
                  </>
                )}
                {record.status === 'posted' && (
                  <>
                    <label className="field">
                      <PayCopy k="livePayoutRail" />
                      <select value={rail} onChange={(event) => setRail(event.target.value)}>
                        <option value="">{payCopy.t('chooseAConnectedLivePayoutRail')}</option>
                        {rails.resource.status === 'ready' &&
                          rails.resource.data
                            .filter((row) => row.mode === 'live' && row.usable && row.healthy && row.capabilities.includes('payout'))
                            .map((row) => (
                              <option value={row.id} key={row.id}>
                                {row.id}
                              </option>
                            ))}
                      </select>
                    </label>
                    {rails.resource.status === 'ready' &&
                      !rails.resource.data.some(
                        (row) => row.mode === 'live' && row.usable && row.healthy && row.capabilities.includes('payout'),
                      ) && (
                        <PayNotice title={payCopy.t('noLivePayoutRailReturned')}>
                          <PayCopy k="aHealthySandboxCannotMoveMerchantMoney" />
                        </PayNotice>
                      )}
                    {pay.access('pay:payout') && (
                      <p className="muted" role="note">
                        {moneyReason('payout', pay.authority?.scopes)}
                      </p>
                    )}
                    <ReviewedAction
                      stepUp="payout"
                      title={payCopy.t('payOutSettlement')}
                      variant="primary"
                      description={payCopy.t('sendThePostedNetAmountThroughThe')}
                      review={
                        <PayDetails
                          values={[
                            [payCopy.t('settlement'), record.id],
                            [payCopy.t('netAmount'), `${displayAmount(record.net)} ${record.assetId}`],
                            [payCopy.t('rail'), rail],
                          ]}
                        />
                      }
                      perform={() =>
                        validatedMutation(
                          pay,
                          'settlement.payout',
                          // The payout goes to the destination saved on the account; the service refuses one named here.
                          { settlementId: record.id, railId: rail },
                          z.object({ settlementId: s.id, railId: z.string().min(1) }),
                          s.settlementSchema,
                          'pay:payout',
                          `settlement:${record.id}`,
                        )
                      }
                      disabled={!rail || Boolean(pay.access('pay:payout'))}
                      onConfirmed={refresh}
                    />
                  </>
                )}
              </div>
            )}
          </PayState>
        </PaySection>
      )}
    </div>
  );
}
