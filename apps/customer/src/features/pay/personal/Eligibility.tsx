import { useState } from 'react';
import { Button, ReviewDialog as Dialog, StatusTag } from '@intafaced/ui';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { uiCopy } from '../../../shared/ui-copy';
import { PaySection, PayState } from '../components';
import type { PersonalPayApi } from '../pay-api';
import type { P2PEligibility } from '../schemas';
import { eligibilityCopy } from './p2p-eligibility-copy';

type CopyT = ReturnType<typeof eligibilityCopy.useCopy>['t'];
type Check = P2PEligibility['checks'][number];

/** One check's reason in words. The service sends a code; the words are the app's. */
export function eligibilityReason(t: CopyT, check: Check, riskVersion: string | null): string {
  const { id, state, reason } = check;
  if (id === 'verification') {
    if (state === 'met') return t('reason_verified', { tier: reason.replace(/^tier\./, '') });
    if (reason === 'denied.kyc_required') return t('reason_kyc');
    return t('reason_region_first');
  }
  if (id === 'contact') {
    if (state === 'met') return t('reason_contact_ok');
    return reason === 'p2p.contact_required' ? t('reason_contact_needed') : t('reason_contact_unknown');
  }
  if (id === 'jurisdiction') {
    if (state === 'met') return t('reason_region_ok');
    if (reason.startsWith('denied.screening')) return t('reason_screening');
    if (reason.startsWith('denied.region')) return t('reason_region_blocked');
    return t('reason_other');
  }
  if (id === 'deposit') return t('reason_deposit');
  if (state === 'met') return t('reason_risk_ok', { version: riskVersion ?? '' });
  if (reason === 'p2p.risk_notice_unset') return t('reason_risk_unset');
  if (reason === 'p2p.risk_not_accepted') return t('reason_risk_needed');
  return t('reason_other');
}

/** The risk and fraud notice, read in full and accepted for the exact version the service published. */
export function RiskSheet({
  pay,
  version,
  onAccepted,
  onClose,
}: {
  pay: PersonalPayApi;
  version: string;
  onAccepted: () => void;
  onClose: () => void;
}) {
  const { t } = eligibilityCopy.useCopy();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<ApiResult<unknown> | null>(null);
  const accept = async () => {
    setBusy(true);
    setFailed(null);
    const result = await pay.acceptRisk(version);
    setBusy(false);
    if (result.ok) onAccepted();
    else setFailed(result);
  };
  return (
    <Dialog closeLabel={uiCopy.t('closeDialog')} title={t('riskTitle')} onClose={() => (busy ? undefined : onClose())}>
      <div className="form-stack" data-testid="p2p-risk-sheet">
        <p className="muted">{t('riskVersion', { version })}</p>
        <ul className="p2p-risk-points">
          <li>{t('riskRole')}</li>
          <li>{t('riskOutside')}</li>
          <li>{t('riskRoles')}</li>
          <li>{t('riskProhibited')}</li>
          <li>{t('riskFakeReceipt')}</li>
          <li>{t('riskPhishing')}</li>
          <li>{t('riskMiddle')}</li>
          <li>{t('riskPressure')}</li>
          <li>{t('riskCancelAfterPay')}</li>
        </ul>
        {failed && !failed.ok ? (
          <p data-testid="failure" className="failure" role="alert">
            {t('riskAcceptFailed')}
          </p>
        ) : null}
        <div className="actions">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t('riskClose')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void accept()}>
            {busy ? t('riskAccepting') : t('riskAccept')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Every requirement for taking an ad, as `access.eligibility` reports it: met, not met with the step that fixes it, or
 * unknown. `compact` lists only what is not met (the ad's take panel); the hub lists all of them.
 */
export function P2PEligibilityPanel({ pay, userId, compact = false }: { pay: PersonalPayApi; userId: string | null; compact?: boolean }) {
  const { t } = eligibilityCopy.useCopy();
  const [round, setRound] = useState(0);
  const [sheet, setSheet] = useState(false);
  const eligibility = useResource((signal) => pay.eligibility(signal), `pay:p2p-eligibility:${userId}:${round}`);
  const version = eligibility.resource.status === 'ready' ? (eligibility.resource.data.notice?.version ?? null) : null;
  if (compact && eligibility.resource.status === 'ready' && eligibility.resource.data.canTake) return null;
  return (
    <PaySection title={t('title')} description={compact ? undefined : t('intro')}>
      <div aria-label={t('title')} role="region" data-testid="p2p-eligibility">
        <PayState resource={eligibility.resource} retry={eligibility.reload}>
          {(data) => (
            <>
              <p data-testid={data.canTake ? undefined : 'failure'} className={data.canTake ? 'muted' : 'failure'} role="status">
                {data.canTake ? t('allMet') : t('someUnmet')}
              </p>
              <ul className="p2p-eligibility">
                {data.checks
                  .filter((check) => !compact || check.state !== 'met')
                  .map((check) => (
                    <li key={check.id} data-check={check.id} data-state={check.state}>
                      <strong>{t(`check_${check.id}` as const)}</strong>{' '}
                      <StatusTag
                        status={check.state === 'met' ? 'filled' : check.state === 'not_met' ? 'failed' : 'pending'}
                        label={t(`state_${check.state}` as const)}
                      />
                      <p className="muted">{eligibilityReason(t, check, version)}</p>
                      {check.state === 'not_met' && check.fix ? (
                        <a className="text-link" href={check.fix}>
                          {check.id === 'verification' ? t('fix_verification') : t('fix_contact')}
                        </a>
                      ) : null}
                      {check.id === 'risk' && check.state === 'not_met' && version ? (
                        <Button variant="secondary" onClick={() => setSheet(true)}>
                          {t('riskOpen')}
                        </Button>
                      ) : null}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </PayState>
      </div>
      {sheet && version ? (
        <RiskSheet
          pay={pay}
          version={version}
          onClose={() => setSheet(false)}
          onAccepted={() => {
            setSheet(false);
            setRound((value) => value + 1);
          }}
        />
      ) : null}
    </PaySection>
  );
}
