import { useState } from 'react';
import { Button } from '@intafaced/ui';
import { EmptyState, Field } from '../../../ui-kit';
import type { z } from 'zod';
import { useResource, type Resource } from '../../../../../shared/resource';
import { PayDetails, PaySection } from '../../../components';
import { Chip, Gate, ListShell, MoreFooter, SelectField, TestTag, Timeline } from '../../components';
import { useCursorList, type ListState } from '../../hooks';
import type { PortalApi } from '../../api';
import type { OnboardingStep } from '../../routes';
import type { KybEvent, MerchantRecord, StarterFee, kybCurrentSchema } from '../../schemas';
import { PortalReview } from '../../ui/PortalReview';
import { DestinationConfirm } from '../../access/DestinationConfirm';
import type { DestinationProof } from '../../access/destination-step-up';
import { normaliseReference } from '../../money/Destinations';
import { useUnsavedForm } from '../../useUnsavedForm';
import { BusinessApplication } from './Application';
import { reason as notLive } from '../../chrome/copy';
import { accountCopy } from '../account/copy';
import type { Progress, TermsState } from '../account/schemas';
import { readyAccess, useOptionalMerchantAccess } from '../../access/MerchantAccess';
import { DateTime } from '../../ui/DateTime';
import { Blocker } from '../account/ui';
import { portalCopy } from '../copy';
import { mc } from '../../money/copy';
import { starterFeeStory } from '../../ui/fee-story';
import { describeDestination, railWords } from '../../money/destination';
import {
  businessDetails,
  destinationShapeOk,
  emptyBusiness,
  merchantNames,
  onboardingSteps,
  railKind,
  validateBusiness,
  type BusinessErrors,
  type BusinessForm,
} from '../model';

type Kyb = z.infer<typeof kybCurrentSchema>;
type Rails = Array<{ id: string; capabilities: string[]; mode: 'live' | 'sandbox' | 'absent'; usable: boolean; healthy: boolean }>;
export type SavedDestination = { railId: string; kind: string; ref: string };
type StepState = 'done' | 'current' | 'waiting' | 'todo';

/**
 * `/pay/onboarding`: the setup overview, and its three steps at their own addresses. Progress is read from the
 * service (a business record, the verification status, the saved destinations), so reloading or switching device
 * never loses it. `starterFee` is the fee INTAFACED has published for new accounts, as the service states it. Until one exists a new
 * account cannot be opened from here: a blank price is refused, never defaulted.
 */
export function Onboarding({
  portal,
  merchant,
  reloadMerchant,
  starterFee,
  step,
}: {
  step?: OnboardingStep;
  portal: PortalApi;
  merchant: MerchantRecord | null;
  reloadMerchant: () => void;
  starterFee: StarterFee | null;
}) {
  const id = merchant?.id ?? 'none';
  const kyb = useResource(
    (s) => (merchant ? portal.kybCurrent(s) : Promise.resolve({ ok: true as const, data: null })),
    `portal:kyb:${id}`,
  );
  const rails = useResource((s) => portal.rails(s), 'portal:rails');
  const progress = useResource(
    (s) => (merchant ? portal.onboardingProgress(merchant.id, s) : Promise.resolve({ ok: true as const, data: null })),
    `portal:progress:${id}`,
  );
  const history = useCursorList(
    (cursor, s) => portal.kybHistory(cursor, s),
    `portal:kyb-history:${id}`,
    (e) => e.seq,
  );
  const [saved, setSaved] = useState<SavedDestination | null>(null);
  return (
    <OnboardingView
      step={step}
      portal={portal}
      merchant={merchant}
      kyb={kyb.resource as Resource<Kyb | null>}
      progress={progress.resource as Resource<Progress | null>}
      history={merchant ? history.state : null}
      loadMoreHistory={history.loadMore}
      rails={rails.resource as Resource<Rails>}
      starterFee={starterFee}
      saved={saved}
      onCreated={reloadMerchant}
      onKybSubmitted={() => {
        kyb.reload();
        progress.reload();
        history.reload();
        reloadMerchant();
      }}
      onDestinationSaved={(value) => {
        setSaved(value);
        progress.reload();
      }}
      retry={() => {
        kyb.reload();
        rails.reload();
        progress.reload();
      }}
    />
  );
}

