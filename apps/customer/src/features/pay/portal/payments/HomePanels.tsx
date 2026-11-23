import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useResource, type Resource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { Chip, CopyReference, Empty, Facts, Gate, Section } from '../volt/parts';
import { portalCopy } from '../copy';
import type { MemberRole, MerchantRecord } from '../schemas';
import { feeStory, hasAccountFee } from '../ui/fee-story';
import { plainCode } from '../ui/plain-code';
import { paymentsCopy as c } from './copy';
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
    <>
      <Section title={c.t('hp_accountTitle')}>
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
      </Section>
      <Section title={c.t('hp_railsTitle')} description={c.t('hp_railsBody')}>
        <Gate resource={rails} retry={retryRails} rows={2}>
          {(rows) =>
            rows.length === 0 ? (
              <Empty title={c.t('hp_railsNone')}>{c.t('hp_railsNoneBody')}</Empty>
            ) : (
              <ul className="lt-rows" aria-label={c.t('hp_railsTitle')}>
                {rows.map((rail) => (
                  <li key={rail.id}>
                    <strong>{railName(rail.id)}</strong>
                    <small className="lt-hint">
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
      </Section>
      <Section
        title={c.t('hp_checkoutTitle')}
        action={
          <a className="lt-link" href="/pay/checkout" aria-label={c.t('hp_checkoutOpen')}>
            <ArrowUpRight size={18} aria-hidden="true" />
          </a>
        }
      >
        <Gate resource={settings} retry={retrySettings} rows={2}>
          {(s) => <CheckoutSummary settings={s} />}
        </Gate>
      </Section>
    </>
  );
}

/**
 * The account's fee statement (`ui/fee-story.ts`). The fee taken at settlement is the account's own rate, so an account
 * with no rate says exactly that. A price list never stands in for it: it only describes a schedule.
 */
function FeeText({ merchant }: { merchant: MerchantRecord | null }) {
  return hasAccountFee(merchant) ? <>{feeStory(merchant)}</> : <span className="lt-hint">{feeStory(merchant)}</span>;
}

/** A short read of the checkout settings, for the Home page. The full page is `/pay/checkout`. */
function CheckoutSummary({ settings }: { settings: CheckoutSettings }) {
  if (settings.status === 'not_configured')
    return (
      <p>
        {c.t('hp_checkoutNone')}{' '}
        <a className="lt-link" href="/pay/checkout">
          {c.t('hp_checkoutOpen')}
        </a>
      </p>
    );
  return (
    <p>
      {settings.domains.length ? c.t('hp_checkoutDomains', { domains: settings.domains.join(', ') }) : c.t('hp_checkoutNoDomains')}{' '}
      <a className="lt-link" href="/pay/checkout">
        {c.t('hp_checkoutOpen')}
      </a>
    </p>
  );
}
