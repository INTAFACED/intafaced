// hand-declared-ok: svc-identity declares the profile.get answer inside its router and packages/contracts has no browser-safe schema for it
import { useId } from 'react';
import { z } from 'zod';
import { SegmentedControl } from '@intafaced/ui';
import { fetchMe, meSchema } from '../data/identity';
import { useAccountViewStatus } from '../features/account/ViewSync';
import { verificationStatus } from '../features/account/verification-guards';
import { useSession } from '../features/session/session';
import { PERSONAL_PROFILE } from '../features/session/profiles';
import { LanguageMenu } from '../shared/LanguageMenu';
import { savePreferences, useResolvedTheme, usePreferences } from '../shared/preferences';
import { useResource } from '../shared/resource';
import { accountMenuCopy } from './account-menu-copy';
import { featureBlocker, isFeatureShown } from './feature-registry';
import { navigate } from './location';
import { shellCopy } from './shell-copy';
import { proCopy } from '../screens/home/pro-copy';
import { ShellSwitch } from '../features/protocol/ShellSwitch';

const profileSchema = z.object({ displayName: z.string().nullable() });

/** The person's name, handle and verification level, each read on its own so one that fails shows "Not shown" and the rest stand. */
function Summary() {
  const { api, userId } = useSession();
  const { t } = accountMenuCopy.useCopy();
  const copy = accountMenuCopy.useCopy();
  const me = useResource((signal) => api.query('identity', 'me', undefined, meSchema, { signal }), `menu-me:${userId}`);
  const profile = useResource(
    (signal) => api.query('identity', 'profile.get', undefined, profileSchema, { signal }),
    `menu-profile:${userId}`,
  );
  const level = useResource(
    (signal) =>
      userId
        ? api.query('identity', 'kyc.status', { limit: 1 }, verificationStatus(userId, 1), { signal })
        : Promise.resolve({ ok: false as const, reason: 'unauthorized' as const, message: '' }),
    `menu-kyc:${userId}`,
  );
  const loading = me.resource.status === 'loading' || profile.resource.status === 'loading' || level.resource.status === 'loading';
  const handle = me.resource.status === 'ready' ? me.resource.data.handle : null;
  const name = profile.resource.status === 'ready' ? profile.resource.data.displayName : null;
  const levelKey =
    level.resource.status === 'ready'
      ? ({ none: 'levelNone', basic: 'levelBasic', full: 'levelFull', institutional: 'levelInstitutional' } as const)[
          level.resource.data.tier
        ]
      : null;
  return (
    <li className="tb-account-summary" aria-label={t('summaryLabel')} aria-busy={loading} data-testid="account-summary">
      {loading ? (
        <span className="tb-account-summary__skeleton" aria-hidden="true" />
      ) : (
        <>
          <strong>{name ?? (handle ? `@${handle}` : t('summaryUnread'))}</strong>
          <small>{handle ? `@${handle}` : t('summaryUnread')}</small>
        </>
      )}
      {userId ? <small lang="zxx">{copy.t('summaryAccountId', { id: `${userId.slice(0, 8)}…` })}</small> : null}
      {!loading ? <small>{copy.t('summaryVerification', { level: levelKey ? t(levelKey) : t('summaryUnread') })}</small> : null}
    </li>
  );
}

/** Personal, each business the person belongs to, sub-accounts and the way to open a business. Choosing changes the view only. */
function Profiles({ close }: { close: () => void }) {
  const { profiles } = useSession();
  const { t } = accountMenuCopy.useCopy();
  const copy = accountMenuCopy.useCopy();
  const choose = (id: string) => {
    savePreferences({ activeProfile: id });
    close();
    if (id !== PERSONAL_PROFILE) navigate('/pay/merchant');
  };
  return (
    <>
      <li role="presentation" className="tb-account-heading">
        {t('profilesTitle')}
      </li>
      <li>
        <button
          type="button"
          className="tb-account-item"
          aria-pressed={profiles.active === PERSONAL_PROFILE}
          data-testid="profile-personal"
          onClick={() => choose(PERSONAL_PROFILE)}
        >
          {t('personal')}
        </button>
      </li>
      {profiles.businesses.map((row) => (
        <li key={row.id}>
          <button
            type="button"
            className="tb-account-item"
            aria-pressed={profiles.active === row.id}
            data-testid="profile-business"
            onClick={() => choose(row.id)}
          >
            {copy.t('businessNamed', { name: row.name })}
          </button>
        </li>
      ))}
      {profiles.status === 'unread' ? (
        <li className="tb-account-note" role="status">
          {t('businessUnread')}{' '}
          <button type="button" className="tb-account-link" onClick={profiles.reload}>
            {t('businessRetry')}
          </button>
        </li>
      ) : null}
      {profiles.notice === 'gone' ? (
        <li className="tb-account-note" role="status" data-testid="profile-gone">
          {t('businessGone')}
        </li>
      ) : null}
      {profiles.status === 'ready' && profiles.businesses.length === 0 ? (
        <li>
          <a className="tb-account-item" href="/pay/onboarding" onClick={close} data-testid="open-business">
            {t('openBusiness')}
          </a>
        </li>
      ) : null}
      <li>
        <a className="tb-account-item" href="/uc/account#subaccount-list-heading" onClick={close}>
          {t('subAccounts')}
        </a>
      </li>
    </>
  );
}

