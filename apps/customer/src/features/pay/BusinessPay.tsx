import { useMemo, useState } from 'react';
import { z } from 'zod';
import { useSession } from '../session/session';
import { useResource } from '../../shared/resource';
import { usePreferences } from '../../shared/preferences';
import { displayAmount } from '../../shared/money';
import { Button, DataTable, Field, Page } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { createBusinessPayApi, type BusinessPayApi, type PayBusinessAuthority } from './pay-api';
import { PayDetails, PayNotice, PayPagination, PaySection, PayState, ReviewedAction, Status } from './components';
import { MerchantPayments } from './MerchantPayments';
import { MerchantBilling } from './MerchantBilling';
import { MerchantNetwork, MerchantPermissions, MerchantDeveloper } from './MerchantNetwork';
import * as s from './schemas';

const rooms = [
  ['/pay/merchant', 'Overview'],
  ['/pay/money', 'Balance'],
  ['/pay/links', 'Payment links'],
  ['/pay/checkout', 'Checkout'],
  ['/pay/payments', 'Payments'],
  ['/pay/customers', 'Customers'],
  ['/pay/payouts', 'Payouts'],
  ['/pay/settlements', 'Settlements'],
  ['/pay/disputes', 'Disputes'],
  ['/pay/invoices', 'Invoices'],
  ['/pay/subscriptions', 'Subscriptions'],
  ['/pay/reports', 'Reports'],
  ['/pay/network', 'Network'],
  ['/pay/permissions', 'Permissions'],
  ['/pay/developer', 'Developer test mode'],
] as const;
export function BusinessPay({ path, authority }: { path: string; authority: PayBusinessAuthority | null }) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  const current = path.split('?')[0];
  const room = rooms.find(([route]) => route === current)?.[1] ?? 'Merchant desk';
  const merchant = useResource((signal) => pay.merchant(signal), `pay:merchant:${userId}:${authority?.companyId ?? 'unavailable'}`);
  return (
    <Page eyebrow="Business Pay" title={room} description={authority?.companyName}>
      <PayState resource={merchant.resource} retry={merchant.reload}>
        {(record) => (
          <div className="pay-business">
            <nav aria-label="Business Pay rooms" className="pay-business-nav">
              {rooms.map(([route, label]) => (
                <a href={route} key={route} aria-current={route === current ? 'page' : undefined}>
                  {label}
                </a>
              ))}
            </nav>
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
                <PayNotice title="Customer directory is unavailable">
                  Payments accept an opaque customer reference, but no merchant-scoped customer list, customer profile or customer
                  management contract is published. Payment events and subscription customer IDs remain visible in their own records.
                </PayNotice>
              ) : (
                <MerchantHome pay={pay} merchant={record} />
              )}
            </div>
          </div>
        )}
      </PayState>
      {merchant.resource.status === 'failed' && (
        <div className="pay-return-links">
          <a className="text-link" href="/pay">
            Return to Personal Pay →
          </a>
          <a className="text-link" href="/identbusiness">
            Open Business verification →
          </a>
        </div>
      )}
    </Page>
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
  if (!parsed.success)
    return {
      ok: false,
      reason: 'error',
      message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    };
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
function MerchantHome({ pay, merchant }: { pay: BusinessPayApi; merchant: s.Merchant }) {
  const [domains, setDomains] = useState('');
  const [profileCreated, setProfileCreated] = useState('');
  const rails = useResource((signal) => pay.query('railHealth', undefined, railHealthSchema, signal), `pay:rails:${merchant.id}`);
  return (
    <div className="stack">
      <PaySection title="Your merchant account">
        <PayDetails
          values={[
            ['Merchant', merchant.id],
            ['Account state', <Status value={merchant.status} />],
            ['Business verification', merchant.kybStatus],
            ['Acquiring mode', merchant.mode],
            ['Merchant fee', merchant.feeBps === null ? 'Not published' : `${merchant.feeBps} basis points`],
          ]}
        />
      </PaySection>
      <PaySection title="Payment rail availability">
        <PayState resource={rails.resource} retry={rails.reload} empty="No payment rails returned">
          {(rows) => (
            <div>
              {rows.map((rail) => (
                <div className="pay-destination" key={rail.id}>
                  <span>
                    {rail.id}
                    <small>{rail.reason ?? (rail.healthy ? 'Service healthy' : 'Service unhealthy')}</small>
                  </span>
                  <span>
                    {rail.mode} · {rail.usable ? 'usable' : 'unavailable'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </PayState>
      </PaySection>
      <PaySection
        title="Checkout domains"
        description="Save domains for a new checkout profile. Existing profiles are not silently rewritten."
      >
        <div className="form-stack pay-form">
          <Field
            label="Domains"
            value={domains}
            onChange={(event) => setDomains(event.target.value)}
            hint="Comma-separated domains supplied by your business. No current-profile read is published, so the field starts empty."
          />
          <ReviewedAction
            title="Create checkout profile"
            description="Create a profile for the entered checkout domains. The returned profile ID can be used on a payment link."
            review={<p>{domains}</p>}
            perform={() =>
              validatedMutation(
                pay,
                'merchant.profile',
                {
                  merchantId: merchant.id,
                  domains: domains
                    .split(',')
                    .map((domain) => domain.trim())
                    .filter(Boolean),
                },
                z.object({ merchantId: s.id, domains: z.array(z.string().min(1)).min(1) }),
                z.object({ id: s.id, merchantId: s.id }),
                'pay:write',
                'profile-create',
              )
            }
            disabled={!domains.trim() || Boolean(pay.access('pay:write'))}
            onConfirmed={(data) => {
              setProfileCreated(data.id);
              setDomains('');
            }}
          />
          {profileCreated && (
            <p className="pay-confirmed" role="status">
              Checkout profile created: {profileCreated}
            </p>
          )}
        </div>
      </PaySection>
    </div>
  );
}
function MerchantBalance({ pay }: { pay: BusinessPayApi }) {
  const { hideBalances } = usePreferences();
  const [assetDraft, setAssetDraft] = useState('');
  const [asset, setAsset] = useState('');
  const balance = useResource(
    (signal) =>
      asset
        ? pay.query('merchant.balances', { merchantId: pay.authority!.merchantId, assetId: asset }, s.balanceSchema, signal)
        : Promise.resolve({
            ok: false as const,
            reason: 'not_supported' as const,
            message: 'Choose the asset to read its ledger projection. No portfolio asset discovery is published for this merchant.',
          }),
    `pay:balance:${pay.authority!.merchantId}:${asset}`,
  );
  return (
    <div className="stack">
      <PaySection title="Merchant ledger balance" description="Clearing and available are read projections of the ledger.">
        <form
          className="pay-filters"
          onSubmit={(event) => {
            event.preventDefault();
            setAsset(assetDraft.trim());
          }}
        >
          <Field
            label="Asset"
            value={assetDraft}
            onChange={(event) => setAssetDraft(event.target.value.toUpperCase())}
            required
            maxLength={16}
          />
          <Button type="submit" variant="secondary">
            Read balance
          </Button>
        </form>
        {asset && (
          <PayState resource={balance.resource} retry={balance.reload}>
            {(data) => (
              <div className="pay-balance-grid">
                <div>
                  <p className="muted">Available · {asset}</p>
                  <strong className="pay-value numeric">{hideBalances ? 'Hidden' : displayAmount(data.available)}</strong>
                </div>
                <div>
                  <p className="muted">Clearing · {asset}</p>
                  <strong className="pay-value numeric">{hideBalances ? 'Hidden' : displayAmount(data.clearing)}</strong>
                </div>
              </div>
            )}
          </PayState>
        )}
      </PaySection>
      <a className="pay-destination" href="/pay/settlements">
        <span>
          Settlement records<small>Gross, fees, net and payout status</small>
        </span>
        <span>→</span>
      </a>
      <PayNotice title="Personal balances stay on Money">
        The merchant projection is not replaced with the principal’s personal withdrawal balance. Business cash accounts belong under the
        bank on Money.
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
    (signal) => pay.query('merchant.listLinks', { merchantId, limit }, z.array(s.linkSchema), signal),
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
      <PaySection
        title="Create a payment link"
        description="Blank amount allows the payer to choose. The service supplies and caps an expiry."
      >
        <div className="form-stack pay-form">
          <Field label="Link label" value={label} onChange={(event) => setLabel(event.target.value)} required maxLength={120} />
          <div className="form-row">
            <Field label="Fixed amount (optional)" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} />
            <Field
              label="Asset (optional)"
              value={currency}
              onChange={(event) => setCurrency(event.target.value.toUpperCase())}
              maxLength={16}
            />
          </div>
          <Field label="Profile ID (optional)" value={profileId} onChange={(event) => setProfileId(event.target.value)} />
          <Field label="Expiry (optional)" type="datetime-local" value={expires} onChange={(event) => setExpires(event.target.value)} />
          <ReviewedAction
            title="Create payment link"
            variant="primary"
            description="The link is a shareable payment capability. Save the returned URL now; the secret token is returned only once."
            review={
              <PayDetails
                values={[
                  ['Label', label],
                  ['Amount', amount ? `${amount} ${currency}` : 'Payer chooses'],
                  ['Expiry', expires || 'Service default'],
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
            <PayNotice title="New payment link">
              <a className="text-link pay-secret" href={`/pay/checkout?token=${encodeURIComponent(created.token)}`}>
                {location.origin}/pay/checkout?token={created.token}
              </a>
              <span className="pay-cell-note">Expires {created.expiresAt}. Copy the link before leaving this page.</span>
            </PayNotice>
          )}
        </div>
      </PaySection>
      <PaySection
        title="Your payment links"
        action={
          <Button variant="secondary" onClick={links.reload}>
            Refresh links
          </Button>
        }
      >
        <PayState resource={links.resource} retry={links.reload} empty="No payment links returned">
          {(rows) => (
            <>
              <DataTable headers={['Label', 'Amount', 'Uses', 'Expires / state', '']} label="Payment links">
                {rows.map((link) => (
                  <tr key={link.id}>
                    <td>
                      {link.label}
                      <small className="pay-cell-note">{link.prefix}</small>
                    </td>
                    <td className="numeric">
                      {link.amount === null ? 'Payer chooses' : `${displayAmount(link.amount)} ${link.currency ?? 'Asset chosen by payer'}`}
                    </td>
                    <td>
                      {link.uses} / {link.maxUses ?? 'Unbounded'}
                    </td>
                    <td>
                      {link.expiresAt ?? 'Not supplied'}
                      <small className="pay-cell-note">{link.active ? 'Active' : 'Deactivated'}</small>
                    </td>
                    <td>
                      {link.active && (
                        <ReviewedAction
                          title="Deactivate"
                          description="Prevent new payments through this link. The server reports whether deactivation was confirmed."
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
  const [kind, setKind] = useState('');
  const [destination, setDestination] = useState('');
  const [reason, setReason] = useState('');
  const records = useResource(
    (signal) => pay.query('settlement.list', { merchantId, limit }, z.array(s.settlementSchema), signal),
    `pay:settlements:${merchantId}:${limit}`,
  );
  const details = useResource(
    (signal) =>
      selected
        ? pay.query('settlement.get', { settlementId: selected }, s.settlementSchema, signal)
        : Promise.resolve({ ok: false as const, reason: 'not_supported' as const, message: 'Open a settlement record.' }),
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
        <PaySection
          title="Create a settlement window"
          description="The service freezes eligible payments and computes gross, published fees and net."
        >
          <div className="form-stack pay-form">
            <Field
              label="Settlement window"
              value={window}
              onChange={(event) => setWindow(event.target.value)}
              hint="Use your actual business window identifier. No window or fee is invented."
            />
            <Field label="Settlement asset" value={asset} onChange={(event) => setAsset(event.target.value.toUpperCase())} maxLength={16} />
            {feeBps === null && (
              <PayNotice title="Merchant fee is not published">
                Creating a settlement is unavailable until the merchant pricing rate exists.
              </PayNotice>
            )}
            <ReviewedAction
              title="Create settlement"
              description="Freeze eligible payments into the named window and ask the service to post its authoritative settlement. This does not initiate a bank payout."
              review={
                <PayDetails
                  values={[
                    ['Window', window],
                    ['Asset', asset],
                    ['Published fee', feeBps === null ? 'Absent' : `${feeBps} basis points`],
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
        title={payouts ? 'Payout records' : 'Settlement records'}
        action={
          <Button variant="secondary" onClick={refresh}>
            Refresh records
          </Button>
        }
      >
        <PayState resource={records.resource} retry={records.reload} empty="No settlements returned">
          {(rows) => (
            <>
              <DataTable label="Settlements" headers={['Window / asset', 'Gross', 'Fees', 'Net', 'Status', '']}>
                {rows.map((record) => (
                  <tr key={record.id}>
                    <td>
                      {record.window}
                      <small className="pay-cell-note">{record.assetId}</small>
                    </td>
                    <td className="numeric">{displayAmount(record.gross)}</td>
                    <td className="numeric">{displayAmount(record.fees)}</td>
                    <td className="numeric">{displayAmount(record.net)}</td>
                    <td>
                      <Status value={record.status} />
                    </td>
                    <td>
                      <Button variant="ghost" onClick={() => setSelected(record.id)}>
                        Open
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
        <PaySection title="Settlement details">
          <PayState resource={details.resource} retry={details.reload}>
            {(record) => (
              <div className="form-stack">
                <PayDetails
                  values={[
                    ['Settlement', record.id],
                    ['Net amount', `${displayAmount(record.net)} ${record.assetId}`],
                    ['Status', record.status],
                    ['Payout reference', record.payoutRef ?? 'Not confirmed'],
                  ]}
                />
                {record.status === 'pending' && (
                  <>
                    <Field label="Why release this pending window?" value={reason} onChange={(event) => setReason(event.target.value)} />
                    <ReviewedAction
                      title="Release pending window"
                      description="Unfreeze pending payments so they can enter a later window. This does not release funds to a bank or recipient."
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
                      Live payout rail
                      <select value={rail} onChange={(event) => setRail(event.target.value)}>
                        <option value="">Choose a connected live payout rail</option>
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
                        <PayNotice title="No live payout rail returned">
                          A healthy sandbox cannot move merchant money. Payout remains unavailable until an eligible live rail is connected.
                        </PayNotice>
                      )}
                    <Field
                      label="Destination kind"
                      value={kind}
                      onChange={(event) => setKind(event.target.value)}
                      hint="Use the destination kind supplied for the selected live rail. The service validates the permitted kind."
                    />
                    <Field label="Destination reference" value={destination} onChange={(event) => setDestination(event.target.value)} />
                    <ReviewedAction
                      title="Pay out settlement"
                      variant="primary"
                      description="Send the posted net amount through the selected live payout rail. The server checks ownership, permissions, destination and rail posture again."
                      review={
                        <PayDetails
                          values={[
                            ['Settlement', record.id],
                            ['Net amount', `${displayAmount(record.net)} ${record.assetId}`],
                            ['Rail', rail],
                            ['Destination', `${kind}: ${destination}`],
                          ]}
                        />
                      }
                      perform={() =>
                        validatedMutation(
                          pay,
                          'settlement.payout',
                          { settlementId: record.id, railId: rail, destination: { kind, ref: destination } },
                          z.object({
                            settlementId: s.id,
                            railId: z.string().min(1),
                            destination: z.object({ kind: z.string().min(1), ref: z.string().min(1) }),
                          }),
                          s.settlementSchema,
                          'pay:payout',
                          `settlement:${record.id}`,
                        )
                      }
                      disabled={!rail || !kind || !destination || Boolean(pay.access('pay:payout'))}
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
