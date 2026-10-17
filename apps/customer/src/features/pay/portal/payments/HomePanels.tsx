import { useMemo, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { ArrowUpRight } from 'lucide-react';
import { EmptyState, Field } from '../../ui-kit';
import { useResource, type Resource } from '../../../../shared/resource';
import { useSession } from '../../../session/session';
import { PaySection } from '../../components';
import { validatedMutation } from '../../BusinessPay';
import { createBusinessPayApi, type PayBusinessAuthority } from '../../pay-api';
import * as shared from '../../schemas';
import type { PortalApi } from '../api';
import { Chip, Facts, Gate } from '../components';
import { portalCopy } from '../copy';
import type { ControlProfile, MemberRole, MerchantRecord, PricingRule } from '../schemas';
import { formatMoney } from '../ui/format';
import { CopyReference } from '../ui/CopyReference';
import { DateTime } from '../ui/DateTime';
import { PortalReview } from '../ui/PortalReview';
import { plainCode } from '../ui/plain-code';
import { paymentsCopy as c } from './copy';
import { definite } from './not-available';
import type { CheckoutSettings } from './schemas';

export type FeeLine = { assetCode: string; percent: string; flat: string | null; fromBand: boolean };
const LAYER_RANK = { merchant: 0, tier: 1, global: 2 } as const;
/** The price each asset is charged now, from the pricing read: the most specific rule's first band. */
export function feeLines(rules: ControlProfile['pricing']): FeeLine[] {
  const best = new Map<string, PricingRule>();
  for (const rule of rules ?? []) {
    const have = best.get(rule.assetCode);
    if (!have || LAYER_RANK[rule.layer] < LAYER_RANK[have.layer]) best.set(rule.assetCode, rule);
  }
  return [...best.values()]
    .sort((a, b) => a.assetCode.localeCompare(b.assetCode))
    .map((rule) => {
      const band = rule.bands[0]!;
      const flat = band.flatFee && /[1-9]/.test(band.flatFee) ? formatMoney(band.flatFee, rule.assetCode) : null;
      return { assetCode: rule.assetCode, percent: feePercent(band.feeBps), flat, fromBand: rule.bands.length > 1 };
    });
}

type Rail = Resource<Array<{ id: string; mode: 'live' | 'sandbox' | 'absent'; usable: boolean; healthy: boolean }>>;

/** The fee as a person says it: 150 basis points is 1.5%. */
export const feePercent = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

/** Rails by the names a merchant would use. A rail this page does not know is said as plain words, never as its code. */
export const railName = (id: string) =>
  id === 'crypto-native' ? c.t('hp_railCrypto') : id === 'card-sandbox' ? c.t('hp_railCard') : plainCode(id.replace(/-/g, '_'));

/**
 * The three panels under the Home overview, in plain words: who the account is, how customers can pay, and the checkout
 * settings. Everything comes from reads that exist; a read that is not available says so instead of guessing.
 */
export function HomePanels({
  portal,
  merchantId,
  merchant,
  role,
  feeRate,
}: {
  portal: PortalApi;
  merchantId: string;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  /** Slot for the effective fee rate (money package's `YourEffectiveFee`), shown instead of the price rule when given. */
  feeRate?: ReactNode;
}) {
  const rails = useResource((s) => portal.rails(s), `portal:home-rails:${merchantId}`);
  const settings = useResource((s) => portal.checkoutSettings(merchantId, s), `portal:home-checkout:${merchantId}`);
  const pricing = useResource((s) => portal.control(merchantId, s), `portal:home-pricing:${merchantId}`);
  return (
    <HomePanelsView
      merchant={merchant}
      role={role}
      pricing={pricing.resource}
      rails={rails.resource}
      settings={settings.resource}
      retryRails={rails.reload}
      retrySettings={settings.reload}
      {...(feeRate ? { feeRate } : {})}
    />
  );
}

export function HomePanelsView({
  merchant,
  role,
  pricing,
  rails,
  settings,
  retryRails,
  retrySettings,
  feeRate,
}: {
  /** The effective fee rate read (a component from the money package), shown in place of the price rule when given. */
  feeRate?: ReactNode;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  pricing?: Resource<ControlProfile>;
  rails: Rail;
  settings: Resource<CheckoutSettings>;
  retryRails: () => void;
  retrySettings: () => void;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <div className="stack">
      <PaySection title={c.t('hp_accountTitle')}>
        <Facts
          items={[
            ...(merchant
              ? ([
                  [c.t('hp_status'), <Chip kind="merchant" value={merchant.status} />],
                  [c.t('hp_verification'), <Chip kind="kyb" value={merchant.kybStatus} />],
                  [c.t('hp_mode'), t(merchant.mode === 'gateway' ? 'modeGateway' : merchant.mode === 'psp' ? 'modePsp' : 'modePayfac')],
                  [
                    c.t('hp_fee'),
                    <>
                      {feeRate ?? <FeeText pricing={pricing} />}
                      {merchant.starterFee?.source === 'local_test' && merchant.feeBps === merchant.starterFee.bps && (
                        <>
                          <br />
                          <span className="muted">{t('testFeeNotPricing', { bps: merchant.starterFee.bps })}</span>
                        </>
                      )}
                    </>,
                  ],
                ] as const)
              : []),
            ...(role ? ([[c.t('hp_role'), t(`role_${role}` as 'role_owner')]] as const) : []),
            ...(merchant ? ([[c.t('hp_reference'), <CopyReference value={merchant.id} what={c.t('hp_reference')} />]] as const) : []),
          ]}
        />
      </PaySection>
      <PaySection title={c.t('hp_railsTitle')} description={c.t('hp_railsBody')}>
        <Gate resource={rails} retry={retryRails} rows={2}>
          {(rows) =>
            rows.length === 0 ? (
              <EmptyState title={c.t('hp_railsNone')}>{c.t('hp_railsNoneBody')}</EmptyState>
            ) : (
              <ul
                className="pp-rails"
                aria-label={c.t('hp_railsTitle')}
                style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}
              >
                {rows.map((rail) => (
                  <li key={rail.id} style={{ display: 'grid', gap: 2 }}>
                    <strong>{railName(rail.id)}</strong>
                    <small className="muted">
                      {rail.mode === 'live' ? c.t('hp_modeLive') : rail.mode === 'sandbox' ? c.t('hp_modeTest') : c.t('hp_modeOff')}
                      {' · '}
                      {!rail.usable ? c.t('hp_notReady') : rail.healthy ? c.t('hp_ready') : c.t('hp_problems')}
                    </small>
                  </li>
                ))}
              </ul>
            )
          }
        </Gate>
      </PaySection>
      <PaySection
        title={c.t('hp_checkoutTitle')}
        action={
          <a className="text-link" href="/pay/checkout" aria-label={c.t('hp_checkoutOpen')}>
            <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        }
      >
        <Gate resource={settings} retry={retrySettings} rows={2}>
          {(s) => <CheckoutSummary settings={s} />}
        </Gate>
      </PaySection>
    </div>
  );
}

