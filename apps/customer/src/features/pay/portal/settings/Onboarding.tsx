import { Button, EmptyState } from '@intafaced/ui';
import { useState } from 'react';
import { useResource, type Resource } from '../../../../shared/resource';
import { Field } from '@intafaced/ui';
import { PayDetails, PaySection } from '../../components';
import { PortalReview } from '../ui/PortalReview';
import { Chip, ComingSoon, Gate, ListShell, MoreFooter, PortalFailure, SelectField, Timeline } from '../components';
import { portalCopy, w3cCopy } from './copy';
import { useCursorList, type ListState } from '../hooks';
import { type StepState } from '../model';
import {
  businessDetails,
  merchantNames,
  destinationShapeOk,
  emptyBusiness,
  onboardingSteps,
  railKind,
  validateBusiness,
  type BusinessErrors,
  type BusinessForm,
} from './model';
import type { PortalApi } from '../api';
import type { KybEvent, MerchantRecord } from '../schemas';
import { kybCurrentSchema } from '../schemas';
import type { z } from 'zod';
import type { OnboardingStep } from '../routes';
import { useUnsavedForm } from '../useUnsavedForm';

type Kyb = z.infer<typeof kybCurrentSchema>;
type Rails = Array<{ id: string; capabilities: string[]; mode: 'live' | 'sandbox' | 'absent'; usable: boolean; healthy: boolean }>;
export type SavedDestination = { railId: string; kind: string; ref: string };

/**
 * `/pay/onboarding`: three steps, tiered limits, live in a day. Progress is read from the service (a merchant
 * record, the verification status), so reloading or switching device never loses it.
 * `starterFeeBps` is the fee INTAFACED has published for new accounts. Until one exists it is null and the
 * account cannot be opened from here: a blank price is refused, never defaulted.
 */
export function Onboarding({
  portal,
  merchant,
  reloadMerchant,
  starterFeeBps,
  step,
}: {
  step?: OnboardingStep;
  portal: PortalApi;
  merchant: MerchantRecord | null;
  reloadMerchant: () => void;
  starterFeeBps: number | null;
}) {
  const kyb = useResource(
    (s) => (merchant ? portal.kybCurrent(s) : Promise.resolve({ ok: true as const, data: null })),
    `portal:kyb:${merchant?.id ?? 'none'}`,
  );
  const rails = useResource((s) => portal.rails(s), 'portal:rails');
  const history = useCursorList(
    (cursor, s) => portal.kybHistory(cursor, s),
    `portal:kyb-history:${merchant?.id ?? 'none'}`,
    (e) => e.seq,
  );
  const [saved, setSaved] = useState<SavedDestination | null>(null);
  return (
    <OnboardingView
      step={step}
      portal={portal}
      merchant={merchant}
      kyb={kyb.resource as Resource<Kyb | null>}
      history={merchant ? history.state : null}
      loadMoreHistory={history.loadMore}
      rails={rails.resource as Resource<Rails>}
      starterFeeBps={starterFeeBps}
      saved={saved}
      onCreated={reloadMerchant}
      onKybSubmitted={() => {
        kyb.reload();
        history.reload();
        reloadMerchant();
      }}
      onDestinationSaved={setSaved}
      retry={() => {
        kyb.reload();
        rails.reload();
      }}
    />
  );
}

