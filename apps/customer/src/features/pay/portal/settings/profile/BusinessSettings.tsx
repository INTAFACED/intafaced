import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { Field } from '../../../ui-kit';
import { useResource, type Resource } from '../../../../../shared/resource';
import { useSession } from '../../../../session/session';
import { PayDetails, PaySection } from '../../../components';
import { useMerchantAccess } from '../../access/MerchantAccess';
import { Chip, ListShell, MoreFooter } from '../../components';
import { useCursorList, useMemberNames, type ListState } from '../../hooks';
import type { PortalApi } from '../../api';
import { AuditPanel } from '../../ui/AuditPanel';
import { CopyReference } from '../../ui/CopyReference';
import { DateTime } from '../../ui/DateTime';
import { PortalReview } from '../../ui/PortalReview';
import { useUnsavedForm } from '../../useUnsavedForm';
import { actorName } from '../account/actors';
import { reason as notLive } from '../../chrome/copy';
import { accountCopy } from '../account/copy';
import { isWaiting, profilePatch, sensitiveChanges, toForm, validateProfile, type ProfileForm } from '../account/model';
import type { BusinessProfile, ProfileChange, ProfileFields } from '../account/schemas';
import { ReadGate } from '../account/ui';

type Who = {
  merchantId: string;
  accountStatus: string;
  mode: string | null;
  kybStatus: string | null;
  displayName: string | null;
  legalName: string | null;
};

