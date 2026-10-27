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
import type { MemberRole, MerchantRecord } from '../schemas';
import { CopyReference } from '../ui/CopyReference';
import { feeStory, hasAccountFee } from '../ui/fee-story';
import { DateTime } from '../ui/DateTime';
import { PortalReview } from '../ui/PortalReview';
import { plainCode } from '../ui/plain-code';
import { paymentsCopy as c } from './copy';
import { CheckoutLook } from './CheckoutLook';
import { CheckoutMethods } from './CheckoutMethods';
import { definite } from './not-available';
import type { CheckoutSettings } from './schemas';

type Rail = Resource<Array<{ id: string; mode: 'live' | 'sandbox' | 'absent'; usable: boolean; healthy: boolean }>>;

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
}: {
  portal: PortalApi;
  merchantId: string;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
}) {
  const rails = useResource((s) => portal.rails(s), `portal:home-rails:${merchantId}`);
  const settings = useResource((s) => portal.checkoutSettings(merchantId, s), `portal:home-checkout:${merchantId}`);
  return (
    <HomePanelsView
      merchant={merchant}
      role={role}
      rails={rails.resource}
      settings={settings.resource}
      retryRails={rails.reload}
      retrySettings={settings.reload}
    />
  );
}

export function HomePanelsView({
  merchant,
  role,
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
                  [c.t('hp_fee'), feeRate ?? <FeeText merchant={merchant} />],
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

/**
 * The account's fee statement (`ui/fee-story.ts`). The fee taken at settlement is the account's own rate, so an account
 * with no rate says exactly that. A price list never stands in for it: it only describes a schedule.
 */
function FeeText({ merchant }: { merchant: MerchantRecord | null }) {
  return hasAccountFee(merchant) ? <>{feeStory(merchant)}</> : <span className="muted">{feeStory(merchant)}</span>;
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
  return (
    <CheckoutSettingsView
      settings={settings.resource}
      retry={settings.reload}
      merchantId={merchantId}
      authority={authority}
      portal={portal}
    />
  );
}

export function CheckoutSettingsView({
  settings,
  retry,
  merchantId,
  authority,
  portal,
}: {
  settings: Resource<CheckoutSettings>;
  retry: () => void;
  merchantId: string;
  authority: PayBusinessAuthority | null;
  /** Reads and saves the checkout look. Without it (a static preview) that section is left out. */
  portal?: PortalApi;
}) {
  return (
    <div className="stack">
      {portal && <CheckoutLook portal={portal} />}
      {portal && <CheckoutMethods portal={portal} />}
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
      <div data-testid="form-stack" className="form-stack pp-form">
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