export type OnboardingViewProps = {
  step?: OnboardingStep;
  portal: PortalApi;
  merchant: MerchantRecord | null;
  kyb: Resource<Kyb | null>;
  progress: Resource<Progress | null>;
  history: ListState<KybEvent> | null;
  loadMoreHistory: () => void;
  rails: Resource<Rails>;
  starterFee: StarterFee | null;
  saved: SavedDestination | null;
  onCreated: () => void;
  onKybSubmitted: () => void;
  onDestinationSaved: (value: SavedDestination) => void;
  retry: () => void;
};

/** The three steps' states, from the service's progress when it answers and from the account record when it does not. */
export function stepStates(props: Pick<OnboardingViewProps, 'merchant' | 'kyb' | 'progress' | 'saved'>) {
  const progress = props.progress.status === 'ready' ? props.progress.data : null;
  const kybStatus = progress?.kybStatus ?? (props.kyb.status === 'ready' && props.kyb.data ? props.kyb.data.kybStatus : null);
  const destination = progress ? progress.destination.present : props.saved !== null;
  const base = onboardingSteps(props.merchant, kybStatus, destination);
  const business: StepState = props.merchant ? (progress && !progress.business.done ? 'current' : 'done') : 'current';
  return { ...base, business, progress, kybStatus, destination };
}