/** Simple · Pro, where the control exists below 1000 px (the bar shows it above that). */
/** The Simple | Pro row. While its registry row is blocked it is drawn disabled with its reason (proof state is never visibility). */
function ModeRow() {
  const { t: tp } = proCopy.useCopy();
  const { t } = shellCopy.useCopy();
  const { layoutMode } = usePreferences();
  const blocker = featureBlocker('pro-mode-switch');
  return (
    <li className="tb-account-mode min-[1000px]:hidden">
      <span className="tb-account-mode__label">{tp('Switch name')}</span>
      <fieldset disabled={blocker !== null} className="m-0 min-w-0 border-0 p-0">
        <SegmentedControl
          size={28}
          aria-label={tp('Switch name')}
          value={layoutMode}
          onValueChange={(value) => savePreferences({ layoutMode: value === 'pro' ? 'pro' : 'simple' })}
          items={[
            { value: 'simple', label: t('Simple') },
            { value: 'pro', label: t('Pro') },
          ]}
        />
      </fieldset>
      {blocker && (
        <span className="text-sm text-fg-2" data-testid="tb-account-mode-blocked">
          {blocker}
        </span>
      )}
    </li>
  );
}

/** The contents of the account menu, in the order of the navigation spec (IA-SPEC 1.7). Mounted only while the menu is open. */
export function AccountMenuBody({ close, onSignOut }: { close: () => void; onSignOut: () => void }) {
  const { t } = accountMenuCopy.useCopy();
  const { theme } = usePreferences();
  const status = useAccountViewStatus();
  const id = useId();
  const row = (href: string, label: string, value?: string) => (
    <li>
      <a className="tb-account-item" href={href} onClick={close}>
        {label}
        {value ? <span className="tb-account-value">{value}</span> : null}
      </a>
    </li>
  );
  const drawn = useResolvedTheme(theme);
  return (
    <ul aria-labelledby={id}>
      <span id={id} hidden>
        {t('menu')}
      </span>
      <Summary />
      <li className="tb-account-divider" role="separator" />
      <Profiles close={close} />
      <li className="tb-account-divider" role="separator" />
      {isFeatureShown('pro-mode-switch') && <ModeRow />}
      {/* The bar has no room for the Exchange | Web3 switch below 1280 px, so the menu carries it there. */}
      <li className="tb-account-mode min-[1280px]:hidden">
        <ShellSwitch current="exchange" here={typeof location === 'undefined' ? '/' : location.pathname + location.search} />
      </li>
      <li className="tb-account-language">
        <LanguageMenu keptIn={status === 'not-saved' ? 'not-saved' : 'account'} onSelect={(next) => savePreferences({ language: next })} />
      </li>
      {row('/view', t('theme'), t(drawn === 'light' ? 'themeLight' : 'themeDark'))}
      <li className="tb-account-divider" role="separator" />
      {row('/uc/account', t('account'))}
      {row('/uc/safe', t('security'))}
      {row('/verification', t('verification'))}
      {row('/developers', t('developer'))}
      <li className="tb-account-divider" role="separator" />
      <li>
        <button
          type="button"
          className="tb-account-item"
          onClick={() => {
            close();
            onSignOut();
          }}
        >
          {t('signOut')}
        </button>
      </li>
    </ul>
  );
}