function FeeText({ pricing }: { pricing?: Resource<ControlProfile> }) {
  if (!pricing || pricing.status === 'loading') return <>…</>;
  if (pricing.status === 'failed') return <span className="muted">{c.t('hp_feeUnavailable')}</span>;
  const lines = feeLines(pricing.data.pricing);
  if (lines.length === 0) return <span className="muted">{c.t('hp_feeNone')}</span>;
  return (
    <>
      {lines.map((line, i) => (
        <span key={line.assetCode}>
          {i > 0 && <br />}
          {lines.length > 1 && `${line.assetCode}: `}
          {line.fromBand ? c.t('hp_feeFrom') : ''}
          {line.flat
            ? c.t('hp_feePercentFlat', { percent: line.percent, flat: line.flat })
            : c.t('hp_feePercent', { percent: line.percent })}
        </span>
      ))}
    </>
  );
}

/** A short read of the checkout settings, for the Home page. The full page is `/pay/checkout`. */
function CheckoutSummary({ settings }: { settings: CheckoutSettings }) {
  if (settings.status === 'not_configured')
    return (
      <p>
        {c.t('hp_checkoutNone')}{' '}
        <a className="text-link" href="/pay/checkout">
          {c.t('hp_checkoutOpen')}
        </a>
      </p>
    );
  return (
    <p>
      {settings.domains.length ? c.t('hp_checkoutDomains', { domains: settings.domains.join(', ') }) : c.t('hp_checkoutNoDomains')}{' '}
      <a className="text-link" href="/pay/checkout">
        {c.t('hp_checkoutOpen')}
      </a>
    </p>
  );
}