export function OnboardingView(props: OnboardingViewProps) {
  const { t } = portalCopy.useCopy();
  const { t: a } = accountCopy.useCopy();
  const { merchant } = props;
  const steps = stepStates(props);
  const items: Array<[0 | 1 | 2, StepState, string, string, string]> = [
    [0, steps.business, t('step1Title'), t('step1Short'), 'business'],
    [1, steps.verification, t('step2Title'), t('step2Short'), 'verification'],
    [2, steps.payout, t('step3Title'), t('step3Short'), 'go-live'],
  ];
  const shown = props.step ? (props.step === 'business' ? 0 : props.step === 'verification' ? 1 : 2) : null;
  return (
    <div className="stack">
      <nav aria-label={t('stepsLabel')}>
        <ol className="sa-steps">
          {items.map(([index, state, title, short, slug]) => (
            <li key={index} className="sa-step" aria-current={shown === index ? 'step' : undefined}>
              <h3>
                {t('stepOf', { n: index + 1 })}: {title}
              </h3>
              <p>{short}</p>
              <p>
                <strong>{t(`stepState_${state}` as 'stepState_done')}</strong>
              </p>
              <a className="text-link" href={`/pay/onboarding/${slug}`}>
                {state === 'done' ? a('stepReview') : a('stepOpen')}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      {shown === null && <Overview {...props} />}
      {shown === 0 && <StepBusiness {...props} />}
      {shown === 1 && <StepVerification {...props} />}
      {shown === 2 && <StepGoLive {...props} />}
      {shown !== null && merchant === null && <p className="muted">{a('startHere')}</p>}
    </div>
  );
}

/**
 * The merchant terms: a blocker naming what is missing while none are published, the published version to read and
 * accept, or when it was accepted. Only the owner signs for the business; svc-pay refuses anyone else.
 */
function Terms({
  portal,
  merchantId,
  terms,
  onAccepted,
}: {
  portal: PortalApi;
  merchantId: string;
  terms: TermsState | null;
  onAccepted: () => void;
}) {
  const { t: a } = accountCopy.useCopy();
  const owner = readyAccess(useOptionalMerchantAccess())?.role === 'owner';
  // Unknown until progress answers: say nothing rather than claim none are published (the step notes a failed read).
  if (!terms) return null;
  if (terms.state === 'not_configured')
    return (
      <Blocker reason={a('waitTerms')} needs="terms version" title={a('termsTitle')}>
        {a('termsBlocked')}
      </Blocker>
    );
  return (
    <div data-testid="onboarding-terms" className="stack">
      <h3 className="pp-sub">{a('termsTitle')}</h3>
      <p className="muted">{a('termsBody')}</p>
      <a className="text-link" href={terms.url} target="_blank" rel="noreferrer noopener">
        {a('termsRead', { version: terms.version })}
      </a>
      {terms.state === 'accepted' ? (
        <p className="pp-confirmed" role="status">
          {a('termsAccepted', { version: terms.version })} <DateTime value={terms.acceptedAt} />
        </p>
      ) : (
        <div className="pp-actions">
          <PortalReview
            title={a('termsAccept')}
            variant="primary"
            description={a('termsAcceptBody', { version: terms.version })}
            perform={() => portal.termsAccept(merchantId, terms.version)}
            onConfirmed={onAccepted}
            disabled={!owner}
            disabledReason={a('termsOwnerOnly')}
          />
        </div>
      )}
    </div>
  );
}

/** Where things stand: what is done, what is left, and what can be done right now. */
function Overview(props: OnboardingViewProps) {
  const { t: a } = accountCopy.useCopy();
  const { t } = portalCopy.useCopy();
  const { merchant } = props;
  const steps = stepStates(props);
  const progress = steps.progress;
  const left: string[] = [];
  if (!merchant) left.push(a('leftBusiness'));
  else {
    if (progress && !progress.business.done)
      left.push(
        a('leftBusinessMissing', { fields: progress.business.missing.map((m) => a(`missing_${m}` as 'missing_legalName')).join(', ') }),
      );
    if (steps.kybStatus !== 'approved') left.push(steps.kybStatus === 'pending' ? a('leftVerifyWaiting') : a('leftVerify'));
    if (!steps.destination) left.push(a('leftDestination'));
    if (progress?.terms.state === 'not_accepted') left.push(a('leftTerms'));
    if (merchant.status !== 'active' || steps.kybStatus !== 'approved') left.push(a('leftLive'));
  }
  return (
    <>
      <PaySection title={a('overviewLeftTitle')} description={a('overviewLeftBody')}>
        {merchant && left.length === 0 ? (
          <p className="pp-confirmed" role="status">
            {a('allDone')}
          </p>
        ) : (
          <ul className="sa-list">
            {left.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {merchant && (
          <PayDetails
            values={[
              [t('factStatus'), <Chip kind="merchant" value={merchant.status} />],
              [t('factVerification'), steps.kybStatus ? <Chip kind="kyb" value={steps.kybStatus} /> : t('notGiven')],
            ]}
          />
        )}
      </PaySection>
      <PaySection title={a('overviewNowTitle')} description={a('overviewNowBody')}>
        {merchant ? (
          <div className="pp-actions">
            <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/links/new" />}>
              {t('createFirstLink')}
            </Button>
            <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/merchant" />}>
              {t('openDashboard')}
            </Button>
          </div>
        ) : (
          <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/onboarding/business" />}>
            {a('startBusiness')}
          </Button>
        )}
        <p className="muted">
          {a('limitsLine')} <TestTag />{' '}
          <a className="text-link" href="/pay/limits">
            {t('reviewLimits')}
          </a>
        </p>
      </PaySection>
      <PaySection title={a('overviewWaitTitle')} description={a('overviewWaitBody')}>
        <div className="stack">
          <Blocker reason={notLive('reasonDocuments')} needs="document check provider" title={a('docsHeading')}>
            {a('docsBlocked')}
          </Blocker>
          {progress?.terms.state === 'not_configured' && (
            <Blocker reason={a('waitTerms')} needs="terms version" title={a('termsTitle')}>
              {a('termsBlocked')}
            </Blocker>
          )}
        </div>
      </PaySection>
    </>
  );
}

function StepBusiness({ portal, merchant, starterFee, onCreated, progress }: OnboardingViewProps) {
  const { t } = portalCopy.useCopy();
  const { t: a } = accountCopy.useCopy();
  const [form, setForm] = useState<BusinessForm>(emptyBusiness);
  const [tried, setTried] = useState(false);
  useUnsavedForm(!merchant && Object.values(form).some(Boolean), a('acUnsaved'));
  const set = (field: keyof BusinessForm) => (event: { target: { value: string } }) => setForm({ ...form, [field]: event.target.value });
  const errors: BusinessErrors = tried || Object.values(form).some(Boolean) ? validateBusiness(form) : {};
  const errorText = (field: keyof BusinessForm) => (errors[field] ? t(`err_${errors[field]}` as 'err_required') : undefined);
  if (merchant) {
    const missing = progress.status === 'ready' && progress.data ? progress.data.business.missing : [];
    return (
      <PaySection title={t('step1Title')} description={t('step1DoneBody')}>
        <PayDetails
          values={[
            [
              t('factMerchantId'),
              <span data-testid="pp-mono" className="pp-mono">
                {merchant.id}
              </span>,
            ],
            [t('factMode'), t(merchant.mode === 'gateway' ? 'modeGateway' : merchant.mode === 'psp' ? 'modePsp' : 'modePayfac')],
            [t('factStatus'), <Chip kind="merchant" value={merchant.status} />],
          ]}
        />
        {missing.length > 0 && (
          <p className="pp-callout" role="note">
            {a('leftBusinessMissing', { fields: missing.map((m) => a(`missing_${m}` as 'missing_legalName')).join(', ') })}
          </p>
        )}
        <p className="muted pp-note">{a('businessEditElsewhere')}</p>
        <a className="text-link" href="/pay/settings">
          {a('editBusiness')}
        </a>
      </PaySection>
    );
  }
  const invalid = Object.keys(validateBusiness(form)).length > 0;
  const noFee = starterFee === null;
  return (
    <PaySection title={t('step1Title')} description={t('step1Body')}>
      <form
        data-testid="form-stack"
        className="form-stack pp-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
        }}
      >
        <fieldset className="sa-group">
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
        <fieldset className="sa-group">
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
        <fieldset className="sa-group">
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
        <p className="sa-reviewed">{a('sensitiveReviewed')}</p>
        {noFee && (
          <Blocker reason={notLive('reasonFees')} needs="starter fee" title={a('starterFeeTitle')}>
            {a('starterFeeBlocked')}
          </Blocker>
        )}
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
                [t('factStartingFee'), noFee ? t('feeNotPublished') : starterFeeStory(starterFee)],
              ]}
            />
          }
          perform={async () => {
            setTried(true);
            return noFee
              ? { ok: false as const, reason: 'forbidden' as const, message: a('starterFeeRefusal'), code: 'portal.local' }
              : portal.createMerchant(starterFee.bps, businessDetails(form), merchantNames(form));
          }}
          onConfirmed={onCreated}
          disabled={invalid || noFee}
          disabledReason={noFee ? a('starterFeeRefusal') : t('fixFieldsFirst')}
        />
        {invalid && !noFee && <p className="muted pp-note">{t('fixFieldsFirst')}</p>}
      </form>
    </PaySection>
  );
}

function StepVerification({ portal, merchant, kyb, history, loadMoreHistory, onKybSubmitted, retry }: OnboardingViewProps) {
  const { t } = portalCopy.useCopy();
  const { t: a } = accountCopy.useCopy();
  const [ref, setRef] = useState('');
  const [submitted, setSubmitted] = useState(false);
  useUnsavedForm(Boolean(ref) && !submitted, a('acUnsaved'));
  if (!merchant) return <EmptyState title={t('needStep1Title')}>{t('needStep1Body')}</EmptyState>;
  return (
    <>
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
                  <div data-testid="form-stack" className="form-stack pp-form">
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
      </PaySection>
      <BusinessApplication
        portal={portal}
        merchant={merchant}
        kybStatus={kyb.status === 'ready' && kyb.data ? kyb.data.kybStatus : merchant.kybStatus}
        kybRef={kyb.status === 'ready' && kyb.data ? kyb.data.kybRef : merchant.kybRef}
        onSubmitted={onKybSubmitted}
      />
      <a className="text-link" href="/pay/onboarding/go-live">
        {a('continueGoLive')}
      </a>
      <PaySection title={t('historyTitle')}>
        {history && (
          <ListShell state={history} retry={retry} empty={{ title: t('kybHistoryEmptyTitle'), body: t('kybHistoryEmptyBody') }}>
            {(rows) => (
              <>
                <Timeline
                  label={t('historyTitle')}
                  items={rows.map((row) => ({
                    at: row.at,
                    title: t('kybFromTo', { from: kybWord(row.fromStatus, t), to: kybWord(row.toStatus, t) }),
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
    </>
  );
}

export const kybWord = (status: string, t: ReturnType<typeof portalCopy.useCopy>['t']) =>
  status === 'none'
    ? t('chipKyb_none')
    : status === 'pending'
      ? t('chipKyb_pending')
      : status === 'approved'
        ? t('chipKyb_approved')
        : status === 'rejected'
          ? t('chipKyb_rejected')
          : status;

function StepGoLive(props: OnboardingViewProps) {
  const { portal, merchant, rails, saved, onDestinationSaved, retry, progress } = props;
  const { t } = portalCopy.useCopy();
  const { t: a } = accountCopy.useCopy();
  const { t: m } = mc.useCopy();
  const [railId, setRailId] = useState('');
  const [ref, setRef] = useState('');
  const [proof, setProof] = useState<DestinationProof>({ code: '' });
  useUnsavedForm(Boolean(ref) && normaliseReference(ref) !== saved?.ref, a('acUnsaved'));
  if (!merchant) return <EmptyState title={t('needStep1Title')}>{t('needStep1Body')}</EmptyState>;
  const steps = stepStates(props);
  const onFile = steps.progress?.destination.destinations ?? [];
  return (
    <>
      <PaySection title={t('step3Title')} description={t('step3Body')}>
        {onFile.length > 0 && (
          <div>
            <h3 className="pp-sub">{a('onFileTitle')}</h3>
            <ul className="sa-list" aria-label={a('onFileTitle')}>
              {onFile.map((d) => (
                <li key={`${d.railId}:${d.destinationMasked}`}>{describeDestination(m, d.kind, d.destinationMasked, d.railId)}</li>
              ))}
            </ul>
          </div>
        )}
        <Gate resource={rails} retry={retry} rows={2}>
          {(all) => {
            const payoutRails = all.filter((rail) => rail.capabilities.includes('payout'));
            if (payoutRails.length === 0)
              return (
                <Blocker reason={a('waitPayoutRail')} needs="payout rail" title={t('noPayoutRailTitle')}>
                  {t('noPayoutRailBody')}
                </Blocker>
              );
            const chosen = payoutRails.find((rail) => rail.id === railId) ?? payoutRails[0]!;
            const kind = railKind(chosen.id);
            const shapeOk = ref.trim() === '' || destinationShapeOk(kind, ref);
            return (
              <div data-testid="form-stack" className="form-stack pp-form">
                <SelectField
                  label={`${t('fRail')} *`}
                  value={chosen.id}
                  onChange={setRailId}
                  options={payoutRails.map(
                    (rail) => [rail.id, `${railWords(m, rail.id)} · ${t(rail.mode === 'live' ? 'railLive' : 'railSandbox')}`] as const,
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
                    <>
                      <PayDetails
                        values={[
                          [t('fRail'), railWords(m, chosen.id)],
                          [t('fKind'), t(kind === 'crypto' ? 'kindCrypto' : 'kindBank')],
                          [
                            t('factDestination'),
                            <span data-testid="pp-mono" className="pp-mono">
                              {normaliseReference(ref)}
                            </span>,
                          ],
                        ]}
                      />
                      <DestinationConfirm proof={proof} onChange={setProof} />
                    </>
                  }
                  perform={() => {
                    // A code is good once: the next try asks for a new one, whatever this one's answer.
                    if ('code' in proof) setProof({ code: '' });
                    return portal.setPayoutDestination(merchant.id, chosen.id, kind, normaliseReference(ref), proof);
                  }}
                  onConfirmed={(data) => {
                    onDestinationSaved({ railId: data.railId, kind: data.kind, ref: data.ref });
                  }}
                  disabled={ref.trim() === '' || !shapeOk}
                  disabledReason={t(kind === 'crypto' ? 'hAddress' : 'hBankRef')}
                />
                {saved && (
                  <p className="pp-confirmed" role="status">
                    {t('destinationSaved')}
                  </p>
                )}
                <p className="muted pp-note">{a('destinationMasked')}</p>
              </div>
            );
          }}
        </Gate>
      </PaySection>
      <PaySection title={a('goLiveReviewTitle')} description={a('goLiveReviewBody')}>
        <PayDetails
          values={[
            [t('factStatus'), <Chip kind="merchant" value={merchant.status} />],
            [t('factVerification'), steps.kybStatus ? <Chip kind="kyb" value={steps.kybStatus} /> : t('notGiven')],
            [t('factDestination'), steps.destination ? a('destinationOnFile') : a('destinationMissing')],
            [t('factLive'), steps.kybStatus === 'approved' ? a('liveByIntafaced') : a('liveWaitingVerification')],
            [
              t('factLimits'),
              <>
                <TestTag />{' '}
                <a className="text-link" href="/pay/limits">
                  {t('reviewLimits')}
                </a>
              </>,
            ],
          ]}
        />
        {steps.kybStatus !== 'approved' && (
          <Blocker reason={notLive('reasonVerified')} needs="approved verification" title={a('liveHeading')}>
            {a('liveBlockedBody')}
          </Blocker>
        )}
        <Terms portal={portal} merchantId={merchant.id} terms={steps.progress?.terms ?? null} onAccepted={retry} />
        <div className="pp-actions">
          <a className="text-link" href="/pay/pricing">
            {t('reviewPricing')}
          </a>
          <Button variant="secondary" nativeButton={false} role="link" render={<a href="/pay/merchant" />}>
            {t('openDashboard')}
          </Button>
        </div>
        {progress.status === 'failed' && <p className="muted pp-note">{a('progressUnavailable')}</p>}
      </PaySection>
    </>
  );
}