export function OnboardingView(props: {
  step?: OnboardingStep;
  portal: PortalApi;
  merchant: MerchantRecord | null;
  kyb: Resource<Kyb | null>;
  history: ListState<KybEvent> | null;
  loadMoreHistory: () => void;
  rails: Resource<Rails>;
  starterFeeBps: number | null;
  saved: SavedDestination | null;
  onCreated: () => void;
  onKybSubmitted: () => void;
  onDestinationSaved: (value: SavedDestination) => void;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const { t: c } = w3cCopy.useCopy();
  const { merchant, saved } = props;
  const kybStatus = props.kyb.status === 'ready' && props.kyb.data ? props.kyb.data.kybStatus : null;
  const steps = onboardingSteps(merchant, kybStatus, saved !== null);
  const [open, setOpen] = useState<0 | 1 | 2 | null>(null);
  const shown = props.step ? (props.step === 'business' ? 0 : props.step === 'verification' ? 1 : 2) : (open ?? steps.current);
  const items: Array<[0 | 1 | 2, StepState, string, string]> = [
    [0, steps.business, t('step1Title'), t('step1Short')],
    [1, steps.verification, t('step2Title'), t('step2Short')],
    [2, steps.payout, t('step3Title'), t('step3Short')],
  ];
  return (
    <div className="stack">
      <a className="text-link" href="/pay/merchant">
        {c('backMerchant')}
      </a>
      <p className="pp-callout">{c('serverProgress')}</p>
      <nav aria-label={t('stepsLabel')}>
        <ol className="pp-steps">
          {items.map(([index, state, title, short]) => (
            <li key={index} className={`pp-step pp-step--${state}`} aria-current={shown === index ? 'step' : undefined}>
              <a
                className="pp-step-button"
                href={`/pay/onboarding/${index === 0 ? 'business' : index === 1 ? 'verification' : 'go-live'}`}
                onClick={(event) => {
                  if (!props.step) {
                    event.preventDefault();
                    setOpen(index);
                  }
                }}
              >
                <span className="pp-step-num" aria-hidden="true">
                  {state === 'done' ? '✓' : index + 1}
                </span>
                <span>
                  <strong>
                    {t('stepOf', { n: index + 1 })}: {title}
                  </strong>
                  <small>{short}</small>
                  <em className="pp-step-state">{t(`stepState_${state}` as 'stepState_done')}</em>
                </span>
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {shown === 0 && <StepBusiness {...props} />}
      {shown === 1 && <StepVerification {...props} />}
      {shown === 2 && <StepPayout {...props} />}
      {steps.sandboxReady && merchant && <SandboxSummary merchant={merchant} saved={saved!} liveWaiting={steps.liveWaiting} />}
    </div>
  );
}

function StepBusiness({ portal, merchant, starterFeeBps, onCreated }: Parameters<typeof OnboardingView>[0]) {
  const { t } = portalCopy.useCopy();
  const [form, setForm] = useState<BusinessForm>(emptyBusiness);
  const [tried, setTried] = useState(false);
  const { t: c } = w3cCopy.useCopy();
  useUnsavedForm(!merchant && Object.values(form).some(Boolean), c('unsaved'));
  const errors: BusinessErrors = tried ? validateBusiness(form) : {};
  const set = (field: keyof BusinessForm) => (event: { target: { value: string } }) => setForm({ ...form, [field]: event.target.value });
  const errorText = (field: keyof BusinessForm) => {
    const problem = tried || form[field] ? validateBusiness(form)[field] : errors[field];
    return problem ? t(`err_${problem}` as 'err_required') : undefined;
  };
  if (merchant)
    return (
      <PaySection title={t('step1Title')} description={t('step1DoneBody')}>
        <PayDetails
          values={[
            [t('factMerchantId'), <span className="pp-mono">{merchant.id}</span>],
            [t('factMode'), t(merchant.mode === 'gateway' ? 'modeGateway' : merchant.mode === 'psp' ? 'modePsp' : 'modePayfac')],
            [t('factStatus'), <Chip kind="merchant" value={merchant.status} />],
          ]}
        />
        <p className="muted pp-note">{t('step1Locked')}</p>
      </PaySection>
    );
  const invalid = Object.keys(validateBusiness(form)).length > 0;
  return (
    <PaySection title={t('step1Title')} description={t('step1Body')}>
      <form
        className="form-stack pp-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
        }}
      >
        <fieldset className="pp-group">
          <legend>{t('groupBusiness')}</legend>
          <Field
            label={`${t('fLegalName')} *`}
            value={form.legalName}
            onChange={set('legalName')}
            maxLength={120}
            autoComplete="organization"
            error={errorText('legalName')}
            hint={t('hLegalName')}
            required
          />
          <Field
            label={t('fDisplayName')}
            value={form.displayName}
            onChange={set('displayName')}
            maxLength={120}
            error={errorText('displayName')}
            hint={t('hDisplayName')}
          />
          <div className="form-row">
            <Field
              label={`${t('fCountry')} *`}
              value={form.country}
              onChange={set('country')}
              maxLength={2}
              error={errorText('country')}
              hint={t('hCountry')}
              required
            />
            <Field
              label={`${t('fBusinessType')} *`}
              value={form.businessType}
              onChange={set('businessType')}
              maxLength={80}
              error={errorText('businessType')}
              hint={t('hBusinessType')}
              required
            />
          </div>
        </fieldset>
        <fieldset className="pp-group">
          <legend>{t('groupContact')}</legend>
          <Field
            label={t('fWebsite')}
            type="url"
            inputMode="url"
            value={form.website}
            onChange={set('website')}
            error={errorText('website')}
            hint={t('hWebsite')}
          />
          <Field
            label={`${t('fContactEmail')} *`}
            type="email"
            value={form.contactEmail}
            onChange={set('contactEmail')}
            autoComplete="email"
            error={errorText('contactEmail')}
            hint={t('hContactEmail')}
            required
          />
        </fieldset>
        <fieldset className="pp-group">
          <legend>{t('groupVolume')}</legend>
          <Field
            label={t('fExpectedVolume')}
            value={form.expectedVolume}
            onChange={set('expectedVolume')}
            maxLength={200}
            error={errorText('expectedVolume')}
            hint={t('hExpectedVolume')}
          />
          <p className="pp-declared">{t('declaredNotVerified')}</p>
        </fieldset>
        <ComingSoon>{c('draftGap')}</ComingSoon>
        {starterFeeBps === null && <ComingSoon title={t('noStarterPricingTitle')}>{t('noStarterPricingBody')}</ComingSoon>}
        <PortalReview
          title={t('createAccount')}
          variant="primary"
          description={t('createAccountBody')}
          review={
            <PayDetails
              values={[
                [t('fLegalName'), form.legalName],
                [t('fDisplayName'), form.displayName.trim() || t('notGiven')],
                [t('fCountry'), form.country.toUpperCase()],
                [t('fBusinessType'), form.businessType],
                [t('fContactEmail'), form.contactEmail],
                [t('fExpectedVolume'), form.expectedVolume ? `${form.expectedVolume} (${t('declaredTag')})` : t('notGiven')],
                [t('factStartingFee'), starterFeeBps === null ? t('feeNotPublished') : t('feeBps', { bps: starterFeeBps })],
              ]}
            />
          }
          perform={async () => {
            setTried(true);
            return starterFeeBps === null
              ? { ok: false as const, reason: 'forbidden' as const, message: t('noStarterPricingTitle'), code: 'portal.local' }
              : portal.createMerchant(starterFeeBps, businessDetails(form), merchantNames(form));
          }}
          onConfirmed={onCreated}
          disabled={invalid || starterFeeBps === null}
          disabledReason={t(starterFeeBps === null ? 'noStarterPricingBody' : 'fixFieldsFirst')}
        />
        {invalid && <p className="muted pp-note">{t('fixFieldsFirst')}</p>}
      </form>
    </PaySection>
  );
}

function StepVerification({
  portal,
  merchant,
  kyb,
  history,
  loadMoreHistory,
  onKybSubmitted,
  retry,
}: Parameters<typeof OnboardingView>[0]) {
  const { t } = portalCopy.useCopy();
  const [ref, setRef] = useState('');
  const { t: c } = w3cCopy.useCopy();
  const [submitted, setSubmitted] = useState(false);
  useUnsavedForm(Boolean(ref) && !submitted, c('unsaved'));
  if (!merchant) return <EmptyState title={t('needStep1Title')}>{t('needStep1Body')}</EmptyState>;
  return (
    <PaySection title={t('step2Title')} description={t('step2Body')}>
      <Gate resource={kyb} retry={retry} rows={2}>
        {(current) => {
          const status = current?.kybStatus ?? merchant.kybStatus;
          const canSubmit = status === 'none' || status === 'rejected';
          return (
            <>
              <PayDetails
                values={[
                  [t('factVerification'), <Chip kind="kyb" value={status} />],
                  [t('factReference'), current?.kybRef ?? t('notGiven')],
                ]}
              />
              <p className="pp-callout" role="note">
                {status === 'approved'
                  ? t('kybApprovedNote')
                  : status === 'pending'
                    ? t('kybPendingNote')
                    : status === 'rejected'
                      ? t('kybRejectedNote')
                      : t('kybNoneNote')}
              </p>
              {canSubmit && (
                <div className="form-stack pp-form">
                  <Field
                    label={`${t('fKybRef')} *`}
                    value={ref}
                    onChange={(e) => setRef(e.target.value)}
                    maxLength={128}
                    hint={t('hKybRef')}
                    error={ref.length > 0 && ref.trim().length === 0 ? t('err_required') : undefined}
                    required
                  />
                  <PortalReview
                    title={t('submitVerification')}
                    variant="primary"
                    description={t('submitVerificationBody')}
                    review={<PayDetails values={[[t('fKybRef'), ref.trim()]]} />}
                    perform={() => portal.submitKyb(merchant.id, ref.trim())}
                    onConfirmed={() => {
                      setSubmitted(true);
                      onKybSubmitted();
                    }}
                    disabled={ref.trim().length === 0}
                    disabledReason={t('hKybRef')}
                  />
                </div>
              )}
            </>
          );
        }}
      </Gate>
      <ComingSoon>{c('verificationGap')}</ComingSoon>
      <a className="text-link" href="/pay/onboarding/go-live">
        {c('continueDestination')}
      </a>
      <h3 className="pp-sub">{t('historyTitle')}</h3>
      {history && (
        <ListShell state={history} retry={retry} empty={{ title: t('kybHistoryEmptyTitle'), body: t('kybHistoryEmptyBody') }}>
          {(rows) => (
            <>
              <Timeline
                label={t('historyTitle')}
                items={rows.map((row) => ({
                  at: row.at,
                  title: `${t('kybFromTo', { from: kybWord(row.fromStatus, t), to: kybWord(row.toStatus, t) })}`,
                  detail:
                    row.decidedBy === 'merchant'
                      ? row.reason
                        ? `${t('bySubmitter')} · ${row.reason}`
                        : t('bySubmitter')
                      : t('byIntafaced'),
                }))}
              />
              {history.status === 'ready' && <MoreFooter state={history} onMore={loadMoreHistory} />}
            </>
          )}
        </ListShell>
      )}
    </PaySection>
  );
}
const kybWord = (status: string, t: ReturnType<typeof portalCopy.useCopy>['t']) =>
  status === 'none'
    ? t('chipKyb_none')
    : status === 'pending'
      ? t('chipKyb_pending')
      : status === 'approved'
        ? t('chipKyb_approved')
        : status === 'rejected'
          ? t('chipKyb_rejected')
          : status;

function StepPayout({ portal, merchant, rails, saved, onDestinationSaved, retry }: Parameters<typeof OnboardingView>[0]) {
  const { t } = portalCopy.useCopy();
  const [railId, setRailId] = useState('');
  const [ref, setRef] = useState('');
  const { t: c } = w3cCopy.useCopy();
  useUnsavedForm(Boolean(ref) && ref.trim() !== saved?.ref, c('unsaved'));
  if (!merchant) return <EmptyState title={t('needStep1Title')}>{t('needStep1Body')}</EmptyState>;
  return (
    <PaySection title={t('step3Title')} description={t('step3Body')}>
      <ComingSoon>{c('goLiveGap')}</ComingSoon>
      <div className="pp-actions">
        <a className="text-link" href="/pay/pricing">
          {c('reviewPricing')}
        </a>
        <a className="text-link" href="/pay/limits">
          {c('reviewLimits')}
        </a>
      </div>
      <Gate resource={rails} retry={retry} rows={2}>
        {(all) => {
          const payoutRails = all.filter((rail) => rail.capabilities.includes('payout'));
          if (payoutRails.length === 0) return <ComingSoon title={t('noPayoutRailTitle')}>{t('noPayoutRailBody')}</ComingSoon>;
          const chosen = payoutRails.find((rail) => rail.id === railId) ?? payoutRails[0]!;
          const kind = railKind(chosen.id);
          const shapeOk = ref.trim() === '' || destinationShapeOk(kind, ref);
          return (
            <div className="form-stack pp-form">
              <SelectField
                label={`${t('fRail')} *`}
                value={chosen.id}
                onChange={setRailId}
                options={payoutRails.map(
                  (rail) => [rail.id, `${rail.id} · ${t(rail.mode === 'live' ? 'railLive' : 'railSandbox')}`] as const,
                )}
                hint={t('hRail')}
              />
              <Field
                label={`${kind === 'crypto' ? t('fAddress') : t('fBankRef')} *`}
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                hint={kind === 'crypto' ? t('hAddress') : t('hBankRef')}
                error={shapeOk ? undefined : t(kind === 'crypto' ? 'err_address' : 'err_bankRef')}
                required
              />
              <PortalReview
                title={t('saveDestination')}
                variant="primary"
                description={t('saveDestinationBody')}
                review={
                  <PayDetails
                    values={[
                      [t('fRail'), chosen.id],
                      [t('fKind'), t(kind === 'crypto' ? 'kindCrypto' : 'kindBank')],
                      [t('factDestination'), <span className="pp-mono">{ref.trim()}</span>],
                    ]}
                  />
                }
                perform={() => portal.setPayoutDestination(merchant.id, chosen.id, kind, ref.trim())}
                onConfirmed={(data) => onDestinationSaved({ railId: data.railId, kind: data.kind, ref: data.ref })}
                disabled={ref.trim() === '' || !shapeOk}
                disabledReason={t(kind === 'crypto' ? 'hAddress' : 'hBankRef')}
              />
              {saved && (
                <p className="pp-confirmed" role="status">
                  {t('destinationSaved')}
                </p>
              )}
              <p className="muted pp-note">{t('noReadBack')}</p>
            </div>
          );
        }}
      </Gate>
    </PaySection>
  );
}

function SandboxSummary({ merchant, saved, liveWaiting }: { merchant: MerchantRecord; saved: SavedDestination; liveWaiting: boolean }) {
  const { t } = portalCopy.useCopy();
  const { t: c } = w3cCopy.useCopy();
  return (
    <PaySection title={c('destinationVisit')} description={c('goLiveGap')}>
      <PayDetails
        values={[
          [t('factMerchantId'), <span className="pp-mono">{merchant.id}</span>],
          [t('factStatus'), <Chip kind="merchant" value={merchant.status} />],
          [t('factLive'), liveWaiting ? t('liveWaiting') : c('activationUnknown')],
          [t('factDestination'), <span className="pp-mono">{saved.ref}</span>],
          [t('factLimits'), t('limitsArriveSoon')],
        ]}
      />
      <div className="pp-actions">
        <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/merchant" />}>
          {t('openDashboard')}
        </Button>
        <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/links" />}>
          {t('createFirstLink')}
        </Button>
      </div>
    </PaySection>
  );
}