/** `/pay/checkout`: the checkout profile as the service holds it now, and a way for the owner to add a new one. */
export function CheckoutSettingsPage({
  portal,
  merchantId,
  authority,
}: {
  portal: PortalApi;
  merchantId: string;
  authority: PayBusinessAuthority | null;
}) {
  const settings = useResource((s) => portal.checkoutSettings(merchantId, s), `portal:checkout-settings:${merchantId}`);
  return <CheckoutSettingsView settings={settings.resource} retry={settings.reload} merchantId={merchantId} authority={authority} />;
}

export function CheckoutSettingsView({
  settings,
  retry,
  merchantId,
  authority,
}: {
  settings: Resource<CheckoutSettings>;
  retry: () => void;
  merchantId: string;
  authority: PayBusinessAuthority | null;
}) {
  return (
    <div className="stack">
      <PaySection title={c.t('cs_currentTitle')} description={c.t('cs_currentBody')}>
        <Gate resource={settings} retry={retry} rows={3}>
          {(s) =>
            s.status === 'not_configured' ? (
              <EmptyState title={c.t('cs_noneTitle')}>{c.t('cs_noneBody')}</EmptyState>
            ) : (
              <Facts
                items={[
                  [
                    c.t('cs_domains'),
                    s.domains.length ? (
                      <ul className="pp-plain-list">
                        {s.domains.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    ) : (
                      c.t('hp_checkoutNoDomains')
                    ),
                  ],
                  [c.t('cs_since'), <DateTime value={s.createdAt} />],
                  [c.t('cs_reference'), <CopyReference value={s.profileId} what={c.t('cs_reference')} />],
                ]}
              />
            )
          }
        </Gate>
      </PaySection>
      <NewProfile merchantId={merchantId} authority={authority} onSaved={retry} />
    </div>
  );
}

function NewProfile({
  merchantId,
  authority,
  onSaved,
}: {
  merchantId: string;
  authority: PayBusinessAuthority | null;
  onSaved: () => void;
}) {
  const { api, userId } = useSession();
  const pay = useMemo(() => createBusinessPayApi(api, userId, authority), [api, userId, authority]);
  const [domains, setDomains] = useState('');
  const [created, setCreated] = useState('');
  const list = domains
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  const noWrite = pay.access('pay:write') !== null;
  return (
    <PaySection title={c.t('cs_newTitle')} description={c.t('cs_newBody')}>
      {noWrite && (
        <p className="muted pp-note" role="note">
          {c.t('cs_ownerOnly')}
        </p>
      )}
      <div className="form-stack pp-form">
        <Field label={c.t('cs_domains')} value={domains} onChange={(e) => setDomains(e.target.value)} hint={c.t('cs_domainsHint')} />
        <PortalReview
          title={c.t('cs_create')}
          description={c.t('cs_createBody')}
          variant="primary"
          disabled={noWrite || list.length === 0}
          review={<Facts items={[[c.t('cs_domains'), list.join(', ')]]} />}
          perform={async () =>
            definite(
              await validatedMutation(
                pay,
                'merchant.profile',
                { merchantId, domains: list },
                z.object({ merchantId: shared.id, domains: z.array(z.string().min(1)).min(1) }),
                z.object({ id: shared.id, merchantId: shared.id }),
                'pay:write',
                'profile-create',
              ),
            )
          }
          onConfirmed={(data) => {
            setCreated(data.id);
            setDomains('');
            onSaved();
          }}
        />
        {created && (
          <p role="status" className="pp-callout">
            {c.t('cs_created')}
          </p>
        )}
      </div>
    </PaySection>
  );
}