/** `/pay/settings`: the business's own details, who changed them, and what is waiting for review. */
export function BusinessSettings({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { access, canOwnerWrite, can } = useMerchantAccess();
  const { userId } = useSession();
  const names = useMemberNames(portal);
  const profile = useResource((s) => portal.profileGet(merchantId, s), `portal:profile:${merchantId}`);
  const history = useCursorList(
    (cursor, s) => portal.profileHistory(merchantId, cursor, s),
    `portal:profile-history:${merchantId}`,
    (c) => c.requestId,
  );
  const ready = access.status === 'ready' ? access : null;
  const who: Who = {
    merchantId,
    accountStatus: ready?.accountStatus ?? 'active',
    mode: ready?.mode ?? null,
    kybStatus: ready?.kybStatus ?? null,
    displayName: ready?.displayName ?? null,
    legalName: ready?.legalName ?? null,
  };
  const mayEdit = canOwnerWrite || can('profile.manage') || ready?.role === 'admin';
  return (
    <BusinessSettingsView
      portal={portal}
      who={who}
      profile={profile.resource}
      history={history.state}
      me={userId}
      names={names}
      mayEdit={mayEdit}
      mayChangeRule={ready?.role === 'owner'}
      interactive={ready?.sessionInteractive ?? null}
      loadMoreHistory={history.loadMore}
      reload={() => {
        profile.reload();
        history.reload();
      }}
    />
  );
}

export function BusinessSettingsView(props: {
  portal: PortalApi;
  who: Who;
  profile: Resource<BusinessProfile>;
  history: ListState<ProfileChange>;
  me: string | null;
  names: ReadonlyMap<string, string>;
  mayEdit: boolean;
  /** Second approval binds admins, so only the owner switches it (svc-pay refuses anyone else). */
  mayChangeRule: boolean;
  interactive: boolean | null;
  loadMoreHistory: () => void;
  reload: () => void;
}) {
  const { t } = accountCopy.useCopy();
  const { who, profile, history } = props;
  const waiting = history.status === 'ready' ? history.items.filter((c) => isWaiting(c.status)) : [];
  const lastApplied =
    history.status === 'ready' ? history.items.find((c) => c.status === 'applied' || c.status === 'applied_pre_kyb') : undefined;
  // the name on this very page comes from the details shown below it, so the two can never disagree
  const read = profile.status === 'ready' ? profile.data : null;
  const shownName = read?.displayName ?? read?.legalName ?? who.displayName ?? who.legalName;
  return (
    <div className="stack">
      <PaySection title={t('profileAccountTitle')}>
        <PayDetails
          values={[
            [t('fName'), shownName ?? t('notSet')],
            [t('fAccountStatus'), <Chip kind="merchant" value={who.accountStatus} />],
            [t('fVerification'), who.kybStatus ? <Chip kind="kyb" value={who.kybStatus} /> : t('notSet')],
            [t('fAccountId'), <CopyReference value={who.merchantId} what={t('fAccountId')} />],
          ]}
        />
        {lastApplied && (
          <AuditPanel who={actorName(lastApplied.makerId, props.me, props.names)} at={lastApplied.decidedAt ?? lastApplied.createdAt} />
        )}
        <p className="muted">{props.mayEdit ? t('whoMayEdit') : t('whoMayEditNot')}</p>
      </PaySection>

      {waiting.length > 0 && (
        <p className="pp-callout" role="status">
          <strong>{t('pendingTitle')}</strong> {waiting.length === 1 ? t('pendingBodyOne') : t('pendingBodyMany', { n: waiting.length })}
        </p>
      )}

      <ReadGate
        resource={profile}
        retry={props.reload}
        waiting={{ reason: notLive('reasonProfile'), body: t('profileEditBlocked'), needs: 'merchant.businessProfile.get' }}
        rows={4}
      >
        {(data) => <ProfileForm key={data.version} {...props} profile={data} />}
      </ReadGate>

      <SecondApproval
        portal={props.portal}
        merchantId={who.merchantId}
        mayEdit={props.mayChangeRule}
        loading={profile.status === 'loading'}
        fromService={read?.secondApprovalEnabled}
        reload={props.reload}
      />

      <PaySection title={t('profileHistoryTitle')} description={t('profileHistoryBody')}>
        <ListShell state={history} retry={props.reload} empty={{ title: t('profileHistoryEmpty'), body: t('profileHistoryEmptyBody') }}>
          {(rows) => (
            <>
              <ul className="stack" aria-label={t('profileHistoryTitle')}>
                {rows.map((change) => (
                  <li key={change.requestId}>
                    <ChangeRow {...props} change={change} />
                  </li>
                ))}
              </ul>
              {history.status === 'ready' && <MoreFooter state={history} onMore={props.loadMoreHistory} />}
            </>
          )}
        </ListShell>
      </PaySection>
    </div>
  );
}

const FIELD_LABEL = {
  displayName: 'pfDisplayName',
  legalName: 'pfLegalName',
  address: 'pfAddress',
  website: 'pfWebsite',
  supportEmail: 'pfSupportEmail',
  supportPhone: 'pfSupportPhone',
  statementDescriptor: 'pfDescriptor',
  industry: 'pfIndustry',
} as const satisfies Record<keyof ProfileFields, string>;

const addressText = (a: ProfileFields['address'] | undefined) =>
  a ? [a.line1, a.line2, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(', ') : '';

function show(value: unknown, empty: string): string {
  if (value === null || value === undefined || value === '') return empty;
  if (typeof value === 'object') return addressText(value as ProfileFields['address']);
  return String(value);
}

function ProfileForm({
  portal,
  profile,
  who,
  mayEdit,
  interactive,
  reload,
}: {
  portal: PortalApi;
  profile: BusinessProfile;
  who: Who;
  mayEdit: boolean;
  interactive: boolean | null;
  reload: () => void;
}) {
  const { t } = accountCopy.useCopy();
  const original = toForm(profile);
  const [form, setForm] = useState<ProfileForm>(original);
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<'applied' | 'pending_review' | 'pending_second_approval' | null>(null);
  const patch = profilePatch(profile, form);
  const changed = Object.keys(patch) as Array<keyof ProfileFields>;
  const sensitive = sensitiveChanges(patch);
  const errors = validateProfile(form);
  const invalid = Object.keys(errors).length > 0;
  const kybLocked = who.kybStatus === 'pending';
  const locked = !mayEdit || interactive === false;
  const dirty = changed.length > 0;
  useUnsavedForm(dirty && outcome === null, t('acUnsaved'));
  const set = (key: keyof ProfileForm) => (e: { target: { value: string } }) => {
    setOutcome(null);
    setForm({ ...form, [key]: e.target.value });
  };
  const problem = (key: keyof ProfileForm) => (errors[key] ? t(`pfErr_${errors[key]}` as 'pfErr_required') : undefined);
  const sensitiveLocked = locked || kybLocked;
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 500;
  const blockedWhy = locked
    ? interactive === false
      ? t('needVerifiedSession')
      : t('whoMayEditNot')
    : !dirty
      ? t('nothingChanged')
      : invalid
        ? t('fixFields')
        : kybLocked && sensitive.length > 0
          ? t('lockedInReview')
          : !reasonOk
            ? t('reasonNeeded')
            : undefined;
  const field = (key: keyof ProfileForm, label: string, extra: { hint?: string; sensitive?: boolean; max?: number } = {}) => (
    <Field
      label={label}
      value={form[key]}
      onChange={set(key)}
      maxLength={extra.max ?? 200}
      disabled={extra.sensitive ? sensitiveLocked : locked}
      error={problem(key)}
      hint={extra.hint}
    />
  );
  return (
    <PaySection title={t('profileFormTitle')} description={t('profileFormBody')}>
      <form data-testid="form-stack" className="form-stack pp-form" noValidate onSubmit={(e) => e.preventDefault()}>
        <fieldset className="sa-group">
          <legend>{t('groupPublic')}</legend>
          {field('displayName', t('pfDisplayName'), { hint: t('pfhDisplayName') })}
          {field('website', t('pfWebsite'), { hint: t('pfhWebsite') })}
          {field('supportEmail', t('pfSupportEmail'))}
          {field('supportPhone', t('pfSupportPhone'))}
        </fieldset>
        <fieldset className="sa-group">
          <legend>{t('groupLegal')}</legend>
          <p className="sa-reviewed">{kybLocked ? t('lockedInReview') : t('reviewedByIntafaced')}</p>
          {field('legalName', t('pfLegalName'), { sensitive: true, hint: t('pfhLegalName') })}
          {field('line1', t('pfLine1'), { sensitive: true })}
          {field('line2', t('pfLine2'), { sensitive: true })}
          <div className="form-row">
            {field('city', t('pfCity'), { sensitive: true })}
            {field('region', t('pfRegion'), { sensitive: true })}
          </div>
          <div className="form-row">
            {field('postalCode', t('pfPostalCode'), { sensitive: true, max: 32 })}
            {field('country', t('pfCountry'), { sensitive: true, max: 2, hint: t('pfhCountry') })}
          </div>
          {field('statementDescriptor', t('pfDescriptor'), { sensitive: true, hint: t('pfhDescriptor') })}
          {field('industry', t('pfIndustry'), { sensitive: true })}
        </fieldset>
        <Field
          label={`${t('fReason')} *`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          disabled={locked}
          hint={t('hReason')}
        />
        <div className="pp-actions">
          <PortalReview
            title={t('saveChanges')}
            variant="primary"
            description={sensitive.length > 0 ? t('saveBodyReviewed') : t('saveBody')}
            review={
              <div className="sa-diff">
                {changed.map((key) => (
                  <p key={key}>
                    <strong>{t(FIELD_LABEL[key])}</strong>: <del>{show(profile[key], t('notSet'))}</del> → {show(patch[key], t('cleared'))}
                    {sensitive.includes(key as never) && <span className="sa-reviewed"> · {t('reviewedByIntafaced')}</span>}
                  </p>
                ))}
                <p className="muted">
                  {t('fReason')}: {reason.trim()}
                </p>
              </div>
            }
            perform={() =>
              portal.profileSubmit({ merchantId: who.merchantId, expectedVersion: profile.version, reason: reason.trim(), ...patch })
            }
            onConfirmed={(result) => {
              setOutcome(result.outcome);
              reload();
            }}
            disabled={blockedWhy !== undefined}
            disabledReason={blockedWhy}
          />
          {dirty && (
            <Button variant="ghost" onClick={() => setForm(original)}>
              {t('discard')}
            </Button>
          )}
        </div>
        {blockedWhy && dirty && <p className="muted pp-note">{blockedWhy}</p>}
        {outcome && (
          <p className="pp-confirmed" role="status">
            {t(outcome === 'applied' ? 'outcomeSaved' : outcome === 'pending_review' ? 'outcomeReview' : 'outcomeSecond')}
          </p>
        )}
      </form>
    </PaySection>
  );
}

function ChangeRow({
  change,
  portal,
  who,
  me,
  names,
  mayEdit,
  reload,
}: {
  change: ProfileChange;
  portal: PortalApi;
  who: Who;
  me: string | null;
  names: ReadonlyMap<string, string>;
  mayEdit: boolean;
  reload: () => void;
}) {
  const { t } = accountCopy.useCopy();
  const [reason, setReason] = useState('');
  const keys = Object.keys(change.after) as Array<keyof ProfileFields>;
  const statusWord: Record<string, string> = {
    applied: t('chSaved'),
    applied_pre_kyb: t('chSaved'),
    pending: t('chSecond'),
    pending_review: t('chReview'),
    rejected: t('chRejected'),
    conflict: t('chConflict'),
  };
  const mine = me !== null && change.makerId === me;
  const open = isWaiting(change.status);
  const reasonOk = reason.trim().length >= 3;
  const act = (decision: 'confirm' | 'reject' | 'withdraw') => () =>
    portal.profileConfirm({
      merchantId: who.merchantId,
      requestId: change.requestId,
      decision,
      expectedChangeHash: change.changeHash,
      reason: reason.trim(),
    });
  return (
    <article className="pp-card">
      <div>
        <strong>{keys.length ? keys.map((k) => t(FIELD_LABEL[k])).join(', ') : t('chNoFields')}</strong>{' '}
        <span className="muted">· {statusWord[change.status] ?? change.status}</span>
        <small className="muted pay-cell-note">
          {t('byWho', { who: actorName(change.makerId, me, names) })} · <DateTime value={change.createdAt} />
        </small>
        <small className="muted pay-cell-note">
          {t('fReason')}: {change.reason}
        </small>
        {change.checkerId && (
          <small className="muted pay-cell-note">
            {t('decidedBy', { who: actorName(change.checkerId, me, names) })}
            {change.decidedAt && (
              <>
                {' · '}
                <DateTime value={change.decidedAt} />
              </>
            )}
          </small>
        )}
      </div>
      {open && mayEdit && (
        <div data-testid="form-stack" className="form-stack">
          <Field label={t('fReason')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} hint={t('hReason')} />
          <div className="pp-actions">
            {change.status === 'pending' && !mine && (
              <>
                <PortalReview
                  title={t('confirmChange')}
                  description={t('confirmChangeBody')}
                  perform={act('confirm')}
                  onConfirmed={reload}
                  disabled={!reasonOk}
                  disabledReason={t('reasonNeeded')}
                />
                <PortalReview
                  title={t('rejectChange')}
                  description={t('rejectChangeBody')}
                  perform={act('reject')}
                  onConfirmed={reload}
                  disabled={!reasonOk}
                  disabledReason={t('reasonNeeded')}
                />
              </>
            )}
            {mine && (
              <PortalReview
                title={t('withdrawChange')}
                description={t('withdrawChangeBody')}
                perform={act('withdraw')}
                onConfirmed={reload}
                disabled={!reasonOk}
                disabledReason={t('reasonNeeded')}
              />
            )}
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * Second approval: whether a legal-detail change also needs a teammate, as the business profile reports it. Security
 * state never comes from the browser: while the profile loads the section says nothing, and when the read fails the page
 * says it can't read the setting. Never both buttons: one control that moves the setting to the other state.
 */
function SecondApproval({
  portal,
  merchantId,
  mayEdit,
  loading,
  fromService,
  reload,
}: {
  portal: PortalApi;
  merchantId: string;
  mayEdit: boolean;
  loading: boolean;
  fromService: boolean | undefined;
  reload: () => void;
}) {
  const { t } = accountCopy.useCopy();
  const current = fromService ?? null;
  const turnOn = current !== true;
  if (loading)
    return (
      <PaySection title={t('secondApprovalTitle')} description={t('secondApprovalBody')}>
        <p role="status" aria-busy="true" />
      </PaySection>
    );
  return (
    <PaySection title={t('secondApprovalTitle')} description={t('secondApprovalBody')}>
      <p role="status">
        <strong>{current === null ? t('secondApprovalUnknown') : current ? t('secondApprovalIsOn') : t('secondApprovalIsOff')}</strong>
      </p>
      {current === null ? (
        <p className="muted pp-note">{t('secondApprovalCantChange')}</p>
      ) : (
        <div className="pp-actions">
          <PortalReview
            key={turnOn ? 'on' : 'off'}
            title={turnOn ? t('secondApprovalOn') : t('secondApprovalOff')}
            description={turnOn ? t('secondApprovalOnBody') : t('secondApprovalOffBody')}
            perform={() => portal.profileSecondApproval(merchantId, turnOn)}
            onConfirmed={reload}
            disabled={!mayEdit}
            disabledReason={t('secondApprovalOwnerOnly')}
          />
        </div>
      )}
    </PaySection>
  );
}
